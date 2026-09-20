// Deletes one of the authenticated caller's own posts, and its exclusive
// share-snapshots storage objects (POST DELETION beta blocker). A thin,
// authenticated-only HTTP wrapper — the only thing it coordinates beyond a
// single RLS-protectable DB delete is the durable share-snapshots bucket,
// which no DB constraint can ever clean up on its own.
//
// Live schema, verified directly (not inferred) before this was written:
//   comments.post_id         -> posts.id ON DELETE CASCADE
//   notifications.post_id    -> posts.id ON DELETE CASCADE
//   notifications.comment_id -> comments.id ON DELETE CASCADE
//   likes.post_id, rate_my_grail_cards.post_id, grail_ratings.post_id,
//   card_share_items.post_id -> posts.id ON DELETE CASCADE (schema.sql)
//   post_images.post_id      -> posts.id ON DELETE CASCADE (supabase/
//   migrations/20260911150000_create_post_images.sql — text posts' 0-4
//   mixed-source images)
// Every one of these is removed automatically the instant the posts row
// itself is deleted — this function never deletes any of them explicitly,
// and must not start doing so again (that would just be redundant work
// racing the cascade).
//
// Why this still can't be a plain client-side RLS-gated delete: posts has
// an owner-only DELETE policy (posts_delete_own: auth.uid() = user_id),
// which is exactly what would stop another user from deleting this post if
// they somehow tried it directly — but this function itself runs on the
// SERVICE-ROLE client, which bypasses RLS entirely. posts_delete_own is
// not what protects this code path; the explicit `post.user_id === userId`
// check and the `user_id`-scoped delete query below are. RLS remains the
// (still-relevant) protection for any ordinary client-side direct DELETE
// attempt against posts — this function just isn't relying on it for its
// own safety.
//
// AUTHENTICATED CALLERS ONLY — same rationale as copy-share-snapshot-image
// and create-snapshot-post (no legitimate anonymous caller for "delete my
// own post"); supabase.functions.invoke() is safe to use client-side here.
//
// Request:  POST { post_id: string }
//           Authorization: Bearer <user JWT>  (required)
// Response: { status: 'ok' }
//         | { status: 'failed'; reason: string }
//
// Flow:
//   1. Authenticate the caller.
//   2. Fetch the post server-side.
//   3. Verify post.user_id === caller's user id.
//   4. Collect exact share-snapshots URLs from posts.image_url ('item'
//      posts) or the relevant child table's snapshot_image_url rows
//      ('card_share' / 'rate_my_grails') — BEFORE deleting anything, since
//      the cascade below removes those child rows.
//   5. Delete the posts row, still scoped to id + user_id as defense in
//      depth on top of the ownership check in step 3.
//   6. Rely on the confirmed FK cascades above for every dependent DB row
//      — nothing here deletes comments/notifications/likes/etc. itself.
//   7. Best-effort delete only the exact collected share-snapshots
//      objects — failures here are logged, never turned into a reported
//      deletion failure (the post itself is already gone by this point;
//      an orphaned storage object is unreferenced dead weight, never a
//      broken/visible reference).
//   8. Return a minimal { status: 'ok' }.
//
// Never touches item-images — every URL considered for storage deletion is
// validated against the share-snapshots bucket's own public-URL shape
// (parseShareSnapshotsStoragePath) before being passed to a delete call;
// anything that doesn't match (e.g. some still-unmigrated legacy value) is
// simply skipped, never guessed at or force-parsed.

import {
  handleCorsPreflight,
  jsonResponse,
  parseShareSnapshotsStoragePath,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  let body: { post_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const postId = body.post_id;
  if (typeof postId !== 'string' || !UUID_RE.test(postId)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_input' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ status: 'failed', reason: 'invalid_token' }, 401);
  }

  const { data: post, error: postError } = await client
    .from('posts')
    .select('id, user_id, post_type, image_url')
    .eq('id', postId)
    .maybeSingle();

  if (postError) {
    return jsonResponse({ status: 'failed', reason: 'lookup_failed' }, 200);
  }
  if (!post) {
    return jsonResponse({ status: 'failed', reason: 'not_found' }, 200);
  }
  if (post.user_id !== userId) {
    // Never reveals anything to the caller beyond "unauthorized" — same
    // convention as create-snapshot-post's own ownership check. This is
    // the hard boundary that makes deleting another user's post
    // impossible: even a caller who guesses a valid post_id and holds a
    // valid JWT for a DIFFERENT account is rejected here before anything
    // is read or deleted.
    return jsonResponse({ status: 'failed', reason: 'unauthorized' }, 200);
  }

  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const candidateUrls: string[] = [];

  if (post.post_type === 'item' && post.image_url) {
    candidateUrls.push(post.image_url as string);
  } else if (post.post_type === 'card_share') {
    const { data: rows } = await client
      .from('card_share_items')
      .select('snapshot_image_url')
      .eq('post_id', postId);
    for (const row of (rows ?? []) as { snapshot_image_url: string | null }[]) {
      if (row.snapshot_image_url) candidateUrls.push(row.snapshot_image_url);
    }
  } else if (post.post_type === 'rate_my_grails') {
    const { data: rows } = await client
      .from('rate_my_grail_cards')
      .select('snapshot_image_url')
      .eq('post_id', postId);
    for (const row of (rows ?? []) as { snapshot_image_url: string | null }[]) {
      if (row.snapshot_image_url) candidateUrls.push(row.snapshot_image_url);
    }
  } else if (post.post_type === 'text') {
    // Two generations of text-post image: the original single optional
    // photo (still just posts.image_url, pre-multi-image), and the
    // current 0-4 mixed-source post_images rows (supabase/migrations/
    // 20260911150000_create_post_images.sql). A single row can only ever
    // have used one or the other, but both are checked unconditionally —
    // cheap, and never assumes which generation a given row belongs to.
    if (post.image_url) {
      candidateUrls.push(post.image_url as string);
    }
    const { data: rows } = await client
      .from('post_images')
      .select('image_url')
      .eq('post_id', postId);
    for (const row of (rows ?? []) as { image_url: string }[]) {
      if (row.image_url) candidateUrls.push(row.image_url);
    }
  }

  // Every candidate must resolve against THIS project's own share-snapshots
  // bucket shape — anything that doesn't (never expected post-migration,
  // but never trusted blindly either) is dropped, not force-deleted.
  const storagePaths = candidateUrls
    .map((url) => parseShareSnapshotsStoragePath(url, projectUrl))
    .filter((path): path is string => !!path);

  // The authoritative delete — scoped to id AND user_id. This is defense
  // in depth on top of the ownership check already performed above, NOT a
  // reliance on posts_delete_own — that RLS policy has no effect here
  // (this client is service-role and bypasses RLS entirely); it's the
  // explicit .eq('user_id', userId) below that actually enforces
  // ownership on this exact query. Cascades comments / notifications /
  // likes / rate_my_grail_cards / grail_ratings / card_share_items
  // automatically — confirmed live FK behavior, not re-deleted here.
  const { data: deletedRows, error: deleteError } = await client
    .from('posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', userId)
    .select('id');

  if (deleteError) {
    console.error('[delete-post] posts delete failed:', deleteError.message, { postId });
    return jsonResponse({ status: 'failed', reason: 'delete_failed' }, 200);
  }
  if (!deletedRows || deletedRows.length === 0) {
    console.error('[delete-post] posts delete matched zero rows:', { postId, userId });
    return jsonResponse({ status: 'failed', reason: 'delete_failed' }, 200);
  }

  // The post (and every FK-cascaded row above) is authoritatively gone —
  // only the share-snapshots storage cleanup is left, best-effort, and
  // must never turn an already-successful deletion into a reported
  // failure.
  if (storagePaths.length > 0) {
    const { error: storageError } = await client.storage.from('share-snapshots').remove(storagePaths);
    if (storageError) {
      console.error('[delete-post] share-snapshots cleanup failed:', storageError.message, { postId, storagePaths });
    }
  }

  return jsonResponse({ status: 'ok' }, 200);
});

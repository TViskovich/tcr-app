// Server-orchestrated, all-or-nothing creation for the two MULTI-item
// feed-snapshot post types — card_share and rate_my_grails (Phase 3E,
// item-images beta privacy hardening — final pre-cutover blockers).
//
// Why this exists, not just copy-share-snapshot-image: a multi-card post
// needs N image copies AND a multi-row DB write (posts + N child rows) to
// either all succeed or none happen — Postgres can't make HTTP/Storage
// calls mid-transaction, so this can't be one plpgsql function the way
// create_card_share_post was. Doing the copies from the client and then
// calling a DB RPC would still leave a window where some copies succeeded
// but the RPC failed (or vice versa) with no single place enforcing the
// combined invariant. This function is that single place: it copies every
// item's image FIRST, and only if every single one succeeds does it then
// create the post and its child rows using SERVICE ROLE (bypassing RLS —
// so every check RLS/the old RPC used to provide is re-verified here
// explicitly, matching this codebase's established RLS-mirroring
// convention).
//
// Invariant this enforces: a card_share or rate_my_grails post is NEVER
// visible to the caller (or anyone else) unless every one of its cards
// already has a durable share-snapshots URL. There is no partial/
// best-effort state a caller can observe — either the whole post exists
// with fully-durable images, or nothing was created at all.
//
// create_card_share_post (the original RPC) is intentionally left in the
// database, unused by the client from this phase forward — dropping it
// wasn't requested and isn't required for correctness; it simply has no
// remaining caller.
//
// AUTHENTICATED CALLERS ONLY — same rationale as copy-share-snapshot-image
// (no legitimate anonymous caller; supabase.functions.invoke() is safe to
// use client-side for this reason, see lib/share-snapshots.ts).
//
// (post_type 'folder_share' — { post_type, caption, folder_id } — is handled
// by handleFolderShare at the bottom of this file.)
// Request:  POST { post_type: 'card_share' | 'rate_my_grails';
//                   caption: string | null;
//                   item_ids: string[] }   (card_share: 2-5, matching the
//                                            original RPC's own bounds;
//                                            rate_my_grails: 1+, matching
//                                            existing client behavior —
//                                            no prior upper bound existed
//                                            to preserve)
//           Authorization: Bearer <user JWT>  (required)
// Response: { status: 'ok'; post_id: string }
//         | { status: 'failed'; reason: string }
//
// Failure semantics (Part A4): copying every item's snapshot bytes is
// part of successful creation, not optional decoration. Any single copy
// failure aborts the ENTIRE request before any DB row is written — never
// a raw item-images URL, never a silent partial post. If a copy batch
// partially succeeds before one failure, the already-uploaded
// share-snapshots objects from that batch become orphaned (nothing in the
// DB will ever reference them, since no post row is created on this
// path) — accepted as reported cleanup debt rather than a compensating
// delete, consistent with keeping this a bounded fix rather than a larger
// distributed-transaction redesign. If the DB write itself fails AFTER
// every copy succeeded (rare — a genuine insert-time failure), this
// function DOES compensate by deleting the just-created, still-childless
// posts row it created moments earlier in this same request (safe: this
// request is the only thing that could possibly reference that row yet)
// — but does not attempt to delete the now-orphaned share-snapshots
// objects in that case either, for the same reason.

import {
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';
import { copyFolderCoverIntoShareSnapshots, copyItemImageIntoShareSnapshots } from '../_shared/share-snapshot.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTI_ITEM_POST_TYPES = new Set(['card_share', 'rate_my_grails']);
const CARD_SHARE_MIN = 2;
const CARD_SHARE_MAX = 5;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  let body: { post_type?: unknown; caption?: unknown; item_ids?: unknown; folder_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const postType = body.post_type;
  const caption = typeof body.caption === 'string' ? body.caption : null;
  const itemIds = body.item_ids;

  // Folder Share is folder-driven (the server decides which items are
  // represented) rather than item_ids-driven — handled separately below.
  if (postType === 'folder_share') {
    return handleFolderShare(req, body, caption);
  }

  if (typeof postType !== 'string' || !MULTI_ITEM_POST_TYPES.has(postType)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_post_type' }, 400);
  }
  if (
    !Array.isArray(itemIds) ||
    !itemIds.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))
  ) {
    return jsonResponse({ status: 'failed', reason: 'invalid_items' }, 400);
  }
  if (new Set(itemIds).size !== itemIds.length) {
    return jsonResponse({ status: 'failed', reason: 'duplicate_item' }, 400);
  }
  if (postType === 'card_share' && (itemIds.length < CARD_SHARE_MIN || itemIds.length > CARD_SHARE_MAX)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_item_count' }, 400);
  }
  if (postType === 'rate_my_grails' && itemIds.length < 1) {
    return jsonResponse({ status: 'failed', reason: 'invalid_item_count' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ status: 'failed', reason: 'invalid_token' }, 401);
  }

  // Ownership check — every item must belong to the caller. One batched
  // query, never one per item. Also carries the title/brand this
  // function needs for the child rows' snapshot_title/snapshot_subtitle,
  // derived server-side from the live row rather than trusted from the
  // client — same principle create_card_share_post's own comment
  // documents.
  const { data: ownedItems } = await client
    .from('collection_items')
    .select('id, title, brand')
    .in('id', itemIds)
    .eq('user_id', userId);

  const ownedById = new Map((ownedItems ?? []).map((i: any) => [i.id as string, i]));
  if (itemIds.some((id) => !ownedById.has(id))) {
    return jsonResponse({ status: 'failed', reason: 'unauthorized' }, 200);
  }

  // Copy every item's current image into share-snapshots FIRST. groupId
  // is a temporary Storage-path grouping label only — not a real row id
  // (no post exists yet) — so a partially-successful batch can never be
  // mistaken for belonging to a post that ends up not being created.
  const groupId = crypto.randomUUID();
  const copyResults = await Promise.all(
    itemIds.map((itemId) =>
      copyItemImageIntoShareSnapshots(
        client,
        userId,
        itemId,
        postType as 'card_share' | 'rate_my_grails',
        groupId,
      ),
    ),
  );

  if (copyResults.some((r) => !r.ok)) {
    return jsonResponse({ status: 'failed', reason: 'copy_failed' }, 200);
  }
  const copied = copyResults as { ok: true; publicUrl: string; storagePath: string }[];

  // All copies succeeded — now, and only now, create the post + child
  // rows, using the already-durable share-snapshots URLs directly.
  const { data: postRow, error: postError } = await client
    .from('posts')
    .insert({ user_id: userId, post_type: postType, caption })
    .select('id')
    .single();

  if (postError || !postRow) {
    return jsonResponse({ status: 'failed', reason: 'insert_failed' }, 200);
  }

  const childRows = itemIds.map((itemId, index) => ({
    post_id: postRow.id,
    item_id: itemId,
    snapshot_image_url: copied[index].publicUrl,
    snapshot_title: ownedById.get(itemId)?.title ?? null,
    snapshot_subtitle: ownedById.get(itemId)?.brand ?? null,
    display_order: index,
  }));

  const childTable = postType === 'card_share' ? 'card_share_items' : 'rate_my_grail_cards';
  const { error: childError } = await client.from(childTable).insert(childRows);

  if (childError) {
    // The post row exists but has zero child rows — a visibly broken,
    // imageless post. Compensate by deleting it (safe: this request is
    // the only thing that could reference this just-created row so far).
    await client.from('posts').delete().eq('id', postRow.id);
    return jsonResponse({ status: 'failed', reason: 'insert_failed' }, 200);
  }

  return jsonResponse({ status: 'ok', post_id: postRow.id }, 200);
});

// ── folder_share ────────────────────────────────────────────────────────────
// "Share Folder" feed post: a snapshot of up to FOLDER_SHARE_MAX_ITEMS of a
// folder's items at posting time — durable share-snapshots image copies plus
// title/subtitle, exactly like card_share_items — so the post keeps looking
// the same after the folder is reordered/renamed, an item is deleted (child
// row's item_id goes NULL, the snapshot stays), or an item later becomes
// private. Same all-or-nothing rule as above: every copy first, then the
// post + child rows.
//
// Privacy at posting time (stricter than card_share, which only checks
// ownership): the folder must be the caller's and effectively public (folder
// and every ancestor is_public, evaluated as an anonymous viewer), and only
// active, is_public items with a primary photo are eligible.
//
// posts.folder_item_count = the number of ELIGIBLE (public, active,
// photographed) items at posting time — NOT the folder's full item count.
// posts.folder_cover_snapshot_url = a share-snapshots copy of the folder's
// explicit cover at posting time (NULL when it has none).
const FOLDER_SHARE_MAX_ITEMS = 4;

async function handleFolderShare(req: Request, body: { folder_id?: unknown }, caption: string | null) {
  const folderId = body.folder_id;
  if (typeof folderId !== 'string' || !UUID_RE.test(folderId)) {
    return jsonResponse({ status: 'failed', reason: 'invalid_folder' }, 400);
  }
  if (caption !== null && caption.length > 280) {
    return jsonResponse({ status: 'failed', reason: 'caption_too_long' }, 400);
  }

  const client = serviceRoleClient();
  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ status: 'failed', reason: 'invalid_token' }, 401);
  }

  const { data: folder } = await client
    .from('folders')
    .select('id, name, user_id, cover_source, cover_storage_path, cover_item_id')
    .eq('id', folderId)
    .maybeSingle();
  if (!folder || folder.user_id !== userId) {
    return jsonResponse({ status: 'failed', reason: 'unauthorized' }, 200);
  }

  // Effectively public, as an anonymous viewer would see it.
  const { data: visibility } = await client.rpc('folder_effective_visibility_batch', {
    folder_ids: [folderId],
    caller: null,
  });
  if (!(visibility as { folder_id: string; visible: boolean }[] | null)?.some((v) => v.visible)) {
    return jsonResponse({ status: 'failed', reason: 'folder_not_public' }, 200);
  }

  const { data: candidateItems } = await client
    .from('collection_items')
    .select('id, title, brand, created_at')
    .eq('folder_id', folderId)
    .eq('user_id', userId)
    .eq('collection_status', 'active')
    .eq('is_public', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  const candidateIds = (candidateItems ?? []).map((i: any) => i.id as string);
  if (candidateIds.length === 0) {
    return jsonResponse({ status: 'failed', reason: 'no_eligible_items' }, 200);
  }

  const { data: primaries } = await client
    .from('collection_item_images')
    .select('item_id')
    .eq('is_primary', true)
    .in('item_id', candidateIds);
  const photographed = new Set((primaries ?? []).map((r: any) => r.item_id as string));
  const eligible = (candidateItems ?? []).filter((i: any) => photographed.has(i.id));
  if (eligible.length === 0) {
    return jsonResponse({ status: 'failed', reason: 'no_eligible_items' }, 200);
  }

  const picked = eligible.slice(0, FOLDER_SHARE_MAX_ITEMS) as { id: string; title: string | null; brand: string | null }[];

  const groupId = crypto.randomUUID();
  const copyResults = await Promise.all(
    picked.map((item) => copyItemImageIntoShareSnapshots(client, userId, item.id, 'folder_share', groupId)),
  );
  if (copyResults.some((r) => !r.ok)) {
    return jsonResponse({ status: 'failed', reason: 'copy_failed' }, 200);
  }
  const copied = copyResults as { ok: true; publicUrl: string; storagePath: string }[];

  // The folder's cover, resolved EXACTLY the way the folder screen's own cover
  // resolver (get-folder-cover-signed-url) does, but as an anonymous viewer
  // would see it (a private item is never published as the cover):
  //   'upload'     -> folders.cover_storage_path
  //   'item'       -> folders.cover_item_id's primary photo (must be eligible;
  //                   otherwise there is no cover)
  //   'first_card' -> the folder's NEWEST eligible item's primary photo (the
  //                   automatic cover; ordered by created_at, not folder order)
  // The stored cover_crop (pan/zoom framing) is deliberately ignored — the
  // post shows the whole image. The chosen image is copied into
  // share-snapshots; any copy failure fails the whole request.
  let coverSnapshotUrl: string | null = null;
  if (folder.cover_source === 'upload') {
    if (folder.cover_storage_path) {
      const cover = await copyFolderCoverIntoShareSnapshots(client, userId, folder.cover_storage_path as string, groupId);
      if (!cover.ok) return jsonResponse({ status: 'failed', reason: 'copy_failed' }, 200);
      coverSnapshotUrl = cover.publicUrl;
    }
  } else {
    const coverItem =
      folder.cover_source === 'item'
        ? (folder.cover_item_id ? eligible.find((i: any) => i.id === folder.cover_item_id) : undefined)
        : [...eligible].sort(
            (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          )[0];
    if (coverItem) {
      const cover = await copyItemImageIntoShareSnapshots(client, userId, coverItem.id, 'folder_share', groupId);
      if (!cover.ok) return jsonResponse({ status: 'failed', reason: 'copy_failed' }, 200);
      coverSnapshotUrl = cover.publicUrl;
    }
  }

  const { data: postRow, error: postError } = await client
    .from('posts')
    .insert({
      user_id: userId,
      post_type: 'folder_share',
      caption,
      folder_id: folderId,
      folder_name: folder.name,
      folder_item_count: eligible.length,
      folder_cover_snapshot_url: coverSnapshotUrl,
    })
    .select('id')
    .single();
  if (postError || !postRow) {
    return jsonResponse({ status: 'failed', reason: 'insert_failed' }, 200);
  }

  const { error: childError } = await client.from('folder_share_items').insert(
    picked.map((item, index) => ({
      post_id: postRow.id,
      item_id: item.id,
      snapshot_image_url: copied[index].publicUrl,
      snapshot_title: item.title ?? null,
      snapshot_subtitle: item.brand ?? null,
      display_order: index,
    })),
  );
  if (childError) {
    await client.from('posts').delete().eq('id', postRow.id);
    return jsonResponse({ status: 'failed', reason: 'insert_failed' }, 200);
  }

  return jsonResponse({ status: 'ok', post_id: postRow.id }, 200);
}

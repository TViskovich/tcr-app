import { supabase } from './supabase';

export type SnapshotType = 'post' | 'card_share' | 'rate_my_grails';

export type CopyShareSnapshotImageResult =
  | { status: 'ok'; publicUrl: string }
  | { status: 'failed' };

// Single-item durable-snapshot copy (Phase 3E — item-images beta privacy
// hardening, final pre-cutover blockers). MUST be called and confirmed
// 'ok' BEFORE inserting the row that will carry its result — never insert
// first and best-effort-upgrade after (an earlier draft of this phase did
// that, and it left a window where a failed copy meant a post permanently
// stuck pointing at a fragile item-images URL, which the eventual
// private-bucket cutover would break outright). Callers:
// app/item/new.tsx's share-to-feed and app/share-card/new.tsx's
// single-card path — the only two single-item snapshot writers.
// card_share (multi-card) and rate_my_grails go through
// createSnapshotPost below instead, since those need several copies plus
// a multi-row DB write to succeed or fail together as one unit, which
// this single-item function was never meant to coordinate.
//
// targetId does not need to be a real row id that already exists — see
// the Edge Function's own module comment. Both current callers pass
// itemId again as targetId, since no post id exists yet at call time.
//
// Authenticated-only — see the Edge Function's own module comment for why
// supabase.functions.invoke() (rather than the direct-fetch transport
// hooks/use-signed-item-images.ts and hooks/use-signed-folder-covers.ts
// use for their anonymous-capable functions) is safe here: there is no
// legitimate anonymous caller for a write operation scoped to "snapshot
// your own item."
export async function copyShareSnapshotImage(
  itemId: string,
  snapshotType: SnapshotType,
  targetId: string,
): Promise<CopyShareSnapshotImageResult> {
  const { data, error } = await supabase.functions.invoke('copy-share-snapshot-image', {
    body: { item_id: itemId, snapshot_type: snapshotType, target_id: targetId },
  });
  if (error || data?.status !== 'ok' || typeof data?.public_url !== 'string') {
    if (__DEV__) console.warn('[copyShareSnapshotImage] failed:', error ?? data);
    return { status: 'failed' };
  }
  return { status: 'ok', publicUrl: data.public_url };
}

// Standard text post's optional single attached photo (app/post/new.tsx)
// — a freshly-uploaded, caller-owned item-images object (from
// uploadItemImage(), lib/storage.ts), copied server-side into the durable
// share-snapshots bucket. Unlike copyShareSnapshotImage above, there is no
// collection_items row behind this photo at all; the Edge Function
// authorizes purely on the source object's own path being inside the
// caller's own item-images/{userId}/ namespace. MUST be called and
// confirmed 'ok' BEFORE inserting the post row that will carry its
// result — same call-before-insert rule as copyShareSnapshotImage, for the
// same reason (never leave a post pointing at a fragile item-images URL).
export async function copyPostPhotoToShareSnapshots(sourceUrl: string): Promise<CopyShareSnapshotImageResult> {
  const { data, error } = await supabase.functions.invoke('copy-post-photo-to-share-snapshots', {
    body: { source_url: sourceUrl },
  });
  if (error || data?.status !== 'ok' || typeof data?.public_url !== 'string') {
    if (__DEV__) console.warn('[copyPostPhotoToShareSnapshots] failed:', error ?? data);
    return { status: 'failed' };
  }
  return { status: 'ok', publicUrl: data.public_url };
}

export type MultiItemSnapshotType = Extract<SnapshotType, 'card_share' | 'rate_my_grails'>;

export type CreateSnapshotPostResult =
  | { status: 'ok'; postId: string }
  | { status: 'failed'; reason: string };

// All-or-nothing creation for the two multi-item post types. Delegates
// entirely to the create-snapshot-post Edge Function — every image copy
// AND the post + child-row DB write happen server-side as one unit;
// nothing about this call is best-effort. Either the returned post
// already has every card's durable share-snapshots URL in place, or
// nothing was created at all. See the Edge Function's own module comment
// for the full invariant and failure-mode rationale.
export async function createSnapshotPost(
  postType: MultiItemSnapshotType,
  itemIds: string[],
  caption: string | null,
): Promise<CreateSnapshotPostResult> {
  const { data, error } = await supabase.functions.invoke('create-snapshot-post', {
    body: { post_type: postType, item_ids: itemIds, caption },
  });
  if (error || data?.status !== 'ok' || typeof data?.post_id !== 'string') {
    const reason = typeof data?.reason === 'string' ? data.reason : (error ? 'request_failed' : 'unknown');
    if (__DEV__) console.warn('[createSnapshotPost] failed:', reason, error ?? data);
    return { status: 'failed', reason };
  }
  return { status: 'ok', postId: data.post_id };
}

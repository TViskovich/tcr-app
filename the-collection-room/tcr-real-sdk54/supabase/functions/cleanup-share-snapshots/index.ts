// Best-effort cleanup for share-snapshots objects that were already copied
// during a text-post creation attempt (app/post/new.tsx) that then failed
// BEFORE any posts/post_images row was ever written — either because a
// later attachment's own copy failed, or because the create_text_post RPC
// itself failed after every attachment had already been copied. Storage
// and Postgres are not one transaction: create_text_post's own atomicity
// only ever covers the posts/post_images ROWS; by the time it's called,
// every attachment's share-snapshots OBJECT already durably exists
// regardless of whether that RPC call then succeeds. This function
// reclaims exactly those objects on a failed attempt — nothing else.
//
// AUTHENTICATED CALLERS ONLY — same rationale as every other write-side
// Edge Function this app's lib/share-snapshots.ts calls (no legitimate
// anonymous caller for "delete my own just-failed upload").
//
// Request:  POST { urls: string[] }
//           Authorization: Bearer <user JWT>  (required)
// Response: { status: 'ok'; deleted: number }
//         | { status: 'failed'; reason: string }
//
// Every url must resolve (via parseShareSnapshotsStoragePath, the same
// helper delete-post already uses) to a path inside the CALLER'S OWN
// prefix ({callerId}/...) in the share-snapshots bucket specifically —
// never item-images, never any other bucket, and never another user's
// object even if a client somehow sent one. A url that doesn't validate
// against both checks is silently skipped, never force-deleted: this
// endpoint can only ever narrow what a client asks for, never widen it.
// A request with zero legitimately-owned urls ends up deleting nothing,
// which is a normal ('ok', deleted: 0) outcome, not an error — this keeps
// the caller (a catch block already showing the user the REAL failure)
// free to fire this off without needing to pre-validate its own list.
//
// The 20-url cap below is a sanity bound, not a tuned limit: today's
// composer allows at most 4 attachments per post, so a legitimate call
// here is never larger than that; 20 leaves headroom without turning this
// into an unbounded bulk-delete surface.

import {
  handleCorsPreflight,
  jsonResponse,
  parseShareSnapshotsStoragePath,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';

const MAX_URLS = 20;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'failed', reason: 'method_not_allowed' }, 405);
  }

  let body: { urls?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const urls = body.urls;
  if (!Array.isArray(urls) || !urls.every((u): u is string => typeof u === 'string')) {
    return jsonResponse({ status: 'failed', reason: 'invalid_input' }, 400);
  }
  if (urls.length === 0) {
    return jsonResponse({ status: 'ok', deleted: 0 }, 200);
  }
  if (urls.length > MAX_URLS) {
    return jsonResponse({ status: 'failed', reason: 'too_many_urls' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ status: 'failed', reason: 'invalid_token' }, 401);
  }

  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const ownedPaths = urls
    .map((url) => parseShareSnapshotsStoragePath(url, projectUrl))
    .filter((path): path is string => !!path && path.split('/')[0] === userId);

  if (ownedPaths.length === 0) {
    return jsonResponse({ status: 'ok', deleted: 0 }, 200);
  }

  const { error } = await client.storage.from('share-snapshots').remove(ownedPaths);
  if (error) {
    console.error('[cleanup-share-snapshots] remove failed:', error.message, { userId, count: ownedPaths.length });
    return jsonResponse({ status: 'failed', reason: 'delete_failed' }, 200);
  }

  return jsonResponse({ status: 'ok', deleted: ownedPaths.length }, 200);
});

// Copies an authenticated caller's own collection item's current primary
// gallery image into the durable, always-public share-snapshots bucket
// (Phase 3E — item-images beta privacy hardening, final pre-cutover
// blockers). Thin HTTP wrapper around the shared copy core in
// ../_shared/share-snapshot.ts (also used by create-snapshot-post).
//
// This function is the CLIENT-ORCHESTRATED, single-item primitive: the
// caller is expected to call this BEFORE inserting its own row, and only
// insert that row once this returns 'ok' — never insert first and best-
// effort-upgrade after (that was Phase 3E's first-draft design; it left a
// window where a failed copy meant a post permanently stuck pointing at a
// fragile item-images URL, which the eventual private-bucket cutover
// would break outright). See lib/share-snapshots.ts's own module comment
// for the exact call-before-insert sequencing used by
// app/item/new.tsx's share-to-feed and app/share-card/new.tsx's
// single-card path — the only two remaining callers of this function.
// card_share (multi-card) and rate_my_grails now go through
// create-snapshot-post instead, since those need multiple copies plus a
// multi-row DB write to succeed or fail together, which this single-item
// function was never meant to coordinate.
//
// AUTHENTICATED CALLERS ONLY — there is no legitimate anonymous caller for
// this function (only an owner may snapshot their own item), so unlike
// get-collection-item-image-signed-url / get-folder-cover-signed-url, no
// anonymous-vs-invalid-token ambiguity exists here: any request without a
// resolvable user id is rejected outright with 401. This is also why
// lib/share-snapshots.ts safely uses supabase.functions.invoke() rather
// than the direct-fetch transport those two anonymous-capable functions
// require.
//
// Request:  POST { item_id: string; snapshot_type: 'post' | 'card_share' | 'rate_my_grails'; target_id: string }
//           Authorization: Bearer <user JWT>  (required)
// Response: { status: 'ok'; public_url: string; storage_path: string }
//         | { status: 'unavailable' }
//
// target_id does not need to be a real row id that already exists — it's
// only a Storage path grouping label (see ../_shared/share-snapshot.ts).
// The only current caller that invokes this before its own row exists
// (the single-item 'post' path) passes item_id again as target_id, since
// no post id exists yet at that point.
//
// Authorization (delegated entirely to copyItemImageIntoShareSnapshots, see
// its own comment in ../_shared/share-snapshot.ts): item_id must either
// belong to the caller (any privacy state — matching create_card_share_post's
// existing rule that you may always share/snapshot your own item), or — for
// this function's 'post' snapshot_type only — be genuinely public (active,
// is_public, and its whole folder chain effectively visible to an anonymous
// viewer). This lets "Post to Feed" work for another user's public card,
// not just the caller's own collection.

import {
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';
import { copyItemImageIntoShareSnapshots } from '../_shared/share-snapshot.ts';

const UNAVAILABLE = { status: 'unavailable' as const };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_TYPES = new Set(['post', 'card_share', 'rate_my_grails']);

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: { item_id?: unknown; snapshot_type?: unknown; target_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const itemId = body.item_id;
  const snapshotType = body.snapshot_type;
  const targetId = body.target_id;
  if (
    typeof itemId !== 'string' || !UUID_RE.test(itemId) ||
    typeof snapshotType !== 'string' || !SNAPSHOT_TYPES.has(snapshotType) ||
    typeof targetId !== 'string' || !UUID_RE.test(targetId)
  ) {
    return jsonResponse({ error: 'invalid_input' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  const result = await copyItemImageIntoShareSnapshots(
    client,
    userId,
    itemId,
    snapshotType as 'post' | 'card_share' | 'rate_my_grails',
    targetId,
  );

  if (!result.ok) {
    // TEMPORARY DIAGNOSTIC LOGGING (foreign-item repost investigation) —
    // the client only ever sees the generic 'unavailable' status below
    // (never result.reason, which stays server-log-only by design — see
    // CopyFailureReason's own comment); copyItemImageIntoShareSnapshots
    // itself already logs the specific branch that produced this, but this
    // one extra line ties it back to the exact HTTP request/caller/item
    // for easier log searching. Safe to remove once the live failure path
    // is confirmed.
    console.error('[copy-share-snapshot-image] returning unavailable:', { reason: result.reason, itemId, snapshotType, userId });
    return jsonResponse(UNAVAILABLE, 200);
  }

  return jsonResponse(
    { status: 'ok', public_url: result.publicUrl, storage_path: result.storagePath },
    200,
  );
});

// Copies a freshly-uploaded, caller-owned item-images object into the
// durable, always-public share-snapshots bucket, for a standard text
// post's optional single attached photo (app/post/new.tsx). Thin HTTP
// wrapper around copyOwnedItemImageIntoShareSnapshots in
// ../_shared/share-snapshot.ts.
//
// Unlike copy-share-snapshot-image, this does NOT require a
// collection_items row — there is no item behind a plain text post's
// photo, and none is added just to satisfy that function's own
// authorization check. Authorization here is instead purely "the source
// object's own path lives inside the caller's own item-images/{userId}/
// namespace," verified server-side (never trusting client-supplied path
// structure directly — parseItemImagesStoragePath both extracts and
// validates the path against this project's own item-images bucket
// before it's ever used).
//
// The caller is expected to call this AFTER uploading the photo via the
// existing uploadItemImage() client helper and BEFORE inserting its own
// post row — only insert once this returns 'ok', same call-before-insert
// sequencing copy-share-snapshot-image's own module comment documents,
// for the same reason: a post permanently stuck pointing at a fragile,
// non-durable item-images URL is exactly the failure mode Phase 3E's
// share-snapshots bucket exists to avoid.
//
// AUTHENTICATED CALLERS ONLY — there is no legitimate anonymous caller
// (only the uploading user may copy their own staged photo), so any
// request without a resolvable user id is rejected outright with 401,
// same posture as copy-share-snapshot-image.
//
// Request:  POST { source_url: string }   (the exact item-images public
//                                           URL uploadItemImage() just
//                                           returned to the client)
//           Authorization: Bearer <user JWT>  (required)
// Response: { status: 'ok'; public_url: string; storage_path: string }
//         | { status: 'unavailable' }
//
// On success, the source item-images object is deleted (best-effort) — it
// was only ever a staging upload for this one copy, never referenced by
// any row, so removing it can never orphan anything else.

import {
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';
import { copyOwnedItemImageIntoShareSnapshots } from '../_shared/share-snapshot.ts';

const UNAVAILABLE = { status: 'unavailable' as const };

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: { source_url?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const sourceUrl = body.source_url;
  if (typeof sourceUrl !== 'string' || !sourceUrl) {
    return jsonResponse({ error: 'invalid_input' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  const result = await copyOwnedItemImageIntoShareSnapshots(client, userId, sourceUrl);

  if (!result.ok) {
    return jsonResponse(UNAVAILABLE, 200);
  }

  return jsonResponse(
    { status: 'ok', public_url: result.publicUrl, storage_path: result.storagePath },
    200,
  );
});

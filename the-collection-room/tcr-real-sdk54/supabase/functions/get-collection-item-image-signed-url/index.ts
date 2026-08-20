// Issues short-lived signed URLs for collection_item_images rows, enforcing
// the exact same visibility rule as the folders/collection_items RLS
// migration (supabase/migrations/20260819120000_enforce_collection_folder_privacy.sql):
// folders.is_public = true OR authenticated caller id = folders.user_id.
//
// Part of the item-images beta privacy hardening (Architecture B — see the
// item-images static/architecture audits). This function is backend-only
// infrastructure for Phase 2: item-images remains a PUBLIC bucket and
// existing storage.objects policies are UNCHANGED while this ships. Nothing
// about this function makes any existing image inaccessible — it only
// proves out the future authorized-delivery path ahead of the bucket
// actually going private in a later phase.
//
// Supports fully unauthenticated callers, because a public folder's images
// must remain viewable by anonymous/public viewers once item-images is
// eventually made private — this function MUST be deployed with gateway-level
// JWT verification disabled (`supabase functions deploy
// get-collection-item-image-signed-url --no-verify-jwt`), otherwise the
// gateway itself would reject an anonymous request with 401 before this code
// ever runs, breaking public-folder access entirely. All authorization is
// instead enforced inside this function, per request, below — identical
// posture to get-registry-snapshot-image-url.
//
// Request:  POST { image_ids: string[] }   (1-50 collection_item_images.id
//                                            values; never a raw storage_path,
//                                            item id, folder id, or owner id)
//           Authorization: Bearer <user JWT>  (optional)
// Response: { results: Array<
//               { id: string; status: 'ok'; signed_url: string; expires_in: number }
//             | { id: string; status: 'unavailable' }
//           > }
//
// Nonexistent rows and rows the caller isn't authorized to view return the
// exact same per-id { status: 'unavailable' } shape — row existence is never
// leaked through a distinct response, and one row's outcome never reveals
// anything about another row's in the same batch (each is resolved and
// authorized independently).
//
// A present-but-invalid/expired JWT is rejected outright for the whole
// request (401) — never silently downgraded to an anonymous request, same
// design as resolveCaller's documented contract.
//
// storage_path itself is never included in the response — only the signed
// URL the client actually needs to render the image.

import {
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';

const SIGNED_URL_TTL_SECONDS = 300;
const MAX_BATCH_SIZE = 50;
const UNAVAILABLE = { status: 'unavailable' as const };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolvedRow = {
  id: string;
  storage_path: string;
  is_public: boolean;
  owner_id: string;
};

// Mirrors folders_select_public / items_select_public's exact condition —
// deliberately re-implemented here rather than shared with the database
// layer (Edge Functions and Postgres RLS policies can't share code
// directly), matching this app's established per-module RLS-mirroring
// convention (see canViewRegisteredCard in ../_shared/registry-image.ts).
function canViewFolder(row: { is_public: boolean; owner_id: string }, callerId: string | null): boolean {
  if (row.is_public) return true;
  return callerId !== null && callerId === row.owner_id;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: { image_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  // Strict input-shape validation, rejecting the whole request rather than
  // silently dropping/coercing bad entries — image_ids is the only
  // identifier this function ever accepts, and every entry must already
  // look like a collection_item_images.id (a UUID). A raw storage path,
  // owner id, or any other string shape is rejected here, before any DB
  // lookup or authorization logic runs.
  const imageIds = body.image_ids;
  if (
    !Array.isArray(imageIds) ||
    imageIds.length === 0 ||
    imageIds.length > MAX_BATCH_SIZE ||
    !imageIds.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))
  ) {
    return jsonResponse({ error: 'invalid_image_ids' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  // One batched lookup for every requested id, resolving
  // collection_item_images -> collection_items -> folders in a single
  // round trip via PostgREST embedded resources. Uses the service-role
  // client (bypasses RLS entirely), so canViewFolder below is the ONLY
  // authorization boundary here — nothing about this query's success
  // implies the caller may view any of these rows.
  const { data: rows, error } = await client
    .from('collection_item_images')
    .select('id, storage_path, collection_items!inner(folder_id, folders!inner(is_public, user_id))')
    .in('id', imageIds);

  if (error) {
    // A query-level failure must not be reported per-row (that would imply
    // some rows were successfully checked and others weren't) — every
    // requested id fails uniformly.
    return jsonResponse(
      { results: imageIds.map((id) => ({ id, ...UNAVAILABLE })) },
      200,
    );
  }

  const resolved = new Map<string, ResolvedRow>();
  for (const r of (rows ?? []) as any[]) {
    const folder = r.collection_items?.folders;
    if (!folder) continue;
    resolved.set(r.id, {
      id: r.id,
      storage_path: r.storage_path,
      is_public: folder.is_public,
      owner_id: folder.user_id,
    });
  }

  const results = await Promise.all(
    imageIds.map(async (id) => {
      const row = resolved.get(id);
      if (!row || !canViewFolder(row, userId)) {
        return { id, ...UNAVAILABLE };
      }

      const { data: signed, error: signError } = await client.storage
        .from('item-images')
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) {
        return { id, ...UNAVAILABLE };
      }

      return { id, status: 'ok' as const, signed_url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS };
    }),
  );

  return jsonResponse({ results }, 200);
});

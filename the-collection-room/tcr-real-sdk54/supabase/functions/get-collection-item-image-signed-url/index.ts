// Issues short-lived signed URLs for collection_item_images rows, enforcing
// the exact same visibility rule as the collection_items/collection_item_images
// RLS (supabase/migrations/20260819120000_enforce_collection_folder_privacy.sql,
// tightened by 20260825120000_add_collection_item_privacy.sql to also require
// the item's own privacy flag, then by
// 20260902120000_recursive_folder_hierarchy_privacy.sql to make the folder
// leg ancestor-aware):
//   _folder_is_effectively_visible_for(folders.id, caller)   -- folder AND
//                                                                every ancestor
//                                                                public, or
//                                                                caller owns it
//   AND (collection_items.is_public = true OR caller = collection_items.user_id)
// OR the item is Grail-showcased (20260910120000_grail_slot_visibility_
// exception.sql — "Grail placement = implicit publish": an item referenced
// by its owner's own entry_type='item' profile_grail_slots row is signable
// for any caller regardless of its folder/own privacy, scoped to that exact
// item only — see canViewItem/ResolvedRow.grail_showcased below).
// This function runs as service-role and therefore bypasses table RLS
// entirely — canViewItem below is the ONLY authorization boundary for image
// delivery; the table-level RLS change alone does not protect this path.
// The folder leg is resolved via one batched call to
// folder_effective_visibility_batch() rather than a second,
// independently-maintained ancestor walk here.
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
  item_id: string;
  storage_path: string;
  folder_effectively_visible: boolean;
  item_is_public: boolean;
  owner_id: string;
  // Grail-slot visibility exception (Option B, "Grail placement = implicit
  // publish" — see supabase/migrations/20260910120000_
  // grail_slot_visibility_exception.sql). True when this row's item_id is
  // referenced by an entry_type='item' profile_grail_slots row belonging to
  // the same owner — resolved below via one batched query, mirroring the
  // equivalent additional OR branch added to items_select_public /
  // collection_item_images_select_public in that migration. Independent of
  // folder_effectively_visible/item_is_public: a Grail-showcased item signs
  // successfully even when its folder is private and/or the item's own
  // is_public is false, but this flag never widens beyond the exact item a
  // Grail slot names — no sibling item in the same folder gets it.
  grail_showcased: boolean;
};

// Mirrors items_select_public / collection_item_images_select_public's exact
// condition (Model A, most-restrictive-wins), PLUS the narrow Grail-slot
// exception added alongside those same policies (see this file's
// ResolvedRow.grail_showcased doc comment above). The folder leg
// (folder_effectively_visible) is resolved by the recursive
// folder_effective_visibility_batch() RPC (supabase/migrations/
// 20260902120000_recursive_folder_hierarchy_privacy.sql) rather than a
// second, independently-maintained ancestor walk here — this function only
// combines that result with the item's own privacy flag and the Grail
// exception, matching this app's established per-module RLS-mirroring
// convention (see canViewRegisteredCard in ../_shared/registry-image.ts).
// Owner override applies regardless of any other flag; a non-owner needs
// EITHER (the folder, and every one of its ancestors, AND the item to be
// public) OR (this exact item to be Grail-showcased by its own owner).
function canViewItem(
  row: { folder_effectively_visible: boolean; item_is_public: boolean; owner_id: string; grail_showcased: boolean },
  callerId: string | null,
): boolean {
  if (callerId !== null && callerId === row.owner_id) return true;
  if (row.folder_effectively_visible && row.item_is_public) return true;
  return row.grail_showcased;
}

// One batched call for every distinct folder referenced by this request's
// items, rather than one RPC round trip per folder.
async function resolveVisibleFolderIds(
  client: ReturnType<typeof serviceRoleClient>,
  folderIds: string[],
  callerId: string | null,
): Promise<Set<string>> {
  if (!folderIds.length) return new Set();
  const { data, error } = await client.rpc('folder_effective_visibility_batch', {
    folder_ids: folderIds,
    caller: callerId,
  });
  if (error || !data) return new Set();
  return new Set(
    (data as { folder_id: string; visible: boolean }[])
      .filter((row) => row.visible)
      .map((row) => row.folder_id),
  );
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

  // Three separate, unambiguous batched lookups — collection_item_images
  // -> collection_items -> folders — rather than one embedded PostgREST
  // select. An embedded `collection_items!inner(..., folders!inner(...))`
  // select USED to work here, but folders.cover_item_id (added by
  // 20260901120000_add_folder_cover_item_id.sql, referencing
  // collection_items(id) for the folder-cover-picker feature) gave
  // PostgREST a SECOND foreign-key path between collection_items and
  // folders (alongside the original collection_items.folder_id ->
  // folders.id), so it can no longer auto-resolve which relationship
  // `folders!inner(...)` means and fails the whole query with PGRST201
  // ("more than one relationship was found"). That failure was silently
  // swallowed by the `if (error)` branch below, three lines down, which
  // exists for a DIFFERENT reason (never reporting a query-level failure
  // per-row) but has the side effect of returning HTTP 200 with every id
  // marked unavailable — exactly the "200s in the logs, blank previews"
  // symptom this was diagnosed from. Confirmed by reproducing the exact
  // broken query directly against the live REST API and getting that same
  // PGRST201 back, not by inspection alone. Splitting into separate
  // queries (matching get-folder-cover-signed-url's own already-working
  // pattern) sidesteps the ambiguity entirely rather than depending on a
  // PostgREST relationship-hint string that would silently break again the
  // next time a new FK is added between these two tables. Still uses the
  // service-role client (bypasses RLS entirely), so canViewItem below is
  // the ONLY authorization boundary here — nothing about any of these
  // queries succeeding implies the caller may view any of these rows.
  const { data: images, error: imagesError } = await client
    .from('collection_item_images')
    .select('id, item_id, storage_path')
    .in('id', imageIds);

  if (imagesError) {
    // A query-level failure must not be reported per-row (that would imply
    // some rows were successfully checked and others weren't) — every
    // requested id fails uniformly.
    return jsonResponse(
      { results: imageIds.map((id) => ({ id, ...UNAVAILABLE })) },
      200,
    );
  }

  const imageRows = (images ?? []) as { id: string; item_id: string; storage_path: string | null }[];

  type ItemRow = { id: string; folder_id: string; is_public: boolean };
  const itemById = new Map<string, ItemRow>();
  const itemIds = [...new Set(imageRows.map((img) => img.item_id))];
  if (itemIds.length) {
    const { data: items } = await client.from('collection_items').select('id, folder_id, is_public').in('id', itemIds);
    for (const it of (items ?? []) as ItemRow[]) {
      itemById.set(it.id, it);
    }
  }

  type FolderRow = { id: string; user_id: string };
  const folderById = new Map<string, FolderRow>();
  const folderIds = [...new Set([...itemById.values()].map((it) => it.folder_id))];
  if (folderIds.length) {
    const { data: folders } = await client.from('folders').select('id, user_id').in('id', folderIds);
    for (const f of (folders ?? []) as FolderRow[]) {
      folderById.set(f.id, f);
    }
  }

  const visibleFolderIds = await resolveVisibleFolderIds(client, folderIds, userId);

  // Grail-slot visibility exception — one batched lookup covering every
  // distinct item this request's images belong to, mirroring the narrow OR
  // branch added to items_select_public/collection_item_images_select_public
  // (supabase/migrations/20260910120000_grail_slot_visibility_exception.sql).
  // Cross-checked against each item's own owner below (gs.user_id vs.
  // folder.user_id) as the same defense-in-depth that migration's policies
  // apply — a slot can never legitimately reference another user's item
  // (profile_grail_slots_insert_own), but this never trusts that
  // structurally alone.
  const grailShowcasedOwnerByItemId = new Map<string, string>();
  if (itemIds.length) {
    const { data: grailRows } = await client
      .from('profile_grail_slots')
      .select('item_id, user_id')
      .eq('entry_type', 'item')
      .in('item_id', itemIds);
    for (const row of (grailRows ?? []) as { item_id: string | null; user_id: string }[]) {
      if (row.item_id) grailShowcasedOwnerByItemId.set(row.item_id, row.user_id);
    }
  }

  const resolved = new Map<string, ResolvedRow>();
  for (const img of imageRows) {
    if (!img.storage_path) continue;
    const item = itemById.get(img.item_id);
    if (!item) continue;
    const folder = folderById.get(item.folder_id);
    if (!folder) continue;
    resolved.set(img.id, {
      id: img.id,
      item_id: img.item_id,
      storage_path: img.storage_path,
      folder_effectively_visible: visibleFolderIds.has(folder.id),
      item_is_public: item.is_public,
      // folders.user_id and collection_items.user_id are always equal for
      // any legitimately-created row (items_insert_own requires the item's
      // owner to already own the target folder) — using the folder's is the
      // established convention here, unchanged from before this pass.
      owner_id: folder.user_id,
      grail_showcased: grailShowcasedOwnerByItemId.get(img.item_id) === folder.user_id,
    });
  }

  const results = await Promise.all(
    imageIds.map(async (id) => {
      const row = resolved.get(id);
      if (!row || !canViewItem(row, userId)) {
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

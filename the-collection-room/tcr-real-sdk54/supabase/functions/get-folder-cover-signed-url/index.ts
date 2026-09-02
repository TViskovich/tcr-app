// Issues short-lived signed URLs for folder covers, enforcing the exact
// same visibility rule as folders_select_public (the migration at
// supabase/migrations/20260819120000_enforce_collection_folder_privacy.sql):
// folders.is_public = true OR authenticated caller id = folders.user_id.
//
// Part of the item-images beta privacy hardening (Phase 3D). item-images
// remains a PUBLIC bucket while this ships — nothing about this function
// makes any existing cover inaccessible, it only proves out the future
// authorized-delivery path for folder covers ahead of the bucket actually
// going private.
//
// Supports fully unauthenticated callers, because a public folder's cover
// must remain viewable by anonymous/public viewers once item-images is
// eventually made private — this function MUST be deployed with
// gateway-level JWT verification disabled (`supabase functions deploy
// get-folder-cover-signed-url --no-verify-jwt`), otherwise the gateway
// itself would reject an anonymous request with 401 before this code ever
// runs. All authorization is instead enforced inside this function, per
// request, below — identical posture to
// get-collection-item-image-signed-url.
//
// A present-but-invalid/expired JWT is rejected outright for the whole
// request (401) — never silently downgraded to an anonymous request.
//
// Request:  POST { folder_ids: string[] }   (1-50 folders.id values; never
//                                             a raw storage_path, item id,
//                                             or owner id)
//           Authorization: Bearer <user JWT>  (optional — sent only when
//                                               the caller has a real
//                                               session; see
//                                               hooks/use-signed-folder-covers.ts,
//                                               same direct-fetch transport
//                                               already validated for
//                                               get-collection-item-image-signed-url)
// Response: { results: Array<
//               { id: string; status: 'ok'; signed_url: string; expires_in: number }
//             | { id: string; status: 'unavailable' }
//           > }
//
// Nonexistent folders and folders the caller isn't authorized to view
// return the exact same per-id { status: 'unavailable' } shape — folder
// existence is never leaked through a distinct response.
//
// Cover resolution (per folder, only after authorization):
//   - cover_source = 'upload'     -> folders.cover_storage_path directly.
//     cover_image_url is NEVER read here — it's a transitional/legacy
//     display value, not a canonical or trusted identifier.
//   - cover_source = 'first_card' -> the folder's own newest active
//     collection_items row (created_at DESC, collection_status = 'active')
//     that the caller is authorized to view, then that item's
//     collection_item_images row where is_primary = true, using ITS
//     storage_path. Never collection_items.image_url, never a
//     caller-supplied item id, never a path copied into/read from
//     folders.cover_storage_path (which stays NULL for first_card by
//     design — see the Phase 3D migration). This means a primary-image
//     change on the newest item is naturally reflected here without any
//     duplicate path state to keep in sync. Same most-restrictive-wins
//     item-privacy rule as 'item' below, not just folder privacy: the
//     folder owner gets the true newest item regardless of its own
//     is_public; any other caller gets the newest item that is ALSO
//     public, skipping over private ones in that same newest-first order
//     (a private item never becomes some other viewer's cover just because
//     it happens to be newest) — never falling further back to a raw
//     collection_items.image_url or any other bypass. A folder whose every
//     active item is private resolves to no cover for a non-owner viewer,
//     the same 'unavailable' outcome as having no items at all.
//   - cover_source = 'item'       -> folders.cover_item_id (owner-picked,
//     not necessarily the newest — see 20260901120000_
//     add_folder_cover_item_id.sql), then that item's own primary gallery
//     image, same as first_card's own item->image_id resolution. Unlike
//     first_card, this additionally requires the picked item's own
//     is_public flag for any non-owner caller (most-restrictive-wins,
//     matching collection_items privacy — see 20260825120000_
//     add_collection_item_privacy.sql): a folder owner can feature a
//     private item as their own hero, but a public folder does not expose
//     that private item's image to anyone else through this path. A null
//     cover_item_id (e.g. the referenced item was since deleted — ON
//     DELETE SET NULL) resolves to 'unavailable', not a silent fallback to
//     first_card.
// Any folder with no resolvable cover (no cover_storage_path, no
// cover_item_id, no active items, no PUBLIC active item for a non-owner
// caller, no primary gallery image, or a signing failure) resolves to the
// same 'unavailable' outcome as an unauthorized one.

import {
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
  validateItemImagesStoragePath,
} from '../_shared/registry-image.ts';

const SIGNED_URL_TTL_SECONDS = 300;
const MAX_BATCH_SIZE = 50;
const UNAVAILABLE = { status: 'unavailable' as const };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolvedFolder = {
  id: string;
  is_public: boolean;
  user_id: string;
  cover_source: string;
  cover_storage_path: string | null;
  cover_item_id: string | null;
};

// Mirrors folders_select_public / items_select_public's exact condition —
// deliberately re-implemented here rather than shared with the database
// layer, matching this app's established per-module RLS-mirroring
// convention (see canViewFolder in get-collection-item-image-signed-url,
// canViewRegisteredCard in ../_shared/registry-image.ts).
function canViewFolder(row: { is_public: boolean; user_id: string }, callerId: string | null): boolean {
  if (row.is_public) return true;
  return callerId !== null && callerId === row.user_id;
}

// Shared by both item-privacy checks below ('item' and, as of this pass,
// 'first_card') — the folder owner's override for "may see a private item
// used as their own cover regardless of its own is_public." Not a change
// to what either path resolves to, just the one place that condition is
// now written instead of being duplicated inline a second time.
function isOwnerCaller(folder: { user_id: string }, callerId: string | null): boolean {
  return callerId !== null && callerId === folder.user_id;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: { folder_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  // Strict input-shape validation, rejecting the whole request rather than
  // silently dropping/coercing bad entries — folder_ids is the only
  // identifier this function ever accepts, and every entry must already
  // look like a folders.id (a UUID).
  const folderIds = body.folder_ids;
  if (
    !Array.isArray(folderIds) ||
    folderIds.length === 0 ||
    folderIds.length > MAX_BATCH_SIZE ||
    !folderIds.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))
  ) {
    return jsonResponse({ error: 'invalid_folder_ids' }, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  // Uses the service-role client (bypasses RLS entirely), so canViewFolder
  // below is the ONLY authorization boundary here — nothing about this
  // query's success implies the caller may view any of these rows.
  const { data: folders, error: foldersError } = await client
    .from('folders')
    .select('id, is_public, user_id, cover_source, cover_storage_path, cover_item_id')
    .in('id', folderIds);

  if (foldersError) {
    // A query-level failure must not be reported per-row (that would imply
    // some rows were successfully checked and others weren't) — every
    // requested id fails uniformly.
    return jsonResponse(
      { results: folderIds.map((id) => ({ id, ...UNAVAILABLE })) },
      200,
    );
  }

  const folderMap = new Map<string, ResolvedFolder>();
  for (const f of (folders ?? []) as ResolvedFolder[]) {
    folderMap.set(f.id, f);
  }

  const authorizedIds = folderIds.filter((id) => {
    const f = folderMap.get(id);
    return !!f && canViewFolder(f, userId);
  });

  const uploadIds = authorizedIds.filter((id) => folderMap.get(id)!.cover_source === 'upload');
  const itemIds = authorizedIds.filter(
    (id) => folderMap.get(id)!.cover_source === 'item' && !!folderMap.get(id)!.cover_item_id,
  );
  const firstCardIds = authorizedIds.filter(
    (id) => folderMap.get(id)!.cover_source !== 'upload' && folderMap.get(id)!.cover_source !== 'item',
  );

  const folderToStoragePath = new Map<string, string>();

  for (const id of uploadIds) {
    const path = folderMap.get(id)!.cover_storage_path;
    if (path) folderToStoragePath.set(id, path);
  }

  // The folder -> candidate item id map this cover ultimately resolves
  // through, for BOTH item and first_card folders combined — populated
  // below, then resolved to a primary gallery image via one shared
  // collection_item_images lookup (never two separate ones for the two
  // sources).
  const candidateItemByFolder = new Map<string, string>();

  // 'item' — the owner-picked item (folders.cover_item_id), not
  // necessarily the newest. Requires the item's own is_public for any
  // non-owner caller (most-restrictive-wins — see this function's own
  // module comment above); the folder owner sees their own picked item
  // regardless of its privacy flag, same override pattern as
  // canViewFolder.
  if (itemIds.length) {
    const pickedItemIds = itemIds.map((id) => folderMap.get(id)!.cover_item_id!);
    const { data: pickedItems } = await client
      .from('collection_items')
      .select('id, is_public')
      .in('id', pickedItemIds);

    const pickedItemById = new Map<string, { is_public: boolean }>();
    for (const item of (pickedItems ?? []) as { id: string; is_public: boolean }[]) {
      pickedItemById.set(item.id, item);
    }

    for (const folderId of itemIds) {
      const folder = folderMap.get(folderId)!;
      const item = pickedItemById.get(folder.cover_item_id!);
      if (!item) continue; // referenced item no longer exists/resolvable
      if (!item.is_public && !isOwnerCaller(folder, userId)) continue; // most-restrictive-wins
      candidateItemByFolder.set(folderId, folder.cover_item_id!);
    }
  }

  // 'first_card' — the folder's own newest active item the caller is
  // authorized to view. The owner gets the true newest item, full stop
  // (same override as everywhere else in this function). A non-owner gets
  // the newest item that is ALSO public — never simply the newest
  // regardless of its own privacy, which was this path's pre-existing gap
  // (item privacy added after first_card resolution originally shipped,
  // and this path was never updated to check it). Deterministic and
  // requires no extra query: items already come back ordered newest-first,
  // so "skip private ones for a non-owner" is just a linear scan of that
  // same list, taking the first (owner) or first-public (non-owner) match
  // per folder — never a second, differently-ordered query.
  if (firstCardIds.length) {
    const { data: items } = await client
      .from('collection_items')
      .select('id, folder_id, is_public')
      .eq('collection_status', 'active')
      .in('folder_id', firstCardIds)
      .order('created_at', { ascending: false });

    for (const item of (items ?? []) as { id: string; folder_id: string; is_public: boolean }[]) {
      if (candidateItemByFolder.has(item.folder_id)) continue; // already resolved this folder
      const folder = folderMap.get(item.folder_id)!;
      if (!item.is_public && !isOwnerCaller(folder, userId)) continue; // most-restrictive-wins
      candidateItemByFolder.set(item.folder_id, item.id);
    }
  }

  // One shared batched lookup for every candidate item's primary gallery
  // image, covering both 'item' and 'first_card' folders together — never
  // one query per source type, never one per folder.
  if (candidateItemByFolder.size) {
    const candidateItemIds = [...new Set(candidateItemByFolder.values())];
    const { data: images } = await client
      .from('collection_item_images')
      .select('item_id, storage_path')
      .eq('is_primary', true)
      .in('item_id', candidateItemIds);

    const storagePathByItem = new Map<string, string>();
    for (const img of (images ?? []) as { item_id: string; storage_path: string | null }[]) {
      if (img.storage_path) storagePathByItem.set(img.item_id, img.storage_path);
    }

    for (const [folderId, itemId] of candidateItemByFolder) {
      const path = storagePathByItem.get(itemId);
      if (path) folderToStoragePath.set(folderId, path);
    }
  }

  const results = await Promise.all(
    folderIds.map(async (id) => {
      const storagePath = folderToStoragePath.get(id);
      if (!storagePath) return { id, ...UNAVAILABLE };

      const validPath = validateItemImagesStoragePath(storagePath);
      if (!validPath) return { id, ...UNAVAILABLE };

      const { data: signed, error: signError } = await client.storage
        .from('item-images')
        .createSignedUrl(validPath, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) return { id, ...UNAVAILABLE };

      return { id, status: 'ok' as const, signed_url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS };
    }),
  );

  return jsonResponse({ results }, 200);
});

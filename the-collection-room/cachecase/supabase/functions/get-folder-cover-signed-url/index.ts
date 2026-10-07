// Issues short-lived signed URLs for folder covers, enforcing the exact
// same visibility rule as folders_select_public (now the recursive,
// ancestor-aware check added by supabase/migrations/
// 20260902120000_recursive_folder_hierarchy_privacy.sql's
// folder_is_effectively_visible(): a folder is visible to a non-owner only
// if it AND every ancestor up to the root are public; the owner of the
// folder sees it regardless of any ancestor's privacy). Resolved via one
// batched call to that migration's folder_effective_visibility_batch() RPC
// rather than a second, independently-maintained traversal here.
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
// Request:  POST { folder_ids: string[]; tier?: 'preview' | 'detail' | 'original' }
//           folder_ids: 1-50 folders.id values (never a raw storage_path,
//                       item id, or owner id). tier: optional server-approved
//                       transform name (../_shared/image-tiers.ts); omitted =
//                       'original', identical to the pre-tier behavior.
//           Authorization: Bearer <user JWT>  (optional — sent only when
//                                               the caller has a real
//                                               session; see
//                                               hooks/use-signed-folder-covers.ts,
//                                               same direct-fetch transport
//                                               already validated for
//                                               get-collection-item-image-signed-url)
// Response: { results: Array<
//               { id: string; status: 'ok'; signed_url: string; expires_in: number; tier: ImageTier;
//                 image_token?: string }
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
import { IMAGE_TIER_TRANSFORMS, parseImageTier, type ImageTier } from '../_shared/image-tiers.ts';

const SIGNED_URL_TTL_SECONDS = 300;

// image_token — an opaque, stable identity for the image a cover resolves
// to, so the client can key its byte cache on it (lib/private-image-cache-
// key.ts's folderCoverCacheKey) instead of on the signed URL, which rotates
// every SIGNED_URL_TTL_SECONDS. Matters most for 'first_card' covers, whose
// folders row carries no client-visible signal of WHICH image is resolved.
//
// HMAC-SHA256 of the resolved storage path, keyed with a server-only secret
// (derived from the service-role key, never sent anywhere) and truncated to
// 128 bits. Same image -> same token across every re-sign; a different
// resolved image (new first card, new primary image, new upload — each
// always a distinct storage path) -> a different token. It reveals nothing
// about the path, item, or owner and can't be reversed or precomputed
// without the key; at most it tells a caller that two covers THEY are
// already authorized to see are the same image. Only ever computed for an
// authorized, resolved cover — never for an 'unavailable' one. Omitted if
// the key material is somehow unavailable (clients then fall back to
// URL-keyed caching, exactly as before).
const IMAGE_TOKEN_SECRET = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
let imageTokenKey: Promise<CryptoKey> | null = null;

async function imageTokenFor(storagePath: string): Promise<string | undefined> {
  if (!IMAGE_TOKEN_SECRET) return undefined;
  try {
    imageTokenKey ??= crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(`folder-cover-image-token:v1:${IMAGE_TOKEN_SECRET}`),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', await imageTokenKey, new TextEncoder().encode(storagePath)),
    );
    return Array.from(mac.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}
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
  // Embedded picked cover item (folders_cover_item_id_fkey) with its primary
  // image's path (primary filtered to is_primary) — null when unset/deleted.
  cover_item: { id: string; is_public: boolean; primary: { storage_path: string | null }[] | null } | null;
};

type FirstCardRow = {
  id: string;
  folder_id: string;
  is_public: boolean;
  primary: { storage_path: string | null }[] | null;
};

// The user id a bearer token CLAIMS (its JWT `sub`), decoded without
// verification — used only to start the visibility RPC before verification
// finishes, and only ever trusted if resolveCaller then verifies that exact
// id (see the handler). null for no/malformed token, which is also correct
// speculation for an anonymous caller.
function unverifiedTokenSubject(req: Request): string | null {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && UUID_RE.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

// Ancestor-aware folder visibility — delegates to the recursive
// folder_effective_visibility_batch() RPC (supabase/migrations/
// 20260902120000_recursive_folder_hierarchy_privacy.sql) rather than
// re-implementing a parent_folder_id walk here. One batched call per
// request (up to MAX_BATCH_SIZE ids), not one round trip per folder. This
// runs via the service-role client, so the RPC's own SECURITY DEFINER
// helper is what actually authorizes each id — nothing about this
// function's own role bypasses or replaces that.
async function resolveVisibleFolderIds(
  client: ReturnType<typeof serviceRoleClient>,
  folderIds: string[],
  callerId: string | null,
): Promise<Set<string>> {
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

  let body: { folder_ids?: unknown; tier?: unknown };
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

  // Optional tier NAME (never a raw width/quality) — same parsing and
  // server-approved transforms as get-collection-item-image-signed-url.
  // Omitted = 'original', identical to the pre-tier behavior.
  const tier: ImageTier | null = parseImageTier(body.tier);
  if (tier === null) {
    return jsonResponse({ error: 'invalid_tier' }, 400);
  }

  const client = serviceRoleClient();

  // Request latency is dominated by sequential round trips from this
  // function (each ~150-250ms measured: auth verification, PostgREST,
  // Storage), so everything that doesn't truly depend on an earlier result
  // runs in ONE first stage:
  //   - caller verification (auth.getUser — a network call for a signed-in
  //     caller);
  //   - the folders read, with each folder's picked cover item AND that
  //     item's primary-image path embedded (no separate picked-item or
  //     image lookups for 'item' covers);
  //   - the ancestor-aware visibility RPC, started SPECULATIVELY for the
  //     caller id the bearer token claims (decoded, not yet verified). Its
  //     result is used only if verification confirms that exact id;
  //     otherwise it is re-run for the verified id below. So authorization
  //     is always decided for the VERIFIED caller — the speculation only
  //     saves waiting for verification first;
  //   - the Grail-slot exception rows (depend only on the requested ids).
  // Every read here is service-role and feeds server-side resolution only;
  // nothing about any row is returned unless the authorization checks after
  // this stage pass.
  const speculativeCallerId = unverifiedTokenSubject(req);
  const [caller, { data: folders, error: foldersError }, speculativeVisibleIds, grailRows] = await Promise.all([
    resolveCaller(client, req),
    client
      .from('folders')
      .select(
        'id, is_public, user_id, cover_source, cover_storage_path, cover_item_id, ' +
          'cover_item:collection_items!folders_cover_item_id_fkey(id, is_public, primary:collection_item_images(storage_path))',
      )
      .in('id', folderIds)
      .eq('cover_item.primary.is_primary', true),
    resolveVisibleFolderIds(client, folderIds, speculativeCallerId),
    // Grail-slot visibility exception ("Grail placement = implicit
    // publish" — supabase/migrations/20260910120000_grail_slot_visibility_
    // exception.sql): a folder referenced by its own owner's
    // entry_type='collection' profile_grail_slots row authorizes resolving
    // THAT folder's cover, independent of folder_effective_visibility_batch's
    // normal ancestor-chain result. Scoped to the exact folder id only, and
    // cross-checked against the folder's own owner below.
    client
      .from('profile_grail_slots')
      .select('collection_id, user_id')
      .eq('entry_type', 'collection')
      .in('collection_id', folderIds)
      .then(({ data }) => (data ?? []) as { collection_id: string | null; user_id: string }[]),
  ]);

  const { userId, invalid } = caller;
  if (invalid) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  if (foldersError) {
    // A query-level failure must not be reported per-row (that would imply
    // some rows were successfully checked and others weren't) — every
    // requested id fails uniformly.
    return jsonResponse(
      { results: folderIds.map((id) => ({ id, ...UNAVAILABLE })) },
      200,
    );
  }

  // Speculation check: only a result computed for the verified caller id is
  // ever used.
  const visibleFolderIds =
    speculativeCallerId === userId
      ? speculativeVisibleIds
      : await resolveVisibleFolderIds(client, folderIds, userId);

  const folderMap = new Map<string, ResolvedFolder>();
  for (const f of (folders ?? []) as ResolvedFolder[]) {
    folderMap.set(f.id, f);
  }

  const grailShowcasedFolderIds = new Set<string>();
  for (const row of grailRows) {
    if (!row.collection_id) continue;
    const folder = folderMap.get(row.collection_id);
    if (folder && folder.user_id === row.user_id) grailShowcasedFolderIds.add(row.collection_id);
  }

  const authorizedIds = folderIds.filter(
    (id) => folderMap.has(id) && (visibleFolderIds.has(id) || grailShowcasedFolderIds.has(id)),
  );

  // A folder can be internally inconsistent — cover_source claims a
  // specific explicit cover but the field that source actually needs is
  // missing (cover_source: 'upload' with no cover_storage_path;
  // cover_source: 'item' with no cover_item_id). This has always been
  // reachable — folders.cover_source is `NOT NULL DEFAULT 'upload'` at the
  // DB level, and until create-folder-modal.tsx started setting it
  // explicitly, every newly-created folder silently inherited that default
  // with no real upload behind it. Anything claiming 'upload' or 'item'
  // without its backing reference falls through to first-card resolution
  // instead of resolving to 'unavailable' — the exact same newest-active-
  // item resolution every genuine 'first_card' folder uses, not a new
  // fallback path.
  const isUpload = (id: string) =>
    folderMap.get(id)!.cover_source === 'upload' && !!folderMap.get(id)!.cover_storage_path;
  const isPickedItem = (id: string) =>
    folderMap.get(id)!.cover_source === 'item' && !!folderMap.get(id)!.cover_item_id;
  const uploadIds = authorizedIds.filter(isUpload);
  const itemIds = authorizedIds.filter(isPickedItem);
  const firstCardIds = authorizedIds.filter((id) => !isUpload(id) && !isPickedItem(id));

  const folderToStoragePath = new Map<string, string>();

  for (const id of uploadIds) {
    const path = folderMap.get(id)!.cover_storage_path;
    if (path) folderToStoragePath.set(id, path);
  }

  // 'item' — the owner-picked item (folders.cover_item_id), not
  // necessarily the newest, already embedded with its primary-image path.
  // Requires the item's own is_public for any non-owner caller
  // (most-restrictive-wins); the folder owner sees their own picked item
  // regardless of its privacy flag. A missing embed (item deleted) or no
  // primary image resolves to no cover, as before.
  for (const folderId of itemIds) {
    const folder = folderMap.get(folderId)!;
    const item = folder.cover_item;
    if (!item) continue; // referenced item no longer exists/resolvable
    if (!item.is_public && !isOwnerCaller(folder, userId)) continue; // most-restrictive-wins
    const path = item.primary?.[0]?.storage_path;
    if (path) folderToStoragePath.set(folderId, path);
  }

  // 'first_card' — the folder's own newest active item the caller is
  // authorized to view: the owner gets the true newest item; a non-owner
  // gets the newest item that is ALSO public. One query, only for AUTHORIZED
  // first-card folders, with each item's primary-image path embedded (no
  // separate image lookup). Items arrive newest-first, so this is a linear
  // scan taking the first (owner) or first-public (non-owner) match per
  // folder — semantics unchanged.
  if (firstCardIds.length) {
    const { data: items } = await client
      .from('collection_items')
      .select('id, folder_id, is_public, primary:collection_item_images(storage_path)')
      .eq('collection_status', 'active')
      .in('folder_id', firstCardIds)
      .eq('primary.is_primary', true)
      .order('created_at', { ascending: false });

    const resolvedFirstCard = new Set<string>();
    for (const item of (items ?? []) as FirstCardRow[]) {
      if (resolvedFirstCard.has(item.folder_id)) continue; // already resolved this folder
      const folder = folderMap.get(item.folder_id)!;
      if (!item.is_public && !isOwnerCaller(folder, userId)) continue; // most-restrictive-wins
      resolvedFirstCard.add(item.folder_id);
      const path = item.primary?.[0]?.storage_path;
      if (path) folderToStoragePath.set(item.folder_id, path);
    }
  }

  // Signing — only for authorized, resolved paths. A non-original tier is
  // applied purely at this final step (same transform, same fallback as
  // get-collection-item-image-signed-url): if transformed signing fails,
  // fall back once to the untransformed URL and report what was actually
  // served in `tier`.
  const results = await Promise.all(
    folderIds.map(async (id) => {
      const storagePath = folderToStoragePath.get(id);
      if (!storagePath) return { id, ...UNAVAILABLE };

      const validPath = validateItemImagesStoragePath(storagePath);
      if (!validPath) return { id, ...UNAVAILABLE };

      // Same token for every tier of the same image — the client adds the
      // tier to its cache key itself.
      const imageToken = await imageTokenFor(validPath);

      if (tier !== 'original') {
        const { data: transformed, error: transformError } = await client.storage
          .from('item-images')
          .createSignedUrl(validPath, SIGNED_URL_TTL_SECONDS, {
            transform: IMAGE_TIER_TRANSFORMS[tier],
          });
        if (!transformError && transformed?.signedUrl) {
          return {
            id,
            status: 'ok' as const,
            signed_url: transformed.signedUrl,
            expires_in: SIGNED_URL_TTL_SECONDS,
            tier,
            ...(imageToken ? { image_token: imageToken } : {}),
          };
        }
      }

      const { data: signed, error: signError } = await client.storage
        .from('item-images')
        .createSignedUrl(validPath, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) return { id, ...UNAVAILABLE };

      return {
        id,
        status: 'ok' as const,
        signed_url: signed.signedUrl,
        expires_in: SIGNED_URL_TTL_SECONDS,
        tier: 'original' as const,
        ...(imageToken ? { image_token: imageToken } : {}),
      };
    }),
  );

  return jsonResponse({ results }, 200);
});

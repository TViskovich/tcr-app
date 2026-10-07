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
// Every fact canViewItem needs (storage path, owner, item privacy, folder
// visibility, Grail showcase) comes from ONE service-role call to
// resolve_item_images_for_signing() (supabase/migrations/
// 20261011120000_add_resolve_item_images_for_signing.sql), whose folder leg
// reuses _folder_is_effectively_visible_for() rather than a second,
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
// Request:  POST { image_ids: string[]; tier?: 'preview' | 'detail' | 'original' }
//                                           (1-50 collection_item_images.id
//                                            values; never a raw storage_path,
//                                            item id, folder id, or owner id.
//                                            `tier` is optional, defaults to
//                                            'original' — see below.)
//           Authorization: Bearer <user JWT>  (optional)
// Response: { results: Array<
//               { id: string; status: 'ok'; signed_url: string; expires_in: number; tier: ImageTier }
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
// Tiered delivery: `tier` selects a server-approved Storage image transform
// (see ../_shared/image-tiers.ts — clients send a tier NAME only, never
// arbitrary width/quality). The transform is applied purely at the final
// createSignedUrl step, AFTER canViewItem has already authorized the row, so
// a transformed URL is exactly as private as the original signed URL (same
// private bucket, same 300s token, same authorization decision). If the
// transformed signing fails (e.g. transformations unavailable), it falls back
// to the ordinary original signed URL for that same already-authorized row —
// one fallback attempt, no retry loop — and the result's `tier` reports what
// was ACTUALLY served ('original' on fallback). Omitting `tier` is identical
// to the pre-tier behavior.
//
// storage_path itself is never included in the response — only the signed
// URL the client actually needs to render the image.

import { IMAGE_TIER_TRANSFORMS, parseImageTier, type ImageTier } from '../_shared/image-tiers.ts';
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
  // the same owner — resolved by resolve_item_images_for_signing, mirroring the
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
// (folder_effectively_visible) comes from the recursive
// _folder_is_effectively_visible_for() (supabase/migrations/
// 20260902120000_recursive_folder_hierarchy_privacy.sql), evaluated by
// resolve_item_images_for_signing with caller NULL — this function only
// consults it after its own owner check has failed (caller != owner), where
// that function's answer doesn't depend on the caller, so the rule is
// unchanged. This function only combines that result with the item's own
// privacy flag and the Grail exception, matching this app's established
// per-module RLS-mirroring convention (see canViewRegisteredCard in
// ../_shared/registry-image.ts).
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

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  let body: { image_ids?: unknown; tier?: unknown };
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

  const tier: ImageTier | null = parseImageTier(body.tier);
  if (tier === null) {
    return jsonResponse({ error: 'invalid_tier' }, 400);
  }

  const client = serviceRoleClient();

  // Two independent server calls, run concurrently: resolving the caller's
  // token, and ONE set-based lookup of every fact canViewItem needs for every
  // requested image (resolve_item_images_for_signing — see its migration).
  // That lookup is caller-independent, which is what lets it run alongside
  // the token check instead of after it. This replaced a chain of separate
  // lookups (image rows -> items + grail slots -> folders + folder
  // visibility). Still the service-role client (bypasses RLS entirely), so
  // canViewItem below remains the ONLY authorization boundary — nothing about
  // a row being returned implies the caller may view it. An invalid token is
  // still rejected with 401 before anything is returned.
  const [{ userId, invalid }, { data: rows, error: lookupError }] = await Promise.all([
    resolveCaller(client, req),
    client.rpc('resolve_item_images_for_signing', { p_image_ids: imageIds }),
  ]);
  if (invalid) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  if (lookupError) {
    // A query-level failure must not be reported per-row (that would imply
    // some rows were successfully checked and others weren't) — every
    // requested id fails uniformly.
    return jsonResponse(
      { results: imageIds.map((id) => ({ id, ...UNAVAILABLE })) },
      200,
    );
  }

  // Images whose item or folder no longer exists have no row, and are
  // reported unavailable below — same as before.
  const resolved = new Map<string, ResolvedRow>();
  for (const row of (rows ?? []) as {
    image_id: string;
    item_id: string;
    storage_path: string | null;
    owner_id: string;
    item_is_public: boolean;
    folder_effectively_visible: boolean;
    grail_showcased: boolean;
  }[]) {
    if (!row.storage_path) continue;
    resolved.set(row.image_id, {
      id: row.image_id,
      item_id: row.item_id,
      storage_path: row.storage_path,
      folder_effectively_visible: row.folder_effectively_visible === true,
      item_is_public: row.item_is_public === true,
      // folders.user_id — the established owner convention here (folders.
      // user_id and collection_items.user_id are always equal for any
      // legitimately-created row; items_insert_own requires it).
      owner_id: row.owner_id,
      grail_showcased: row.grail_showcased === true,
    });
  }

  const results = await Promise.all(
    imageIds.map(async (id) => {
      const row = resolved.get(id);
      if (!row || !canViewItem(row, userId)) {
        return { id, ...UNAVAILABLE };
      }

      if (tier !== 'original') {
        const { data: transformed, error: transformError } = await client.storage
          .from('item-images')
          .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS, {
            transform: IMAGE_TIER_TRANSFORMS[tier],
          });
        if (!transformError && transformed?.signedUrl) {
          return {
            id,
            status: 'ok' as const,
            signed_url: transformed.signedUrl,
            expires_in: SIGNED_URL_TTL_SECONDS,
            tier,
          };
        }
        // Fall through to the untransformed signed URL below — row is
        // already authorized above; this only changes which bytes are served.
      }

      const { data: signed, error: signError } = await client.storage
        .from('item-images')
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) {
        return { id, ...UNAVAILABLE };
      }

      return {
        id,
        status: 'ok' as const,
        signed_url: signed.signedUrl,
        expires_in: SIGNED_URL_TTL_SECONDS,
        tier: 'original' as const,
      };
    }),
  );

  return jsonResponse({ results }, 200);
});

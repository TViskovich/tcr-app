// Public item sharing — Phase 1: the single, narrow read surface for the
// future public item page at https://<public-domain>/item/<id> and its link
// preview image (a separate web deployment, like the public registry —
// not this Expo app's own app/item/[id].tsx route).
//
// Fully anonymous by design, matching get-public-registry-card: no
// Authorization header is expected or inspected, and every visitor gets the
// same answer — there is no owner branch. Deployed with gateway JWT
// verification disabled
// (`supabase functions deploy get-public-item-share --no-verify-jwt`).
//
// Request:  POST { item_id: string }
// Response: 200 { status: 'ok', data: PublicItemShare } | 200 { status: 'not_found' }
//         | 503 { status: 'unavailable' }  (lookup failed — says nothing about the item)
//
// Request:  POST { item_id: string, asset: 'preview_image' }
// Response: 200 <image bytes, image/jpeg | image/png | image/webp> | 404 (empty body)
//
// Authorization is resolve_public_item_share() (supabase/migrations/
// 20261031120000_add_resolve_public_item_share.sql): it returns a row only
// for an active, public item whose folder and every ancestor folder are
// public — never a private, Grail-only, transferred-out or deleted item.
// This function runs as service_role but reads item data ONLY through that
// RPC, so it can never see an item the RPC refused. A private item, a
// nonexistent item and a deleted item all get the identical not_found (or
// 404 for the image).
//
// The image is streamed through this function rather than returned as a
// signed URL: a signed URL's path IS the storage path ({userId}/...), which
// must never leave the server. Only the server-approved 'preview' transform
// (../_shared/image-tiers.ts) is served. Every image failure — no image,
// HEIC original, transform/sign/download failure — is the same 404, and the
// page shows its placeholder.
//
// Never returned: storage paths, signed URLs, user/folder/image ids,
// description, estimated value, serial number, grading, purchase price, or
// any registry data.

import { IMAGE_TIER_TRANSFORMS } from '../_shared/image-tiers.ts';
import {
  CORS_HEADERS,
  handleCorsPreflight,
  serviceRoleClient,
  validateItemImagesStoragePath,
} from '../_shared/registry-image.ts';
import {
  MAX_SHARE_IMAGE_BYTES,
  parseShareRequest,
  shareableImageType,
  toPublicItemShare,
  type ResolvedShareRow,
} from './share.ts';

// Only long enough for this function's own server-side fetch below.
const SIGNED_URL_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8000;

// The page layer decides its own caching; nothing in front of this function
// may keep a copy past a privacy change.
const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...NO_STORE, 'Content-Type': 'application/json' },
  });
}

function notFoundImage(): Response {
  return new Response(null, { status: 404, headers: { ...CORS_HEADERS, ...NO_STORE } });
}

async function previewImage(
  client: ReturnType<typeof serviceRoleClient>,
  storagePath: string,
): Promise<Response> {
  const { data: signed, error: signError } = await client.storage
    .from('item-images')
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { transform: IMAGE_TIER_TRANSFORMS.preview });
  if (signError || !signed?.signedUrl) return notFoundImage();

  let upstream: Response;
  try {
    upstream = await fetch(signed.signedUrl, {
      headers: { Accept: 'image/webp, image/jpeg, image/png' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return notFoundImage();
  }

  // Validated by the actual Content-Type only, never the path's extension.
  const mime = shareableImageType(upstream.headers.get('Content-Type'));
  const declaredLength = Number(upstream.headers.get('Content-Length') ?? '0');
  if (!upstream.ok || !mime || declaredLength > MAX_SHARE_IMAGE_BYTES) {
    await upstream.body?.cancel();
    return notFoundImage();
  }

  const bytes = await upstream.arrayBuffer().catch(() => null);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SHARE_IMAGE_BYTES) return notFoundImage();

  return new Response(bytes, {
    status: 200,
    headers: { ...CORS_HEADERS, ...NO_STORE, 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' },
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return json({ status: 'not_found' }, 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ status: 'not_found' }, 400);
  }

  const request = parseShareRequest(body);
  if (!request) {
    return json({ status: 'not_found' }, 400);
  }

  const client = serviceRoleClient();
  const { data: rows, error } = await client.rpc('resolve_public_item_share', { p_item_id: request.itemId });

  if (error) {
    if (request.asset === 'preview_image') return notFoundImage();
    return json({ status: 'unavailable' }, 503);
  }

  const row = ((rows ?? []) as ResolvedShareRow[])[0];
  // A database value is still validated before any Storage call.
  const storagePath = row?.image_storage_path ? validateItemImagesStoragePath(row.image_storage_path) : null;

  if (request.asset === 'preview_image') {
    return row && storagePath ? previewImage(client, storagePath) : notFoundImage();
  }

  if (!row) {
    return json({ status: 'not_found' }, 200);
  }

  return json({ status: 'ok', data: toPublicItemShare(row, storagePath !== null) }, 200);
});

// Issues a short-lived signed URL for a registered card's durable registry
// image, enforcing the exact same visibility rule as
// registered_cards_select_visible (visibility='public' OR
// current_owner_id=caller OR created_by=caller).
//
// Supports fully unauthenticated callers for public records. This
// function MUST be deployed with gateway-level JWT verification disabled
// (`supabase functions deploy get-registry-snapshot-image-url
// --no-verify-jwt`) — otherwise the gateway itself would reject an
// anonymous request with 401 before this code ever runs, breaking public
// registry access entirely. All authorization is instead enforced inside
// this function, per request, below.
//
// Request:  POST { registered_card_id: string }
//           Authorization: Bearer <user JWT>  (optional)
// Response: { status: 'ok', signed_url: string, expires_in: number }
//         | { status: 'unavailable' }
//
// Private records, nonexistent records, and records the caller isn't
// authorized to view all return the exact same { status: 'unavailable' }
// shape — record existence is never leaked through a distinct response.
//
// A present-but-invalid/expired JWT is rejected outright (401) — it is
// never silently downgraded to an anonymous request, per the approved
// design (an attacker presenting a stale/tampered token should not get a
// second, quieter chance at anonymous-only access in the same call).

import {
  canViewRegisteredCard,
  handleCorsPreflight,
  jsonResponse,
  resolveCaller,
  serviceRoleClient,
} from '../_shared/registry-image.ts';

const SIGNED_URL_TTL_SECONDS = 300;
const UNAVAILABLE = { status: 'unavailable' as const };

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse(UNAVAILABLE, 405);
  }

  let body: { registered_card_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(UNAVAILABLE, 400);
  }

  const registeredCardId = typeof body.registered_card_id === 'string' ? body.registered_card_id : null;
  if (!registeredCardId) {
    return jsonResponse(UNAVAILABLE, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid) {
    return jsonResponse(UNAVAILABLE, 401);
  }

  const { data: card, error: cardError } = await client
    .from('registered_cards')
    .select('visibility, current_owner_id, created_by, snapshot_image_status, snapshot_image_storage_path')
    .eq('id', registeredCardId)
    .maybeSingle();

  if (cardError || !card) {
    return jsonResponse(UNAVAILABLE, 200);
  }

  if (!canViewRegisteredCard(card, userId)) {
    return jsonResponse(UNAVAILABLE, 200);
  }

  if (card.snapshot_image_status !== 'ready' || !card.snapshot_image_storage_path) {
    return jsonResponse(UNAVAILABLE, 200);
  }

  const { data: signed, error: signError } = await client.storage
    .from('registry-images')
    .createSignedUrl(card.snapshot_image_storage_path as string, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return jsonResponse(UNAVAILABLE, 200);
  }

  return jsonResponse({ status: 'ok', signed_url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS }, 200);
});

// Copies a registered card's linked collection item's primary image into
// the private registry-images bucket, so the certificate's image survives
// ownership transfers (collection_item_id clearing), the linked item being
// edited, and the former owner later deleting their own copy of the photo.
//
// Request:  POST { registered_card_id: string }
//           Authorization: Bearer <user JWT>  (required — no anonymous case)
// Response: { status: 'ready' }
//         | { status: 'failed', error_code?: SnapshotImageErrorCode }
//
// The request body accepts ONLY registered_card_id — no URL, source path,
// destination path, bucket name, user id, or filename. Every storage path
// used below is derived entirely from server-side database rows, gated by
// the caller's own verified identity, never from client input, and never
// trusted without validation even when it came from the database (see
// validateItemImagesStoragePath).
//
// Deployed with default JWT verification ON (gateway rejects a missing or
// malformed Authorization header before this code even runs) — see the
// deployment command in the migration/deploy notes. This function's own
// resolveCaller() check is still kept as defense in depth.
//
// Every write to registered_cards below (both the failure path and the
// success path) is conditioned on id + current_owner_id + collection_item_id
// still matching what was captured for this specific request — never on id
// alone — so a stale in-flight request can never overwrite state belonging
// to a different (now-current) owner or a since-changed linkage. Where that
// three-part condition can't yet be safely constructed (before a valid
// caller identity and the card's original collection_item_id are both
// captured), no database write is attempted at all — see respondFailed vs
// writeFailedState below.

import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  handleCorsPreflight,
  jsonResponse,
  parseItemImagesStoragePath,
  resolveCaller,
  serviceRoleClient,
  validateItemImagesStoragePath,
  type SnapshotImageErrorCode,
} from '../_shared/registry-image.ts';

type ServiceClient = ReturnType<typeof serviceRoleClient>;

// No database write. Used for every precondition failure where the
// necessary authorization state (a confirmed userId AND the originally
// captured collection_item_id) has not yet been established, and for the
// state_changed/database_update_failed branches where a write is
// deliberately skipped because the row's true current state can no longer
// be safely inferred. error_code is omitted from the response itself when
// the failure occurs before any registered_card_id-scoped context exists.
function respondFailed(code: SnapshotImageErrorCode | undefined, httpStatus: number): Response {
  return jsonResponse(code ? { status: 'failed', error_code: code } : { status: 'failed' }, httpStatus);
}

// The ONLY function in this file that writes failure state to
// registered_cards. Requires the authenticated caller's own userId AND the
// collection_item_id captured before any network I/O — both re-asserted in
// the WHERE clause, identical in shape to the ready-path update below, so a
// stale in-flight request can never write onto a row whose ownership or
// linkage has since changed.
async function writeFailedState(
  client: ServiceClient,
  registeredCardId: string,
  userId: string,
  originalCollectionItemId: string,
  code: SnapshotImageErrorCode,
  httpStatus: number,
): Promise<Response> {
  await client
    .from('registered_cards')
    .update({
      snapshot_image_status: 'failed',
      snapshot_image_error_code: code,
      snapshot_image_updated_at: new Date().toISOString(),
    })
    .eq('id', registeredCardId)
    .eq('current_owner_id', userId)
    .eq('collection_item_id', originalCollectionItemId);
  return respondFailed(code, httpStatus);
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return respondFailed(undefined, 405);
  }

  let body: { registered_card_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return respondFailed(undefined, 400);
  }

  const registeredCardId = typeof body.registered_card_id === 'string' ? body.registered_card_id : null;
  if (!registeredCardId) {
    return respondFailed(undefined, 400);
  }

  const client = serviceRoleClient();

  const { userId, invalid } = await resolveCaller(client, req);
  if (invalid || !userId) {
    // No confirmed caller identity yet — never write to the row using an
    // unauthenticated/invalid identity as the authorization condition.
    return respondFailed(undefined, 401);
  }

  const { data: card, error: cardError } = await client
    .from('registered_cards')
    .select('id, current_owner_id, collection_item_id')
    .eq('id', registeredCardId)
    .maybeSingle();

  if (cardError || !card) {
    return respondFailed(undefined, 404);
  }

  // Fast-fail authorization check. The caller is definitively not the
  // current owner of this exact row right now — no write is attempted: a
  // constrained condition using this caller's userId would never match
  // this row anyway, and attempting one would misleadingly imply this
  // caller has standing to affect it.
  if (card.current_owner_id !== userId) {
    return respondFailed(undefined, 403);
  }

  const originalCollectionItemId = card.collection_item_id as string | null;
  if (!originalCollectionItemId) {
    // originalCollectionItemId doesn't exist to constrain a write against
    // — return without mutating the row, per the precondition-failure
    // rule (a card with no linked item has nothing to copy from, and
    // nothing safe to record a failure status against yet either).
    return respondFailed('source_missing', 200);
  }

  // From this point on, userId and originalCollectionItemId are both
  // captured and safe to use as the authorization condition for every
  // subsequent failure write via writeFailedState.
  const { data: item, error: itemError } = await client
    .from('collection_items')
    .select('id, user_id, image_url')
    .eq('id', originalCollectionItemId)
    .maybeSingle();

  if (itemError || !item) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'source_missing', 200);
  }

  if (item.user_id !== userId) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'source_unauthorized', 200);
  }

  // Trusted-source resolution — server-side database data only, in the
  // approved preference order, falling through to the next option
  // whenever the preferred one is absent OR fails validation:
  //   1. collection_item_images primary row's storage_path column,
  //      itself validated — never assumed safe merely because it came
  //      from the database rather than the client.
  //   2. that same row's image_url, tightly parsed (decoded, then
  //      validated) against this exact project's own item-images bucket.
  //   3. collection_items.image_url, same tight parse.
  // Never an arbitrary external URL, and never bypassable via an encoded
  // traversal sequence or a raw traversal payload sitting directly in a
  // database column.
  let sourcePath: string | null = null;

  const { data: primaryImage } = await client
    .from('collection_item_images')
    .select('storage_path, image_url')
    .eq('item_id', originalCollectionItemId)
    .eq('is_primary', true)
    .maybeSingle();

  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';

  if (primaryImage?.storage_path) {
    sourcePath = validateItemImagesStoragePath(
      primaryImage.storage_path as string,
    );
  }
  if (!sourcePath && primaryImage?.image_url) {
    sourcePath = parseItemImagesStoragePath(primaryImage.image_url as string, projectUrl);
  }
  if (!sourcePath && item.image_url) {
    sourcePath = parseItemImagesStoragePath(item.image_url as string, projectUrl);
  }

  if (!sourcePath) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'source_missing', 200);
  }

  const { data: downloaded, error: downloadError } = await client.storage
    .from('item-images')
    .download(sourcePath);

  if (downloadError || !downloaded) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'download_failed', 200);
  }

  if (downloaded.size > MAX_IMAGE_BYTES) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'file_too_large', 200);
  }

  const contentType = downloaded.type;
  const extension = ALLOWED_IMAGE_MIME_TYPES[contentType];
  if (!extension) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'invalid_type', 200);
  }

  // Fixed, extensionless destination — the contentType is stored as object
  // metadata by the upload call itself, so the served Content-Type header
  // is still correct without needing the extension in the path. This
  // avoids ever accumulating original.jpg/original.png/original.webp
  // duplicates across retries where the validated type changed between
  // attempts (e.g. the source image was replaced).
  const destinationPath = `${registeredCardId}/original`;

  const { error: uploadError } = await client.storage
    .from('registry-images')
    .upload(destinationPath, downloaded, { contentType, upsert: true });

  if (uploadError) {
    return writeFailedState(client, registeredCardId, userId, originalCollectionItemId, 'upload_failed', 200);
  }

  // Race-safe completion: only mark ready if current_owner_id AND
  // collection_item_id are still exactly what they were captured as at the
  // start of this request. If either changed mid-flight (e.g. a transfer
  // was accepted, or the card was relinked to a different item), zero rows
  // match and this is a no-op — the card is never marked ready off a
  // source that's no longer actually the current one.
  const { data: updated, error: updateError } = await client
    .from('registered_cards')
    .update({
      snapshot_image_status: 'ready',
      snapshot_image_storage_path: destinationPath,
      snapshot_image_error_code: null,
      snapshot_image_updated_at: new Date().toISOString(),
    })
    .eq('id', registeredCardId)
    .eq('current_owner_id', userId)
    .eq('collection_item_id', originalCollectionItemId)
    .select('id')
    .maybeSingle();

  if (updateError) {
    // The conditional update itself errored (not merely zero rows) — its
    // outcome, and therefore the row's true current state, can't be
    // safely inferred from here. No follow-up write is attempted: better
    // to leave the row exactly as it was than risk a second write based
    // on unknown state.
    return respondFailed('database_update_failed', 200);
  }

  if (!updated) {
    // The conditional update matched zero rows — ownership or linkage
    // changed during the copy. Deliberately NOT deleted and NOT touched:
    // destinationPath is deterministic and keyed only by
    // registeredCardId, so it may already be the exact object a PRIOR
    // successful copy attempt already committed and is currently
    // referenced by this row's own snapshot_image_storage_path. Deleting
    // it here — even best-effort — could destroy a durable image another,
    // already-successful request is relying on. The object (whatever it
    // currently holds — this attempt's own just-uploaded bytes, or an
    // earlier successful copy's) is simply left in place: private
    // (unreachable without a signed URL, itself gated by the same
    // visibility check), safe, and available for a later authorized
    // upsert to overwrite. No registry-row update is performed either:
    // the conditional update above already definitively proved the
    // captured state is stale.
    return respondFailed('state_changed', 409);
  }

  return jsonResponse({ status: 'ready' }, 200);
});

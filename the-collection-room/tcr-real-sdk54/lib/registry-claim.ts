import { getRegistrySnapshotImageUrl } from './registry-images';
import { uploadItemImageFromBytes } from './storage';
import { supabase } from './supabase';
import type { CollectionItem } from '@/types';

export type ClaimRegisteredCardParams = {
  registeredCardId: string;
  folderId: string;
  title: string | null;
  player: string | null;
  year: number | null;
  brand: string | null;
  team: string | null;
  grade: string | null;
  gradingCompany: string | null;
  serialNumber: string | null;
};

export type ClaimRegisteredCardResult =
  | { error: null; data: CollectionItem }
  | { error: string; data: null };

// Thin wrapper — mirrors lib/ownership-transfer.ts's exact discriminated-
// union result convention (never throws). A flat `{ error: string | null;
// data: CollectionItem | null }` return type (each field independently
// nullable, not correlated) looks equivalent but silently defeats
// TypeScript's narrowing at call sites — checking `result.error !== null`
// would not narrow `result.data` to non-null, exactly the bug already
// caught and fixed once this session in app/registry/[id].tsx's own
// transfer-initiation handler. Real union, not a flat optional pair.
// claim_registered_card is SECURITY DEFINER and independently re-verifies
// caller identity, current ownership, the unlinked precondition, and
// folder ownership server-side (see the migration's own comments) — this
// function does not duplicate any of that. image_url is always created
// NULL by the RPC itself; any registry snapshot image is attached
// afterward, only on success, via copyRegistrySnapshotImageToNewItem
// below — never as part of this call, and never passed as a parameter
// here.
export async function claimRegisteredCard(
  params: ClaimRegisteredCardParams,
): Promise<ClaimRegisteredCardResult> {
  const { data, error } = await supabase.rpc('claim_registered_card', {
    p_registered_card_id: params.registeredCardId,
    p_folder_id: params.folderId,
    p_title: params.title,
    p_player: params.player,
    p_year: params.year,
    p_brand: params.brand,
    p_team: params.team,
    p_grade: params.grade,
    p_grading_company: params.gradingCompany,
    p_serial_number: params.serialNumber,
  });
  if (error) return { error: error.message, data: null };
  return { error: null, data: data as CollectionItem };
}

export type CopyRegistrySnapshotImageResult =
  | { status: 'copied'; imageUrl: string }
  | { status: 'skipped' }
  | { status: 'failed' };

// Post-claim only — the caller (app/claim-card/[id].tsx) must only invoke
// this AFTER claimRegisteredCard has already returned a successful new
// item; newItemId and userId here always come from that RPC's own result
// and the active authenticated session respectively — never a route
// param, the registered card record, or any other profile. This
// function's own outcome never affects whether the claim itself is
// considered successful. Order is always: 1) claim RPC commits, 2) this
// function requests a signed snapshot URL, 3) fetches its bytes, 4)
// uploads them under the recipient's own item-images path, 5) updates
// only the new item's image_url. Copies ONLY the registry's own durable
// snapshot object via the existing authorized
// get-registry-snapshot-image-url Edge Function — never reads or
// references the former owner's original item-images path/object. The
// signed URL itself is never persisted anywhere; only the freshly
// re-uploaded bytes' resulting public item-images URL is ever written.
//
// 'copied' is only ever returned once the trailing UPDATE has been
// confirmed to have actually touched the caller's own new row (via
// .select('id').maybeSingle() below) — a zero-row match (wrong id, wrong
// user_id, or a since-deleted item) is treated as 'failed', not silently
// reported as success.
//
// Known limitation: if the Storage upload itself succeeds but this final
// UPDATE then fails, the just-uploaded object is left as an orphaned,
// private, recipient-owned item-images object with nothing referencing
// it. No cleanup is attempted here — there is no existing generic
// delete-by-url helper for the item-images bucket to reuse (lib/storage.ts's
// only delete helper, deleteProfileImage, is hardcoded to the avatars
// bucket), and building new cleanup infrastructure for this narrow,
// low-severity case (a small private object under the recipient's own
// path, no data exposure) is out of scope for this pass.
export async function copyRegistrySnapshotImageToNewItem(
  registeredCardId: string,
  newItemId: string,
  userId: string,
): Promise<CopyRegistrySnapshotImageResult> {
  const signed = await getRegistrySnapshotImageUrl(registeredCardId);
  if (signed.status !== 'ok') {
    // Also the correct outcome when the card's snapshot_image_status is
    // 'pending'/'unavailable'/'failed' — the Edge Function itself
    // re-verifies status === 'ready' server-side and returns
    // { status: 'unavailable' } otherwise, independent of whatever the
    // caller already believed client-side.
    return { status: 'skipped' };
  }

  let response: Response;
  try {
    response = await fetch(signed.signed_url);
  } catch (e) {
    if (__DEV__) console.warn('[copyRegistrySnapshotImageToNewItem] fetch failed:', e);
    return { status: 'failed' };
  }

  if (!response.ok) {
    if (__DEV__) console.warn('[copyRegistrySnapshotImageToNewItem] fetch not ok:', response.status);
    return { status: 'failed' };
  }

  const contentType = response.headers.get('content-type');
  if (!contentType) {
    if (__DEV__) console.warn('[copyRegistrySnapshotImageToNewItem] response had no content-type');
    return { status: 'failed' };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (e) {
    if (__DEV__) console.warn('[copyRegistrySnapshotImageToNewItem] arrayBuffer() failed:', e);
    return { status: 'failed' };
  }

  let imageUrl: string;
  try {
    // uploadItemImageFromBytes itself rejects an unsupported/malformed
    // Content-Type (e.g. an HTML error page's text/html), a zero-byte
    // payload, or anything over the shared 10 MB ceiling — any of those
    // surfaces here as a thrown Error, caught below.
    imageUrl = await uploadItemImageFromBytes(bytes, contentType, userId);
  } catch (e) {
    if (__DEV__) console.warn('[copyRegistrySnapshotImageToNewItem] upload failed:', e);
    return { status: 'failed' };
  }

  // Scoped by both id and user_id — the recipient can only ever update
  // their own, brand-new item, never any other row. Only image_url is
  // touched. .select('id').maybeSingle() confirms a row was actually
  // matched and updated — a null result (wrong id/user_id, or the row no
  // longer exists) is treated as failure, not silently reported as
  // 'copied'.
  const { data: updated, error: updateError } = await supabase
    .from('collection_items')
    .update({ image_url: imageUrl })
    .eq('id', newItemId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (updateError || !updated) {
    if (__DEV__) {
      console.warn(
        '[copyRegistrySnapshotImageToNewItem] image_url update failed or matched no row:',
        updateError?.message,
      );
    }
    return { status: 'failed' };
  }

  return { status: 'copied', imageUrl };
}

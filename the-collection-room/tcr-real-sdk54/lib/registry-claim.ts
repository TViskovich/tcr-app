import { deriveStoragePathFromPublicUrl } from './item-images';
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
  // gallerySynced is true only once the canonical collection_item_images
  // primary row was also confirmed created — false means image_url is set
  // and the photo already renders correctly everywhere, but the canonical
  // invariant ("a live item's image has a collection_item_images row with
  // a real storage_path") is not yet satisfied for this item; it self-
  // heals on the owner's next edit-mode entry. 'copied' with
  // gallerySynced: false is deliberately still 'copied', not a new
  // failure state — see this function's own comment below for why the
  // caller's existing status === 'failed' check must not start matching
  // this case.
  | { status: 'copied'; imageUrl: string; gallerySynced: boolean }
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
// the new item's image_url, 6) creates the corresponding
// collection_item_images gallery row (Phase 3E — see below). Copies ONLY
// the registry's own durable snapshot object via the existing authorized
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
//
// Gallery-row creation (Phase 3E fix): previously this function only ever
// updated collection_items.image_url, leaving primary_image_id null for
// every claimed card until the owner happened to open Edit mode once
// (item-image-gallery-manager.tsx's materializeLegacyItemImage
// self-heal) — meaning a freshly-claimed card's cover photo rendered as
// "unavailable" everywhere signed delivery is used, immediately, with no
// cutover involved. The gallery-row insert below runs only after the
// image_url UPDATE is already confirmed committed (this whole function
// runs entirely post-commit relative to the claim RPC — there is no
// enclosing transaction to extend here, matching this function's existing
// documented best-effort design). If this insert fails, the item is left
// in exactly the same state this function already produced before this
// fix — but the overall result is still 'copied', never downgraded to
// 'failed': image_url is already durably set at that point, exactly the
// same outcome this function already produced before this fix, so a
// caller's UI must never regress from success to failure over a step
// that's strictly additive on top of an already-successful copy. The gap
// self-heals the same way it already did pre-fix — materializeLegacyItemImage,
// on the owner's next edit-mode entry. Logged in __DEV__ only, same tier
// as deleteProfileImage's own best-effort Storage cleanup elsewhere in
// this codebase.
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

  // Phase 3E gallery-row fix — see the module comment above. Best-effort,
  // strictly additive on top of the already-confirmed image_url update: a
  // failure here never turns this into 'failed', only gallerySynced:
  // false. is_primary: true is normally safe unconditionally (this is
  // always a brand-new item, image_url starts NULL per
  // claimRegisteredCard's own comment, so no gallery row would ordinarily
  // exist yet) — but this whole function is documented as callable only
  // once per claim, not guaranteed never to be re-invoked for the same
  // newItemId by some future caller, so the existence check below makes
  // that guarantee explicit and enforced here rather than merely assumed:
  // a second call for the same item can never create a duplicate primary
  // row (which collection_item_images_one_primary's partial unique index
  // would otherwise reject as a Storage-orphaning insert failure anyway).
  let gallerySynced = false;
  const { data: existingPrimary } = await supabase
    .from('collection_item_images')
    .select('id')
    .eq('item_id', newItemId)
    .eq('is_primary', true)
    .maybeSingle();

  if (existingPrimary) {
    gallerySynced = true;
  } else {
    const { error: galleryError } = await supabase.from('collection_item_images').insert({
      item_id: newItemId,
      user_id: userId,
      image_url: imageUrl,
      storage_path: deriveStoragePathFromPublicUrl(imageUrl, 'item-images'),
      sort_order: 0,
      is_primary: true,
    });
    if (galleryError) {
      if (__DEV__) {
        console.warn(
          '[copyRegistrySnapshotImageToNewItem] gallery row insert failed (image_url already set; self-heals on next edit-mode entry):',
          galleryError.message,
        );
      }
    } else {
      gallerySynced = true;
    }
  }

  return { status: 'copied', imageUrl, gallerySynced };
}

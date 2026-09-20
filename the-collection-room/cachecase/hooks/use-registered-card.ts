import { useCallback, useEffect, useState } from 'react';

import { copyRegistrySnapshotImage } from '@/lib/registry-images';
import { supabase } from '@/lib/supabase';
import type { RegisteredCard } from '@/types';

type RegisterResult = {
  error: string | null;
  // Present whenever the registered_cards row itself exists after this
  // call (including the partial-failure case where the row was created
  // but the durable image copy failed) — lets a caller distinguish "no row
  // was ever created, nothing to retry" from "row exists, only the image
  // copy needs retrying," without depending on this hook's own state
  // timing (registeredCard is only guaranteed current on the NEXT render).
  registeredCardId?: string;
};

type RegisterParams = {
  serialNumber?: string | null;
  gradeCompany?: string | null;
  grade?: string | null;
  certNumber?: string | null;
};

// Registry status for exactly one collection item, plus the ability to
// register it. Scoped to the item-detail "Register with CacheCase" flow
// (Phase 2B1). visibility is always 'public' (no visibility picker in this
// phase). registered_cards has no direct-INSERT/UPDATE RLS policy —
// register_card(...) is the only way this ever changes.
export function useRegisteredCardForItem(collectionItemId: string | undefined) {
  const [registeredCard, setRegisteredCard] = useState<RegisteredCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async () => {
    if (!collectionItemId) {
      setRegisteredCard(null);
      setLoading(false);
      return;
    }
    setLoading(true);

    const { data, error: queryError } = await supabase
      .from('registered_cards')
      .select('*')
      .eq('collection_item_id', collectionItemId)
      .maybeSingle();

    if (queryError) {
      console.error('[useRegisteredCardForItem] load failed:', {
        operation: 'load',
        collectionItemId,
        code: queryError.code,
        message: queryError.message,
      });
      setError(queryError.message);
      setLoading(false);
      return;
    }

    setRegisteredCard((data as RegisteredCard | null) ?? null);
    setError(null);
    setLoading(false);
  }, [collectionItemId]);

  useEffect(() => {
    load();
  }, [load]);

  // Only mutates state after the RPC confirms success (data present, no
  // error) — a failed call leaves registeredCard exactly as it was, never
  // optimistically flipped.
  const registerItem = useCallback(
    async (params: RegisterParams = {}): Promise<RegisterResult> => {
      if (!collectionItemId) return { error: 'No item to register.' };
      // Defense-in-depth: the calling screen already disables its button
      // while registering, but this hook must not depend on the caller
      // getting that right — a second overlapping call is a safe no-op
      // here regardless. registering is in the dependency array below so
      // this check always reads the current value, not a stale closure.
      if (registering) return { error: null };

      setRegistering(true);
      try {
        // p_card_type_id is deliberately always null in this phase — not a
        // missing implementation. registered_cards.card_type_id is
        // nullable, the live register_card RPC accepts a nullable
        // p_card_type_id, and automatic card_types matching/creation was
        // explicitly deferred (see the card_types migration's own "no
        // automatic global deduplication yet" comment). The collection
        // item is still linked via p_collection_item_id regardless.
        // Card-type selection/linking is a separate, later catalog
        // workflow. Every key below is present in the live register_card
        // signature — no extra/invalid parameters.
        const { data, error: rpcError } = await supabase.rpc('register_card', {
          p_card_type_id: null,
          p_collection_item_id: collectionItemId,
          p_serial_number: params.serialNumber ?? null,
          p_grade_company: params.gradeCompany ?? null,
          p_grade: params.grade ?? null,
          p_cert_number: params.certNumber ?? null,
          p_visibility: 'public',
        });

        if (rpcError) {
          console.error('[useRegisteredCardForItem] register_card failed:', {
            operation: 'register_card',
            collectionItemId,
            code: rpcError.code,
            message: rpcError.message,
          });
          // register_card raises this exact text for the collection-item
          // uniqueness conflict — mapped to shorter user-facing phrasing
          // rather than shown raw.
          if (rpcError.message === 'This collection item is already linked to another registered card') {
            return { error: 'This card is already registered with CacheCase.' };
          }
          return { error: rpcError.message };
        }

        if (!data) {
          return { error: 'Registration did not return a record. Please try again.' };
        }

        const card = data as RegisteredCard;
        setRegisteredCard(card);

        // Durable-image reliability: register_card seeds
        // snapshot_image_status to 'pending' only when the linked item
        // actually had a source image (see
        // set_snapshot_image_status_in_register_card.sql) — otherwise it's
        // already correctly 'unavailable' and there is nothing to copy.
        // Calling copy-registry-snapshot-image for a legitimate no-image
        // card would incorrectly flip that 'unavailable' status to
        // 'failed'/source_missing, so it's skipped entirely rather than
        // called and ignored.
        if (card.snapshot_image_status === 'pending') {
          // Awaited (not fire-and-forget): the registration operation
          // isn't reliably complete until the durable copy actually lands
          // in the private registry-images bucket, since the new registry
          // image display path never reads snapshot_image_url. copy-
          // registry-snapshot-image's own destination path
          // (`${registeredCardId}/original`, upsert:true) is deterministic
          // and keyed only by the already-created row's id, so retrying it
          // — here or later via retrySnapshotImage — is always safe and
          // never touches register_card again.
          const copyResult = await copyRegistrySnapshotImage(card.id);

          // The Edge Function (not this client) owns snapshot_image_status
          // / snapshot_image_storage_path — resync from the database
          // rather than guessing at the row's post-copy shape here.
          await load();

          if (copyResult.status !== 'ready') {
            console.warn('[useRegisteredCardForItem] snapshot image copy did not complete:', {
              operation: 'copy_registry_snapshot_image',
              registeredCardId: card.id,
              status: copyResult.status,
            });
            return {
              error:
                'Card registered, but the durable registry image could not be saved. You can retry saving the image from this screen.',
              registeredCardId: card.id,
            };
          }
        }

        return { error: null, registeredCardId: card.id };
      } finally {
        setRegistering(false);
      }
    },
    [collectionItemId, registering, load],
  );

  // Retries ONLY the durable image copy for an already-registered card —
  // never re-invokes register_card, so it can never create a duplicate
  // registration or trip registered_cards_unique_collection_item. Safe to
  // call repeatedly: the destination storage path is deterministic and
  // upserted, and every write inside copy-registry-snapshot-image is
  // re-verified against the row's current owner/linkage before it commits.
  const retrySnapshotImage = useCallback(
    async (registeredCardId: string): Promise<{ error: string | null }> => {
      const result = await copyRegistrySnapshotImage(registeredCardId);
      await load();
      if (result.status === 'ready') return { error: null };
      return {
        error: 'The durable registry image still could not be saved. Please try again shortly.',
      };
    },
    [load],
  );

  return {
    registeredCard,
    loading,
    error,
    registering,
    refresh: load,
    registerItem,
    retrySnapshotImage,
  };
}

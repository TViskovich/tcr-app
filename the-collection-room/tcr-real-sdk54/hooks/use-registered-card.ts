import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { RegisteredCard } from '@/types';

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
    async (params: RegisterParams = {}): Promise<{ error: string | null }> => {
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

        setRegisteredCard(data as RegisteredCard);
        return { error: null };
      } finally {
        setRegistering(false);
      }
    },
    [collectionItemId, registering],
  );

  return { registeredCard, loading, error, registering, refresh: load, registerItem };
}

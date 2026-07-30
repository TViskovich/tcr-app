import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { RegistryEvent } from '@/types';

type ProfileNameMap = Record<string, { username: string; display_name: string | null }>;

// Read-only provenance timeline for one registered card. registry_events'
// actor_id/from_owner_id/to_owner_id all reference auth.users (same
// architectural gap as registered_cards.current_owner_id — see
// app/registry/[id].tsx's own ownerProfile comment), so none of them can be
// embedded in the events query itself; names are resolved via one separate,
// deduplicated profiles query covering every id referenced across the
// whole batch of events, never one query per event.
export function useRegistryEvents(registeredCardId: string | undefined) {
  const [events, setEvents] = useState<RegistryEvent[]>([]);
  const [profileNames, setProfileNames] = useState<ProfileNameMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards against an older in-flight request (e.g. from rapidly
  // navigating between registry cards) or a request that outlives unmount
  // from applying stale state — every state update below is preceded by a
  // check that this exact call is still the current one.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => mountedRef.current && requestId === requestIdRef.current;

    if (!registeredCardId) {
      setEvents([]);
      setProfileNames({});
      setError(null);
      setLoading(false);
      return;
    }

    setError(null);
    setEvents([]);
    setProfileNames({});
    setLoading(true);

    try {
      const { data, error: queryError } = await supabase
        .from('registry_events')
        .select('*')
        .eq('registered_card_id', registeredCardId)
        .order('created_at', { ascending: true });

      if (!isCurrent()) return;

      if (queryError) {
        console.error('[useRegistryEvents] load failed:', {
          operation: 'load',
          registeredCardId,
          code: queryError.code,
          message: queryError.message,
        });
        setError(queryError.message);
        setEvents([]);
        setProfileNames({});
        return;
      }

      const rows = (data as RegistryEvent[] | null) ?? [];
      setEvents(rows);
      setError(null);

      // Dedupe every actor/from_owner/to_owner id referenced across all
      // events in this batch into one query.
      const userIds = [
        ...new Set(
          rows
            .flatMap((row) => [row.actor_id, row.from_owner_id, row.to_owner_id])
            .filter((value): value is string => !!value),
        ),
      ];

      if (userIds.length === 0) {
        setProfileNames({});
        return;
      }

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .in('id', userIds);

      if (!isCurrent()) return;

      if (profilesError) {
        // Best-effort — profile resolution failing must never prevent the
        // timeline itself (already set above) from rendering. Explicitly
        // reset rather than leaving a previous, now-mismatched map intact.
        console.error('[useRegistryEvents] profile resolution failed:', {
          operation: 'resolve_profiles',
          registeredCardId,
          code: profilesError.code,
          message: profilesError.message,
        });
        setProfileNames({});
        return;
      }

      const map: ProfileNameMap = {};
      for (const p of (profiles ?? []) as { id: string; username: string; display_name: string | null }[]) {
        map[p.id] = { username: p.username, display_name: p.display_name };
      }
      setProfileNames(map);
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[useRegistryEvents] load threw:', {
        operation: 'load',
        registeredCardId,
        code: null,
        message: e instanceof Error ? e.message : String(e),
      });
      setError('Could not load registry history. Please try again.');
      setEvents([]);
      setProfileNames({});
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [registeredCardId]);

  useEffect(() => {
    load();
  }, [load]);

  // The only way the screen ever gets a name — never returns or exposes
  // the raw id itself, so a caller can't accidentally render a UUID by
  // falling back to the input.
  const resolveName = useCallback(
    (userId: string | null): string | null => {
      if (!userId) return null;
      const profile = profileNames[userId];
      if (!profile) return null;
      return profile.display_name || profile.username || null;
    },
    [profileNames],
  );

  return { events, loading, error, resolveName, refresh: load };
}

import { useCallback, useEffect, useState } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';

// Grid View / List View for Profile V2's Collection and Items tabs — a
// per-viewer, per-tab display preference. Device-local (AsyncStorage), so
// no backend: it's how the signed-in viewer likes to browse, applied to
// every profile they look at (their own and others'), and never changes
// what they're allowed to see or do.

export type ProfileViewMode = 'grid' | 'list';
export type ProfileViewTab = 'collections' | 'items';

// In-memory mirror, so remounting Profile (or opening another profile)
// applies the choice on the first frame; only the very first read of a
// session waits on AsyncStorage (Grid until then — the default).
const memory = new Map<string, ProfileViewMode>();

const storageKey = (viewerId: string | undefined, tab: ProfileViewTab) =>
  `cachecase:profile-view-mode:${viewerId ?? 'anon'}:${tab}`;

export function useProfileViewMode(viewerId: string | undefined, tab: ProfileViewTab) {
  const key = storageKey(viewerId, tab);
  const [state, setState] = useState<{ key: string; mode: ProfileViewMode } | null>(() => {
    const cached = memory.get(key);
    return cached ? { key, mode: cached } : null;
  });

  useEffect(() => {
    if (memory.has(key)) return;
    let cancelled = false;
    AsyncStorage.getItem(key)
      .then((stored) => {
        const mode: ProfileViewMode = stored === 'list' ? 'list' : 'grid';
        if (!memory.has(key)) memory.set(key, mode);
        // A choice made while this was reading wins.
        if (!cancelled) setState((prev) => (prev?.key === key ? prev : { key, mode: memory.get(key)! }));
      })
      .catch(() => {
        // Unreadable storage — just stay on the default.
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const mode: ProfileViewMode = state?.key === key ? state.mode : (memory.get(key) ?? 'grid');

  const setMode = useCallback(
    (next: ProfileViewMode) => {
      memory.set(key, next);
      setState({ key, mode: next });
      AsyncStorage.setItem(key, next).catch(() => {
        // Best effort — this session still uses the choice (memory above).
      });
    },
    [key],
  );

  return [mode, setMode] as const;
}

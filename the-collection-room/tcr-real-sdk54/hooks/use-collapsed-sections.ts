import { useCallback, useState } from 'react';

// Tracks collapsed *ids* rather than expanded ones, so the common case
// (most/all sections expanded) needs no entries at all, and collections
// are expanded by default with zero setup.
//
// Session-local for this first implementation — state resets on remount,
// per folder id. Deliberately exposed as just { isExpanded, toggle } so a
// later AsyncStorage- or Supabase-profile-backed version is a drop-in
// replacement with the same surface, without changing any caller.
export function useCollapsedSections() {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const isExpanded = useCallback((id: string) => !collapsedIds.has(id), [collapsedIds]);

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return { isExpanded, toggle };
}

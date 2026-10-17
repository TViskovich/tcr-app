import { useCallback, useRef, useState } from 'react';

import { useFocusEffect } from 'expo-router';

import { supabase } from '@/lib/supabase';

export type FolderCrumb = { id: string; name: string };

// Ancestors fetched per request: the folder plus this many parents, as one
// nested self-embed (folders.parent_folder_id -> folders). Real trees are a
// few levels deep, so one request almost always covers the whole path; a
// deeper tree continues from where the previous request stopped.
const LEVELS_PER_REQUEST = 6;
// Hard stop for a pathological (or cyclic legacy) chain.
const MAX_REQUESTS = 4;

type FolderNode = {
  id: string;
  name: string;
  parent_folder_id: string | null;
  // Absent at the deepest embedded level; null when the parent exists but
  // RLS hides it from this viewer (or it's gone).
  parent?: FolderNode | null;
};

function nodeSelect(depth: number): string {
  const base = 'id, name, parent_folder_id';
  return depth === 0 ? base : `${base}, parent:folders!parent_folder_id(${nodeSelect(depth - 1)})`;
}
const NODE_SELECT = nodeSelect(LEVELS_PER_REQUEST - 1);

// Walks folderId and its ancestors, returning the path outermost-first
// (e.g. DC Comics › Absolute Batman), or null if the folder itself isn't
// visible to this viewer.
//
// Every level is an ordinary folders read, so folders_select_public (RLS)
// decides what comes back: a parent the viewer can't see returns null and
// the path stops below it — its name never reaches the client. Only
// id/name/parent_folder_id are selected: no covers, no items.
async function fetchFolderPath(folderId: string): Promise<FolderCrumb[] | null> {
  const chain: FolderCrumb[] = [];
  const seen = new Set<string>();
  let nextId: string | null = folderId;

  for (let request = 0; nextId && request < MAX_REQUESTS; request++) {
    const res = await supabase.from('folders').select(NODE_SELECT).eq('id', nextId).maybeSingle();
    if (res.error) throw res.error;
    let node = res.data as unknown as FolderNode | null;
    if (!node) break; // not visible (or deleted) — stop here
    nextId = null;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push({ id: node.id, name: node.name });
      if (!node.parent_folder_id) break; // reached a top-level collection
      if (node.parent === undefined) {
        // Deepest level of this request — continue from the parent.
        nextId = node.parent_folder_id;
        break;
      }
      node = node.parent; // null = hidden parent: stop
    }
  }

  return chain.length ? chain.reverse() : null;
}

/**
 * The visible collection path for a folder (outermost first), for Item
 * Detail's "Featured In". Loads on focus (so a rename or move made on
 * another screen shows on return) and whenever folderId changes, keeping
 * the previous path on screen while a refresh is in flight.
 *
 * status: 'loading' (nothing yet), 'ready' (path non-empty), 'unavailable'
 * (the folder isn't visible to this viewer), 'error' (request failed).
 */
export function useFolderAncestry(folderId: string | null | undefined) {
  const [result, setResult] = useState<
    | { folderId: string; status: 'ready'; path: FolderCrumb[] }
    | { folderId: string; status: 'unavailable' | 'error'; path: null }
    | null
  >(null);
  const generationRef = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const generation = ++generationRef.current;
      if (!folderId) return;
      fetchFolderPath(folderId).then(
        (path) => {
          if (generation !== generationRef.current) return;
          setResult(
            path ? { folderId, status: 'ready', path } : { folderId, status: 'unavailable', path: null },
          );
        },
        (e) => {
          if (generation !== generationRef.current) return;
          console.error('[useFolderAncestry] load failed:', e);
          setResult({ folderId, status: 'error', path: null });
        },
      );
    }, [folderId]),
  );

  const current = folderId && result?.folderId === folderId ? result : null;
  return { status: current?.status ?? ('loading' as const), path: current?.path ?? null };
}

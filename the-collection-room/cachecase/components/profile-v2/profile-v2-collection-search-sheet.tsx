import { useEffect } from 'react';
import { Keyboard } from 'react-native';

import {
  CollectionSearchResults,
  type CollectionSearchResult,
  useCollectionSearch,
} from '@/components/collection/collection-search';

import { ProfileV2SearchSheet, type SearchSheetToggle } from './profile-v2-search-sheet';

type Props = {
  visible: boolean;
  // The collector whose profile is open (never the viewer's own — that
  // long-press opens the Add menu, with its own search, instead).
  ownerId: string;
  ownerName: string;
  onClose: () => void;
  onSelect: (collection: CollectionSearchResult) => void;
  // Optional switch row under the field while the query is empty (the Collection
  // tab's "List View" switch).
  toggle?: SearchSheetToggle;
};

// Profile V2: long-press another collector's Collection pill → search all
// of their collections the viewer can open, nested ones included, by name
// (case-insensitive, partial). Search logic, privacy filtering and the
// results list are shared with the owner's Add menu
// (components/collection/collection-search.tsx); the sheet itself with
// Search Items (ProfileV2SearchSheet).
export function ProfileV2CollectionSearchSheet({ visible, ownerId, ownerName, toggle, onClose, onSelect }: Props) {
  // Public collections only — see loadSearchableCollections.
  const search = useCollectionSearch(ownerId, { includePrivate: false });
  const { load, setQuery } = search;

  // Fresh on every open — started as the sheet opens, not after its
  // animation.
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  return (
    <ProfileV2SearchSheet
      visible={visible}
      query={search.query}
      onChangeQuery={setQuery}
      placeholder={`Search ${ownerName}'s collections`}
      toggle={toggle}
      onClose={() => {
        setQuery('');
        onClose();
      }}>
      <CollectionSearchResults
        search={search}
        onSelect={(collection) => {
          Keyboard.dismiss();
          setQuery('');
          onSelect(collection);
        }}
      />
    </ProfileV2SearchSheet>
  );
}

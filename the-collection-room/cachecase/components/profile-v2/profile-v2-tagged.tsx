import { ActivityIndicator, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { useSavedAll, type SavedCardEntry, type SavedFolderEntry } from '@/hooks/use-saved';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import type { CollectionItem, Folder } from '@/types';

import { PV2 } from './profile-v2-theme';

const COLS = 3;
// Same footprint/aspect-ratio language as ProfileV2ItemsGrid — this tab
// should read as another dense card grid, not a new visual system.
const GRID_HORIZONTAL_MARGIN = 3;
const GRID_GAP = 2;
const GRID_WIDTH = Dimensions.get('window').width - GRID_HORIZONTAL_MARGIN * 2;
const CARD_ASPECT_RATIO = 2.5 / 3.5;
const CELL_WIDTH = (GRID_WIDTH - GRID_GAP * (COLS - 1)) / COLS;
const CELL_HEIGHT = CELL_WIDTH / CARD_ASPECT_RATIO;
const LOADING_PLACEHOLDER_COUNT = 9;

type TaggedEntry =
  | { kind: 'folder'; savedAt: string; folder: SavedFolderEntry }
  | { kind: 'card'; savedAt: string; card: SavedCardEntry };

type Props = {
  // The profile being VIEWED, not necessarily the signed-in viewer.
  userId: string;
  isOwnProfile: boolean;
  onPressItem: (item: CollectionItem) => void;
  onPressFolder: (folder: Folder) => void;
};

// Profile V3's "Tagged" tab. The visible label stays "Tagged" (see
// profile-v2-tab-row.tsx) — only the content behind it changed: this now
// renders the profile owner's existing bookmark/save repository
// (hooks/use-saved.ts's useSavedAll, the exact same source app/saved.tsx
// already reads for the dedicated Saved screen), instead of the old
// tagged-content path, which never had any real implementation wired up
// (profile-v2-screen.tsx had no `section === 'tagged'` render branch at
// all prior to this).
//
// Privacy: only ever queried for the profile's OWNER viewing their own
// profile. `isOwnProfile ? userId : undefined` means a visitor viewing
// someone else's profile passes `undefined` into useSavedAll, which
// no-ops entirely (see that hook's own `!currentUserId` early return) —
// another user's bookmarks are never fetched, let alone rendered, from
// this tab. This matches the only other place saved_* rows are ever
// read in the app (app/saved.tsx, always for the signed-in session's own
// id) — there is no existing precedent anywhere for showing one user's
// saved_* rows to a different viewer.
export function ProfileV2Tagged({ userId, isOwnProfile, onPressItem, onPressFolder }: Props) {
  const { folders, cards, loading } = useSavedAll(isOwnProfile ? userId : undefined);
  // Same batched-signing convention as every other grid in this codebase —
  // one call for the whole tab, never one request per tile.
  const { urls: signedCardImageUrls } = useSignedItemImages(cards.map((c) => c.primary_image_id), COMPACT_IMAGE_TIER);
  const { urls: signedFolderCoverUrls } = useSignedFolderCovers(folders.map((f) => f.id));

  const isEmpty = folders.length === 0 && cards.length === 0;

  if (loading && isEmpty) {
    return (
      <View style={styles.grid}>
        {Array.from({ length: LOADING_PLACEHOLDER_COUNT }, (_, i) => (
          <View key={`loading-${i}`} style={styles.cell} />
        ))}
      </View>
    );
  }

  if (isEmpty) {
    return (
      <View style={styles.empty}>
        {loading ? (
          <ActivityIndicator color={PV2.textSecondary} />
        ) : (
          <Text style={styles.emptyTitle}>Nothing tagged yet</Text>
        )}
      </View>
    );
  }

  // One merged, most-recently-saved-first feed — folders and cards are
  // different shapes, but both are "things this profile owner bookmarked",
  // so they read as a single tab rather than two separate sub-sections.
  const merged: TaggedEntry[] = [
    ...folders.map((folder) => ({ kind: 'folder' as const, savedAt: folder.savedAt, folder })),
    ...cards.map((card) => ({ kind: 'card' as const, savedAt: card.savedAt, card })),
  ].sort((a, b) => b.savedAt.localeCompare(a.savedAt));

  return (
    <View style={styles.grid}>
      {merged.map((entry) =>
        entry.kind === 'folder' ? (
          <FolderTile
            key={`folder-${entry.folder.id}`}
            folder={entry.folder}
            coverUrl={signedFolderCoverUrls.get(entry.folder.id)}
            onPress={() => onPressFolder(entry.folder)}
          />
        ) : (
          <CardTile
            key={`card-${entry.card.id}`}
            card={entry.card}
            imageUrl={entry.card.primary_image_id ? signedCardImageUrls.get(entry.card.primary_image_id) : undefined}
            onPress={() => onPressItem(entry.card)}
          />
        ),
      )}
    </View>
  );
}

function FolderTile({
  folder,
  coverUrl,
  onPress,
}: {
  folder: SavedFolderEntry;
  coverUrl: string | undefined;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.cell} activeOpacity={0.85} onPress={onPress}>
      {coverUrl ? (
        <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      ) : null}
      {/* Same bottom-scrim label treatment as grail-slot-preview.tsx's own
          collection slots — the one other place this app already
          distinguishes "this tile is a collection" from a plain card
          image. */}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.78)']} style={styles.scrim}>
        <Text style={styles.scrimLabel} numberOfLines={1}>{folder.name}</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function CardTile({
  card,
  imageUrl,
  onPress,
}: {
  card: SavedCardEntry;
  imageUrl: string | undefined;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.cell} activeOpacity={0.85} onPress={onPress}>
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // No top margin — same convention as every other tab body
  // (ProfileV2Posts/ProfileV2Collections/ProfileV2ItemsGrid): the starting
  // offset below the sticky tab row is owned entirely by
  // profile-v2-screen.tsx's shared TAB_CONTENT_TOP_GAP.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    gap: GRID_GAP,
  },
  cell: {
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
  },
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 5,
    paddingTop: 12,
    paddingBottom: 4,
  },
  scrimLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: PV2.textSecondary,
    fontSize: 15,
  },
});

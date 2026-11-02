import { useCallback, useEffect } from 'react';
import { ActivityIndicator, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';

import { type TaggedCardEntry, type TaggedFolderEntry, useTaggedContent } from '@/hooks/use-tagged-content';
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
  | { kind: 'folder'; taggedAt: string; folder: TaggedFolderEntry }
  | { kind: 'card'; taggedAt: string; card: TaggedCardEntry };

type Props = {
  // The profile being VIEWED, not necessarily the signed-in viewer.
  userId: string;
  onPressItem: (item: CollectionItem) => void;
  onPressFolder: (folder: Folder) => void;
  // The tagged items this tab is showing, whenever they (re)load — Profile's
  // Search Tagged Items searches exactly these, never a wider item set.
  onCardsChange?: (cards: TaggedCardEntry[]) => void;
};

// Profile V2's "Tagged" tab: the Items and Collections other collectors
// have tagged this profile in (hooks/use-tagged-content.ts — collector
// tagging, not bookmarks; saved content lives on the Saved screen). Shown
// on every profile, to every viewer, limited by RLS to content that viewer
// can see: a private, nested-private or deleted item/collection simply
// isn't returned. Tiles open the original owner's Item / Collection Detail.
// Reloaded whenever the profile regains focus, so a removed tag or content
// that turned private drops out on return.
export function ProfileV2Tagged({ userId, onPressItem, onPressFolder, onCardsChange }: Props) {
  const { folders, cards, loading, failed, refresh } = useTaggedContent(userId);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => {
    onCardsChange?.(cards);
  }, [cards, onCardsChange]);
  // Same batched-signing convention as every other grid in this codebase —
  // one call for the whole tab, never one request per tile.
  const { urls: signedCardImageUrls } = useSignedItemImages(cards.map((c) => c.primary_image_id), COMPACT_IMAGE_TIER);
  // Thumbnail-sized covers: the same small preview tier as item tiles.
  // coverSource: URL + stable cacheKey (token-backed for first_card covers).
  const { coverSource: folderCoverSource } = useSignedFolderCovers(folders.map((f) => f.id), COMPACT_IMAGE_TIER);

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
        ) : failed ? (
          <>
            <Text style={styles.emptyTitle}>Couldn’t load tagged items</Text>
            <TouchableOpacity onPress={() => void refresh()} style={styles.retry} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.emptyTitle}>Nothing tagged yet</Text>
        )}
      </View>
    );
  }

  // One merged, most-recently-tagged-first feed — folders and cards are
  // different shapes, but both are "things this profile was tagged in", so
  // they read as a single tab rather than two separate sub-sections.
  const merged: TaggedEntry[] = [
    ...folders.map((folder) => ({ kind: 'folder' as const, taggedAt: folder.taggedAt, folder })),
    ...cards.map((card) => ({ kind: 'card' as const, taggedAt: card.taggedAt, card })),
  ].sort((a, b) => b.taggedAt.localeCompare(a.taggedAt));

  return (
    <View style={styles.grid}>
      {merged.map((entry) =>
        entry.kind === 'folder' ? (
          <FolderTile
            key={`folder-${entry.folder.id}`}
            folder={entry.folder}
            cover={folderCoverSource(entry.folder)}
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
  cover,
  onPress,
}: {
  folder: TaggedFolderEntry;
  cover: { uri: string; cacheKey?: string } | null;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.cell}
      activeOpacity={0.85}
      onPress={onPress}
      accessibilityLabel={`Collection: ${folder.name}`}>
      {cover ? (
        <Image source={cover} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
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
  card: TaggedCardEntry;
  imageUrl: string | undefined;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.cell}
      activeOpacity={0.85}
      onPress={onPress}
      accessibilityLabel={card.title || 'Item'}>
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
  retry: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  retryText: {
    color: PV2.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});

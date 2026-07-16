import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CollectionPreviewCard,
  PREVIEW_CARD_ASPECT_RATIO,
  PREVIEW_CARD_RADIUS,
} from '@/components/collection/collection-preview-card';
import { CollectionSearchBar } from '@/components/collection/collection-search-bar';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  NO_PLAYER_KEY,
  groupItemsByPlayer,
  itemMatchesSearch,
  useItems,
  type PlayerGroup,
} from '@/hooks/use-collection';
import type { CollectionItem } from '@/types';

// Dense grid. Gap is applied via FlatList's own contentContainerStyle/
// columnWrapperStyle gap support — no per-item margin math, no
// ItemSeparatorComponent (unreliable with numColumns > 1).
const NUM_COLUMNS = 2;
const GRID_GAP = 3;

// The gallery for one folder — "a folder that holds folders": opening a
// top-level category (Basketball, Baseball, ...) first reveals its
// player groupings, and opening a grouping reveals that player's individual
// cards. Same route both times — grouping mode vs. card mode is decided
// purely by whether the `player` param is present — so there's no second
// route/file to keep in sync with this one.
export default function CollectionFolderScreen() {
  const params = useLocalSearchParams<{
    folderId?: string | string[];
    title?: string | string[];
    player?: string | string[];
  }>();

  // Expo Router params can be string or string[] — always take the first value.
  const folderId = Array.isArray(params.folderId) ? params.folderId[0] : params.folderId;
  const passedTitle = Array.isArray(params.title) ? params.title[0] : params.title;
  const activePlayer = Array.isArray(params.player) ? params.player[0] : params.player;

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();

  // Existing hook (hooks/use-collection.ts) — already filters
  // collection_items by folder_id and orders newest-first. Not duplicated,
  // and shared by both grouping mode and card mode below.
  const { items, loading } = useItems(folderId);

  const [search, setSearch] = useState('');

  const folderTitle = passedTitle || 'Collection';
  const thumbWidth = (windowWidth - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  const groups = useMemo(() => groupItemsByPlayer(items), [items]);

  const cardItems = useMemo(() => {
    if (!activePlayer) return [];
    return activePlayer === NO_PLAYER_KEY
      ? items.filter((i) => !i.player?.trim())
      : items.filter((i) => i.player?.trim() === activePlayer);
  }, [items, activePlayer]);

  // Filters what's already loaded (the full per-folder item set from
  // useItems, not a capped preview) — no new query per keystroke. A group
  // matches if its player name matches, or any card inside it does (team,
  // title, brand — see hooks/use-collection.ts's itemMatchesSearch).
  const filteredGroups = useMemo(() => {
    const q = search.trim();
    if (!q) return groups;
    const qLower = q.toLowerCase();
    return groups.filter(
      (group) => group.label.toLowerCase().includes(qLower) || group.items.some((item) => itemMatchesSearch(item, q)),
    );
  }, [groups, search]);

  const filteredCardItems = useMemo(() => {
    const q = search.trim();
    if (!q) return cardItems;
    return cardItems.filter((item) => itemMatchesSearch(item, q));
  }, [cardItems, search]);

  const isCardMode = !!activePlayer;
  const screenTitle = isCardMode ? (activePlayer === NO_PLAYER_KEY ? 'Other' : activePlayer!) : folderTitle;
  const visibleCount = isCardMode ? cardItems.length : items.length;

  function openItem(item: CollectionItem) {
    router.push({ pathname: '/item/[id]', params: { id: item.id } });
  }

  function openGroup(group: PlayerGroup) {
    router.push({
      pathname: '/collection/[folderId]',
      params: { folderId: folderId ?? '', title: folderTitle, player: group.key },
    });
  }

  // Same /item/new + folderId/folderName params app/folder/[id].tsx and
  // app/(tabs)/collection.tsx already use — not a new creation flow.
  function addCard() {
    router.push({
      pathname: '/item/new',
      params: { folderId: folderId ?? '', folderName: folderTitle },
    });
  }

  const showInitialLoading = loading && items.length === 0;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
            <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
          </Pressable>

          <View style={styles.titleArea}>
            <Text style={styles.title} numberOfLines={1}>
              {screenTitle}
            </Text>
            {!showInitialLoading && (
              <Text style={styles.count}>
                {visibleCount} {visibleCount === 1 ? 'Card' : 'Cards'}
              </Text>
            )}
          </View>

          <Pressable onPress={addCard} hitSlop={12} style={styles.iconBtn}>
            <IconSymbol name="plus" size={22} color={PV2.textPrimary} />
          </Pressable>
        </View>

        {!showInitialLoading && items.length > 0 && (
          <CollectionSearchBar
            value={search}
            onChange={setSearch}
            placeholder={isCardMode ? 'Search this player’s cards...' : 'Search players, teams...'}
            style={styles.searchBar}
          />
        )}

        {showInitialLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : isCardMode ? (
          <FlatList
            data={filteredCardItems}
            numColumns={NUM_COLUMNS}
            keyExtractor={(item) => item.id}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.gridContent}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.thumb, { width: thumbWidth, aspectRatio: PREVIEW_CARD_ASPECT_RATIO }]}
                onPress={() => openItem(item)}>
                {item.image_url ? (
                  <Image
                    source={{ uri: item.image_url }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={150}
                  />
                ) : (
                  <View style={styles.thumbPlaceholder} />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              search.trim() && cardItems.length > 0 ? (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptyBody}>Try a different search term.</Text>
                </View>
              ) : (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyTitle}>No cards yet</Text>
                  <Text style={styles.emptyBody}>Add your first card to this collection.</Text>
                  <Pressable style={styles.emptyButton} onPress={addCard}>
                    <Text style={styles.emptyButtonText}>Add Card</Text>
                  </Pressable>
                </View>
              )
            }
          />
        ) : (
          <FlatList
            data={filteredGroups}
            numColumns={NUM_COLUMNS}
            keyExtractor={(group) => group.key}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.gridContent}
            renderItem={({ item: group }) => {
              const cover = group.items.find((i) => i.image_url)?.image_url ?? null;
              return (
                <CollectionPreviewCard
                  imageUrl={cover}
                  title={group.label}
                  subtitle={`${group.items.length} ${group.items.length === 1 ? 'card' : 'cards'}`}
                  tileWidth={thumbWidth}
                  onPress={() => openGroup(group)}
                />
              );
            }}
            ListEmptyComponent={
              search.trim() && groups.length > 0 ? (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptyBody}>Try a different search term.</Text>
                </View>
              ) : (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyTitle}>No cards yet</Text>
                  <Text style={styles.emptyBody}>Add your first card to this collection.</Text>
                  <Pressable style={styles.emptyButton} onPress={addCard}>
                    <Text style={styles.emptyButtonText}>Add Card</Text>
                  </Pressable>
                </View>
              )
            }
          />
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleArea: {
    flex: 1,
    alignItems: 'center',
    gap: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  count: {
    fontSize: 12,
    color: PV2.textSecondary,
  },
  searchBar: {
    marginHorizontal: 12,
    marginBottom: 10,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    gap: GRID_GAP,
  },
  gridContent: {
    gap: GRID_GAP,
    paddingTop: 10,
    paddingBottom: 24,
    flexGrow: 1,
  },
  // Same look as CollectionPreviewCard's own tile (bordered dark panel,
  // rounded corners) so individual-card thumbnails match the Collection
  // page's photo style exactly, not a separate flatter treatment.
  thumb: {
    borderRadius: PREVIEW_CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  thumbPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: PV2.collectorPanelBg,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: 14,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
});

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useSavedAll } from '@/hooks/use-saved';
import type { SavedCardEntry, SavedFolderEntry, SavedGrailsEntry } from '@/hooks/use-saved';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { useAuth } from '@/lib/auth';

export default function SavedScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();

  const { folders, cards, grails, loading, refresh } = useSavedAll(currentUserId);
  // One batched call for the whole Saved Cards section — never one signing
  // request per row (item-images beta privacy hardening, Phase 3C).
  const { urls: signedCardImageUrls } = useSignedItemImages(cards.map((c) => c.primary_image_id), COMPACT_IMAGE_TIER);
  // One batched call for the whole Saved Collections section (Phase 3D) —
  // useSavedAll's own folder query is already public-only
  // (hooks/use-saved.ts: .eq('is_public', true)), so every id requested
  // here is expected to resolve, but the request still goes through the
  // same authorized signed-delivery path as an owner's own folders.
  const { urls: signedFolderCoverUrls } = useSignedFolderCovers(folders.map((f) => f.id));
  const [refreshing, setRefreshing] = useState(false);
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const isEmpty = folders.length === 0 && cards.length === 0 && grails.length === 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Saved', headerBackTitle: '' }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : isEmpty ? (
        <View style={styles.center}>
          <CacheCaseLogo variant="icon" size="lg" placement="emptyState" />
          <Text style={styles.emptyTitle}>Nothing saved yet</Text>
          <Text style={styles.emptyBody}>
            Bookmark collections, cards, and Grails showcases to revisit them here.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PV2.link} />
          }>

          {folders.length > 0 && (
            <Section title="Saved Collections">
              {folders.map(folder => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  coverUrl={signedFolderCoverUrls.get(folder.id)}
                  onPress={() =>
                    router.push({
                      pathname: '/collection/[folderId]',
                      params: { folderId: folder.id, title: folder.name },
                    })
                  }
                />
              ))}
            </Section>
          )}

          {cards.length > 0 && (
            <Section title="Saved Cards">
              {cards.map(card => (
                <CardRow
                  key={card.id}
                  card={card}
                  signedImageUrls={signedCardImageUrls}
                  onPress={() =>
                    router.push({ pathname: '/item/[id]', params: { id: card.id } })
                  }
                />
              ))}
            </Section>
          )}

          {grails.length > 0 && (
            <Section title="Saved Grails">
              {grails.map(g => (
                <GrailsRow
                  key={g.ownerId}
                  entry={g}
                  onPress={() =>
                    router.push({
                      pathname: '/grails/[userId]',
                      params: { userId: g.ownerId, username: g.username, displayName: g.displayName ?? '' },
                    })
                  }
                />
              ))}
            </Section>
          )}

        </ScrollView>
      )}
    </>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// ─── Row components ───────────────────────────────────────────────────────────

function FolderRow({
  folder,
  coverUrl,
  onPress,
}: {
  folder: SavedFolderEntry;
  coverUrl: string | undefined;
  onPress: () => void;
}) {
  const ownerName = folder.ownerDisplayName || folder.ownerUsername;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.thumb}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.thumbPlaceholder]}>
            <Text style={styles.thumbInitial}>{folder.name.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>{folder.name}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>by {ownerName}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function CardRow({
  card,
  signedImageUrls,
  onPress,
}: {
  card: SavedCardEntry;
  signedImageUrls: Map<string, string>;
  onPress: () => void;
}) {
  const ownerName = card.ownerDisplayName || card.ownerUsername;
  const cardTitle = card.title || card.player || 'Untitled Card';
  const imageUrl = card.primary_image_id ? signedImageUrls.get(card.primary_image_id) : undefined;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.thumb, styles.thumbCard]}>
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.thumbPlaceholder]}>
            <Text style={styles.thumbEmoji}>🃏</Text>
          </View>
        )}
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>{cardTitle}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>by {ownerName}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function GrailsRow({ entry, onPress }: { entry: SavedGrailsEntry; onPress: () => void }) {
  const name = entry.displayName || entry.username;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.thumb, styles.thumbRound]}>
        {entry.avatarUrl ? (
          <Image source={{ uri: entry.avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.thumbPlaceholder]}>
            <Text style={styles.thumbInitial}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>{name}&apos;s Grails</Text>
        <Text style={styles.rowSub} numberOfLines={1}>@{entry.username}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: PV2.bg,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingBottom: 40,
  },
  section: {
    marginTop: 28,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: PV2.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  sectionBody: {
    backgroundColor: PV2.panel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: PV2.panel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
    gap: 12,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  thumbCard: {
    borderRadius: 4,
    aspectRatio: 5 / 7,
    width: undefined,
    height: 48,
  },
  thumbRound: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  thumbEmoji: {
    fontSize: 22,
  },
  rowInfo: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowSub: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  chevron: {
    fontSize: 22,
    color: PV2.textTertiary,
    flexShrink: 0,
  },
});

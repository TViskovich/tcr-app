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
import { useSavedAll } from '@/hooks/use-saved';
import type { SavedCardEntry, SavedFolderEntry, SavedGrailsEntry } from '@/hooks/use-saved';
import { useAuth } from '@/lib/auth';

export default function SavedScreen() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();

  const { folders, cards, grails, loading, refresh } = useSavedAll(currentUserId);
  const [refreshing, setRefreshing] = useState(false);

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
          <ActivityIndicator size="large" color="#0a7ea4" />
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
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0a7ea4" />
          }>

          {folders.length > 0 && (
            <Section title="Saved Collections">
              {folders.map(folder => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  onPress={() =>
                    router.push({ pathname: '/folder/[id]', params: { id: folder.id, name: folder.name } })
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

function FolderRow({ folder, onPress }: { folder: SavedFolderEntry; onPress: () => void }) {
  const ownerName = folder.ownerDisplayName || folder.ownerUsername;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.thumb}>
        {folder.cover_image_url ? (
          <Image source={{ uri: folder.cover_image_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
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

function CardRow({ card, onPress }: { card: SavedCardEntry; onPress: () => void }) {
  const ownerName = card.ownerDisplayName || card.ownerUsername;
  const cardTitle = card.title || card.player || 'Untitled Card';
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.thumb, styles.thumbCard]}>
        {card.image_url ? (
          <Image source={{ uri: card.image_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
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
        <Text style={styles.rowTitle} numberOfLines={1}>{name}'s Grails</Text>
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
    backgroundColor: '#f8f9fa',
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#11181C',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 15,
    color: '#687076',
    textAlign: 'center',
    lineHeight: 22,
  },
  scroll: {
    flex: 1,
    backgroundColor: '#f8f9fa',
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
    color: '#687076',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  sectionBody: {
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
    gap: 12,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
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
    color: '#1565C0',
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
    color: '#11181C',
  },
  rowSub: {
    fontSize: 13,
    color: '#687076',
  },
  chevron: {
    fontSize: 22,
    color: '#ccc',
    flexShrink: 0,
  },
});

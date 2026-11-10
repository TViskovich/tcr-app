import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Stack, useFocusEffect } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { useAuth } from '@/lib/auth';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import {
  BLOCK_COPY,
  BLOCKED_PAGE_SIZE,
  type BlockedCollector,
  listBlockedCollectors,
  subscribeBlockChanges,
  unblockCollector,
} from '@/lib/user-blocks';

// Dashboard → Account & Security → Blocked Collectors. Lists only the
// signed-in collector's own blocks (list_blocked_collectors), newest first,
// in pages, each with Unblock. Collectors whose accounts are pending
// deletion or gone simply don't appear (the server leaves them out).
export default function BlockedCollectorsScreen() {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const viewerId = session?.user?.id ?? null;
  const [rows, setRows] = useState<BlockedCollector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    const result = await listBlockedCollectors(null);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setRows(result.value);
    setHasMore(result.value.length === BLOCKED_PAGE_SIZE);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFirstPage();
    }, [loadFirstPage]),
  );

  // A block or unblock made on another screen.
  useEffect(() => subscribeBlockChanges(() => void loadFirstPage()), [loadFirstPage]);

  async function loadMore() {
    if (loadingMore || !hasMore || rows.length === 0) return;
    setLoadingMore(true);
    const result = await listBlockedCollectors(rows[rows.length - 1].blockedAt);
    setLoadingMore(false);
    if (!result.ok) return;
    setRows((prev) => [...prev, ...result.value.filter((r) => !prev.some((p) => p.userId === r.userId))]);
    setHasMore(result.value.length === BLOCKED_PAGE_SIZE);
  }

  function confirmUnblock(row: BlockedCollector) {
    Alert.alert(BLOCK_COPY.unblockTitle(row.username), BLOCK_COPY.unblockBody, [
      { text: 'Cancel', style: 'cancel' },
      { text: BLOCK_COPY.unblockAction, onPress: () => void unblock(row) },
    ]);
  }

  async function unblock(row: BlockedCollector) {
    if (!viewerId || busyRef.current) return;
    busyRef.current = true;
    setBusyId(row.userId);
    try {
      const result = await unblockCollector(viewerId, row.userId);
      if (!result.ok) {
        Alert.alert('Couldn’t unblock', result.message);
        return;
      }
      setRows((prev) => prev.filter((r) => r.userId !== row.userId));
      setNotice(`Unblocked @${row.username}.`);
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)/dashboard" />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Blocked Collectors
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.userId}
        contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.intro}>
            <Text style={styles.body}>
              Collectors you block can’t message you, follow you or interact with your posts and collection, and you won’t see
              theirs. They aren’t notified. Anything you’ve made public can still be seen by people who aren’t signed in.
            </Text>
            <Text style={styles.body}>Unblocking doesn’t bring back follows, tags or other connections removed when you blocked.</Text>
            {notice ? (
              <Text style={styles.notice} accessibilityLiveRegion="polite" accessibilityRole="alert">
                {notice}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.spinner} color={PV2.textPrimary} accessibilityLabel="Loading blocked collectors" />
          ) : error ? (
            <View style={styles.card} accessibilityRole="alert">
              <Text style={styles.body}>{error}</Text>
              <Pressable style={styles.secondary} onPress={loadFirstPage} accessibilityRole="button" accessibilityLabel="Try again">
                <Text style={styles.secondaryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.empty}>You haven’t blocked anyone.</Text>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.spinner} color={PV2.textPrimary} /> : null}
        renderItem={({ item }) => {
          const busy = busyId === item.userId;
          return (
            <View style={styles.row} accessible={false}>
              <ChatAvatar uri={item.avatarUrl} name={item.displayName || item.username} size={40} />
              <View style={styles.rowText}>
                {item.displayName ? (
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.displayName}
                  </Text>
                ) : null}
                <Text style={item.displayName ? styles.rowSubtitle : styles.rowTitle} numberOfLines={1}>
                  @{item.username}
                </Text>
              </View>
              <Pressable
                onPress={() => confirmUnblock(item)}
                disabled={busyId !== null}
                style={({ pressed }) => [styles.secondary, (pressed || busy) && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Unblock @${item.username}`}
                accessibilityState={{ disabled: busyId !== null, busy }}>
                {busy ? <ActivityIndicator size="small" color={PV2.textPrimary} /> : <Text style={styles.secondaryText}>Unblock</Text>}
              </Pressable>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PV2.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  headerTitle: { flex: 1, textAlign: 'center', color: PV2.textPrimary, fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 36 },
  content: { padding: 20, gap: 10 },
  intro: { gap: 10, marginBottom: 6 },
  body: { color: PV2.textSecondary, fontSize: 14, lineHeight: 20 },
  notice: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  empty: { color: PV2.textTertiary, fontSize: 14, textAlign: 'center', marginTop: 24 },
  spinner: { marginTop: 24 },
  card: {
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    padding: 16,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: PV2.textPrimary, fontSize: 15, fontWeight: '600' },
  rowSubtitle: { color: PV2.textTertiary, fontSize: 13 },
  secondary: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PV2.border,
    alignItems: 'center',
    minWidth: 92,
  },
  secondaryText: { color: PV2.textPrimary, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});

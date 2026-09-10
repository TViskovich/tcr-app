import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Stack, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/ui/back-button';
import { type FollowListDirection, useFollowList } from '@/hooks/use-follow-list';
import { useAuth } from '@/lib/auth';
import { navigateToProfile } from '@/lib/profile-navigation';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

import { FollowListRow } from './follow-list-row';
import { PV2 } from './profile-v2-theme';

type Props = {
  // The profile being VIEWED (from the route param) — never the signed-in
  // viewer's own id. See app/followers/[userId].tsx / app/following/[userId].tsx.
  userId: string;
  direction: FollowListDirection;
};

const TITLE: Record<FollowListDirection, string> = {
  followers: 'Followers',
  following: 'Following',
};

const EMPTY_TEXT: Record<FollowListDirection, string> = {
  followers: 'No followers yet',
  following: 'Not following anyone yet',
};

// Shared body for both Followers and Following — the two screens differ
// only in `direction` (which flips the useFollowList query direction and
// the title/empty text above), so this is the one place their layout,
// header, and loading/empty/error states live rather than two near-
// identical copies. Header chrome (custom PV2-dark header, not the native
// Stack header, which follows the device's system theme rather than this
// app's own palette) copied from app/transactions/[userId].tsx's own
// established pattern for exactly this situation.
export function FollowListScreen({ userId, direction }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { users, loading, error, refresh } = useFollowList(userId, direction, currentUserId);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <BackButton fallbackHref="/(tabs)/profile" />
        <Text style={styles.headerTitle}>{TITLE[direction]}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading && users.length === 0 ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={PV2.textSecondary} />
        </View>
      ) : error && users.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>Couldn&apos;t load {TITLE[direction].toLowerCase()}</Text>
          <Pressable style={styles.retryButton} onPress={refresh} accessibilityRole="button">
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : users.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>{EMPTY_TEXT[direction]}</Text>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FollowListRow
              user={item}
              currentUserId={currentUserId}
              onPress={() => navigateToProfile(router, currentUserId, item.id, item.username)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={{ paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

// Matches BackButton's own fixed 44x44 touch target — this right-side
// spacer has no button of its own, it exists purely so headerTitle stays
// centered between two equal-width slots.
const HEADER_SPACER_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: PV2.panelBorder,
  },
  headerSpacer: {
    width: HEADER_SPACER_SIZE,
    height: HEADER_SPACER_SIZE,
  },
  headerTitle: {
    color: PV2.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  emptyTitle: {
    color: PV2.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 4,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
    marginLeft: 72,
  },
});

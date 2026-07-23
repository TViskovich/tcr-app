import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from './profile-v2-theme';

type Props = {
  posts: FeedPost[];
  currentUserId: string | undefined;
  onUserPress: (username: string) => void;
  onPostPress: (postId: string) => void;
  onLike: (postId: string) => void;
  // Set only when the posts query itself failed — distinct from a
  // genuinely empty list, so a failure is never shown as "No posts yet."
  error?: string | null;
  onRetry?: () => void;
};

// Plain stacked list, not a FlatList — this renders inside the profile
// screen's single outer ScrollView, same reasoning as ProfileV2Collections.
export function ProfileV2Posts({ posts, currentUserId, onUserPress, onPostPress, onLike, error, onRetry }: Props) {
  if (error && posts.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Couldn&apos;t load posts</Text>
        <Text style={styles.errorDetail}>{error}</Text>
        {onRetry && (
          <Pressable style={styles.retryButton} onPress={onRetry}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (posts.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No posts yet</Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          currentUserId={currentUserId}
          onUserPress={() => onUserPress(post.username)}
          onPostPress={() => onPostPress(post.id)}
          onLike={() => onLike(post.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: 16,
    marginTop: 14,
    gap: 12,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: PV2.textSecondary,
    fontSize: 15,
  },
  errorDetail: {
    color: PV2.textTertiary,
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 14,
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from './profile-v2-theme';

type Props = {
  posts: FeedPost[];
  currentUserId: string | undefined;
  onUserPress: (username: string) => void;
  onPostPress: (postId: string) => void;
  // Feed comment/reply redesign — opens the dedicated reply composer,
  // separate from onPostPress (post detail). See post-card.tsx's own
  // onCommentPress prop comment.
  onCommentPress: (postId: string) => void;
  onLike: (postId: string) => void;
  // Owner-only — PostCard itself gates the affordance to posts where
  // currentUserId === post.user_id, so this is safe to always pass through.
  onDelete: (postId: string) => void;
  // Set only when the posts query itself failed — distinct from a
  // genuinely empty list, so a failure is never shown as "No posts yet."
  error?: string | null;
  onRetry?: () => void;
};

// Plain stacked list, not a FlatList — this renders inside the profile
// screen's single outer ScrollView, same reasoning as ProfileV2Collections.
export function ProfileV2Posts({ posts, currentUserId, onUserPress, onPostPress, onCommentPress, onLike, onDelete, error, onRetry }: Props) {
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
          onCommentPress={() => onCommentPress(post.id)}
          onLike={() => onLike(post.id)}
          onDelete={() => onDelete(post.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // No top margin — the starting offset below the sticky tab row is now
  // owned entirely by profile-v2-screen.tsx's shared TAB_CONTENT_TOP_GAP
  // (tabBodyWrap), so every tab body begins at the same height. The gap
  // between posts (`gap: 12`) and each PostCard's own internal padding are
  // unrelated to this and untouched.
  list: {
    paddingHorizontal: 16,
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
  // Was PV2.accent (solid red) — the same color this design system reserves
  // for destructive/severe actions elsewhere (Remove Avatar, Stolen/Missing
  // custody status, etc). Retrying a failed query isn't destructive, so
  // this now matches ProfileV2Grid's retry button exactly (neutral panel
  // style, same padding/radius/text treatment) rather than each empty/error
  // state inventing its own button color.
  retryButton: {
    marginTop: 14,
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
});

import { StyleSheet, Text, View } from 'react-native';

import { PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from './profile-v2-theme';

type Props = {
  posts: FeedPost[];
  currentUserId: string | undefined;
  onUserPress: (username: string) => void;
  onPostPress: (postId: string) => void;
  onLike: (postId: string) => void;
};

// Plain stacked list, not a FlatList — this renders inside the profile
// screen's single outer ScrollView, same reasoning as ProfileV2Collections.
export function ProfileV2Posts({ posts, currentUserId, onUserPress, onPostPress, onLike }: Props) {
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
});

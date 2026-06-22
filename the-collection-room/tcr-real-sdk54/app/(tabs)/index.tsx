import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';

type FeedPost = {
  id: string;
  image_url: string;
  caption: string | null;
  created_at: string;
};

export default function HomeScreen() {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('posts')
      .select('id, image_url, caption, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    setPosts((data as FeedPost[]) ?? []);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFeed();
    }, [loadFeed]),
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Home</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No posts yet</Text>
          <Text style={styles.emptyBody}>
            Add an item to your collection and enable "Share to feed" to post here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PostCard post={item} />}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

function PostCard({ post }: { post: FeedPost }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardImageWrap}>
        <Image
          source={{ uri: post.image_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
      </View>
      {post.caption ? (
        <View style={styles.cardBody}>
          <Text style={styles.cardCaption}>{post.caption}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#11181C',
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: '#687076',
    textAlign: 'center',
    lineHeight: 22,
  },
  list: {
    padding: 12,
    gap: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardImageWrap: {
    aspectRatio: 1,
    backgroundColor: '#e9ecef',
  },
  cardBody: {
    padding: 12,
    gap: 4,
  },
  cardCaption: {
    fontSize: 14,
    color: '#11181C',
  },
});

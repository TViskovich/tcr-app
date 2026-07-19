import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { RateMyGrailCard } from '@/types';

type PostDetail = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails';
  image_url: string | null;
  content: string | null;
  caption: string | null;
  created_at: string;
  item_name: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  likeCount: number;
  liked: boolean;
  grailCards: RateMyGrailCard[];
  avgRating: number | null;
  ratingCount: number;
  myRating: number | null;
};

type Comment = {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Defined outside the screen so FlatList ListHeaderComponent doesn't remount on re-renders
function PostHeader({
  post,
  commentCount,
  likeScaleAnim,
  onLikeTap,
  rating,
  onRate,
}: {
  post: PostDetail;
  commentCount: number;
  likeScaleAnim: Animated.Value;
  onLikeTap: () => void;
  rating: { avg: number | null; count: number; myRating: number | null; isOwner: boolean; submitting: boolean };
  onRate: (score: number) => void;
}) {
  const displayName = post.display_name || post.username;
  return (
    <View>
      {/* Header bar — avatar + name above the photo */}
      <View style={styles.userRow}>
        <View style={styles.avatar}>
          {post.avatar_url ? (
            <Image source={{ uri: post.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>
        <View style={styles.userInfo}>
          <Text style={styles.postDisplayName}>{displayName}</Text>
          <Text style={styles.postUsername}>@{post.username}</Text>
        </View>
        <Text style={styles.postAge}>{formatAge(post.created_at)}</Text>
      </View>

      {/* Post body — text for text posts, grails grid for Rate My Grails, image otherwise */}
      {post.post_type === 'text' ? (
        <Text style={styles.textContent}>{post.content}</Text>
      ) : post.post_type === 'rate_my_grails' ? (
        <View style={styles.grailsWrap}>
          <GrailsPostBody
            cards={post.grailCards}
            caption={post.caption}
            avg={rating.avg}
            count={rating.count}
            myRating={rating.myRating}
            isOwner={rating.isOwner}
            submitting={rating.submitting}
            onRate={onRate}
          />
        </View>
      ) : (
        <View style={styles.imageWrap}>
          <Image source={{ uri: post.image_url! }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        </View>
      )}

      {/* Caption only for item posts (Rate My Grails renders its own caption
          inside GrailsPostBody, above) */}
      {post.post_type !== 'text' && post.post_type !== 'rate_my_grails' && (post.caption || post.item_name) ? (
        <Text style={styles.caption}>{post.caption || post.item_name}</Text>
      ) : null}

      {/* Like + comment counts */}
      <View style={styles.actions}>
        <Pressable onPress={onLikeTap} hitSlop={8} style={styles.actionBtn}>
          <Animated.View style={{ transform: [{ scale: likeScaleAnim }] }}>
            <Text style={[styles.actionEmoji, !post.liked && styles.dim]}>🔥</Text>
          </Animated.View>
          <Text style={[styles.actionCount, post.liked && styles.likedCount]}>
            {post.likeCount}
          </Text>
        </Pressable>

        <View style={[styles.actionBtn, styles.commentCountBtn]}>
          <Text style={[styles.actionEmoji, styles.dim]}>💬</Text>
          <Text style={styles.actionCount}>{commentCount}</Text>
        </View>
      </View>

      <View style={styles.divider} />
    </View>
  );
}

function CommentRow({
  comment,
  isOwn,
  onDelete,
}: {
  comment: Comment;
  isOwn: boolean;
  onDelete: (id: string) => void;
}) {
  const displayName = comment.display_name || comment.username;
  return (
    <View style={styles.commentRow}>
      <View style={styles.commentAvatar}>
        {comment.avatar_url ? (
          <Image source={{ uri: comment.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.commentAvatarPlaceholder]}>
            <Text style={styles.commentAvatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.commentContent}>
        <View style={styles.commentMeta}>
          <Text style={styles.commentUsername}>{displayName}</Text>
          <Text style={styles.commentAge}>{formatAge(comment.created_at)}</Text>
        </View>
        <Text style={styles.commentBody}>{comment.body}</Text>
      </View>
      {isOwn && (
        <TouchableOpacity onPress={() => onDelete(comment.id)} hitSlop={8} style={styles.deleteBtn}>
          <Text style={styles.deleteText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function PostDetailScreen() {
  const { id: postId } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const insets = useSafeAreaInsets();
  // A single-post detail view, not a browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [post, setPost] = useState<PostDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [sending, setSending] = useState(false);
  const likeScaleAnim = useRef(new Animated.Value(1)).current;
  const flatListRef = useRef<FlatList<Comment>>(null);

  const rating = useGrailRating({
    postId: post?.id ?? '',
    postOwnerId: post?.user_id ?? '',
    currentUserId,
    initialAvg: post?.avgRating ?? null,
    initialCount: post?.ratingCount ?? 0,
    initialMyRating: post?.myRating ?? null,
  });

  const fetchComments = useCallback(async (pid: string): Promise<Comment[]> => {
    const { data: rows } = await supabase
      .from('comments')
      .select('id, user_id, body, created_at')
      .eq('post_id', pid)
      .order('created_at', { ascending: true });

    if (!rows?.length) return [];

    const userIds = [...new Set((rows as any[]).map((c) => c.user_id as string))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    return (rows as any[]).map((c) => {
      const cp = profileMap.get(c.user_id) ?? {};
      return {
        id: c.id,
        user_id: c.user_id,
        body: c.body,
        created_at: c.created_at,
        username: cp.username ?? 'user',
        display_name: cp.display_name ?? null,
        avatar_url: cp.avatar_url ?? null,
      };
    });
  }, []);

  useEffect(() => {
    if (!postId) return;

    async function load() {
      setLoading(true);

      const { data: postRow } = await supabase
        .from('posts')
        .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
        .eq('id', postId)
        .single();

      if (!postRow) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      const row = postRow as any;
      const isRateMyGrails = row.post_type === 'rate_my_grails';

      const [profileRes, itemRes, likesRes, fetchedComments, cardsRes, ratingsRes] = await Promise.all([
        supabase.from('profiles').select('id, username, display_name, avatar_url').eq('id', row.user_id).single(),
        // Text/rate_my_grails posts have no item_id — skip the items lookup to avoid a malformed query.
        row.item_id
          ? supabase.from('collection_items').select('name').eq('id', row.item_id).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('likes').select('user_id').eq('post_id', postId),
        fetchComments(postId),
        isRateMyGrails
          ? supabase
              .from('rate_my_grail_cards')
              .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
              .eq('post_id', postId)
              .order('display_order', { ascending: true })
          : Promise.resolve({ data: [] }),
        isRateMyGrails
          ? supabase.from('grail_ratings').select('rater_user_id, score').eq('post_id', postId)
          : Promise.resolve({ data: [] }),
      ]);

      const likeRows = (likesRes.data ?? []) as any[];
      const p = profileRes.data as any;
      const item = itemRes.data as any;
      const ratingRows = (ratingsRes.data ?? []) as any[];

      setPost({
        id: row.id,
        user_id: row.user_id,
        post_type: (row.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails',
        image_url: row.image_url ?? null,
        content: row.content ?? null,
        caption: row.caption ?? null,
        created_at: row.created_at,
        item_name: item?.name ?? null,
        username: p?.username ?? 'user',
        display_name: p?.display_name ?? null,
        avatar_url: p?.avatar_url ?? null,
        likeCount: likeRows.length,
        liked: likeRows.some((l: any) => l.user_id === currentUserId),
        grailCards: (cardsRes.data ?? []) as any[],
        avgRating: ratingRows.length
          ? ratingRows.reduce((sum, r) => sum + r.score, 0) / ratingRows.length
          : null,
        ratingCount: ratingRows.length,
        myRating: ratingRows.find((r) => r.rater_user_id === currentUserId)?.score ?? null,
      });

      setComments(fetchedComments);
      setLoading(false);
    }

    load();
  }, [postId, currentUserId, fetchComments]);

  function handleLikeTap() {
    if (!currentUserId || !post) return;
    const currentPost = post;

    Animated.sequence([
      Animated.timing(likeScaleAnim, { toValue: 1.4, duration: 80, useNativeDriver: true }),
      Animated.spring(likeScaleAnim, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 10 }),
    ]).start();

    const wasLiked = currentPost.liked;
    setPost((prev) =>
      prev
        ? { ...prev, liked: !wasLiked, likeCount: wasLiked ? prev.likeCount - 1 : prev.likeCount + 1 }
        : prev,
    );

    const query = wasLiked
      ? supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', currentPost.id)
      : supabase.from('likes').insert({ user_id: currentUserId, post_id: currentPost.id });

    query.then(({ error }: any) => {
      if (error) {
        console.error(wasLiked ? 'Unlike failed:' : 'Like failed:', error.message);
        return;
      }
      if (wasLiked) {
        supabase.from('notifications').delete()
          .eq('actor_id', currentUserId).eq('post_id', currentPost.id).eq('type', 'like')
          .then(({ error: e }) => { if (e) console.error('Like notif delete failed:', e.message); });
      } else if (currentPost.user_id !== currentUserId) {
        supabase.from('notifications').insert({
          user_id: currentPost.user_id,
          actor_id: currentUserId,
          type: 'like',
          post_id: currentPost.id,
        }).then(({ error: e }) => {
          if (e && e.code !== '23505') console.error('Like notif failed:', e.message);
        });
      }
    });
  }

  async function handleAddComment() {
    if (!currentUserId || !newComment.trim() || !post || sending) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');

    const { error } = await supabase
      .from('comments')
      .insert({ user_id: currentUserId, post_id: post.id, body });

    if (error) {
      console.error('Comment failed:', error.message);
      setNewComment(body);
      setSending(false);
      return;
    }

    if (post.user_id !== currentUserId) {
      supabase.from('notifications').insert({
        user_id: post.user_id,
        actor_id: currentUserId,
        type: 'comment',
        post_id: post.id,
      }).then(({ error: e }) => { if (e) console.error('Comment notif failed:', e.message); });
    }

    const fresh = await fetchComments(post.id);
    setComments(fresh);
    setSending(false);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }

  function handleDeleteComment(commentId: string) {
    Alert.alert('Delete comment?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('comments').delete().eq('id', commentId);
          if (error) {
            console.error('Delete comment failed:', error.message);
          } else {
            setComments((prev) => prev.filter((c) => c.id !== commentId));
          }
        },
      },
    ]);
  }

  if (loading && !post) {
    return (
      <>
        <Stack.Screen options={{ title: 'Post' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </>
    );
  }

  if (notFound || !post) {
    return (
      <>
        <Stack.Screen options={{ title: 'Post' }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Post not found.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: `@${post.username}`, headerBackTitle: '' }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        <FlatList
          ref={flatListRef}
          data={comments}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <CommentRow
              comment={item}
              isOwn={item.user_id === currentUserId}
              onDelete={handleDeleteComment}
            />
          )}
          ListHeaderComponent={
            <PostHeader
              post={post}
              commentCount={comments.length}
              likeScaleAnim={likeScaleAnim}
              onLikeTap={handleLikeTap}
              rating={rating}
              onRate={rating.submitRating}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyComments}>
              <Text style={styles.emptyCommentsText}>No comments yet. Be the first!</Text>
            </View>
          }
          contentContainerStyle={{ flexGrow: 1 }}
        />

        {/* Comment input bar */}
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TextInput
            style={styles.input}
            value={newComment}
            onChangeText={setNewComment}
            placeholder="Add a comment..."
            placeholderTextColor="#999"
            returnKeyType="send"
            onSubmitEditing={handleAddComment}
            blurOnSubmit={false}
            editable={!sending}
            maxLength={500}
          />
          <TouchableOpacity
            onPress={handleAddComment}
            disabled={!newComment.trim() || sending}
            style={styles.sendBtn}>
            {sending ? (
              <ActivityIndicator size="small" color="#0a7ea4" />
            ) : (
              <Text style={[styles.sendText, !newComment.trim() && styles.sendTextDisabled]}>
                Post
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  errorText: {
    fontSize: 16,
    color: '#687076',
  },
  // Post header
  imageWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: '#e9ecef',
  },
  grailsWrap: {
    padding: 12,
    backgroundColor: '#1A1A1A',
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#333333',
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  userInfo: {
    flex: 1,
    gap: 1,
  },
  postDisplayName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  postUsername: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
  },
  postAge: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.40)',
    flexShrink: 0,
  },
  textContent: {
    fontSize: 18,
    color: '#11181C',
    paddingHorizontal: 12,
    paddingVertical: 16,
    lineHeight: 26,
  },
  caption: {
    fontSize: 15,
    color: '#11181C',
    paddingHorizontal: 12,
    paddingBottom: 12,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  commentCountBtn: {
    marginLeft: 16,
  },
  actionEmoji: {
    fontSize: 20,
  },
  dim: {
    opacity: 0.25,
  },
  actionCount: {
    fontSize: 14,
    fontWeight: '500',
    color: '#687076',
    minWidth: 16,
  },
  likedCount: {
    color: '#E65100',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e0e0e0',
  },
  // Comments
  commentRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  commentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
    flexShrink: 0,
    marginTop: 2,
  },
  commentAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarInitial: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1565C0',
  },
  commentContent: {
    flex: 1,
    gap: 3,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentUsername: {
    fontSize: 13,
    fontWeight: '600',
    color: '#11181C',
  },
  commentAge: {
    fontSize: 11,
    color: '#aaa',
  },
  commentBody: {
    fontSize: 14,
    color: '#333',
    lineHeight: 20,
  },
  deleteBtn: {
    paddingLeft: 8,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  deleteText: {
    fontSize: 13,
    color: '#bbb',
  },
  emptyComments: {
    padding: 32,
    alignItems: 'center',
  },
  emptyCommentsText: {
    fontSize: 14,
    color: '#687076',
  },
  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#fff',
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#11181C',
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxHeight: 100,
  },
  sendBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    minWidth: 44,
    alignItems: 'center',
  },
  sendText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  sendTextDisabled: {
    color: '#ccc',
  },
});

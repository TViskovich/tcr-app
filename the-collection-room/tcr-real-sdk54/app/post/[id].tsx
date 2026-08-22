import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { HeaderBackButton } from '@react-navigation/elements';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { deletePost } from '@/lib/posts';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CardShareItem, RateMyGrailCard } from '@/types';

// Extra clearance so the comment input bar's "Post" button sits above the
// globally-rendered floating tab bar (see components/navigation/
// global-floating-tab-bar.tsx, rendered as a root-level sibling of every
// screen outside app/(tabs) — it is NOT part of this screen's own view
// tree, so it doesn't get pushed up by KeyboardAvoidingView). Without this,
// the input bar sits underneath that bar's touch-absorbing surface
// whenever the keyboard is closed, and taps meant for "Post" (or even
// focusing the text field) land on the tab bar's inert background instead
// — no error, no navigation, nothing happens. Applied only while the
// keyboard is closed; once it's open the bar hugs the keyboard exactly as
// before, with no dead gap.
const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + 16;

type PostDetail = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails' | 'card_share';
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
  cardShareItems: CardShareItem[];
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

      {/* Post body — text for text posts, grails grid for Rate My Grails,
          carousel for card_share, image otherwise */}
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
      ) : post.post_type === 'card_share' ? (
        // card_share posts have no top-level image_url (their images live
        // in card_share_items instead) — must never fall through to the
        // plain-image branch below, which would pass an undefined uri to
        // Image. An empty cardShareItems list (query returned zero rows
        // for this post, distinct from the whole fetch failing) gets a
        // controlled fallback instead of silently rendering nothing.
        <View style={styles.imageWrap}>
          {post.cardShareItems.length > 0 ? (
            <CardSharePostBody cards={post.cardShareItems} />
          ) : (
            <View style={styles.cardShareUnavailable}>
              <Text style={styles.cardShareUnavailableText}>Shared cards unavailable</Text>
            </View>
          )}
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
  const router = useRouter();
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
  // Distinct from notFound — the post query itself failed (network/RLS/etc),
  // as opposed to succeeding with zero rows. Conflating the two used to hide
  // real failures behind a misleading "Post not found" message.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set only when a comments query fails — never cleared to [] on failure,
  // so a failed refresh can't wipe comments that are already on screen.
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [sending, setSending] = useState(false);
  const [deletingPost, setDeletingPost] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const likeScaleAnim = useRef(new Animated.Value(1)).current;
  const flatListRef = useRef<FlatList<Comment>>(null);

  // Owns the mount/postId-change load's request batch only — the
  // Retry-comments and post-a-comment refresh paths below are user-
  // triggered actions (not a mount/route effect), same classification as
  // profile-v2-screen.tsx's handleSave, so they're intentionally left
  // uncancelled. An in-flight request left running past the point this
  // screen unmounts can have its underlying XHR connection torn down by
  // the native networking layer and crash with whatwg-fetch's status-0
  // RangeError — see hooks/use-profile.ts for the full mechanism writeup.
  const loadControllerRef = useRef<AbortController | null>(null);

  // Tracks keyboard state purely to toggle TAB_BAR_CLEARANCE above — see
  // that constant's comment. "Will" events on iOS (available there) avoid a
  // one-frame lag/flash; Android only has "Did" events.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // DEBUG (temporary — see task report; remove once verified against a
  // running app). Confirms the id this screen actually received and
  // whether the native stack has real history to pop to.
  useEffect(() => {
    console.log('[PostDetail][DEBUG] mounted', {
      postIdReceived: postId,
      canGoBack: router.canGoBack(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // Prefer popping real history (preserves whatever screen/scroll position
  // the user actually came from — feed, profile, notifications, etc. — per
  // requirement). Only fall back to the main feed when there's genuinely no
  // history to go back to (e.g. a cold deep link straight into this route).
  function handleBack() {
    const canGoBack = router.canGoBack();
    console.log('[PostDetail][DEBUG] handleBack', { canGoBack });
    if (canGoBack) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  }

  const rating = useGrailRating({
    postId: post?.id ?? '',
    postOwnerId: post?.user_id ?? '',
    currentUserId,
    initialAvg: post?.avgRating ?? null,
    initialCount: post?.ratingCount ?? 0,
    initialMyRating: post?.myRating ?? null,
  });

  // Returns { comments, error } instead of throwing or silently returning
  // [] on failure — a failed query must never look identical to "this post
  // genuinely has zero comments." Callers decide what to do with the
  // error (show a banner, keep prior state, etc.) rather than this
  // function silently deciding "empty" on their behalf. `signal` is
  // optional — only the mount-effect load() below (an at-risk mount-driven
  // load) supplies one; the retry-comments and post-a-comment refresh
  // callers are user-triggered actions and intentionally don't cancel.
  const fetchComments = useCallback(async (pid: string, signal?: AbortSignal): Promise<{ comments: Comment[]; error: string | null }> => {
    console.log('[PostDetail][DEBUG] fetchComments: start', { postId: pid });

    const commentsQuery = supabase
      .from('comments')
      .select('id, user_id, body, created_at')
      .eq('post_id', pid)
      .order('created_at', { ascending: true });
    const { data: rows, error: rowsError } = await (signal ? commentsQuery.abortSignal(signal) : commentsQuery);

    if (rowsError) {
      console.error('[PostDetail] fetchComments: comments query failed:', rowsError.message, rowsError);
      return { comments: [], error: rowsError.message };
    }

    if (!rows?.length) {
      console.log('[PostDetail][DEBUG] fetchComments: success, 0 comments');
      return { comments: [], error: null };
    }

    const userIds = [...new Set((rows as any[]).map((c) => c.user_id as string))];
    const profilesQuery = supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);
    const { data: profiles, error: profilesError } = await (signal ? profilesQuery.abortSignal(signal) : profilesQuery);

    if (profilesError) {
      console.error('[PostDetail] fetchComments: profiles query failed:', profilesError.message, profilesError);
      return { comments: [], error: profilesError.message };
    }

    const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    const comments = (rows as any[]).map((c) => {
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

    console.log('[PostDetail][DEBUG] fetchComments: success', { count: comments.length });
    return { comments, error: null };
  }, []);

  useEffect(() => {
    if (!postId) return;

    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    async function load() {
      setLoading(true);
      setLoadError(null);
      setNotFound(false);

      try {
        const { data: postRow, error: postError } = await supabase
          .from('posts')
          .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
          .eq('id', postId)
          .abortSignal(controller.signal)
          .single();

        if (loadControllerRef.current !== controller || controller.signal.aborted) return;

        if (postError) {
          // A real query failure (network, RLS, etc.) — never presented as
          // "not found," which would hide the actual cause.
          console.error('[PostDetail] load: post query failed:', postError.message, postError);
          setLoadError(postError.message);
          return;
        }

        if (!postRow) {
          setNotFound(true);
          return;
        }

        const row = postRow as any;
        const isRateMyGrails = row.post_type === 'rate_my_grails';
        const isCardShare = row.post_type === 'card_share';

        const [profileRes, itemRes, likesRes, commentsResult, cardsRes, ratingsRes, cardShareItemsRes] = await Promise.all([
          supabase.from('profiles').select('id, username, display_name, avatar_url').eq('id', row.user_id).abortSignal(controller.signal).single(),
          // Text/rate_my_grails/card_share posts have no item_id — skip the items lookup to avoid a malformed query.
          row.item_id
            ? supabase.from('collection_items').select('name').eq('id', row.item_id).abortSignal(controller.signal).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from('likes').select('user_id').eq('post_id', postId).abortSignal(controller.signal),
          fetchComments(postId, controller.signal),
          isRateMyGrails
            ? supabase
                .from('rate_my_grail_cards')
                .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
                .eq('post_id', postId)
                .order('display_order', { ascending: true })
                .abortSignal(controller.signal)
            : Promise.resolve({ data: [] }),
          isRateMyGrails
            ? supabase.from('grail_ratings').select('rater_user_id, score').eq('post_id', postId).abortSignal(controller.signal)
            : Promise.resolve({ data: [] }),
          isCardShare
            ? supabase
                .from('card_share_items')
                .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
                .eq('post_id', postId)
                .order('display_order', { ascending: true })
                .abortSignal(controller.signal)
            : Promise.resolve({ data: [], error: null }),
        ]);

        if (loadControllerRef.current !== controller || controller.signal.aborted) return;

        // Same manual pattern as the postError check above (this catch
        // block only exists to guard the batch's staleness/abort state,
        // not to convert thrown errors into this specific message) — a
        // card_share post whose own cards failed to load can't be
        // meaningfully shown, same severity as the post row itself
        // failing. Never treated as "zero cards" — that's only true when
        // the query actually succeeds with an empty result.
        if (cardShareItemsRes.error) {
          console.error('[PostDetail] load: card_share_items query failed:', cardShareItemsRes.error.message, cardShareItemsRes.error);
          setLoadError(cardShareItemsRes.error.message);
          return;
        }

        const likeRows = (likesRes.data ?? []) as any[];
        const p = profileRes.data as any;
        const item = itemRes.data as any;
        const ratingRows = (ratingsRes.data ?? []) as any[];

        setPost({
          id: row.id,
          user_id: row.user_id,
          post_type: (row.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails' | 'card_share',
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
          cardShareItems: (cardShareItemsRes.data ?? []) as CardShareItem[],
        });

        setComments(commentsResult.comments);
        setCommentsError(commentsResult.error);
      } catch (e) {
        if (controller.signal.aborted || loadControllerRef.current !== controller) return;
        if (__DEV__) console.error('[PostDetail] load failed:', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load post.');
      } finally {
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      controller.abort();
    };
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
    // sending is checked and set synchronously (no await before it), so a
    // second tap/return-key-press dispatched while the first is still in
    // flight is rejected here rather than racing it.
    if (!currentUserId || !newComment.trim() || !post || sending) return;
    setSending(true);
    const body = newComment.trim();

    console.log('[PostDetail][DEBUG] handleAddComment: inserting', {
      postId: post.id,
      userId: currentUserId,
      bodyLength: body.length,
    });

    const { data: inserted, error } = await supabase
      .from('comments')
      .insert({ user_id: currentUserId, post_id: post.id, body })
      .select('id, user_id, body, created_at')
      .single();

    if (error || !inserted) {
      console.error('[PostDetail] handleAddComment: insert failed:', error?.message, error);
      Alert.alert('Comment failed', error?.message ?? 'Could not post your comment. Please try again.');
      setSending(false);
      return;
    }

    console.log('[PostDetail][DEBUG] handleAddComment: insert succeeded', { commentId: inserted.id });

    // Only clear the input once the insert is confirmed successful.
    setNewComment('');

    if (post.user_id !== currentUserId) {
      supabase.from('notifications').insert({
        user_id: post.user_id,
        actor_id: currentUserId,
        type: 'comment',
        post_id: post.id,
      }).then(({ error: e }) => { if (e) console.error('Comment notif failed:', e.message); });
    }

    const result = await fetchComments(post.id);
    if (result.error) {
      // The comment is already saved server-side — don't let a failed
      // refresh wipe the list back to whatever was there before. Append
      // the row we just got back from the insert instead, so it's still
      // visible immediately.
      console.error('[PostDetail] handleAddComment: refresh after insert failed:', result.error);
      setCommentsError(result.error);
      setComments((prev) => [
        ...prev,
        {
          id: inserted.id,
          user_id: inserted.user_id,
          body: inserted.body,
          created_at: inserted.created_at,
          username: 'you',
          display_name: null,
          avatar_url: null,
        },
      ]);
    } else {
      setComments(result.comments);
      setCommentsError(null);
    }

    setSending(false);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }

  async function retryLoadComments() {
    if (!post) return;
    const result = await fetchComments(post.id);
    if (result.error) {
      setCommentsError(result.error);
    } else {
      setComments(result.comments);
      setCommentsError(null);
    }
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
            console.error('[PostDetail] handleDeleteComment failed:', error.message, error);
            Alert.alert('Error', 'Could not delete comment. Please try again.');
          } else {
            setComments((prev) => prev.filter((c) => c.id !== commentId));
          }
        },
      },
    ]);
  }

  // Same title/body/Cancel-Delete shape as this app's other destructive-
  // action confirmations (app/item/[id].tsx's handleDelete, folder-edit-
  // modal.tsx's confirmDeleteFolder, components/feed/post-card.tsx's own
  // handleDeleteTap for the feed/profile-list version of this same
  // action). On success, navigates back — there's no post left here to
  // display. On failure, the post stays fully visible and untouched;
  // nothing was removed optimistically on this single-post screen.
  function handleDeletePostPress() {
    if (!post || deletingPost) return;
    Alert.alert(
      'Delete Post',
      "This will permanently remove this post, its comments, and likes. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingPost(true);
            const result = await deletePost(post.id);
            if (result.status !== 'ok') {
              console.error('[PostDetail] handleDeletePostPress failed:', result.reason);
              setDeletingPost(false);
              Alert.alert('Error', 'Could not delete post. Please try again.');
              return;
            }
            handleBack();
          },
        },
      ],
    );
  }

  const headerBackLeft = () => <HeaderBackButton onPress={handleBack} displayMode="minimal" />;

  if (loading && !post) {
    return (
      <>
        <Stack.Screen options={{ title: 'Post', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Post', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Could not load this post.</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
        </View>
      </>
    );
  }

  if (notFound || !post) {
    return (
      <>
        <Stack.Screen options={{ title: 'Post', headerLeft: headerBackLeft }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Post not found.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: `@${post.username}`,
          headerBackTitle: '',
          headerLeft: headerBackLeft,
          headerRight:
            post.user_id === currentUserId
              ? () =>
                  deletingPost ? (
                    <ActivityIndicator size="small" color="#0a7ea4" style={styles.headerDeleteBtn} />
                  ) : (
                    <TouchableOpacity
                      onPress={handleDeletePostPress}
                      style={styles.headerDeleteBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Post options">
                      <Text style={styles.headerDeleteText}>Delete</Text>
                    </TouchableOpacity>
                  )
              : undefined,
        }}
      />
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

        {commentsError && (
          <View style={styles.commentsErrorBanner}>
            <Text style={styles.commentsErrorText} numberOfLines={2}>
              Comments could not load: {commentsError}
            </Text>
            <TouchableOpacity onPress={retryLoadComments} hitSlop={8}>
              <Text style={styles.commentsErrorRetry}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Comment input bar — extra bottom clearance (TAB_BAR_CLEARANCE)
            only while the keyboard is closed, so the "Post" button sits
            above the floating tab bar instead of underneath its
            touch-absorbing surface. See TAB_BAR_CLEARANCE's comment. */}
        <View
          style={[
            styles.inputBar,
            {
              paddingBottom: keyboardVisible
                ? Math.max(insets.bottom, 8)
                : Math.max(insets.bottom, 8) + TAB_BAR_CLEARANCE,
            },
          ]}>
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
  headerDeleteBtn: {
    paddingHorizontal: 4,
  },
  headerDeleteText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#E53935',
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
  errorDetail: {
    fontSize: 13,
    color: '#aaa',
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
  commentsErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FDECEA',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f5c6c2',
  },
  commentsErrorText: {
    flex: 1,
    fontSize: 12,
    color: '#B3261E',
  },
  commentsErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B3261E',
  },
  // Post header
  imageWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: '#e9ecef',
    overflow: 'hidden',
  },
  cardShareUnavailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardShareUnavailableText: {
    fontSize: 13,
    color: '#687076',
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

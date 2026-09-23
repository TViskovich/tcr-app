import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image as RNImage,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { FittedRoundedImage } from '@/components/feed/fitted-rounded-image';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { fetchPostImages } from '@/components/feed/post-card';
import { PostImageCarousel } from '@/components/feed/post-image-carousel';
import { ItemPhotoViewerModal } from '@/components/item-detail/item-photo-viewer-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { deletePost } from '@/lib/posts';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CardShareItem, PostImage, RateMyGrailCard } from '@/types';

// Post Detail's immersive text+photo media frame (app/post/[id].tsx's own
// tuning, distinct from the feed's TEXT_POST_* constants in post-card.tsx —
// this screen is meant to show the photo MUCH larger than the feed does).
// Bounds are looser than the feed's text-post frame (which deliberately
// keeps a photo "attached to text", not the main event) and the height cap
// is a bigger share of the viewport, while still leaving room below for the
// engagement row and reply bar to stay reachable without scrolling on a
// typical phone.
const DETAIL_MEDIA_MIN_ASPECT_RATIO = 3 / 5;
const DETAIL_MEDIA_MAX_ASPECT_RATIO = 4 / 3;
const DETAIL_MEDIA_DEFAULT_ASPECT_RATIO = 4 / 5;
const DETAIL_MEDIA_MAX_HEIGHT_FRACTION = 0.62;

function clampDetailMediaAspectRatio(ratio: number): number {
  return Math.min(DETAIL_MEDIA_MAX_ASPECT_RATIO, Math.max(DETAIL_MEDIA_MIN_ASPECT_RATIO, ratio));
}

// Extra clearance so the "Add a comment..." row sits above the
// globally-rendered floating tab bar (see components/navigation/
// global-floating-tab-bar.tsx, rendered as a root-level sibling of every
// screen outside app/(tabs) — it is NOT part of this screen's own view
// tree). Without this, the row sits underneath that bar's touch-absorbing
// surface and taps land on the tab bar's inert background instead — no
// error, no navigation, nothing happens. Unconditional now (feed comment/
// reply redesign moved the actual text input to its own screen, so nothing
// on this screen ever raises the keyboard anymore — no keyboard-open/closed
// distinction is needed here the way the old inline input bar required).
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
  // Text posts' 0-4 mixed-source images (see post-card.tsx's own FeedPost.images
  // comment) — empty for every non-'text' post_type and for any 'text' post
  // created before this feature existed (which may still fall back to the
  // legacy image_url below).
  images: PostImage[];
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

// Custom black top bar for the immersive text+photo layout ONLY — replaces
// the native Stack header for that one branch (see the screen's own
// isImmersiveText decision below). Back button on the left (BackButton,
// this app's one standardized back control), owner-only overflow/delete on
// the right (same confirm-then-delete action the native header's old
// headerRight offered — no new backend behavior), a same-size empty spacer
// in its place for a non-owner viewer so the back button stays put on the
// left rather than the row re-centering around one child. paddingTop
// absorbs the safe-area inset the native header used to provide.
function ImmersiveHeaderBar({
  insetTop,
  isOwner,
  deletingPost,
  onDeletePress,
}: {
  insetTop: number;
  isOwner: boolean;
  deletingPost: boolean;
  onDeletePress: () => void;
}) {
  return (
    <View style={[styles.immersiveTopBar, { paddingTop: insetTop + 6 }]}>
      <BackButton fallbackHref="/(tabs)" />
      {isOwner ? (
        deletingPost ? (
          <View style={styles.immersiveOverflowBtn}>
            <ActivityIndicator size="small" color={PV2.accent} />
          </View>
        ) : (
          <TouchableOpacity
            onPress={onDeletePress}
            hitSlop={10}
            style={styles.immersiveOverflowBtn}
            accessibilityRole="button"
            accessibilityLabel="Post options">
            <IconSymbol name="ellipsis" size={20} color={PV2.textPrimary} />
          </TouchableOpacity>
        )
      ) : (
        <View style={styles.immersiveOverflowBtn} />
      )}
    </View>
  );
}

// Large immersive media for a text post's attached photo(s) — the whole
// point of Phase 1. Reuses PostImageCarousel (multi-image) and
// FittedRoundedImage (single-image) unchanged from the feed rather than
// reimplementing paging/contain-fit — only the OUTER frame (edge-to-edge,
// no rounding, bigger max-height fraction) and the dots' POSITION (below
// the media, not overlaid on it — see PostImageCarousel's showDots prop)
// differ from the feed's own treatment of the exact same images. Tapping
// the current page opens the existing full-screen viewer
// (ItemPhotoViewerModal) via onOpenViewer — see this screen's own comment
// on that choice.
function ImmersiveMedia({
  images,
  legacyImageUrl,
  aspectRatio,
  maxHeight,
  activeIndex,
  onActiveIndexChange,
  onOpenViewer,
}: {
  images: PostImage[];
  legacyImageUrl: string | null;
  aspectRatio: number;
  maxHeight: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onOpenViewer: (uri: string) => void;
}) {
  const frameStyle = { aspectRatio, maxHeight };

  if (images.length > 1) {
    return (
      <View style={styles.immersiveMediaWrap}>
        <View style={[styles.immersiveMediaBox, frameStyle]}>
          <PostImageCarousel
            images={images.map((img) => ({ key: img.id, uri: img.image_url }))}
            mediaBorderRadius={0}
            showDots={false}
            onActiveIndexChange={onActiveIndexChange}
            onPress={() => onOpenViewer(images[activeIndex]?.image_url ?? images[0].image_url)}
          />
        </View>
        <View style={styles.immersiveDots} pointerEvents="none">
          {images.map((img, index) => (
            <View key={img.id} style={[styles.immersiveDot, index === activeIndex && styles.immersiveDotActive]} />
          ))}
        </View>
      </View>
    );
  }

  const uri = images[0]?.image_url ?? legacyImageUrl;
  if (!uri) return null;

  return (
    <View style={styles.immersiveMediaWrap}>
      <TouchableOpacity
        style={[styles.immersiveMediaBox, frameStyle]}
        onPress={() => onOpenViewer(uri)}
        activeOpacity={0.95}>
        <FittedRoundedImage uri={uri} radius={0} />
      </TouchableOpacity>
    </View>
  );
}

// Defined outside the screen so FlatList ListHeaderComponent doesn't remount on re-renders
function PostHeader({
  post,
  commentCount,
  likeScaleAnim,
  onLikeTap,
  rating,
  onRate,
  hasImmersiveMedia,
  mediaFrame,
  activeMediaIndex,
  onActiveMediaIndexChange,
  onOpenMediaViewer,
}: {
  post: PostDetail;
  commentCount: number;
  likeScaleAnim: Animated.Value;
  onLikeTap: () => void;
  rating: { avg: number | null; count: number; myRating: number | null; isOwner: boolean; submitting: boolean };
  onRate: (score: number) => void;
  // Text-post-with-media-only — see the screen's own hasImmersiveMedia calc.
  hasImmersiveMedia: boolean;
  mediaFrame: { aspectRatio: number; maxHeight: number };
  activeMediaIndex: number;
  onActiveMediaIndexChange: (index: number) => void;
  onOpenMediaViewer: (uri: string) => void;
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

      {/* Post body — text for text posts (immersive media block first when
          a text post actually has an attached photo — see hasImmersiveMedia
          below; this branch previously never rendered any image for a text
          post at all, even when one existed), grails grid for Rate My
          Grails, carousel for card_share, image otherwise */}
      {post.post_type === 'text' ? (
        hasImmersiveMedia ? (
          <>
            <ImmersiveMedia
              images={post.images}
              legacyImageUrl={post.image_url}
              aspectRatio={mediaFrame.aspectRatio}
              maxHeight={mediaFrame.maxHeight}
              activeIndex={activeMediaIndex}
              onActiveIndexChange={onActiveMediaIndexChange}
              onOpenViewer={onOpenMediaViewer}
            />
            {post.content ? <Text style={styles.caption}>{post.content}</Text> : null}
          </>
        ) : (
          <Text style={styles.textContent}>{post.content}</Text>
        )
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
  const [deletingPost, setDeletingPost] = useState(false);
  const likeScaleAnim = useRef(new Animated.Value(1)).current;
  const flatListRef = useRef<FlatList<Comment>>(null);

  // Immersive text+photo media (Phase 1) — natural aspect ratio of the lead
  // image, measured client-side exactly like post-card.tsx's own
  // mediaAspectRatio (nothing in the schema stores source width/height).
  // null until measured (or on failure), meaning "use
  // DETAIL_MEDIA_DEFAULT_ASPECT_RATIO". Only ever used for a text post that
  // actually has media — see hasImmersiveMedia below.
  const [mediaAspectRatio, setMediaAspectRatio] = useState<number | null>(null);
  // Which page of a multi-image carousel is currently showing — surfaced by
  // PostImageCarousel's onActiveIndexChange (momentum-end-only commits, same
  // as its own internal state) so tapping the media opens the full-screen
  // viewer on the actual visible photo, not always the first.
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  // Full-screen image viewer (ItemPhotoViewerModal, reused as-is — see this
  // screen's own comment on that choice) — null when closed.
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const { height: windowHeight } = useWindowDimensions();
  // Tracks each render's own comment count purely so the focus-refetch
  // effect below (which re-fetches on every refocus, e.g. returning from
  // the reply composer) can tell "a new comment actually arrived" apart
  // from "nothing changed" without depending on `comments` itself in that
  // effect's own deps (which would re-run it on every comment list update,
  // including the refetch's own setComments call — an infinite loop).
  const commentCountRef = useRef(0);
  useEffect(() => {
    commentCountRef.current = comments.length;
  }, [comments.length]);

  // Lead media URL for a text post's attached photo(s) — post_images (if
  // any, already ordered) first, then the legacy single image_url. Only
  // ever non-null for post_type 'text'; a stable primitive (not the images
  // array itself) so the measurement effect below doesn't re-run on every
  // unrelated post-object replacement.
  const leadMediaUri =
    post?.post_type === 'text' ? (post.images[0]?.image_url ?? post.image_url) : null;

  useEffect(() => {
    setMediaAspectRatio(null);
    if (!leadMediaUri) return;
    let cancelled = false;
    RNImage.getSize(
      leadMediaUri,
      (width, height) => {
        if (!cancelled && height > 0) setMediaAspectRatio(width / height);
      },
      () => {
        // Left as null (DETAIL_MEDIA_DEFAULT_ASPECT_RATIO fallback) — same
        // "measurement failure ≠ image-load failure" split as post-card.tsx's
        // own identical effect.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [leadMediaUri]);

  // Resets the carousel page back to the first image whenever the post
  // itself changes (e.g. a cold deep link straight into a different postId
  // while this screen instance is somehow reused) — never carries a stale
  // index from a previously-viewed post into a new one.
  useEffect(() => {
    setActiveMediaIndex(0);
  }, [post?.id]);

  // Owns the mount/postId-change load's request batch only — the
  // Retry-comments and post-a-comment refresh paths below are user-
  // triggered actions (not a mount/route effect), same classification as
  // profile-v2-screen.tsx's handleSave, so they're intentionally left
  // uncancelled. An in-flight request left running past the point this
  // screen unmounts can have its underlying XHR connection torn down by
  // the native networking layer and crash with whatwg-fetch's status-0
  // RangeError — see hooks/use-profile.ts for the full mechanism writeup.
  const loadControllerRef = useRef<AbortController | null>(null);

  // Prefer popping real history (preserves whatever screen/scroll position
  // the user actually came from — feed, profile, notifications, etc. — per
  // requirement). Only fall back to the main feed when there's genuinely no
  // history to go back to (e.g. a cold deep link straight into this route).
  function handleBack() {
    const canGoBack = router.canGoBack();
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

    return { comments, error: null };
  }, []);

  // Feed comment/reply redesign — this screen no longer owns its own
  // composer (the inline TextInput/"Post" bar was removed in favor of the
  // dedicated reply composer, app/post-reply/[id].tsx, opened by the
  // tappable row below). Since composing now happens on a separate routed
  // screen, refetch comments on every refocus so a reply just posted there
  // is visible immediately on return — same useFocusEffect-refetch
  // convention already used by app/collection/[folderId].tsx. Scoped to
  // `post?.id` (not the whole `post` object) so an optimistic like-count
  // update elsewhere on this screen — which does replace `post` with a new
  // object — can't spuriously retrigger this while already focused.
  useFocusEffect(
    useCallback(() => {
      if (!post) return;
      let cancelled = false;
      (async () => {
        const before = commentCountRef.current;
        const result = await fetchComments(post.id);
        if (cancelled) return;
        if (result.error) {
          setCommentsError(result.error);
        } else {
          setComments(result.comments);
          setCommentsError(null);
          if (result.comments.length > before) {
            setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [post?.id, fetchComments]),
  );

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
        const isText = row.post_type === 'text';

        const [profileRes, itemRes, likesRes, commentsResult, cardsRes, ratingsRes, cardShareItemsRes, postImagesMap] = await Promise.all([
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
          // Same "throws, not caught here" convention fetchPostImages
          // documents itself — a failure here propagates up through this
          // Promise.all rejection into the try/catch below (same handling
          // fetchCardShareItems's own failures get via cardShareItemsRes.error
          // just above, just via the throw path instead of a returned
          // {error} — see post-reply/[id].tsx's own identical call for
          // precedent), rather than silently rendering this text post with
          // no photo.
          isText ? fetchPostImages([postId], controller.signal) : Promise.resolve(new Map<string, PostImage[]>()),
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
          images: (postImagesMap as Map<string, PostImage[]>).get(row.id) ?? [],
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
        // Server-verified against the likes row that just committed
        // (create_or_refresh_like_notification RPC), never a direct client
        // insert.
        supabase.rpc('create_or_refresh_like_notification', { p_post_id: currentPost.id }).then(({ error: e }) => {
          if (e) console.error('Like notif failed:', e.message);
        });
      }
    });
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

  const headerBackLeft = () => <BackButton fallbackHref="/(tabs)" />;

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

  // Phase 1 scope gate — the immersive layout is for TEXT posts that
  // actually carry a photo (post_images and/or the legacy image_url) ONLY.
  // rate_my_grails/card_share/item posts and a plain text-only post all
  // keep the existing native-header layout below, completely untouched.
  const hasImmersiveMedia = post.post_type === 'text' && (post.images.length > 0 || !!post.image_url);
  const mediaFrame = {
    aspectRatio:
      mediaAspectRatio != null ? clampDetailMediaAspectRatio(mediaAspectRatio) : DETAIL_MEDIA_DEFAULT_ASPECT_RATIO,
    maxHeight: windowHeight * DETAIL_MEDIA_MAX_HEIGHT_FRACTION,
  };
  const isOwner = post.user_id === currentUserId;

  return (
    <>
      <Stack.Screen
        options={
          hasImmersiveMedia
            ? // Immersive layout renders its own black top bar (below) in
              // place of the native header — see ImmersiveHeaderBar's own
              // comment for why.
              { headerShown: false }
            : {
                title: `@${post.username}`,
                headerBackTitle: '',
                headerLeft: headerBackLeft,
                headerRight: isOwner
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
              }
        }
      />
      {/* Feed comment/reply redesign — this screen no longer hosts its own
          text input/keyboard, so it no longer needs KeyboardAvoidingView
          either (nothing on this screen ever raises the keyboard now; the
          reply composer is a separate routed screen that owns that). */}
      <View style={styles.container}>
        {hasImmersiveMedia && (
          <ImmersiveHeaderBar
            insetTop={insets.top}
            isOwner={isOwner}
            deletingPost={deletingPost}
            onDeletePress={handleDeletePostPress}
          />
        )}
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
              hasImmersiveMedia={hasImmersiveMedia}
              mediaFrame={mediaFrame}
              activeMediaIndex={activeMediaIndex}
              onActiveMediaIndexChange={setActiveMediaIndex}
              onOpenMediaViewer={setViewerUri}
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

        {/* Replaces the old inline TextInput/"Post" bar — tapping this row
            now opens the dedicated reply composer (app/post-reply/[id].tsx)
            instead of composing in place. Extra bottom clearance
            (TAB_BAR_CLEARANCE) is now unconditional (no keyboard ever opens
            on this screen anymore) so it always sits above the floating tab
            bar's touch-absorbing surface — see that constant's comment. */}
        <TouchableOpacity
          style={[styles.addCommentRow, { paddingBottom: Math.max(insets.bottom, 8) + TAB_BAR_CLEARANCE }]}
          onPress={() => post && router.push({ pathname: '/post-reply/[id]', params: { id: post.id } })}
          disabled={!post}
          activeOpacity={0.7}>
          <Text style={styles.addCommentPlaceholder}>Add a comment...</Text>
        </TouchableOpacity>
      </View>

      {/* Full-screen image viewer — reused as-is from Edit Item's photo
          inspector (components/item-detail/item-photo-viewer-modal.tsx)
          rather than building a second pinch/pan/zoom system. It shows only
          the single tapped photo (no paging of its own) — for a multi-image
          post this opens whichever page the carousel is currently on;
          swiping between images while zoomed in full-screen is deferred
          (see this screen's own Phase 2 notes). */}
      <ItemPhotoViewerModal visible={!!viewerUri} uri={viewerUri ?? undefined} onClose={() => setViewerUri(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  // Immersive text+photo layout only (replaces the native Stack header for
  // that one branch — see ImmersiveHeaderBar's own comment). Strong black,
  // not PV2.bg — this bar sits directly above the equally-black media, per
  // the "strong black/dark background" direction, rather than the app's
  // usual near-black panel shade.
  immersiveTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    backgroundColor: '#000',
  },
  // Same 44x44 footprint as BackButton's own touch target, for visual
  // symmetry on the row's opposite side (both an active button and the
  // non-owner empty-spacer case share this one size).
  immersiveOverflowBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Media + its below-media dot row — the "black background around any
  // unused space" the media box's own letterboxing/maxHeight cap can leave.
  immersiveMediaWrap: {
    backgroundColor: '#000',
    paddingBottom: 10,
  },
  // width: 100% + aspectRatio + maxHeight (the latter two set inline from
  // mediaFrame — see the JSX) is the same "Yoga resolves a true cap"
  // pattern post-card.tsx's own singleCardMaxHeight uses. No horizontal
  // padding/margin — edge-to-edge per the "use nearly the full available
  // width" direction, and no borderRadius — square corners read as more
  // "immersive" here than the feed's own rounded media frame.
  immersiveMediaBox: {
    width: '100%',
    backgroundColor: '#000',
  },
  immersiveDots: {
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    marginTop: 10,
  },
  immersiveDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  immersiveDotActive: {
    width: 16,
    backgroundColor: PV2.accent,
  },
  headerDeleteBtn: {
    paddingHorizontal: 4,
  },
  headerDeleteText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.accent,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  errorDetail: {
    fontSize: 13,
    color: PV2.textTertiary,
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
  // Same accentSoft-fill / accent-tinted-border error-banner convention as
  // app/collection/[folderId].tsx's own refreshErrorRow — not a one-off
  // light red here anymore.
  commentsErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: PV2.accentSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(232,24,26,0.35)',
  },
  commentsErrorText: {
    flex: 1,
    fontSize: 12,
    color: PV2.accent,
  },
  commentsErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.accent,
  },
  // Post header
  imageWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: PV2.collectorPanelBg,
    overflow: 'hidden',
  },
  cardShareUnavailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardShareUnavailableText: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  // Was its own separate '#1A1A1A' fill (a pre-dark-theme-unification
  // leftover) — components/feed/post-card.tsx's own card header already
  // dropped this exact same per-section fill in favor of one shared
  // PV2.bg for the whole post (see that file's own history comments); this
  // screen is the expanded/detail view of the same post header, so it now
  // matches that same already-completed pattern instead of carrying its
  // own separate near-black shade.
  grailsWrap: {
    padding: 12,
    backgroundColor: PV2.bg,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: PV2.bg,
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  userInfo: {
    flex: 1,
    gap: 1,
  },
  postDisplayName: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  postUsername: {
    fontSize: 12,
    color: PV2.textSecondary,
  },
  postAge: {
    fontSize: 12,
    color: PV2.textSecondary,
    flexShrink: 0,
  },
  textContent: {
    fontSize: 18,
    color: PV2.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 16,
    lineHeight: 26,
  },
  caption: {
    fontSize: 15,
    color: PV2.textPrimary,
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
    color: PV2.textSecondary,
    minWidth: 16,
  },
  // Burnt-orange "liked" accent (pairs with the 🔥 reaction) — not a
  // light-mode color, reads fine on a dark background as-is; left
  // untouched rather than remapped onto PV2.accent's red, which would
  // change this highlight's actual hue rather than just its theme.
  likedCount: {
    color: '#E65100',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
  },
  // Comments
  commentRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  commentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
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
    color: PV2.textPrimary,
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
    color: PV2.textPrimary,
  },
  commentAge: {
    fontSize: 11,
    color: PV2.textTertiary,
  },
  commentBody: {
    fontSize: 14,
    color: PV2.textPrimary,
    lineHeight: 20,
  },
  deleteBtn: {
    paddingLeft: 8,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  deleteText: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  emptyComments: {
    padding: 32,
    alignItems: 'center',
  },
  emptyCommentsText: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  // Add-comment row — replaces the old inline input bar; tapping it opens
  // the dedicated reply composer (app/post-reply/[id].tsx) instead.
  addCommentRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
    backgroundColor: PV2.bg,
  },
  addCommentPlaceholder: {
    fontSize: 15,
    color: PV2.textTertiary,
  },
});

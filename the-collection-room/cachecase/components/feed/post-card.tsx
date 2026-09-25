import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image as RNImage,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { FittedRoundedImage } from '@/components/feed/fitted-rounded-image';
import { PostImageCarousel } from '@/components/feed/post-image-carousel';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { supabase } from '@/lib/supabase';
import type { CardShareItem, PostImage, RateMyGrailCard } from '@/types';

export type FeedPost = {
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
  commentCount: number;
  isFollowing: boolean;
  grailCards: RateMyGrailCard[];
  avgRating: number | null;
  ratingCount: number;
  myRating: number | null;
  cardShareItems: CardShareItem[];
  // Text posts' 0-4 mixed-source images (supabase/migrations/
  // 20260911150000_create_post_images.sql), ordered by sort_order. Empty
  // for every post created before this feature existed, and for every
  // OTHER post_type (those keep using image_url/cardShareItems/grailCards
  // as before) — a legacy single-photo text post still has image_url set
  // and this stays [], which is exactly what keeps it rendering unchanged
  // (see PostCard's own isTextPost branch below).
  images: PostImage[];
};

// Shared by app/(tabs)/index.tsx's queryFeed and
// fetchUserPosts below — batch-fetches the grail snapshot rows + ratings for
// whichever of the given posts are Rate My Grails posts, keyed by post_id,
// so every caller builds FeedPost the same way. `signal` is required, not
// optional — every current caller is a mount/focus-driven load that owns an
// AbortController (see hooks/use-profile.ts for why an in-flight request
// left running past the point its caller unmounted or was superseded can
// crash with whatwg-fetch's status-0 RangeError).
export async function fetchGrailData(postIds: string[], signal: AbortSignal, currentUserId?: string) {
  const [cardsRes, ratingsRes] = await Promise.all([
    supabase
      .from('rate_my_grail_cards')
      .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
      .in('post_id', postIds)
      .order('display_order', { ascending: true })
      .abortSignal(signal),
    supabase.from('grail_ratings').select('post_id, rater_user_id, score').in('post_id', postIds).abortSignal(signal),
  ]);

  const cardsMap = new Map<string, RateMyGrailCard[]>();
  for (const row of (cardsRes.data ?? []) as any[]) {
    const list = cardsMap.get(row.post_id) ?? [];
    list.push(row as RateMyGrailCard);
    cardsMap.set(row.post_id, list);
  }

  const ratingTotals = new Map<string, { sum: number; count: number; mine: number | null }>();
  for (const row of (ratingsRes.data ?? []) as any[]) {
    const entry = ratingTotals.get(row.post_id) ?? { sum: 0, count: 0, mine: null };
    entry.sum += row.score;
    entry.count += 1;
    if (row.rater_user_id === currentUserId) entry.mine = row.score;
    ratingTotals.set(row.post_id, entry);
  }

  return { cardsMap, ratingTotals };
}

// Shared by app/(tabs)/index.tsx's queryFeed and
// fetchUserPosts below — batch-fetches card_share_items for whichever of
// the given posts are 'card_share' posts, keyed by post_id, mirroring
// fetchGrailData's shape above. `signal` required for the same reason as
// fetchGrailData's.
export async function fetchCardShareItems(postIds: string[], signal: AbortSignal): Promise<Map<string, CardShareItem[]>> {
  const map = new Map<string, CardShareItem[]>();

  if (postIds.length === 0) {
    return map;
  }

  const { data, error } = await supabase
    .from('card_share_items')
    .select('id, post_id, item_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
    .in('post_id', postIds)
    .order('display_order', { ascending: true })
    .abortSignal(signal);

  if (error) {
    // Same reasoning as app/(tabs)/index.tsx's queryFeed
    // — expected cancellation (focus-loss/request-replacement) must not be
    // logged as a real failure. Still thrown either way, unchanged: the
    // caller's own controller.signal.aborted check already discards an
    // aborted result correctly regardless of what's thrown here.
    if (!signal.aborted) {
      console.error('[fetchCardShareItems] query failed:', error.message, error);
    }
    throw error;
  }

  for (const row of (data ?? []) as CardShareItem[]) {
    const list = map.get(row.post_id) ?? [];
    list.push(row);
    map.set(row.post_id, list);
  }

  return map;
}

// Shared by app/(tabs)/index.tsx's queryFeed and
// fetchUserPosts below — batch-fetches post_images for whichever of the
// given posts are 'text' posts, keyed by post_id. Exact same shape/
// convention as fetchCardShareItems above (one batched query across every
// post id, ordered by sort_order, never one query per post). A 'text' post
// created before this feature existed simply has zero rows here — its map
// entry is just never set, and PostCard falls back to its legacy
// image_url rendering for that case.
export async function fetchPostImages(postIds: string[], signal: AbortSignal): Promise<Map<string, PostImage[]>> {
  const map = new Map<string, PostImage[]>();

  if (postIds.length === 0) {
    return map;
  }

  const { data, error } = await supabase
    .from('post_images')
    .select('id, post_id, item_id, image_url, source_type, sort_order')
    .in('post_id', postIds)
    .order('sort_order', { ascending: true })
    .abortSignal(signal);

  if (error) {
    // Same reasoning as fetchCardShareItems above — expected cancellation
    // must not be logged as a real failure, but is still thrown either
    // way so the caller's own abort check decides what to do with it.
    if (!signal.aborted) {
      console.error('[fetchPostImages] query failed:', error.message, error);
    }
    throw error;
  }

  for (const row of (data ?? []) as PostImage[]) {
    const list = map.get(row.post_id) ?? [];
    list.push(row);
    map.set(row.post_id, list);
  }

  return map;
}

// One user's own post history, newest first — no date window, no engagement
// ranking (unlike the main feed's queryFeed), since this powers a profile's
// Posts tab rather than a ranked/windowed feed. Mirrors queryFeed's row
// shaping so it can reuse the same PostCard renderer below. `signal`
// required — see fetchGrailData's comment above.
export async function fetchUserPosts(userId: string, signal: AbortSignal, currentUserId?: string): Promise<FeedPost[]> {
  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, item_id, post_type, image_url, content, caption, created_at')
    .eq('user_id', userId)
    .in('post_type', ['item', 'text', 'rate_my_grails', 'card_share'])
    .order('created_at', { ascending: false })
    .abortSignal(signal);

  if (postsError) {
    console.error('[fetchUserPosts] posts query failed:', postsError.message, postsError);
    throw postsError;
  }

  if (!postRows?.length) return [];

  const itemIds = [...new Set((postRows as any[]).map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = (postRows as any[]).map((p) => p.id as string);
  const grailPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'rate_my_grails')
    .map((p) => p.id as string);
  const cardSharePostIds = (postRows as any[])
    .filter((p) => p.post_type === 'card_share')
    .map((p) => p.id as string);
  const textPostIds = (postRows as any[])
    .filter((p) => p.post_type === 'text')
    .map((p) => p.id as string);

  const [profileRes, itemsRes, likesRes, commentsRes, grailData, cardShareMap, postImagesMap] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, hero_display_name, avatar_url')
      .eq('id', userId)
      .abortSignal(signal)
      .single(),
    itemIds.length > 0
      ? supabase.from('collection_items').select('id, name, image_url').in('id', itemIds).abortSignal(signal)
      : Promise.resolve({ data: [] }),
    supabase.from('likes').select('post_id, user_id').in('post_id', postIds).abortSignal(signal),
    supabase.from('comments').select('post_id').in('post_id', postIds).abortSignal(signal),
    grailPostIds.length > 0
      ? fetchGrailData(grailPostIds, signal, currentUserId)
      : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
    // fetchCardShareItems throws on failure (logging its own error first) —
    // deliberately not caught here, so a card-share query failure fails
    // this whole fetch loudly via the caller's own error handling, rather
    // than silently rendering posts with missing card data.
    fetchCardShareItems(cardSharePostIds, signal),
    // Same "throws, not caught here" convention as fetchCardShareItems —
    // a post_images query failure must fail this whole fetch loudly, not
    // silently render text posts with missing images.
    fetchPostImages(textPostIds, signal),
  ]);

  const profile = (profileRes.data as any) ?? {};
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  const likeCountMap = new Map<string, number>();
  const likedSet = new Set<string>();
  for (const row of (likesRes.data ?? []) as any[]) {
    likeCountMap.set(row.post_id, (likeCountMap.get(row.post_id) ?? 0) + 1);
    if (row.user_id === currentUserId) likedSet.add(row.post_id);
  }

  const commentCountMap = new Map<string, number>();
  for (const row of (commentsRes.data ?? []) as any[]) {
    commentCountMap.set(row.post_id, (commentCountMap.get(row.post_id) ?? 0) + 1);
  }

  const { cardsMap, ratingTotals } = grailData;

  return (postRows as any[]).map((post) => {
    const item = post.item_id ? (itemMap.get(post.item_id) ?? {}) : {};
    const rating = ratingTotals.get(post.id);
    return {
      id: post.id,
      user_id: post.user_id,
      post_type: (post.post_type ?? 'item') as 'item' | 'text' | 'rate_my_grails' | 'card_share',
      image_url: post.image_url ?? (item as any).image_url ?? null,
      content: post.content ?? null,
      caption: post.caption ?? null,
      created_at: post.created_at,
      item_name: (item as any).name ?? null,
      username: profile.username ?? 'user',
      // Hero/display name first, matching the profile identity card's own
      // source of truth (profile-v2-screen.tsx's `hero_display_name ||
      // display_name || ...`) — same fallback queryFeed
      // in app/(tabs)/index.tsx uses, so every PostCard consumer (Feed,
      // and this file's own fetchUserPosts for a profile's Posts tab)
      // resolves the author name identically. PostCard's own
      // `post.display_name || post.username` (unchanged) completes the
      // fallback down to username.
      display_name: profile.hero_display_name || profile.display_name || null,
      avatar_url: profile.avatar_url ?? null,
      likeCount: likeCountMap.get(post.id) ?? 0,
      liked: likedSet.has(post.id),
      commentCount: commentCountMap.get(post.id) ?? 0,
      isFollowing: false,
      grailCards: cardsMap.get(post.id) ?? [],
      avgRating: rating ? rating.sum / rating.count : null,
      ratingCount: rating?.count ?? 0,
      myRating: rating?.mine ?? null,
      cardShareItems: cardShareMap.get(post.id) ?? [],
      images: postImagesMap.get(post.id) ?? [],
    };
  });
}

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PostCard({
  post,
  currentUserId,
  onUserPress,
  onPostPress,
  onCommentPress,
  onLike,
  onDelete,
}: {
  post: FeedPost;
  currentUserId: string | undefined;
  onUserPress: () => void;
  onPostPress: () => void;
  // Feed comment/reply redesign — the comment icon now opens the dedicated
  // reply composer (app/post-reply/[id].tsx) instead of reusing
  // onPostPress's plain "go to post detail" navigation. Required (not
  // optional) since both real call sites (app/(tabs)/index.tsx,
  // profile-v2-posts.tsx) already wire a real handler.
  onCommentPress: () => void;
  onLike: () => void;
  // Owner-only — omitted (or simply never rendered, see isOwner below) for
  // every other viewer's post. The caller owns the actual delete request
  // and local list update; this component only surfaces the confirmed
  // intent.
  onDelete?: () => void;
}) {
  const [imageError, setImageError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const isTextPost = post.post_type === 'text';
  const isRateMyGrails = post.post_type === 'rate_my_grails';
  const isCardShare = post.post_type === 'card_share';
  const isOwner = !!currentUserId && currentUserId === post.user_id;

  // Single-card ('item') post media height cap — SINGLE_CARD_MAX_HEIGHT_FRACTION
  // of the actual device viewport, not a fixed pixel value, so this scales
  // sensibly across phone sizes. useWindowDimensions (not a one-time
  // Dimensions.get('window') snapshot) so this stays correct if the window
  // ever changes (rotation, split-view) without needing a remount. Applied
  // as an explicit maxHeight below, on top of aspectRatio sizing — see
  // mediaImageWrapSingle's own comment for why both are needed together.
  const { height: windowHeight } = useWindowDimensions();
  const singleCardMaxHeight = windowHeight * SINGLE_CARD_MAX_HEIGHT_FRACTION;

  // Natural aspect ratio of the current post's LEAD image, measured
  // client-side — nothing in the schema stores source width/height, so
  // this is the only way to size the box to the image's real shape rather
  // than force-cropping every post into a fixed 5:7 box. null until
  // measured (or on failure), meaning "use MEDIA_DEFAULT_ASPECT_RATIO".
  // Shared by the standard image path AND card-share: a card-share post's
  // outer Feed frame is now derived from its FIRST card's image, using the
  // exact same measure→clamp→maxHeight pipeline a single-photo post uses
  // (see clampSingleCardAspectRatio and its own call sites below) — the
  // carousel itself still swipes internally between differently-shaped
  // cards without ever resizing (see cardImageWrap's own comment), but the
  // Feed footprint it presents is now sized the same way a single-photo
  // post's is, rather than an independent, always-5/7 rule that existed
  // only because this was a carousel. rate_my_grails is still excluded —
  // GrailsPostBody is a static grid with its own layout, not part of this
  // single/multi-photo frame unification.
  const [mediaAspectRatio, setMediaAspectRatio] = useState<number | null>(null);

  // Text-post photo frame — same viewport-relative cap idea as
  // singleCardMaxHeight above, but a smaller fraction, so a text photo never
  // out-sizes a shared card. Shared by the single-image, carousel, and
  // legacy-image_url text-post branches below.
  const textPhotoFrame = {
    aspectRatio: mediaAspectRatio != null ? clampMediaAspectRatio(mediaAspectRatio) : TEXT_POST_DEFAULT_ASPECT_RATIO,
    maxHeight: windowHeight * TEXT_POST_MAX_HEIGHT_FRACTION,
  };

  // Stable primitive (a URL string, or null) rather than depending on
  // post.cardShareItems (a fresh array reference on every parent re-render
  // even when its content is unchanged) — keeps the effect below from
  // re-measuring on every render that doesn't actually change which image
  // is the lead card.
  const cardShareLeadImageUrl = isCardShare ? (post.cardShareItems[0]?.snapshot_image_url ?? null) : null;

  // Same lead-image measurement, extended to post_images-backed text posts
  // (1 image, or the 2-4 image carousel): a 1-image post is now measured
  // and sized exactly like the carousel rather than sitting in
  // AttachmentImageGrid's fixed-4:3 cropped tile. createTextPost never
  // writes posts.image_url for a post_images-backed post (it only inserts
  // post_images rows), so post.image_url is null here regardless — this is
  // genuinely a separate source, not a duplicate of the branch below.
  const postImagesLeadUrl =
    isTextPost && post.images.length > 0 ? (post.images[0]?.image_url ?? null) : null;

  useEffect(() => {
    setMediaAspectRatio(null);
    if (isRateMyGrails) return;
    // Text posts CAN carry an optional attached photo (app/post/new.tsx)
    // and reuse this exact responsive sizing via post.image_url (or, for a
    // 2-4 image post, via postImagesLeadUrl above); card-share posts have
    // no top-level image_url at all and measure their first card's
    // snapshot instead (see cardShareLeadImageUrl above).
    const uri = isCardShare ? cardShareLeadImageUrl : (postImagesLeadUrl ?? post.image_url);
    if (!uri) return;
    let cancelled = false;
    RNImage.getSize(
      uri,
      (width, height) => {
        if (!cancelled && height > 0) setMediaAspectRatio(width / height);
      },
      () => {
        // Left as null (MEDIA_DEFAULT_ASPECT_RATIO fallback) — a failed
        // measurement here is not the same failure as the image itself
        // failing to load (that's handled by the Image's own onError /
        // imageError state below), so this must never trip that path.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [post.image_url, postImagesLeadUrl, cardShareLeadImageUrl, isRateMyGrails, isCardShare]);

  const rating = useGrailRating({
    postId: post.id,
    postOwnerId: post.user_id,
    currentUserId,
    initialAvg: post.avgRating,
    initialCount: post.ratingCount,
    initialMyRating: post.myRating,
  });

  function handleLikeTap() {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.4, duration: 80, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 10 }),
    ]).start();
    onLike();
  }

  // Same title/body/Cancel-Delete shape as this codebase's other
  // destructive-action confirmations (e.g. app/item/[id].tsx's
  // handleDelete, folder-edit-modal.tsx's confirmDeleteFolder) — there's
  // no separate "menu" step elsewhere in this app either, so tapping the
  // single owner-only affordance goes straight to this confirmation.
  function handleDeleteTap() {
    Alert.alert(
      'Delete Post',
      "This will permanently remove this post, its comments, and likes. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ],
    );
  }

  // Only hide on image error for item posts — text posts have no image to fail.
  if (imageError && !isTextPost) return null;

  const displayName = post.display_name || post.username;

  return (
    <View style={styles.card}>
      {/* User row — tapping the avatar/name/date group navigates to their
          public profile; the owner-only "..." sits outside that touch
          target as its own sibling, in the same row. */}
      <View style={styles.cardHeader}>
        <TouchableOpacity style={styles.cardHeaderUserTouch} onPress={onUserPress} activeOpacity={0.7}>
          <View style={styles.cardAvatar}>
            {post.avatar_url ? (
              <Image
                source={{ uri: post.avatar_url }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={200}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.cardAvatarPlaceholder]}>
                <Text style={styles.cardAvatarInitial}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.cardIdentityLine}>
            <Text style={styles.cardDisplayName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.cardUsername} numberOfLines={1}>
              @{post.username}
            </Text>
          </View>
          <Text style={styles.cardDate}>{formatAge(post.created_at)}</Text>
        </TouchableOpacity>

        {isOwner && onDelete && (
          <TouchableOpacity
            onPress={handleDeleteTap}
            hitSlop={10}
            style={styles.moreBtn}
            accessibilityRole="button"
            accessibilityLabel="Post options">
            <IconSymbol name="ellipsis" size={18} color="rgba(255,255,255,0.55)" />
          </TouchableOpacity>
        )}
      </View>

      {/* Post body — text block for text posts (optionally followed by an
          attached photo, see app/post/new.tsx), grails grid for Rate My
          Grails, image otherwise. The standard image path (final branch
          below) gets the X-style indented content column — caption/
          hashtag text directly above a large, edge-forward image whose
          left edge lines up with the identity text above it (never under
          the avatar). Rate My Grails keeps its own previous full-bleed
          grid wrapper, unchanged — GrailsPostBody is a static grid, not a
          swipeable carousel, and wasn't part of the single/multi-photo
          sizing mismatch this pass fixes. CardShare's own wrapper below now
          reuses the exact same content column, media box, AND aspect-ratio
          sizing rule as the standard single-photo path (mediaContentColumn/
          mediaContentColumnFull/mediaImageWrapSingle/singleCardMaxHeight/
          clampSingleCardAspectRatio) rather than its own independent,
          always-5/7 frame — the frame is measured once from the first
          card's image (see mediaAspectRatio's own comment above) and then
          held fixed while swiping, so the two post types now present the
          same outer Feed footprint by construction, not by two separately
          tuned sizing systems that happen to look similar. Its caption
          still renders separately, after the media (see cardBody below) —
          only the outer media footprint changed here. */}
      {isRateMyGrails ? (
        <View style={styles.cardGrailsWrap}>
          <GrailsPostBody
            cards={post.grailCards}
            caption={post.caption}
            avg={rating.avg}
            count={rating.count}
            myRating={rating.myRating}
            isOwner={rating.isOwner}
            submitting={rating.submitting}
            onRate={rating.submitRating}
          />
        </View>
      ) : isCardShare ? (
        // card_share posts have no top-level image_url (their images live
        // in card_share_items instead) — must never fall through to the
        // plain-image branch below, which would pass an undefined uri to
        // Image. An empty cardShareItems list (query returned zero rows
        // for this specific post, distinct from the whole fetch failing —
        // see fetchCardShareItems) gets a controlled fallback instead of
        // silently rendering nothing.
        <View style={[styles.mediaContentColumn, styles.mediaContentColumnFull]}>
          <View
            style={[
              styles.cardImageWrap,
              styles.mediaImageWrapSingle,
              {
                // Same measure→clamp→maxHeight pipeline the single-photo
                // path uses (clampSingleCardAspectRatio, singleCardMaxHeight)
                // — see mediaAspectRatio's own comment above for why this is
                // measured from the FIRST card specifically. Fixed for the
                // lifetime of this render regardless of which card is
                // currently swiped to; only the image inside changes
                // per-slide (contentFit="contain" in CardSharePostBody), the
                // outer frame does not.
                aspectRatio:
                  mediaAspectRatio != null ? clampSingleCardAspectRatio(mediaAspectRatio) : MEDIA_DEFAULT_ASPECT_RATIO,
                maxHeight: singleCardMaxHeight,
              },
            ]}>
            {post.cardShareItems.length > 0 ? (
              <CardSharePostBody cards={post.cardShareItems} mediaBorderRadius={MEDIA_CORNER_RADIUS} />
            ) : (
              <View style={styles.cardShareUnavailable}>
                <Text style={styles.cardShareUnavailableText}>Shared cards unavailable</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <>
          {isTextPost && (
            <TouchableOpacity style={styles.cardTextWrap} onPress={onPostPress} activeOpacity={0.95}>
              <Text style={styles.cardTextContent}>{post.content}</Text>
            </TouchableOpacity>
          )}
          {/* A text post's 1 image (app/post/new.tsx) — no carousel/FlatList
              for a case that never needs to page. Sized by the same
              measured-ratio frame as the carousel below (textPhotoFrame) with
              contentFit="contain", instead of AttachmentImageGrid's fixed
              4:3 'cover' tile, which cropped most portrait/card photos.
              Every image_url in post.images is already durable
              share-snapshots data (same pipeline as the legacy single photo
              below), so no signed-image branch is needed here either.
              Tapping opens post detail (onPostPress) — unchanged. */}
          {isTextPost && post.images.length === 1 ? (
            <View style={[styles.mediaContentColumn, styles.mediaContentColumnFull]}>
              <TouchableOpacity
                style={[styles.mediaImageWrap, styles.mediaImageWrapText, textPhotoFrame]}
                onPress={onPostPress}
                activeOpacity={0.95}>
                {post.images[0].image_url ? (
                  // Rounds/clips the photo's own rectangle (see
                  // FittedRoundedImage) — the wrapper's radius alone only
                  // rounds the frame, which is larger than a letterboxed
                  // photo.
                  <FittedRoundedImage uri={post.images[0].image_url} radius={MEDIA_CORNER_RADIUS} />
                ) : null}
              </TouchableOpacity>
            </View>
          ) : isTextPost && post.images.length > 1 ? (
            /* 2-4 images — horizontal swipeable carousel (collage → carousel
                pass) instead of AttachmentImageGrid's collage, one image at
                a time, full post media width, native paging. Sized via the
                exact same measure→clamp→maxHeight frame (textPhotoFrame,
                'contain') the single-image and legacy branches use —
                measured once from post.images[0]
                (postImagesLeadUrl above) and held fixed while swiping, same
                "measured from the lead, frame never resizes mid-swipe"
                precedent CardSharePostBody already established for
                card-share. No aspectRatio-per-image, no per-count width
                change: every page (2, 3, or 4 images) fills this identical
                frame. Tapping any page opens post detail (onPostPress) —
                same handler the single-image/legacy paths already use, and
                the same tap target the previous whole-grid TouchableOpacity
                offered (there is still no separate full-screen image viewer
                in this app to defer to instead). */
            <View style={[styles.mediaContentColumn, styles.mediaContentColumnFull]}>
              <View style={[styles.mediaImageWrap, styles.mediaImageWrapText, textPhotoFrame]}>
                <PostImageCarousel
                  images={post.images.map((img) => ({ key: img.id, uri: img.image_url }))}
                  mediaBorderRadius={MEDIA_CORNER_RADIUS}
                  onPress={onPostPress}
                />
              </View>
            </View>
          ) : (
            /* A text post's optional LEGACY single attached photo (posts
                created before post_images existed — post.images is []
                for these) shares the exact same outer horizontal frame
                (mediaContentColumnFull's 12px inset + mediaImageWrapSingle's
                86%-centered width) as a genuine single-card share and
                card-share's carousel, so every media-bearing post type
                lines up on one common left/right edge in Feed — only the
                aspect-ratio RULE and contentFit still differ by type
                (clampMediaAspectRatio + 'cover' here vs.
                clampSingleCardAspectRatio + 'contain' for !isTextPost), not
                the frame's position/width. caption/item_name are
                item-post-only fields. Its image_url points at
                share-snapshots (copy-post-photo-to-share-snapshots), the
                same durable, always-public surface every other post image
                already renders from — no special signed-image branch
                needed here. */
            post.image_url && (
              <View style={[styles.mediaContentColumn, styles.mediaContentColumnFull]}>
                {!isTextPost && (post.caption || post.item_name) && (
                  <Text style={styles.mediaCaption}>{post.caption || post.item_name}</Text>
                )}
                <TouchableOpacity
                  style={[
                    styles.mediaImageWrap,
                    // Same isTextPost split this branch already applies to
                    // aspectRatio/contentFit below — a legacy (pre-
                    // post_images) text post's attached photo gets the same
                    // narrower text-post frame as the two branches above, for
                    // visual consistency across every text-post photo shape;
                    // an 'item' (sports card) post keeps the unchanged shared
                    // frame.
                    isTextPost ? styles.mediaImageWrapText : styles.mediaImageWrapSingle,
                    isTextPost
                      ? textPhotoFrame
                      : {
                          aspectRatio:
                            mediaAspectRatio != null
                              ? clampSingleCardAspectRatio(mediaAspectRatio)
                              : MEDIA_DEFAULT_ASPECT_RATIO,
                          // Viewport-relative height cap, single-card posts
                          // only (see singleCardMaxHeight's own comment
                          // above) — Yoga resolves this alongside
                          // aspectRatio as a true cap: the box is
                          // min(width / aspectRatio, this), never taller.
                          // When that cap is what actually binds (a tall
                          // portrait card at typical widths), the box's
                          // rendered shape no longer exactly matches the
                          // image's own ratio — contentFit="contain" (below)
                          // is what keeps the full card visible in that
                          // case, via letterboxing instead of a crop.
                          maxHeight: singleCardMaxHeight,
                        },
                  ]}
                  onPress={onPostPress}
                  activeOpacity={0.95}>
                  {isTextPost ? (
                    // Text-post photo: same photo-rectangle rounding as the
                    // single-image branch above. (imageError only ever hides
                    // non-text posts — see the early return — so no onError
                    // is needed here.)
                    <FittedRoundedImage uri={post.image_url} radius={MEDIA_CORNER_RADIUS} />
                  ) : (
                    <Image
                      source={{ uri: post.image_url }}
                      style={StyleSheet.absoluteFill}
                      // 'contain' (never crops — an aspect mismatch against
                      // the box above only ever letterboxes, so the full
                      // card is always visible even for an unusually-cropped
                      // upload).
                      contentFit="contain"
                      transition={200}
                      onError={() => setImageError(true)}
                    />
                  )}
                </TouchableOpacity>
              </View>
            )
          )}
        </>
      )}

      {/* Caption — CardShare only (its previous, un-indented position and
          wrapper, unchanged from Piece 3). Rate My Grails renders its own
          caption inside GrailsPostBody, above; the standard image path's
          caption already moved into mediaContentColumn in Piece 3. */}
      {isCardShare && (post.caption || post.item_name) ? (
        <View style={styles.cardBody}>
          <Text style={styles.cardCaption}>{post.caption || post.item_name}</Text>
        </View>
      ) : null}

      {/* Engagement row (Piece 4) — only the two controls with real,
          working behavior today: like (optimistic, backed by the likes
          table) and comment (opens post detail, same as before). Repost
          and bookmark have no functional backing for posts anywhere in
          this app (see this file's own investigation notes), and there is
          no native share action for a post either — none of the three are
          rendered rather than faked. Indented to MEDIA_CONTENT_LEFT_INSET,
          the same left inset Piece 3 established for the media/content
          column, so this row lines up with it instead of the avatar. */}
      <View style={styles.actionsRow}>
        {/* Comment first, matching the X-style mockup's icon order. Feed
            comment/reply redesign: now opens the dedicated reply composer
            (onCommentPress) instead of post detail (onPostPress) — tapping
            the rest of the card still opens post detail unchanged. Piece 6:
            emoji glyph replaced with IconSymbol's existing 'message'
            mapping (outline speech bubble) — no new icon system introduced. */}
        <TouchableOpacity onPress={onCommentPress} hitSlop={8} style={styles.commentBtn}>
          <IconSymbol name="message" size={19} color={PV2.textSecondary} />
          <Text style={styles.commentCount}>{post.commentCount}</Text>
        </TouchableOpacity>

        {/* Piece 6: emoji replaced with IconSymbol's existing 'heart'/
            'heart.fill' mapping (outline when inactive, filled when
            liked) — same scaleAnim wrapper, same handleLikeTap/onLike,
            same optimistic update, unchanged. */}
        <Pressable onPress={handleLikeTap} hitSlop={8} style={styles.likeBtn}>
          <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
            <IconSymbol
              name={post.liked ? 'heart.fill' : 'heart'}
              size={19}
              color={post.liked ? PV2.accent : PV2.textSecondary}
            />
          </Animated.View>
          <Text style={[styles.likeCount, post.liked && styles.likeCountActive]}>
            {post.likeCount}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// Left inset for the new indented content column (Piece 3 — caption/image
// for the standard image path) below the header — matches cardHeader's own
// paddingHorizontal (12) + cardAvatar's width (36) + cardHeaderUserTouch's
// avatar-to-identity gap (10), so that column's content lines up exactly
// under the identity text above it, never under the avatar.
const MEDIA_CONTENT_LEFT_INSET = 12 + 36 + 10;

// Single source of truth for the feed media frame's corner rounding —
// shared by mediaImageWrap (single-photo) and cardImageWrap (card-share),
// and passed down into CardSharePostBody itself (mediaBorderRadius prop)
// so each carousel slide is clipped to the same radius directly, not only
// via this outer wrapper's own overflow: 'hidden'. Previously each of the
// two outer styles carried its own independent `11` literal — visually
// identical, but two numbers that could silently drift apart; now there is
// exactly one.
const MEDIA_CORNER_RADIUS = 11;

// X/Twitter-inspired responsive single-image sizing — the standard
// image-path AND card-share (measured from its lead card) both use this;
// rate_my_grails is the one exception, keeping its own separate
// GrailsPostBody grid wrapper untouched. Bounds are expressed as width/height ratios, not a raw pixel
// ceiling: clamping the ratio's lower end IS the max-height guard an
// extremely tall upload needs, since height = width / ratio is capped at
// width / MIN once clamped, however tall the source image actually is. The
// upper end (2/1 — "2:1 landscape") keeps very wide/panoramic uploads from
// going too short — shared by both bounds below, unchanged. Used as the
// actual style only once the source image's natural size has been measured
// (see useEffect below); until then (or if measuring fails),
// MEDIA_DEFAULT_ASPECT_RATIO — 5/7, which also happens to already match a
// standard 2.5"x3.5" trading card almost exactly — is used as a
// same-as-before fallback so there's no layout jump for the common case
// and no broken box if getSize ever errors.
const MEDIA_MIN_ASPECT_RATIO = 4 / 5;
const MEDIA_MAX_ASPECT_RATIO = 2 / 1;
const MEDIA_DEFAULT_ASPECT_RATIO = 5 / 7;

// Text-post-with-photo path only, paired with contentFit="contain" (a
// mismatch letterboxes rather than crops). 4/5 — the tallest portrait a
// text photo may present — is what keeps it visibly shorter than a shared
// card's 1/2-bounded frame; a real 5/7 card photo just gets thin side bars.
// Not used by single-card ('item') posts — see clampSingleCardAspectRatio
// below.
function clampMediaAspectRatio(ratio: number): number {
  return Math.min(MEDIA_MAX_ASPECT_RATIO, Math.max(MEDIA_MIN_ASPECT_RATIO, ratio));
}

// Single-card ("item"-type) share posts — and, as of the single/multi-photo
// frame unification, card-share posts' lead-card frame too — get a much
// more permissive lower bound than the text-post path — real trading-card
// photos already hover
// right around MEDIA_DEFAULT_ASPECT_RATIO (5/7 ≈ a standard 2.5x3.5" card),
// so this rarely even triggers; it exists purely as a safety net against a
// pathological upload (e.g. an accidentally cropped tall sliver) making a
// feed post absurdly tall, not as an everyday crop guard the way the
// text-post bound is. Safe to be this loose specifically because this path
// pairs it with contentFit="contain" (see the JSX) — an aspect mismatch
// against this box only ever letterboxes, never crops, so a looser bound
// can never cut off part of the card the way it would under 'cover'.
const SINGLE_CARD_MIN_ASPECT_RATIO = 1 / 2;

function clampSingleCardAspectRatio(ratio: number): number {
  return Math.min(MEDIA_MAX_ASPECT_RATIO, Math.max(SINGLE_CARD_MIN_ASPECT_RATIO, ratio));
}

// Corrective pass — the width/height combination above (near-full-width
// column + a lower aspect-ratio bound loose enough to permit a 2:1
// portrait) had no ceiling on the RESULTING pixel height at all, so a
// typical tall card photo rendered at roughly screen_width * 2 tall —
// visually a near-fullscreen viewer, not a Feed post. Two independent caps
// fix this together (neither alone is enough): a width fraction, so the
// box's own baseline width is smaller to begin with, and a viewport-height
// fraction (singleCardMaxHeight, computed in the component from
// useWindowDimensions), so even a tall card can't exceed a fixed share of
// the visible screen regardless of width. mediaImageWrapSingle applies the
// width half of this; the height half is applied inline (see the JSX) since
// it depends on the live window height, not a static value StyleSheet.create
// can hold.
const SINGLE_CARD_WIDTH_FRACTION = 0.86;
const SINGLE_CARD_MAX_HEIGHT_FRACTION = 0.58;

// Text-post attached-photo path only (the single post_images photo, the 2-4
// image PostImageCarousel, and the legacy single post.image_url branch when
// isTextPost) — deliberately clearly smaller than the item/card-share frame
// above, which keeps using SINGLE_CARD_* unchanged, so a text post reads as
// text-first with a photo attached, not as a photo post. Width is 82% of that
// shared frame; height is capped at 42% of the viewport vs. the card frame's
// 58%, and the portrait ratio bound is 4/5 (see clampMediaAspectRatio) vs.
// the card frame's 1/2. The photo keeps its own measured shape within those
// bounds. TEXT_POST_DEFAULT_ASPECT_RATIO is the pre-measurement fallback —
// the tallest allowed shape, so the common portrait/card photo doesn't jump
// when its real ratio resolves.
const TEXT_POST_MEDIA_WIDTH_FRACTION = SINGLE_CARD_WIDTH_FRACTION * 0.82;
const TEXT_POST_MAX_HEIGHT_FRACTION = 0.42;
const TEXT_POST_DEFAULT_ASPECT_RATIO = MEDIA_MIN_ASPECT_RATIO;

const styles = StyleSheet.create({
  // X-style Piece 2 — flat, edge-to-edge, single unified dark surface (no
  // outer rounded card, no shadow/elevation, no per-section background
  // fills). Every sub-section below (header, text, grails, body) used to
  // carry its own separate '#1A1A1A' background against this card's white
  // one; now there's just this one PV2.bg for the whole post, and each
  // section only contributes spacing.
  // No horizontal/vertical padding here — media sections below
  // (cardImageWrap, cardGrailsWrap, CardSharePostBody) render edge-to-edge
  // exactly as before and must not inherit any new inset from this
  // container. Only the background is shared/unified now; every section
  // still owns its own spacing, same as before this pass.
  // Card-frame polish pass — each post is now its own contained card
  // (PV2.panel, slightly lighter than the screen's PV2.bg) rather than
  // sitting edge-to-edge in a stream separated by Piece 3's old bottom
  // hairline. That per-post borderBottom divider is removed here — it's
  // fully redundant now that every card has its own complete border.
  // marginHorizontal/marginBottom reuse this file's own existing 12px
  // inset unit (cardHeader's paddingHorizontal, mediaContentColumnFull's
  // "12px inset") rather than introducing a new spacing value.
  // borderColor is PV2.panelBorder specifically (not the more general
  // PV2.border) since that's the token this app's theme already pairs
  // with a PV2.panel background elsewhere. overflow: 'hidden' clips
  // content to the new rounded corners; every internal section still
  // renders exactly as before; nothing inside this card's box was moved,
  // resized, or restyled.
  card: {
    backgroundColor: PV2.panel,
    marginHorizontal: 6,
    marginBottom: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    overflow: 'hidden',
    // Very subtle depth only — same restrained shadow recipe this app's
    // theme already uses for an elevated dark surface (e.g. search.tsx's
    // toggleBtnActive), not a new visual language.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.16,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    // Piece 6 — tightened 6→4, a few more px off the header→caption gap.
    paddingBottom: 4,
  },
  cardHeaderUserTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  moreBtn: {
    paddingLeft: 10,
  },
  cardAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#333333',
    flexShrink: 0,
  },
  cardAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardAvatarInitial: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  // Display Name + @username inline on one line (was a two-line stack) —
  // the X-style identity row. cardDate stays a sibling right after this,
  // unchanged in position, so it still lands at the row's far right.
  cardIdentityLine: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  // Piece 6 — sizes nudged up (14→15, 700→600 "semibold" rather than
  // bold) to match the mockup's slightly larger, less heavy identity
  // line; avatar/gap/left-inset math untouched.
  cardDisplayName: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  cardUsername: {
    flexShrink: 1,
    fontSize: 14,
    color: PV2.textSecondary,
  },
  // Piece 6 — fontSize 12→14 and unified onto the PV2.textSecondary token
  // (was a separate, dimmer one-off rgba value).
  cardDate: {
    fontSize: 14,
    color: PV2.textSecondary,
    flexShrink: 0,
  },
  // CardShare's own media box. aspectRatio no longer lives here as a fixed
  // literal — like mediaImageWrap, it's set inline per-post from
  // mediaAspectRatio (measured from the FIRST card, clamped via
  // clampSingleCardAspectRatio — see the JSX and the mediaAspectRatio
  // useEffect above) or MEDIA_DEFAULT_ASPECT_RATIO before that resolves.
  // The frame still stays fixed for the lifetime of this render regardless
  // of which card is swiped to — only ever measured once, from the lead
  // card — so swiping between differently-shaped cards never resizes the
  // outer post. Sizing (width/centering/max-height) comes from
  // mediaImageWrapSingle + the inline maxHeight applied alongside this at
  // the JSX call site — the exact same rules the single-photo path uses —
  // so this style object only still owns the background, corner radius,
  // and clipping.
  cardImageWrap: {
    borderRadius: MEDIA_CORNER_RADIUS,
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
  // Standard image path only (Piece 3) — caption/hashtag text directly
  // above a large, edge-forward image, indented to MEDIA_CONTENT_LEFT_INSET
  // so its left edge lines up with the identity text above rather than the
  // avatar; right edge matches cardHeader's own 12px right inset. Still the
  // base style for a text post's attached photo (mediaContentColumnFull
  // below only ever applies ON TOP of this, and only for a genuine
  // single-card share).
  mediaContentColumn: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    // Piece 5 — tightened from 8 so this + actionsRow's own paddingTop
    // (also tightened) don't stack into a 16px dead zone before actions.
    paddingBottom: 6,
    // Piece 6 — 6→4, a few more px off the caption→image gap.
    gap: 4,
  },
  // X/Twitter reference sizing — applied to EVERY media-bearing post in the
  // standard image path (single-card 'item' posts, card-share via its own
  // JSX call site, and text posts' optional attached photo) so all three
  // share one horizontal frame. Overrides just paddingLeft, from
  // MEDIA_CONTENT_LEFT_INSET (58 — aligned under the identity TEXT, not the
  // avatar) down to 12, the same horizontal inset cardHeader/actionsRow's
  // own paddingRight already use — so the image spans nearly the full post
  // width, gutter-to-gutter with the header above and actions below,
  // instead of being indented an extra ~46px past them (still true for a
  // text post's photo now too). Caption text for single-card posts shares
  // this same column; a text post's own caption/content lives in the
  // separate cardTextWrap above, not here. Aspect-ratio sizing and
  // contentFit are controlled separately, at the mediaImageWrap/Image level
  // in the JSX, and still differ by post type — only this horizontal frame
  // is now shared.
  mediaContentColumnFull: {
    paddingLeft: 12,
  },
  mediaCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: PV2.textPrimary,
    lineHeight: 19,
  },
  // aspectRatio no longer lives here — it's now set inline per-post from
  // the measured (and clamped) natural ratio, or MEDIA_DEFAULT_ASPECT_RATIO
  // before that measurement resolves (see the JSX and useEffect above).
  // Corner treatment (11px radius) and placeholder background unchanged.
  mediaImageWrap: {
    borderRadius: MEDIA_CORNER_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  // Shared outer media frame — single-card ('item') posts, card-share's
  // carousel frame, AND a text post's optional attached photo all apply
  // this now, so every media-bearing Feed post gets the exact same
  // left/right edges (this is the single source of truth for that; see
  // mediaContentColumnFull's own comment for the matching column-padding
  // half of the pair). Only the maxHeight cap alongside this (see the JSX)
  // still differs — applied for !isTextPost, omitted for text posts — that
  // is a height-only exception, not a width/position one. '86%' is
  // relative to mediaContentColumn (this box's flex parent), which is
  // already inset 12px each side — not the raw screen width — so the image
  // reads as visibly narrower than the post's own header/caption row, with
  // real margins on both sides, rather than stretching to fill it.
  // alignSelf: 'center' is required here: mediaContentColumn is a plain
  // flex column (default alignItems: 'stretch'), so without this the box
  // would still stretch to 100% width before the percentage even applied
  // against a meaningfully smaller box.
  mediaImageWrapSingle: {
    width: `${SINGLE_CARD_WIDTH_FRACTION * 100}%`,
    alignSelf: 'center',
  },
  // Text-post attached-photo path only — see TEXT_POST_MEDIA_WIDTH_FRACTION's
  // own comment. Same alignSelf: 'center' as mediaImageWrapSingle (both
  // resolve against mediaContentColumn, the shared flex parent), just a
  // narrower percentage — centering this smaller box within the same column
  // is what produces the "small left/right inset" on top of
  // mediaContentColumnFull's existing 12px column padding, with no new
  // padding/margin of its own.
  mediaImageWrapText: {
    width: `${TEXT_POST_MEDIA_WIDTH_FRACTION * 100}%`,
    alignSelf: 'center',
  },
  // Padding (10, all sides) deliberately untouched — GrailsPostBody
  // renders a media grid, and any padding change would shift its internal
  // grid width math. Piece 5: the background fill was removed (the
  // separate '#1A1A1A' created a slightly different dark shade than the
  // rest of the now-unified PV2.bg card, a small two-tone seam within one
  // post) — this doesn't affect the box's size, only its fill, so it's
  // safe to drop without touching GrailsPostBody's layout.
  cardGrailsWrap: {
    padding: 10,
  },
  // No separate background/rounded container, left-aligned, tighter
  // spacing — flows directly on the card's own single dark surface. No
  // minHeight — that existed to keep a short text post visually
  // substantial as a floating card, which no longer applies.
  // Piece 5 — left inset consolidated onto MEDIA_CONTENT_LEFT_INSET (was
  // paddingHorizontal: 12 on both sides, a leftover from before Piece 3
  // introduced that constant): text posts are the last place that still
  // drifted from the identity/media/actions column's shared left edge.
  cardTextWrap: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    paddingBottom: 6,
  },
  cardTextContent: {
    fontSize: 15,
    color: PV2.textPrimary,
    lineHeight: 20,
  },
  // CardShare caption only now (Piece 4). Piece 5 — same left-inset
  // consolidation as cardTextWrap above, for the same reason.
  cardBody: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  cardCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: PV2.textPrimary,
    lineHeight: 19,
  },
  // Piece 4 — indented to MEDIA_CONTENT_LEFT_INSET (same as Piece 3's
  // mediaContentColumn) so the row aligns under the identity text/media
  // column, not the avatar. Compact, left-grouped rather than
  // space-between: only 2 controls actually exist today (see this file's
  // own investigation notes on repost/bookmark/share), so stretching them
  // to the row's full width would read as sparse rather than "evenly
  // distributed" the way a genuine 5-icon X row does.
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 28,
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    // Piece 5 — tightened (was 8/10) to match the also-tightened
    // paddingBottom on whatever precedes this row (mediaContentColumn/
    // cardTextWrap/cardBody), so media/text→actions and actions→divider
    // read as compact, consistent gaps rather than the previous 16px
    // combined dead zone before actions.
    paddingTop: 6,
    paddingBottom: 8,
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  // Piece 6 — default color now lives on the IconSymbol/Text elements
  // directly (PV2.textSecondary default, PV2.accent active), matching
  // commentCount's own treatment; likeEmoji/likeEmojiDim (the old emoji
  // opacity toggle) are gone with the emoji glyph itself.
  likeCount: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    minWidth: 16,
  },
  likeCountActive: {
    color: PV2.accent,
  },
  commentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  commentCount: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    minWidth: 16,
  },
});

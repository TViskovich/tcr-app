import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image as RNImage,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { supabase } from '@/lib/supabase';
import type { CardShareItem, RateMyGrailCard } from '@/types';

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
};

// Shared by app/(tabs)/index.tsx's queryFeed/queryFollowingFeed and
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

// Shared by app/(tabs)/index.tsx's queryFeed/queryFollowingFeed and
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
    // Same reasoning as app/(tabs)/index.tsx's queryFeed/queryFollowingFeed
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

  const [profileRes, itemsRes, likesRes, commentsRes, grailData, cardShareMap] = await Promise.all([
    supabase.from('profiles').select('id, username, display_name, avatar_url').eq('id', userId).abortSignal(signal).single(),
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
      display_name: profile.display_name ?? null,
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
  onLike,
  onDelete,
}: {
  post: FeedPost;
  currentUserId: string | undefined;
  onUserPress: () => void;
  onPostPress: () => void;
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

  // Natural aspect ratio of the standard image path's image, measured
  // client-side — nothing in the schema stores source width/height, so
  // this is the only way to size the box to the image's real shape rather
  // than force-cropping every post into a fixed 5:7 box. null until
  // measured (or on failure), meaning "use MEDIA_DEFAULT_ASPECT_RATIO".
  const [mediaAspectRatio, setMediaAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    setMediaAspectRatio(null);
    // Text posts CAN now carry an optional attached photo (app/post/new.tsx)
    // and reuse this exact responsive sizing — only rate_my_grails/
    // card_share (which render their own distinct multi-image bodies,
    // unrelated to post.image_url) are excluded here.
    if (isRateMyGrails || isCardShare || !post.image_url) return;
    let cancelled = false;
    RNImage.getSize(
      post.image_url,
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
  }, [post.image_url, isRateMyGrails, isCardShare]);

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
          below) gets the new X-style indented content column —
          caption/hashtag text directly above a large, edge-forward image
          whose left edge lines up with the identity text above it (never
          under the avatar). CardShare/Rate My Grails keep their previous
          caption-after-media positioning and full-bleed wrapper, unchanged
          this pass. */}
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
        <View style={styles.cardImageWrap}>
          {post.cardShareItems.length > 0 ? (
            <CardSharePostBody cards={post.cardShareItems} />
          ) : (
            <View style={styles.cardShareUnavailable}>
              <Text style={styles.cardShareUnavailableText}>Shared cards unavailable</Text>
            </View>
          )}
        </View>
      ) : (
        <>
          {isTextPost && (
            <TouchableOpacity style={styles.cardTextWrap} onPress={onPostPress} activeOpacity={0.95}>
              <Text style={styles.cardTextContent}>{post.content}</Text>
            </TouchableOpacity>
          )}
          {/* A text post's optional attached photo (app/post/new.tsx) reuses
              this exact box/sizing — the only thing gated by isTextPost
              here is the caption line above it, since a text post's body
              already rendered as cardTextContent just above; caption/
              item_name are item-post-only fields. Its image_url points at
              share-snapshots (copy-post-photo-to-share-snapshots), the
              same durable, always-public surface every other post image
              already renders from — no special signed-image branch needed
              here. */}
          {post.image_url && (
            <View style={styles.mediaContentColumn}>
              {!isTextPost && (post.caption || post.item_name) && (
                <Text style={styles.mediaCaption}>{post.caption || post.item_name}</Text>
              )}
              <TouchableOpacity
                style={[
                  styles.mediaImageWrap,
                  {
                    aspectRatio:
                      mediaAspectRatio != null
                        ? clampMediaAspectRatio(mediaAspectRatio)
                        : MEDIA_DEFAULT_ASPECT_RATIO,
                  },
                ]}
                onPress={onPostPress}
                activeOpacity={0.95}>
                <Image
                  source={{ uri: post.image_url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={200}
                  onError={() => setImageError(true)}
                />
              </TouchableOpacity>
            </View>
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
        {/* Comment first, matching the X-style mockup's icon order —
            tapping also opens post detail, same as before. Piece 6: emoji
            glyph replaced with IconSymbol's existing 'message' mapping
            (outline speech bubble) — no new icon system introduced. */}
        <TouchableOpacity onPress={onPostPress} hitSlop={8} style={styles.commentBtn}>
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

// X/Twitter-inspired responsive single-image sizing (standard image-path
// posts only — text/rate_my_grails/card_share are unaffected). Bounds are
// expressed as width/height ratios, not a raw pixel ceiling: clamping the
// ratio's lower end (3/4 — "3:4 portrait") IS the max-height guard an
// extremely tall upload needs, since height = width / ratio is capped at
// width / (3/4) once clamped, however tall the source image actually is.
// The upper end (2/1 — "2:1 landscape") keeps very wide/panoramic uploads
// from going too short. Used as the actual style only once the source
// image's natural size has been measured (see useEffect below); until
// then (or if measuring fails), MEDIA_DEFAULT_ASPECT_RATIO — the same 5/7
// this path used unconditionally before — is used as a same-as-before
// fallback so there's no layout jump for the common case and no broken
// box if getSize ever errors.
const MEDIA_MIN_ASPECT_RATIO = 3 / 4;
const MEDIA_MAX_ASPECT_RATIO = 2 / 1;
const MEDIA_DEFAULT_ASPECT_RATIO = 5 / 7;

function clampMediaAspectRatio(ratio: number): number {
  return Math.min(MEDIA_MAX_ASPECT_RATIO, Math.max(MEDIA_MIN_ASPECT_RATIO, ratio));
}

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
  // Piece 3 — bottom hairline divider replaces the FlatList's old
  // paddingHorizontal/gap floating-card spacing (see app/(tabs)/index.tsx's
  // own list style): posts now sit edge-to-edge in a true stream, each
  // separated by this one divider instead of a gap on all sides.
  card: {
    backgroundColor: PV2.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
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
  // CardShare's own wrapper — layout/position unchanged this pass; only
  // the placeholder tint moved off the old light-theme gray (#e9ecef, a
  // holdover from the white-card era) so it doesn't flash light against
  // the now-dark card while CardSharePostBody's images load.
  cardImageWrap: {
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
  // Standard image path only (Piece 3) — caption/hashtag text directly
  // above a large, edge-forward image, indented to MEDIA_CONTENT_LEFT_INSET
  // so its left edge lines up with the identity text above rather than the
  // avatar; right edge matches cardHeader's own 12px right inset.
  mediaContentColumn: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    // Piece 5 — tightened from 8 so this + actionsRow's own paddingTop
    // (also tightened) don't stack into a 16px dead zone before actions.
    paddingBottom: 6,
    // Piece 6 — 6→4, a few more px off the caption→image gap.
    gap: 4,
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
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
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

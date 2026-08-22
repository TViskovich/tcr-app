import { useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { GrailsPostBody } from '@/components/feed/grails-post-body';
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
          <View style={styles.cardUserInfo}>
            <Text style={styles.cardDisplayName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.cardUsername}>@{post.username}</Text>
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

      {/* Post body — text block for text posts, grails grid for Rate My Grails, image otherwise */}
      {isTextPost ? (
        <TouchableOpacity style={styles.cardTextWrap} onPress={onPostPress} activeOpacity={0.95}>
          <Text style={styles.cardTextContent}>{post.content}</Text>
        </TouchableOpacity>
      ) : isRateMyGrails ? (
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
        // plain-image branch above, which would pass an undefined uri to
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
        <TouchableOpacity style={styles.cardImageWrap} onPress={onPostPress} activeOpacity={0.95}>
          <Image
            source={{ uri: post.image_url! }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            onError={() => setImageError(true)}
          />
        </TouchableOpacity>
      )}

      {/* Caption + actions — caption only shown for item posts (Rate My Grails
          renders its own caption inside GrailsPostBody, above) */}
      <View style={styles.cardBody}>
        {!isTextPost && !isRateMyGrails && (post.caption || post.item_name) ? (
          <Text style={styles.cardCaption}>{post.caption || post.item_name}</Text>
        ) : null}
        <View style={styles.cardActions}>
          <Pressable onPress={handleLikeTap} hitSlop={8} style={styles.likeBtn}>
            <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
              <Text style={[styles.likeEmoji, !post.liked && styles.likeEmojiDim]}>🔥</Text>
            </Animated.View>
            <Text style={[styles.likeCount, post.liked && styles.likeCountActive]}>
              {post.likeCount}
            </Text>
          </Pressable>

          {/* Comment count — tapping also opens post detail */}
          <TouchableOpacity onPress={onPostPress} hitSlop={8} style={styles.commentBtn}>
            <Text style={styles.commentIcon}>💬</Text>
            <Text style={styles.commentCount}>{post.commentCount}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#1A1A1A',
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
  cardUserInfo: {
    flex: 1,
    gap: 1,
  },
  cardDisplayName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  cardUsername: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.60)',
  },
  cardDate: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    flexShrink: 0,
  },
  cardImageWrap: {
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
  cardGrailsWrap: {
    padding: 10,
    backgroundColor: '#1A1A1A',
  },
  cardTextWrap: {
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 16,
    paddingVertical: 20,
    minHeight: 80,
  },
  cardTextContent: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.90)',
    lineHeight: 24,
  },
  cardBody: {
    padding: 12,
    gap: 8,
    backgroundColor: '#1A1A1A',
  },
  cardCaption: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  likeEmoji: {
    fontSize: 20,
  },
  likeEmojiDim: {
    opacity: 0.25,
  },
  likeCount: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.50)',
    minWidth: 16,
  },
  likeCountActive: {
    color: '#FF7043',
  },
  commentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
  },
  commentIcon: {
    fontSize: 18,
    opacity: 0.55,
  },
  commentCount: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.50)',
    minWidth: 16,
  },
});

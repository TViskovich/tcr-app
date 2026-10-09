import { useRef, useState } from 'react';
import {
  Alert,
  Animated,
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
import { FolderShareCollage } from '@/components/feed/folder-share-collage';
import { PostImageCarousel } from '@/components/feed/post-image-carousel';
import { RepostHeader, type SourceOwnerAttribution } from '@/components/feed/repost-header';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrailRating } from '@/hooks/use-grail-rating';
import { rememberMediaSize, useMediaSize } from '@/lib/feed-media-dimensions';
import { supabase } from '@/lib/supabase';
import { fetchFolderOwnerIds, fetchFolderShareItems, type FolderShareData } from '@/lib/folder-share-post';
import type { CardShareItem, PostImage, RateMyGrailCard } from '@/types';

export type { SourceOwnerAttribution };

export type FeedPost = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails' | 'card_share' | 'folder_share' | 'repost' | 'quote';
  // 'item' posts only — the live collection_items.id this post was created
  // from (posts.item_id, ON DELETE SET NULL — null once the source item is
  // deleted, same "tap to view original" gap card_share_items' own item_id
  // already accepts). Used only to navigate to the source item; never
  // required for rendering the post itself, which always renders from the
  // durable image_url/caption/item_name fields below regardless of whether
  // this resolves.
  item_id?: string | null;
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
  // 'folder_share' posts only — snapshot of the shared folder (see
  // lib/folder-share-post.ts). null/undefined for every other post type.
  folderShare?: FolderShareData | null;
  // 'item' and 'folder_share' posts (for a folder: the shared folder's
  // owner, folders.user_id via fetchFolderOwnerIds). For an 'item' post,
  // only when the source item's owner (collection_
  // items.user_id, resolved live — see queryFeed/fetchUserPosts) differs
  // from this post's own user_id — i.e. this is a REPOST of someone else's
  // public card, not a share of the poster's own. null/undefined for an
  // own-item share (existing behavior, completely unchanged) and for every
  // other post_type. Resolved via a live join, not a durable snapshot — see
  // this field's own audit note in the PR that introduced it: if the
  // source item is later deleted (item_id goes null, same as above) or its
  // owner's profile is deleted, this simply comes back null/missing on a
  // FUTURE fetch and the post quietly falls back to rendering with no
  // special repost header, rather than crashing or showing stale data.
  sourceOwner?: SourceOwnerAttribution | null;
  // 'repost' rows only: the ORIGINAL post this repost references, fully
  // hydrated (see hydrateFeedPosts). A repost renders this post's content
  // under "@username reposted"; its own id, author (the reposter), likes
  // and comments stay on the repost row itself.
  repostOf?: FeedPost | null;
  repostOfPostId?: string | null;
  // Original posts only (never reposts): how many reposts reference this
  // post, and whether one of them is the signed-in user's — the Repost
  // control's count and state.
  repostCount?: number;
  repostedByMe?: boolean;
  // 'quote' rows only: the post this quote references, hydrated (see
  // hydrateFeedPosts) — rendered embedded under the quote's own comment
  // (content). null when the quoted post was deleted (its reference is
  // cleared, the quote itself stays).
  quoted?: FeedPost | null;
  quoteOfPostId?: string | null;
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

// Every posts column the feed renders from, plus repost_of_post_id — one
// list shared by every loader so a row always hydrates the same way.
export const FEED_POST_SELECT =
  'id, user_id, item_id, post_type, image_url, content, caption, created_at, folder_id, folder_name, folder_item_count, folder_cover_snapshot_url, repost_of_post_id, quote_of_post_id';

// How many levels of referenced posts (repost -> original, quote ->
// quoted) hydrateFeedPosts resolves.
const REFERENCE_DEPTH = 3;

// Every post type the feed renders. 'repost' rows render their ORIGINAL
// post (FeedPost.repostOf), resolved by hydrateFeedPosts.
export const FEED_POST_TYPES = ['item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'] as const;

type FeedPostRow = {
  id: string;
  user_id: string;
  item_id: string | null;
  post_type: FeedPost['post_type'] | null;
  image_url: string | null;
  content: string | null;
  caption: string | null;
  created_at: string;
  folder_id: string | null;
  folder_name: string | null;
  folder_item_count: number | null;
  folder_cover_snapshot_url: string | null;
  repost_of_post_id: string | null;
  quote_of_post_id: string | null;
};

// Turns raw posts rows (FEED_POST_SELECT) into renderable FeedPosts — the
// one hydration shared by the main feed (app/(tabs)/index.tsx's queryFeed)
// and a profile's Posts tab (fetchUserPosts below), so every post type
// renders identically wherever it appears. Batch queries per page, never
// per post (posts -> profiles goes through auth.users, so PostgREST can't
// embed it; everything is merged in JS).
//
// Reposts: a 'repost' row's ORIGINAL post is fetched (when not already on
// this page) and hydrated in the same batch as everything else, so it
// renders with its own type-specific content (cards, collage, grails,
// images…), and attached as repostOf. The repost row keeps its own id,
// author (the reposter), likes and comments. A repost whose original
// can't be loaded is dropped (deleting an original already deletes its
// reposts — ON DELETE CASCADE). Each ORIGINAL also gets repostCount /
// repostedByMe for the Repost control. `signal` required — see
// fetchGrailData's comment above.
export async function hydrateFeedPosts(
  rows: FeedPostRow[],
  signal: AbortSignal,
  currentUserId?: string,
): Promise<FeedPost[]> {
  if (!rows.length) return [];

  // Every post a row references — a repost's original, a quote's quoted
  // post — fetched in batched rounds (one query per level, never per post)
  // up to REFERENCE_DEPTH levels: enough for a repost of a quote of a
  // quote, whose deepest level is only shown as a "Quoting @user" label.
  const known = new Map(rows.map((r) => [r.id, r]));
  let frontier = rows;
  for (let level = 0; level < REFERENCE_DEPTH && frontier.length > 0; level++) {
    const missing = [
      ...new Set(
        frontier
          .flatMap((r) => [r.repost_of_post_id, r.quote_of_post_id])
          .filter((id): id is string => !!id && !known.has(id)),
      ),
    ];
    if (missing.length === 0) break;
    const { data, error } = await supabase
      .from('posts')
      .select(FEED_POST_SELECT)
      .in('id', missing)
      .abortSignal(signal);
    if (error) {
      console.error('[hydrateFeedPosts] referenced posts query failed:', error.message, error);
      break;
    }
    frontier = (data ?? []) as unknown as FeedPostRow[];
    for (const r of frontier) known.set(r.id, r);
  }
  const postRows = [...known.values()];

  const userIds = [...new Set(postRows.map((p) => p.user_id))];
  const itemIds = [...new Set(postRows.map((p) => p.item_id).filter(Boolean) as string[])];
  const postIds = postRows.map((p) => p.id);
  // Originals (never reposts) — what the Repost control counts.
  const contentIds = postRows.filter((p) => p.post_type !== 'repost').map((p) => p.id);
  const grailPostIds = postRows.filter((p) => p.post_type === 'rate_my_grails').map((p) => p.id);
  const cardSharePostIds = postRows.filter((p) => p.post_type === 'card_share').map((p) => p.id);
  const textPostIds = postRows.filter((p) => p.post_type === 'text').map((p) => p.id);
  const folderSharePostIds = postRows.filter((p) => p.post_type === 'folder_share').map((p) => p.id);
  // Shared folders' ids, for folder_share source-owner attribution (see
  // fetchFolderOwnerIds).
  const sharedFolderIds = postRows
    .filter((p) => p.post_type === 'folder_share' && p.folder_id)
    .map((p) => p.folder_id as string);

  const [profilesRes, itemsRes, likesRes, commentsRes, followsRes, repostsRes, grailData, cardShareMap, postImagesMap, folderShareMap, folderOwnerMap] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, display_name, hero_display_name, avatar_url')
        .in('id', userIds)
        .abortSignal(signal),
      itemIds.length > 0
        ? supabase.from('collection_items').select('id, title, image_url, user_id').in('id', itemIds).abortSignal(signal)
        : Promise.resolve({ data: [] }),
      supabase.from('likes').select('post_id, user_id').in('post_id', postIds).abortSignal(signal),
      supabase.from('comments').select('post_id').in('post_id', postIds).abortSignal(signal),
      currentUserId
        ? supabase.from('follows').select('following_id').eq('follower_id', currentUserId).abortSignal(signal)
        : Promise.resolve({ data: [] }),
      contentIds.length > 0
        ? supabase.from('posts').select('user_id, repost_of_post_id').in('repost_of_post_id', contentIds).abortSignal(signal)
        : Promise.resolve({ data: [] }),
      grailPostIds.length > 0
        ? fetchGrailData(grailPostIds, signal, currentUserId)
        : Promise.resolve({ cardsMap: new Map(), ratingTotals: new Map() }),
      fetchCardShareItems(cardSharePostIds, signal),
      fetchPostImages(textPostIds, signal),
      fetchFolderShareItems(folderSharePostIds, signal),
      fetchFolderOwnerIds(sharedFolderIds, signal),
    ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: any) => [p.id, p]));
  if ((itemsRes as any).error) {
    console.error('[hydrateFeedPosts] collection_items query failed:', (itemsRes as any).error.message, (itemsRes as any).error);
  }
  const itemMap = new Map((itemsRes.data ?? []).map((i: any) => [i.id, i]));

  // Source items' / shared folders' owners for repost attribution: most
  // are already in profileMap (they posted on this page too), so only the
  // missing ones need a second, small batched profiles lookup.
  const missingOwnerIds = [
    ...new Set(
      [...(itemsRes.data ?? []).map((i: any) => i.user_id as string | null), ...folderOwnerMap.values()].filter(
        (id): id is string => !!id && !profileMap.has(id),
      ),
    ),
  ];
  if (missingOwnerIds.length > 0) {
    const { data: ownerProfiles, error: ownerProfilesError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', missingOwnerIds)
      .abortSignal(signal);
    if (ownerProfilesError) {
      console.error('[hydrateFeedPosts] source-owner profiles query failed:', ownerProfilesError.message, ownerProfilesError);
    } else {
      for (const row of (ownerProfiles ?? []) as any[]) profileMap.set(row.id, row);
    }
  }

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

  const followedSet = new Set<string>(((followsRes.data ?? []) as any[]).map((f) => f.following_id as string));

  if ((repostsRes as any).error) {
    console.error('[hydrateFeedPosts] repost counts query failed:', (repostsRes as any).error.message, (repostsRes as any).error);
  }
  const repostCountMap = new Map<string, number>();
  const repostedByMe = new Set<string>();
  for (const row of (repostsRes.data ?? []) as any[]) {
    repostCountMap.set(row.repost_of_post_id, (repostCountMap.get(row.repost_of_post_id) ?? 0) + 1);
    if (row.user_id === currentUserId) repostedByMe.add(row.repost_of_post_id);
  }

  const { cardsMap, ratingTotals } = grailData;

  const built = new Map<string, FeedPost>();
  for (const post of postRows) {
    const profile = profileMap.get(post.user_id) ?? {};
    const item = post.item_id ? (itemMap.get(post.item_id) ?? {}) : {};
    // The source's owner — a shared folder's (folder_share) or the source
    // item's (item posts) — shown as repost attribution only when it isn't
    // the poster themselves.
    const sourceOwnerId = (
      post.post_type === 'folder_share'
        ? post.folder_id
          ? folderOwnerMap.get(post.folder_id)
          : undefined
        : (item as any).user_id
    ) as string | undefined;
    const ownerProfile = sourceOwnerId && sourceOwnerId !== post.user_id ? profileMap.get(sourceOwnerId) : undefined;
    const rating = ratingTotals.get(post.id);
    built.set(post.id, {
      id: post.id,
      user_id: post.user_id,
      post_type: post.post_type ?? 'item',
      item_id: post.item_id ?? null,
      image_url: post.image_url ?? (item as any).image_url ?? null,
      content: post.content ?? null,
      caption: post.caption ?? null,
      created_at: post.created_at,
      item_name: (item as any).title ?? null,
      sourceOwner: ownerProfile
        ? {
            id: ownerProfile.id,
            username: ownerProfile.username ?? 'user',
            displayName: ownerProfile.display_name ?? null,
            avatarUrl: ownerProfile.avatar_url ?? null,
          }
        : null,
      username: profile.username ?? 'user',
      display_name: profile.hero_display_name || profile.display_name || null,
      avatar_url: profile.avatar_url ?? null,
      likeCount: likeCountMap.get(post.id) ?? 0,
      liked: likedSet.has(post.id),
      commentCount: commentCountMap.get(post.id) ?? 0,
      isFollowing: followedSet.has(post.user_id),
      grailCards: cardsMap.get(post.id) ?? [],
      avgRating: rating ? rating.sum / rating.count : null,
      ratingCount: rating?.count ?? 0,
      myRating: rating?.mine ?? null,
      cardShareItems: cardShareMap.get(post.id) ?? [],
      images: postImagesMap.get(post.id) ?? [],
      folderShare:
        post.post_type === 'folder_share'
          ? {
              folderId: post.folder_id ?? null,
              folderName: post.folder_name ?? 'Folder',
              itemCount: post.folder_item_count ?? 0,
              items: folderShareMap.get(post.id) ?? [],
              coverUrl: post.folder_cover_snapshot_url ?? null,
            }
          : null,
      repostOfPostId: post.repost_of_post_id ?? null,
      repostCount: repostCountMap.get(post.id) ?? 0,
      repostedByMe: repostedByMe.has(post.id),
      quoteOfPostId: post.quote_of_post_id ?? null,
    });
  }

  // Attaches what each post references, depth-bounded. A repost whose
  // original is gone is dropped; a quote whose quoted post is gone keeps
  // quoted: null ("This post is unavailable").
  function link(id: string, depth: number): FeedPost | null {
    const post = built.get(id);
    if (!post) return null;
    if (depth >= REFERENCE_DEPTH) return post;
    if (post.post_type === 'repost') {
      const original = post.repostOfPostId ? link(post.repostOfPostId, depth + 1) : null;
      return original ? { ...post, repostOf: original } : null;
    }
    if (post.post_type === 'quote') {
      return { ...post, quoted: post.quoteOfPostId ? link(post.quoteOfPostId, depth + 1) : null };
    }
    return post;
  }

  return rows.map((row) => link(row.id, 0)).filter((p): p is FeedPost => !!p);
}

// Local list updates for a repost/undo of `originalId` by the signed-in
// user — shared by every screen holding a FeedPost list. setRepostState
// updates the original's count/state wherever it appears: as itself, or as
// the repostOf of any repost of it. A no-op where it already matches, so a
// rollback can apply the inverse safely.
export function setRepostState(list: FeedPost[], originalId: string, reposted: boolean): FeedPost[] {
  const patch = (p: FeedPost): FeedPost =>
    p.id !== originalId || !!p.repostedByMe === reposted
      ? p
      : { ...p, repostedByMe: reposted, repostCount: Math.max(0, (p.repostCount ?? 0) + (reposted ? 1 : -1)) };
  return list.map((p) => (p.repostOf ? (p.repostOf.id === originalId ? { ...p, repostOf: patch(p.repostOf) } : p) : patch(p)));
}

// After a confirmed undo: removes the user's own repost entry of
// `originalId` from a loaded list.
export function removeOwnRepost(list: FeedPost[], originalId: string, userId: string): FeedPost[] {
  return list.filter((p) => !(p.post_type === 'repost' && p.user_id === userId && p.repostOf?.id === originalId));
}

// One user's own post history (their posts AND their reposts), newest
// first — no date window, no engagement ranking (unlike the main feed's
// queryFeed), since this powers a profile's Posts tab rather than a
// ranked/windowed feed. Same hydration as the feed (hydrateFeedPosts), so
// it reuses the same PostCard renderer. `signal` required — see
// fetchGrailData's comment above.
export async function fetchUserPosts(userId: string, signal: AbortSignal, currentUserId?: string): Promise<FeedPost[]> {
  const { data: postRows, error: postsError } = await supabase
    .from('posts')
    .select(FEED_POST_SELECT)
    .eq('user_id', userId)
    .in('post_type', [...FEED_POST_TYPES])
    .order('created_at', { ascending: false })
    .abortSignal(signal);

  if (postsError) {
    console.error('[fetchUserPosts] posts query failed:', postsError.message, postsError);
    throw postsError;
  }

  return hydrateFeedPosts((postRows ?? []) as unknown as FeedPostRow[], signal, currentUserId);
}

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PostCard({
  post: entry,
  currentUserId,
  onUserPress,
  onPostPress,
  onCardSharePress,
  onCommentPress,
  onLike,
  onDelete,
  onSourceOwnerPress,
  onSourceItemPress,
  onRepost,
  onReposterPress,
  onOpenQuoted,
  embedded = false,
  readOnly = false,
}: {
  post: FeedPost;
  currentUserId: string | undefined;
  onUserPress: () => void;
  onPostPress: () => void;
  // card_share only: a tap on one of the post's cards, with its index —
  // lets the caller open Post Detail on that same card. Falls back to
  // onPostPress when not given.
  onCardSharePress?: (cardIndex: number) => void;
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
  // Foreign-repost only (post.sourceOwner set — see isForeignRepost below);
  // ignored/never called otherwise. Both optional so every existing call
  // site (SharePostPreview, app/share-folder/new.tsx) that never renders a
  // repost keeps compiling unchanged.
  onSourceOwnerPress?: () => void;
  onSourceItemPress?: () => void;
  // Share Card's local preview: the header (author) and the like/comment
  // row ignore touches, while the media stays interactive — so a
  // multi-card preview can still be swiped. Its cards themselves are
  // already non-navigating there (preview rows carry item_id: null).
  readOnly?: boolean;
  // The Repost control was tapped — the caller opens its Repost / Quote
  // menu for the post's ORIGINAL (see entry/post below). Optional: the
  // control renders only where a caller wires it.
  onRepost?: () => void;
  // A quote's embedded post was tapped — open that post (its own Post
  // Detail, where its cards/items/folder navigate as usual).
  onOpenQuoted?: (postId: string) => void;
  // Rendered INSIDE a quote, as its embedded post: no action row and no
  // nested embed (a quoted quote shows its comment plus "Quoting @user").
  // The caller makes it non-interactive and handles the tap.
  embedded?: boolean;
  // A repost's "@username reposted" line — opens the reposter's profile.
  // (onUserPress is the shown author, i.e. the ORIGINAL post's.)
  onReposterPress?: () => void;
}) {
  // A repost (post_type 'repost') renders its ORIGINAL post's content —
  // author, media, caption, item/folder links, type-specific presentation —
  // from `post`, while its own engagement and ownership stay on `entry`:
  // likes, comments, and delete (= undo repost) belong to the repost row.
  // For every other post, entry and post are the same object.
  const post = entry.repostOf ?? entry;
  const isRepost = post !== entry;
  const [imageError, setImageError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const isTextPost = post.post_type === 'text';
  const isRateMyGrails = post.post_type === 'rate_my_grails';
  const isCardShare = post.post_type === 'card_share';
  const isFolderShare = post.post_type === 'folder_share';
  const isOwner = !!currentUserId && currentUserId === entry.user_id;
  const isQuote = post.post_type === 'quote';
  // A "Share to Feed" repost of someone else's public card or folder — see
  // FeedPost.sourceOwner's own comment for exactly when this is set. A
  // folder repost only swaps the header (RepostHeader); its body is the
  // folder_share branch below either way.
  const isForeignRepost = (post.post_type === 'item' || post.post_type === 'folder_share') && !!post.sourceOwner;

  // Single-card ('item') post media height cap — SINGLE_CARD_MAX_HEIGHT_FRACTION
  // of the actual device viewport, not a fixed pixel value, so this scales
  // sensibly across phone sizes. useWindowDimensions (not a one-time
  // Dimensions.get('window') snapshot) so this stays correct if the window
  // ever changes (rotation, split-view) without needing a remount. Applied
  // as an explicit maxHeight below, on top of aspectRatio sizing — see
  // mediaImageWrapSingle's own comment for why both are needed together.
  const { height: windowHeight } = useWindowDimensions();
  const singleCardMaxHeight = windowHeight * SINGLE_CARD_MAX_HEIGHT_FRACTION;

  // Natural aspect ratio of the current post's LEAD image — nothing in the
  // schema stores source width/height, so it comes from the shared feed
  // media-size cache (lib/feed-media-dimensions.ts: sizes measured this
  // session or persisted from earlier launches, else measured once through
  // expo-image). This is what sizes the box to the image's real shape
  // rather than force-cropping every post into a fixed 5:7 box. Read at
  // render — so an already-known size is there on the card's FIRST render
  // and the frame is final from the start — and derived from the lead uri
  // every render, so a recycled card never shows a previous post's shape.
  // null while unknown (or on failure), meaning "use
  // MEDIA_DEFAULT_ASPECT_RATIO". leadMediaSettled gates the item image and
  // card-share body below: while a size is still being measured, the frame
  // shows only its background, so an image is never drawn at a temporary
  // geometry and then resized.
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

  // Stable primitive (a URL string, or null) rather than depending on
  // post.cardShareItems (a fresh array reference on every parent re-render
  // even when its content is unchanged) — keeps the lead-image size
  // lookup below keyed on the image itself, not on an array identity.
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

  // Text posts CAN carry an optional attached photo (app/post/new.tsx)
  // and reuse this exact responsive sizing via post.image_url (or, for a
  // 2-4 image post, via postImagesLeadUrl above); card-share posts have no
  // top-level image_url at all and use their first card's snapshot instead
  // (see cardShareLeadImageUrl above). rate_my_grails has its own layout.
  const leadImageUri = isRateMyGrails
    ? null
    : isCardShare
      ? cardShareLeadImageUrl
      : (postImagesLeadUrl ?? post.image_url);
  const leadMedia = useMediaSize(leadImageUri);
  const mediaAspectRatio = leadMedia.size ? leadMedia.size.width / leadMedia.size.height : null;
  const leadMediaSettled = leadMedia.settled;

  // Text-post photo frame — same viewport-relative cap idea as
  // singleCardMaxHeight above, but a smaller fraction, so a text photo never
  // out-sizes a shared card. Shared by the single-image, carousel, and
  // legacy-image_url text-post branches below.
  const textPhotoFrame = {
    aspectRatio: mediaAspectRatio != null ? clampMediaAspectRatio(mediaAspectRatio) : TEXT_POST_DEFAULT_ASPECT_RATIO,
    maxHeight: windowHeight * TEXT_POST_MAX_HEIGHT_FRACTION,
  };

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
      isRepost ? 'Remove Repost' : 'Delete Post',
      isRepost
        ? "This removes your repost and its comments and likes. The original post isn't affected."
        : "This will permanently remove this post, its comments, and likes. This can't be undone.",
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
    <View style={[styles.card, embedded && styles.cardEmbedded]}>
      {/* Repost attribution — "@reposter reposted", above the ORIGINAL
          post's own header and content below. Opens the reposter's
          profile. */}
      {isRepost && (
        <TouchableOpacity
          style={styles.repostedByRow}
          onPress={onReposterPress}
          disabled={!onReposterPress || readOnly}
          activeOpacity={0.7}
          accessibilityRole={onReposterPress ? 'button' : undefined}
          accessibilityLabel={`@${entry.username} reposted`}>
          <IconSymbol name="arrow.2.squarepath" size={13} color={PV2.textTertiary} />
          <Text style={styles.repostedByText} numberOfLines={1}>
            @{entry.username} reposted
          </Text>
        </TouchableOpacity>
      )}
      {/* User row — tapping the avatar/name/date group navigates to their
          public profile; the owner-only "..." sits outside that touch
          target as its own sibling, in the same row. Foreign repost:
          replaced entirely by the compact RepostHeader (its own repost
          strip + owner row, including its own "..." rendered inline on
          the strip) — see isForeignRepost's own comment above. Rendered
          directly, NOT inside styles.cardHeader — RepostHeader owns its
          own horizontal insets/margins for its two stacked rows, matching
          cardHeader's paddingHorizontal (12) itself. */}
      {isForeignRepost ? (
        <RepostHeader
          reposterUsername={post.username}
          reposterDisplayName={post.display_name}
          reposterAvatarUrl={post.avatar_url}
          createdAt={post.created_at}
          onReposterPress={onUserPress}
          owner={post.sourceOwner!}
          onOwnerPress={onSourceOwnerPress}
          onDeletePress={isOwner && onDelete ? handleDeleteTap : undefined}
        />
      ) : (
        <View style={styles.cardHeader} pointerEvents={readOnly ? 'none' : 'auto'}>
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
      )}

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
      ) : isFolderShare ? (
        // Folder share — a square collage of the folder's snapshot items
        // (see lib/folder-share-post.ts), with the folder name/count
        // underneath. Tapping either opens post detail like every other
        // feed post; the detail screen has the "View collection" link.
        <View style={[styles.mediaContentColumn, styles.mediaContentColumnFull]}>
          <TouchableOpacity
            style={styles.mediaImageWrapSingle}
            onPress={onPostPress}
            activeOpacity={0.95}
            accessibilityRole="button"
            accessibilityLabel={`${post.folderShare?.folderName ?? 'Folder'}, shared folder`}>
            <FolderShareCollage
              items={post.folderShare?.items ?? []}
              totalCount={post.folderShare?.itemCount ?? 0}
              coverUrl={post.folderShare?.coverUrl}
              liveCoverUri={post.folderShare?.liveCoverUri}
              radius={MEDIA_CORNER_RADIUS}
            />
          </TouchableOpacity>
          <View style={[styles.mediaImageWrapSingle, styles.folderShareMeta]}>
            <Text style={styles.folderShareName} numberOfLines={1}>
              {post.folderShare?.folderName ?? 'Folder'}
            </Text>
            <Text style={styles.folderShareCount}>
              {post.folderShare?.itemCount ?? 0} public {(post.folderShare?.itemCount ?? 0) === 1 ? 'item' : 'items'}
            </Text>
          </View>
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
              // Mounted from the start but invisible until the frame's
              // lead size has settled, so its cards appear inside the final
              // frame rather than inside the default one first — while their
              // images already load. The first card's own load reports its
              // size, which settles the frame even if the background
              // measurement (useMediaSize) never answers.
              <CardSharePostBody
                cards={post.cardShareItems}
                mediaBorderRadius={MEDIA_CORNER_RADIUS}
                hidden={!leadMediaSettled}
                // Feed: tapping a card opens this post (like every other
                // post's media), not the card's item — Post Detail's own
                // carousel is where a card opens its original item. Not in
                // the read-only preview, whose cards don't navigate.
                onCardPress={
                  readOnly ? undefined : (cardIndex) => (onCardSharePress ? onCardSharePress(cardIndex) : onPostPress())
                }
                onFirstImageLoad={(width, height) => {
                  if (cardShareLeadImageUrl) rememberMediaSize(cardShareLeadImageUrl, width, height);
                }}
              />
            ) : (
              <View style={styles.cardShareUnavailable}>
                <Text style={styles.cardShareUnavailableText}>Shared cards unavailable</Text>
              </View>
            )}
          </View>
        </View>
      ) : isQuote ? (
        // Quote: the quoter's comment, then the quoted post embedded — its
        // OWN author, media and presentation, via this same component in
        // `embedded` mode. The embed is one tap target opening the quoted
        // post. Inside an embed, a quoted quote shows only its comment and
        // a "Quoting @user" label, never a second embed.
        <>
          {post.content ? (
            <TouchableOpacity
              style={styles.cardTextWrap}
              onPress={onPostPress}
              disabled={embedded}
              activeOpacity={0.95}>
              <Text style={styles.cardTextContent}>{post.content}</Text>
            </TouchableOpacity>
          ) : null}
          {embedded ? (
            post.quoted ? (
              <Text style={styles.quotingLabel} numberOfLines={1}>
                Quoting @{post.quoted.username}
              </Text>
            ) : null
          ) : (
            <View style={styles.quoteEmbedColumn}>
              {post.quoted ? (
                <Pressable
                  onPress={() => onOpenQuoted?.(post.quoted!.id)}
                  disabled={!onOpenQuoted || readOnly}
                  accessibilityRole="button"
                  accessibilityLabel={`Quoted post by @${post.quoted.username}`}>
                  <View pointerEvents="none">
                    <PostCard
                      post={post.quoted}
                      embedded
                      currentUserId={currentUserId}
                      onUserPress={noopPress}
                      onPostPress={noopPress}
                      onCommentPress={noopPress}
                      onLike={noopPress}
                    />
                  </View>
                </Pressable>
              ) : (
                <View style={styles.quoteUnavailable}>
                  <Text style={styles.cardShareUnavailableText}>This post is unavailable</Text>
                </View>
              )}
            </View>
          )}
        </>
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
                  // The repost IS a social post first — tapping its large
                  // media opens this post's own Post Detail (comments,
                  // likes, repost context, caption), same as every other
                  // post type's media tap. The original source item is
                  // reached via the explicit source-context row below
                  // instead (onSourceItemPress), not this tap.
                  onPress={onPostPress}
                  activeOpacity={0.95}>
                  {isTextPost ? (
                    // Text-post photo: same photo-rectangle rounding as the
                    // single-image branch above. (imageError only ever hides
                    // non-text posts — see the early return — so no onError
                    // is needed here.)
                    <FittedRoundedImage uri={post.image_url} radius={MEDIA_CORNER_RADIUS} />
                  ) : (
                    // Same gate as card-share: mounted (so it loads) but
                    // invisible until the frame above has its final aspect
                    // ratio; its own load can settle that ratio.
                    <Image
                      source={{ uri: post.image_url }}
                      style={[StyleSheet.absoluteFill, !leadMediaSettled && styles.mediaHidden]}
                      // 'contain' (never crops — an aspect mismatch against
                      // the box above only ever letterboxes, so the full
                      // card is always visible even for an unusually-cropped
                      // upload).
                      contentFit="contain"
                      transition={200}
                      onLoad={(e) => {
                        if (post.image_url) rememberMediaSize(post.image_url, e.source.width, e.source.height);
                      }}
                      onError={() => setImageError(true)}
                    />
                  )}
                </TouchableOpacity>

                {/* Source context row — foreign repost only; now the ONE
                    explicit way to reach the original source item from the
                    feed (the large media tap above opens this post's own
                    Post Detail instead — see that TouchableOpacity's own
                    comment). No folder/collection NAME is available
                    anywhere in FeedPost (never fetched for this feature —
                    audited, not invented), so the label still reads "From
                    @owner's collection"; only the destination changed.
                    Disabled (never a dead tap) when onSourceItemPress isn't
                    supplied — e.g. the source item was since deleted,
                    item_id is null (see FeedPost.item_id's own comment).
                    The OWNER's profile is still reached via the owner row
                    in RepostHeader above (onSourceOwnerPress), unchanged. */}
                {isForeignRepost && post.sourceOwner && (
                  <TouchableOpacity
                    style={styles.sourceContextRow}
                    onPress={onSourceItemPress}
                    disabled={!onSourceItemPress}
                    activeOpacity={0.7}
                    accessibilityRole={onSourceItemPress ? 'button' : undefined}
                    accessibilityLabel={`View item — from @${post.sourceOwner.username}'s collection`}>
                    <IconSymbol name="rectangle.stack.fill" size={13} color={PV2.textTertiary} />
                    <Text style={styles.sourceContextText} numberOfLines={1}>
                      From <Text style={styles.sourceContextHandle}>@{post.sourceOwner.username}</Text>&apos;s collection
                    </Text>
                    <IconSymbol name="chevron.right" size={12} color={PV2.textTertiary} />
                  </TouchableOpacity>
                )}
              </View>
            )
          )}
        </>
      )}

      {/* Caption — CardShare only (its previous, un-indented position and
          wrapper, unchanged from Piece 3). Rate My Grails renders its own
          caption inside GrailsPostBody, above; the standard image path's
          caption already moved into mediaContentColumn in Piece 3. */}
      {(isCardShare || isFolderShare) && (post.caption || post.item_name) ? (
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
      {!embedded && (
      <View style={styles.actionsRow} pointerEvents={readOnly ? 'none' : 'auto'}>
        {/* Comment first, matching the X-style mockup's icon order. Feed
            comment/reply redesign: now opens the dedicated reply composer
            (onCommentPress) instead of post detail (onPostPress) — tapping
            the rest of the card still opens post detail unchanged. Piece 6:
            emoji glyph replaced with IconSymbol's existing 'message'
            mapping (outline speech bubble) — no new icon system introduced. */}
        <TouchableOpacity onPress={onCommentPress} hitSlop={8} style={styles.commentBtn}>
          <IconSymbol name="message" size={19} color={PV2.textSecondary} />
          <Text style={styles.commentCount}>{entry.commentCount}</Text>
        </TouchableOpacity>

        {/* Repost — opens the Repost / Quote menu for the ORIGINAL (post),
            so its count/state are the original's whichever entry shows it.
            Your own posts can be reposted and quoted too. */}
        {onRepost && (
          <TouchableOpacity
            onPress={onRepost}
            hitSlop={8}
            style={styles.commentBtn}
            accessibilityRole="button"
            accessibilityLabel="Repost or quote"
            accessibilityState={{ selected: !!post.repostedByMe }}>
            <IconSymbol
              name="arrow.2.squarepath"
              size={19}
              color={post.repostedByMe ? PV2.accent : PV2.textSecondary}
            />
            <Text style={[styles.likeCount, post.repostedByMe && styles.likeCountActive]}>{post.repostCount ?? 0}</Text>
          </TouchableOpacity>
        )}

        {/* Piece 6: emoji replaced with IconSymbol's existing 'heart'/
            'heart.fill' mapping (outline when inactive, filled when
            liked) — same scaleAnim wrapper, same handleLikeTap/onLike,
            same optimistic update, unchanged. */}
        <Pressable onPress={handleLikeTap} hitSlop={8} style={styles.likeBtn}>
          <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
            <IconSymbol
              name={entry.liked ? 'heart.fill' : 'heart'}
              size={19}
              color={entry.liked ? PV2.accent : PV2.textSecondary}
            />
          </Animated.View>
          <Text style={[styles.likeCount, entry.liked && styles.likeCountActive]}>
            {entry.likeCount}
          </Text>
        </Pressable>
      </View>
      )}
    </View>
  );
}

function noopPress() {}

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
// (see useMediaSize / mediaAspectRatio in PostCard); until then (or if
// measuring fails), MEDIA_DEFAULT_ASPECT_RATIO — 5/7, which also happens to
// already match a standard 2.5"x3.5" trading card almost exactly — is used
// as the fallback frame, with the image itself held back until the size has
// settled, and no broken box if measuring ever fails.
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
  // Repost attribution row, above a repost's original header.
  repostedByRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingTop: 10,
    marginBottom: -4,
  },
  repostedByText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textTertiary,
  },
  // A post embedded in a quote: no outer margins (the quote's column
  // places it) and no shadow.
  cardEmbedded: {
    marginHorizontal: 0,
    marginBottom: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  // A quote's embed, aligned with its comment's text column.
  quoteEmbedColumn: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    paddingBottom: 8,
  },
  quoteUnavailable: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingVertical: 18,
    alignItems: 'center',
  },
  quotingLabel: {
    paddingLeft: MEDIA_CONTENT_LEFT_INSET,
    paddingRight: 12,
    paddingBottom: 10,
    fontSize: 13,
    color: PV2.textTertiary,
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
  // clampSingleCardAspectRatio — see the JSX and mediaAspectRatio /
  // useMediaSize above) or MEDIA_DEFAULT_ASPECT_RATIO before that resolves.
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
  // Media mounted (so it loads) but not yet shown — see leadMediaSettled.
  mediaHidden: {
    opacity: 0,
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
  // Foreign repost only — compact row below the card media, same width as
  // mediaImageWrapSingle (alignSelf: 'center' resolves against this row's
  // own flex parent, mediaContentColumn, exactly like the image above it).
  sourceContextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: `${SINGLE_CARD_WIDTH_FRACTION * 100}%`,
    alignSelf: 'center',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: PV2.collectorPanelBg,
  },
  sourceContextText: {
    flex: 1,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  sourceContextHandle: {
    color: PV2.textSecondary,
    fontWeight: '600',
  },
  // aspectRatio no longer lives here — it's now set inline per-post from
  // the measured (and clamped) natural ratio, or MEDIA_DEFAULT_ASPECT_RATIO
  // before that size is known (see the JSX and useMediaSize above).
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
    // The photo is clipped by its own fitted, rounded View
    // (FittedRoundedImage), so this frame's dark panel fill would only show
    // as a thin dark fringe along the photo's anti-aliased rounded edge.
    backgroundColor: 'transparent',
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
  folderShareMeta: {
    paddingTop: 8,
  },
  folderShareName: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  folderShareCount: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: 1,
  },
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

import { useCallback, useEffect, useRef, useState } from 'react';

import { checkTaggingAvailable } from '@/lib/content-tags';
import { ITEM_TYPE_LABEL } from '@/lib/dm-attachments';
import { supabase } from '@/lib/supabase';
import type { CollectibleItemType } from '@/types';

// The Dashboard's analytics, read from data CacheCase already stores — no
// new tables, events or server functions. Every number is a real count the
// signed-in owner can read under existing RLS; the profile totals (items,
// collections, posts, followers…) come from useProfile and are not repeated
// here.
//
// Each group loads and fails on its own: a group that fails is `null` and
// the screen shows "Couldn't load" for it — never a zero standing in for an
// unknown number.

export type CategoryCount = { type: CollectibleItemType | null; label: string; count: number };

export type ViewMetrics = {
  // Sum of profile_item_view_counts (20261101120000_add_item_view_tracking):
  // views of the owner's ACTIVE items by other signed-in collectors, at most
  // one per viewer per item per 30 minutes, counted since tracking began.
  totalViews: number;
  viewedItems: number;
  top: { id: string; title: string; views: number }[];
};

export type Engagement = {
  // All "received from other collectors": the owner's own likes/comments on
  // their own content are excluded.
  postLikes: number;
  postComments: number;
  itemLikes: number;
  itemComments: number;
  collectionLikes: number;
  collectionComments: number;
  // null when the database has no tagging tables (lib/content-tags.ts).
  timesTagged: number | null;
};

// Filled Grails (Top 9) slots. Registry / transfer counts are deliberately
// not loaded: those features aren't part of the beta.
export type Showcase = { grailSlots: number };

export type DashboardAnalytics = {
  categories: CategoryCount[] | null;
  views: ViewMetrics | null;
  engagement: Engagement | null;
  showcase: Showcase | null;
};

const EMPTY: DashboardAnalytics = { categories: null, views: null, engagement: null, showcase: null };
const VIEW_PAGE = 1000;
const VIEW_MAX_PAGES = 20;
const TOP_VIEWED = 3;

type CountResult = { count: number | null; error: unknown };
const countOf = (r: CountResult) => {
  if (r.error || r.count === null) throw r.error ?? new Error('count missing');
  return r.count;
};

async function loadCategories(userId: string, signal: AbortSignal): Promise<CategoryCount[]> {
  const types = Object.keys(ITEM_TYPE_LABEL) as CollectibleItemType[];
  const active = () =>
    supabase
      .from('collection_items')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('collection_status', 'active');
  const results = await Promise.all([
    ...types.map((t) => active().eq('item_type', t).abortSignal(signal)),
    active().is('item_type', null).abortSignal(signal),
  ]);
  const counts = results.map(countOf);
  return [
    ...types.map((type, i) => ({ type, label: ITEM_TYPE_LABEL[type], count: counts[i] })),
    { type: null, label: 'Uncategorized', count: counts[types.length] },
  ]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}

async function loadViews(userId: string, signal: AbortSignal): Promise<ViewMetrics> {
  const rows: { item_id: string; view_count: number }[] = [];
  for (let page = 0; page < VIEW_MAX_PAGES; page++) {
    const { data, error } = await supabase
      .rpc('profile_item_view_counts', { p_owner_id: userId, p_limit: VIEW_PAGE, p_offset: page * VIEW_PAGE })
      .abortSignal(signal);
    if (error) throw error;
    const batch = (data ?? []) as { item_id: string; view_count: number }[];
    rows.push(...batch);
    if (batch.length < VIEW_PAGE) break;
  }
  // Ordered by view_count desc, so the first rows are the most viewed.
  const topRows = rows.slice(0, TOP_VIEWED);
  let titles = new Map<string, string>();
  if (topRows.length) {
    const { data, error } = await supabase
      .from('collection_items')
      .select('id, title')
      .in('id', topRows.map((r) => r.item_id))
      .abortSignal(signal);
    if (error) throw error;
    titles = new Map(((data ?? []) as { id: string; title: string | null }[]).map((r) => [r.id, r.title?.trim() || 'Untitled Item']));
  }
  return {
    totalViews: rows.reduce((sum, r) => sum + Number(r.view_count), 0),
    viewedItems: rows.length,
    top: topRows.map((r) => ({ id: r.item_id, title: titles.get(r.item_id) ?? 'Untitled Item', views: Number(r.view_count) })),
  };
}

async function loadEngagement(userId: string, signal: AbortSignal): Promise<Engagement> {
  // Rows on the owner's content (joined through its parent), by others.
  const onPosts = (table: 'likes' | 'comments') =>
    supabase
      .from(table)
      .select('post_id, posts!inner(user_id)', { count: 'exact', head: true })
      .eq('posts.user_id', userId)
      .neq('user_id', userId)
      .abortSignal(signal);
  const onItems = (table: 'item_likes' | 'item_comments') =>
    supabase
      .from(table)
      .select('item_id, collection_items!inner(user_id, collection_status)', { count: 'exact', head: true })
      .eq('collection_items.user_id', userId)
      .eq('collection_items.collection_status', 'active')
      .neq('user_id', userId)
      .abortSignal(signal);
  const onFolders = (table: 'folder_likes' | 'folder_comments') =>
    supabase
      .from(table)
      .select('folder_id, folders!inner(user_id)', { count: 'exact', head: true })
      .eq('folders.user_id', userId)
      .neq('user_id', userId)
      .abortSignal(signal);

  const tagging = await checkTaggingAvailable();
  const [postLikes, postComments, itemLikes, itemComments, collectionLikes, collectionComments, itemTags, folderTags] =
    await Promise.all([
      onPosts('likes'),
      onPosts('comments'),
      onItems('item_likes'),
      onItems('item_comments'),
      onFolders('folder_likes'),
      onFolders('folder_comments'),
      tagging
        ? supabase.from('collection_item_tags').select('item_id', { count: 'exact', head: true }).eq('tagged_user_id', userId).abortSignal(signal)
        : Promise.resolve({ count: 0, error: null }),
      tagging
        ? supabase.from('folder_tags').select('folder_id', { count: 'exact', head: true }).eq('tagged_user_id', userId).abortSignal(signal)
        : Promise.resolve({ count: 0, error: null }),
    ]);
  return {
    postLikes: countOf(postLikes),
    postComments: countOf(postComments),
    itemLikes: countOf(itemLikes),
    itemComments: countOf(itemComments),
    collectionLikes: countOf(collectionLikes),
    collectionComments: countOf(collectionComments),
    timesTagged: tagging ? countOf(itemTags) + countOf(folderTags) : null,
  };
}

async function loadShowcase(userId: string, signal: AbortSignal): Promise<Showcase> {
  const slots = await supabase
    .from('profile_grail_slots')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .abortSignal(signal);
  return { grailSlots: countOf(slots) };
}

export function useDashboardAnalytics(userId: string | undefined) {
  const [data, setData] = useState<DashboardAnalytics>(EMPTY);
  const [loading, setLoading] = useState(true);
  // Only the latest load may commit (same mechanism as useTaggedContent).
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // No session yet: stay in the loading state (never "Couldn't load");
    // the screen reloads once the user id arrives.
    if (!userId) return;
    setLoading(true);
    const settle = <T,>(p: Promise<T>, label: string) =>
      p.catch((e: unknown) => {
        if (__DEV__ && !controller.signal.aborted) {
          console.warn(`[useDashboardAnalytics] ${label} failed:`, (e as { message?: string })?.message ?? e);
        }
        return null;
      });
    const [categories, views, engagement, showcase] = await Promise.all([
      settle(loadCategories(userId, controller.signal), 'categories'),
      settle(loadViews(userId, controller.signal), 'views'),
      settle(loadEngagement(userId, controller.signal), 'engagement'),
      settle(loadShowcase(userId, controller.signal), 'showcase'),
    ]);
    if (controller.signal.aborted || controllerRef.current !== controller) return;
    controllerRef.current = null;
    setData({ categories, views, engagement, showcase });
    setLoading(false);
  }, [userId]);

  // The screen runs `refresh` on focus and on pull-to-refresh; an unmount
  // cancels whatever is in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { ...data, loading, refresh: load };
}

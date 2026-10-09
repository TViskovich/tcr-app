import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CollectionPreviewCard } from '@/components/collection/collection-preview-card';
import { SharePostPreview } from '@/components/feed/share-post-preview';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  type CollectionItemWithFolderVisibility,
  useAllItems,
  useChildFolders,
  useFolders,
} from '@/hooks/use-collection';
import { useProfile } from '@/hooks/use-profile';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { rememberMediaSize, useMediaSize } from '@/lib/feed-media-dimensions';
import { COMPACT_IMAGE_TIER, DETAIL_IMAGE_TIER, type ImageTier } from '@/lib/image-tiers';
import { attachPrimaryImageIds } from '@/lib/item-images';
import { invalidateOwnProfileCache, peekOwnProfileCacheSync } from '@/lib/own-profile-cache';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import { copyShareSnapshotImage, createSnapshotPost } from '@/lib/share-snapshots';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CardShareItem, CollectionItem, Folder } from '@/types';

const MAX_CHARS = 280;
const MAX_CARDS = 5;
// Folder picker tiles — same 3-across layout as the Grails collection
// picker (app/grail-slot/pick-collection.tsx), inside this screen's own
// 16pt scroll padding.
const FOLDER_COLUMNS = 3;
const FOLDER_GAP = 10;
const SCROLL_PADDING = 16;
// Card tiles in a scope's first screenful (3 per row): signed in their own
// small batch, ahead of the rest, and downloaded at expo-image's high
// priority — the rest follow in a second batch at low priority.
const PRIORITY_CARD_COUNT = 12;

// What the picker is browsing: null = the folder picker itself; 'all' =
// every card (the original single grid); 'folder' = one folder's direct
// cards (and its child folders), with the path from the root folder down so
// Back can step up one level at a time.
type Browse = { kind: 'all' } | { kind: 'folder'; trail: Folder[] };

// A feed post needs an image to be worth sharing — this is a product/UX
// filter only; create-snapshot-post's own copy step independently fails
// the whole request for any item with no resolvable image regardless of
// this (see that function's own module comment). Trimmed, not just
// truthy — a whitespace-only string is not a usable image. Still filtered
// on the legacy image_url field — every real item with a gallery image
// also has this field set (kept in sync by the same DB functions that
// maintain primary_image_id), so this remains an accurate proxy for "has
// an image" without needing to wait on a signed lookup just to decide the
// picker's contents.
function hasShareableImage(item: CollectionItem) {
  return !!item.image_url?.trim();
}

// Loads ONE browse scope's cards — the signed-in user's own active items,
// all of them or one folder's direct items — through the same useAllItems
// query (owner-scoped, folder visibility, primary image ids) this screen
// has always used, plus one batched preview-tier signing call for them.
// Keyed by scope at its call site, so every scope mounts fresh: a spinner
// until ITS rows arrive, never the previous scope's cards. onLoaded hands
// each result to the screen, which keeps every card it has seen so a
// selection made in another folder still resolves (reorder strip, preview,
// Post re-validation).
//
// `seed` (rows this scope already showed this session, else the own-profile
// cache's copy of them) renders on the first frame; the query still runs
// and replaces it — so reopening a folder shows its cards at once instead
// of a spinner. Signing is two batches through the shared signed-URL cache:
// the first screenful (PRIORITY_CARD_COUNT), then the rest, so the visible
// tiles never wait on a large folder's whole batch.
function ScopedCards({
  scopeKey,
  userId,
  folderId,
  seed,
  onLoaded,
  children,
}: {
  scopeKey: string;
  userId: string | undefined;
  folderId?: string;
  seed: CollectionItemWithFolderVisibility[] | null;
  onLoaded: (scopeKey: string, items: CollectionItemWithFolderVisibility[]) => void;
  children: (scope: {
    items: CollectionItemWithFolderVisibility[];
    loading: boolean;
    error: string | null;
    refresh: () => void;
    imageUrls: Map<string, string>;
    servedTiers: Map<string, ImageTier>;
  }) => ReactNode;
}) {
  const { items: allRows, loading, error, refresh } = useAllItems(userId, { folderId, seed });
  const items = allRows.filter(hasShareableImage);
  const priority = useSignedItemImages(
    items.slice(0, PRIORITY_CARD_COUNT).map((i) => i.primary_image_id),
    COMPACT_IMAGE_TIER,
  );
  const rest = useSignedItemImages(
    items.slice(PRIORITY_CARD_COUNT).map((i) => i.primary_image_id),
    COMPACT_IMAGE_TIER,
  );
  const imageUrls = new Map([...rest.urls, ...priority.urls]);
  const servedTiers = new Map([...rest.servedTiers, ...priority.servedTiers]);
  useEffect(() => {
    onLoaded(scopeKey, allRows);
  }, [scopeKey, allRows, onLoaded]);
  return <>{children({ items, loading, error, refresh, imageUrls, servedTiers })}</>;
}

// Card picker for the Create menu's "Share Card" option — lets the
// signed-in user pick 1-5 of their own collection_items and post them to
// the feed. Folder-first: it opens on a collection picker ("All Cards" =
// every card, as before, then the user's root folders in Collection order),
// and loads a scope's cards only once it's opened (ScopedCards). The
// selection lives above that browsing, so cards picked in different
// folders all stay selected. 1 selected copies
// its snapshot then inserts directly (mirrors app/item/new.tsx's own
// share-to-feed pattern). 2-5 selected goes through the
// create-snapshot-post Edge Function (Phase 3E — supersedes the original
// create_card_share_post RPC, still present in the database but no
// longer called from here), which copies every card's image into
// share-snapshots and creates the post + card_share_items rows together,
// server-side, as one all-or-nothing unit — see that function's own
// module comment for the full invariant.
export default function ShareCardScreen() {
  // Optional preselection — set when this screen is opened from Item
  // Detail's Share Item sheet ("Post to Feed") via
  // /share-card/new?itemId=<id>, so the user never has to pick that card
  // again here. Absent (undefined) for every other entry point (the
  // Create menu's own "Share Card" option), which is exactly today's
  // behavior — nothing seeded, picker starts empty.
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const [browse, setBrowse] = useState<Browse | null>(null);
  const currentFolder = browse?.kind === 'folder' ? browse.trail[browse.trail.length - 1] : null;
  // Every one of the user's own cards loaded in ANY scope so far, by id —
  // what selection resolves against, so a card picked in one folder stays
  // selectable/postable after browsing to another.
  const [knownItems, setKnownItems] = useState<Map<string, CollectionItemWithFolderVisibility>>(() => new Map());
  // Rows each scope ('all' or a folder id) has shown during this composer
  // session — reopening it starts from them (see ScopedCards' seed). Lives
  // and dies with this screen, so it never outlasts the session or crosses
  // accounts.
  const scopeRowsRef = useRef(new Map<string, CollectionItemWithFolderVisibility[]>());
  const rememberItems = useCallback((scopeKey: string, loaded: CollectionItemWithFolderVisibility[]) => {
    if (!loaded.length) return;
    scopeRowsRef.current.set(scopeKey, loaded);
    setKnownItems((prev) => {
      const next = new Map(prev);
      for (const item of loaded) next.set(item.id, item);
      return next;
    });
  }, []);
  // The own-profile cache (lib/own-profile-cache.ts) already holds this
  // user's root folders (same useFolders query and order) and every one of
  // their items (same useAllItems rows, primary image ids included). Read
  // once: it lets the folder picker and each card scope paint immediately,
  // while their own queries still run and replace it.
  const [ownCache] = useState(() => (currentUserId ? (peekOwnProfileCacheSync(currentUserId)?.payload ?? null) : null));
  // The seed for the scope being opened, chosen when it's opened (see
  // openScope): this session's rows for it, else the cache's. Never an empty
  // list — an empty seed would flash "no cards" before the real answer.
  const [scopeSeed, setScopeSeed] = useState<CollectionItemWithFolderVisibility[] | null>(null);
  function seedFor(folderId: string | null): CollectionItemWithFolderVisibility[] | null {
    const known = scopeRowsRef.current.get(folderId ?? 'all');
    if (known?.length) return known;
    if (!ownCache) return null;
    const cached = folderId ? ownCache.items.filter((i) => i.folder_id === folderId) : ownCache.items;
    return cached.length ? cached : null;
  }
  const { width: windowWidth } = useWindowDimensions();
  const folderTileWidth = (windowWidth - SCROLL_PADDING * 2 - FOLDER_GAP * (FOLDER_COLUMNS - 1)) / FOLDER_COLUMNS;
  const scrollRef = useRef<ScrollView>(null);
  // Own profile only — the "current user's avatar/username" the preview
  // (below) needs, same hook every other screen in this app already uses
  // for that. Not used for anything else on this screen.
  const { profile: currentProfile } = useProfile(currentUserId);
  // A create form, not a scrollable browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  // Own cards with an image (see hasShareableImage), from every scope
  // loaded so far.
  const shareableItems = [...knownItems.values()].filter(hasShareableImage);

  // Route-param preselection ("Post to Feed" from Item Detail's Share Item
  // sheet, via /share-card/new?itemId=<id>) — fetched directly by id,
  // never through useAllItems/shareableItems above (which is scoped to the
  // SIGNED-IN USER'S OWN items only). This is what lets the source item
  // belong to someone else: a plain by-id select is still subject to
  // items_select_public RLS, so a foreign row only ever comes back at all
  // when it's genuinely public (is_public AND its whole folder chain
  // effectively visible) — a private foreign item is indistinguishable
  // from "not found" here, by design (this must never leak whether a
  // private item exists). isPubliclyShareable (below) re-checks the same
  // "publicly shareable" rule this screen already enforces for the
  // signed-in user's own items, as defense-in-depth and so an owned-but-
  // private source item is rejected identically to a private foreign one
  // — this screen has never allowed posting a private card to the public
  // feed, owned or not, and this entry path doesn't change that.
  const [sourceItem, setSourceItem] = useState<CollectionItemWithFolderVisibility | null>(null);
  const [sourceLoading, setSourceLoading] = useState(!!itemId);
  const [sourceError, setSourceError] = useState<string | null>(null);
  // Foreign-repost attribution ("Share → Post to Feed" on someone else's
  // public card) — the ORIGINAL OWNER's own profile, fetched once
  // sourceItem resolves as not-the-signed-in-user's. Feeds the simplified
  // repost composer's own preview (below) so it's genuinely WYSIWYG with
  // the resulting feed post (same PostCard/RepostHeader rendering — see
  // SharePostPreview's own itemPost prop).
  const [sourceOwnerProfile, setSourceOwnerProfile] = useState<{
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null>(null);
  // Guards against re-fetching the same itemId twice (e.g. React Strict
  // Mode's double-invoke in dev) — itemId itself never changes for the
  // lifetime of this screen (it's a route param), so this only ever needs
  // to fire once per mount.
  const sourceFetchStartedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!itemId || sourceFetchStartedRef.current === itemId) return;
    sourceFetchStartedRef.current = itemId;
    let cancelled = false;

    async function loadSourceItem() {
      setSourceLoading(true);
      setSourceError(null);
      try {
        // Explicit !collection_items_folder_id_fkey — same PostgREST
        // embed ambiguity useAllItems' own query already documents
        // (folders.cover_item_id gives it a second FK path to
        // collection_items).
        const { data: rawItem, error: fetchError } = await supabase
          .from('collection_items')
          .select('*, folders!collection_items_folder_id_fkey(is_public)')
          .eq('id', itemId)
          .eq('collection_status', 'active')
          .maybeSingle();
        if (cancelled) return;

        if (fetchError) {
          console.error('[share-card] source item fetch failed:', fetchError.message, fetchError);
          setSourceError('Something went wrong loading this card. Please try again.');
          return;
        }

        // null covers every ineligible case identically (not found,
        // inactive/deleted, or hidden from this viewer by RLS because
        // it's a private foreign item) — never distinguished further, so
        // this can't be used to probe whether a private item exists.
        if (!rawItem || !(rawItem as CollectionItem).image_url?.trim()) {
          setSourceError('This card isn’t available to share right now.');
          return;
        }

        const { folders, ...itemFields } = rawItem as CollectionItem & {
          folders: { is_public: boolean } | null;
        };
        const withFolderVisibility: CollectionItemWithFolderVisibility = {
          ...itemFields,
          folder_is_public: folders?.is_public ?? false,
        };

        if (!(withFolderVisibility.is_public && withFolderVisibility.folder_is_public)) {
          setSourceError('This card is private and can’t be shared to the feed.');
          return;
        }

        const [withPrimaryId] = await attachPrimaryImageIds([withFolderVisibility]);
        if (cancelled) return;
        setSourceItem(withPrimaryId);
        setSelectedIds((prev) => (prev.includes(withPrimaryId.id) ? prev : [withPrimaryId.id, ...prev]));

        // Foreign-repost attribution — one extra, conditional profile
        // fetch, exactly like app/post/[id].tsx's own equivalent (a
        // single-item screen, not worth the batched-query pattern
        // queryFeed/fetchUserPosts use for a whole page of posts).
        if (withPrimaryId.user_id !== currentUserId) {
          const { data: ownerProfile, error: ownerProfileError } = await supabase
            .from('profiles')
            .select('username, display_name, avatar_url')
            .eq('id', withPrimaryId.user_id)
            .maybeSingle();
          if (cancelled) return;
          if (ownerProfileError) {
            console.error('[share-card] source-owner profile fetch failed:', ownerProfileError.message, ownerProfileError);
          } else if (ownerProfile) {
            setSourceOwnerProfile(ownerProfile);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error('[share-card] source item load threw:', e);
          setSourceError('Something went wrong loading this card. Please try again.');
        }
      } finally {
        if (!cancelled) setSourceLoading(false);
      }
    }

    loadSourceItem();
    return () => {
      cancelled = true;
    };
    // currentUserId is read inside (for the owner-profile fetch branch)
    // but intentionally not what gates re-running this effect — the
    // sourceFetchStartedRef guard above already makes any re-invocation
    // (e.g. a currentUserId change) an immediate no-op, since itemId itself
    // never changes for this screen's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // Merges the route-preselected source item into every id-based lookup
  // below (selectedItems, handlePost's re-validation/single-item path) —
  // but deliberately NOT into shareableItems/the tappable picker grid
  // itself, which stays exactly "the signed-in user's own items" as
  // before. A source item that already IS one of the user's own (already
  // present in shareableItems) is never duplicated.
  const resolvableItems: CollectionItemWithFolderVisibility[] =
    sourceItem && !shareableItems.some((i) => i.id === sourceItem.id)
      ? [sourceItem, ...shareableItems]
      : shareableItems;

  // A repost of someone else's public card — per product decision, this
  // stays a fixed SINGLE-item share: no own-item grid, no reorder UI, no
  // 1-5 selection (see the simplified composer branch in this screen's own
  // render, and toggleSelect's own mixed-selection guard above/below for
  // why mixing isn't supported yet). An own-item preselection (sourceItem
  // present but sourceItem.user_id === currentUserId) keeps the full normal
  // Share Card flow, completely unaffected.
  const isForeignRepost = !!sourceItem && sourceItem.user_id !== currentUserId;

  // Reorder-strip thumbnails and the preview's fallback — 'preview' tier,
  // one batched call for just the SELECTED cards (plus a preselected source
  // item), which may come from several folders. Each picker grid signs its
  // own cards (ScopedCards); both share the same cache and in-flight
  // requests, so a card already shown in a grid never signs twice.
  const { urls: signedItemImageUrls, servedTiers: signedItemServedTiers } = useSignedItemImages(
    resolvableItems
      .filter((i) => i.id === sourceItem?.id || selectedIds.includes(i.id))
      .map((i) => i.primary_image_id),
    COMPACT_IMAGE_TIER,
  );
  // Same identity the signed-URL cache keys by — for stable byte cacheKeys.
  const cacheIdentity = currentUserId ?? 'anon';

  // The folder picker's data — root folders in the user's normal
  // Collection order (useFolders: the Collection tab's own name order),
  // with resolved covers and direct item counts, each fetched in one batch
  // (never per folder) — no card rows at all until a scope is opened. Not
  // loaded for a foreign repost, which never shows the picker.
  const pickerUserId = itemId && (sourceLoading || isForeignRepost) ? undefined : currentUserId;
  const {
    folders: rootFolders,
    itemCounts,
    loading: foldersLoading,
    error: foldersError,
    refresh: refreshFolders,
  } = useFolders(pickerUserId, {
    seed: ownCache
      ? {
          folders: ownCache.folders,
          itemCounts: ownCache.folderItemCounts,
          previewItems: {},
          previewEntries: ownCache.folderPreviewEntries,
        }
      : null,
  });
  // An opened folder's own child folders, shown above its cards — the same
  // one-level-at-a-time hierarchy the Collection screens use (a folder's
  // cards are its DIRECT items only; descendants are reached by opening a
  // child). Filtered by parent so a previous folder's children never show
  // for the frame before this folder's load starts.
  const { folders: childFolderRows } = useChildFolders(currentFolder?.id);
  const childFolders = currentFolder ? childFolderRows.filter((f) => f.parent_folder_id === currentFolder.id) : [];
  // One batched preview-tier call for every folder tile shown, with the
  // stable cacheKeys the Collection screens use (coverSource).
  const { coverSource } = useSignedFolderCovers(
    [...rootFolders, ...childFolders].map((f) => f.id),
    COMPACT_IMAGE_TIER,
  );

  function openFolder(folder: Folder) {
    setScopeSeed(seedFor(folder.id));
    setBrowse((prev) => ({ kind: 'folder', trail: prev?.kind === 'folder' ? [...prev.trail, folder] : [folder] }));
  }

  function openAllCards() {
    setScopeSeed(seedFor(null));
    setBrowse({ kind: 'all' });
  }

  // Up one level: a child folder back to its parent, a root folder or All
  // Cards back to the picker. Never leaves the screen — that's Cancel.
  const goUp = useCallback(() => {
    const parent = browse?.kind === 'folder' && browse.trail.length > 1 ? browse.trail[browse.trail.length - 2] : null;
    if (parent) setScopeSeed(seedFor(parent.id));
    setBrowse((prev) =>
      prev?.kind === 'folder' && prev.trail.length > 1 ? { kind: 'folder', trail: prev.trail.slice(0, -1) } : null,
    );
    // seedFor reads only refs/props that don't need to be dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browse]);

  // Each level starts at its top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [browse]);

  // Android's hardware Back steps up a level while browsing, instead of
  // closing the composer (and its selection) outright.
  useEffect(() => {
    if (!browse) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goUp();
      return true;
    });
    return () => sub.remove();
  }, [browse, goUp]);

  // Effective (most-restrictive-wins) public visibility — the same rule
  // enforced by items_select_public/collection_item_images_select_public
  // RLS and by app/item/new.tsx's own Share-to-feed gate (see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Ownership (useAllItems already scopes this whole list to the caller's
  // own items) grants private viewing, not permission to create a public
  // feed representation — a private card stays ineligible here even though
  // the owner can obviously still see it in this picker.
  function isPubliclyShareable(item: (typeof shareableItems)[number]) {
    return item.folder_is_public && item.is_public;
  }

  const canPost = selectedIds.length >= 1 && !posting;

  // The compose step's own view of the selection, in FINAL posting order —
  // selectedIds' own array order IS that order (see moveSelected below and
  // handlePost, which passes selectedIds straight through to
  // createSnapshotPost/the single-card insert; display_order on the
  // persisted card_share_items rows is assigned server-side from this same
  // array's index — see create-snapshot-post's own module comment). Filters
  // out any id that no longer resolves against resolvableItems defensively
  // (mirrors handlePost's own re-validation below) rather than assuming
  // selectedIds and resolvableItems can never disagree for a render in
  // between state updates.
  const selectedItems = selectedIds
    .map((id) => resolvableItems.find((i) => i.id === id))
    .filter((i): i is (typeof resolvableItems)[number] => !!i);

  // The compose Preview below renders the SELECTED cards through
  // CardSharePostBody at (near) full width, where a 500px preview would look
  // soft — so ONLY the selected items' images (never the whole picker grid)
  // are requested at 'detail'. The already-resolved preview URL is the
  // fallback while a just-selected card's detail URL is still resolving.
  const { urls: signedDetailImageUrls } = useSignedItemImages(
    selectedItems.map((i) => i.primary_image_id),
    DETAIL_IMAGE_TIER,
  );

  // Preview media URLs are signed and CHANGE while Preview is open — none,
  // then the 'preview' tier, then 'detail' — unlike a real feed post's one
  // fixed snapshot URL. PostCard keys its media gate on the LEAD image's URL
  // (useMediaSize): every new URL unmounts the media until that URL is
  // measured, and measuring the detail URL means downloading the full
  // 1400px image first. So the preview went blank exactly when its sharper
  // image arrived. The detail image is the same picture as the preview tier
  // (same aspect ratio, the only thing PostCard uses the size for), so the
  // lead keeps its preview-tier URL until that has been measured, then
  // switches to detail with the measured size handed over — the frame stays
  // mounted and the sharper bytes simply load into it. Preview-only, in
  // memory: nothing here reaches a durable post row.
  const leadImageId = isForeignRepost ? sourceItem?.primary_image_id : selectedItems[0]?.primary_image_id;
  const leadPreviewUrl = leadImageId ? (signedItemImageUrls.get(leadImageId) ?? null) : null;
  const leadPreviewMedia = useMediaSize(leadPreviewUrl);

  function previewImageUrl(imageId: string | null | undefined): string | null {
    if (!imageId) return null;
    const preview = signedItemImageUrls.get(imageId) ?? null;
    const detail = signedDetailImageUrls.get(imageId) ?? null;
    if (imageId !== leadImageId || !detail || !preview) return detail ?? preview;
    if (!leadPreviewMedia.settled) return preview;
    if (leadPreviewMedia.size) rememberMediaSize(detail, leadPreviewMedia.size.width, leadPreviewMedia.size.height);
    return detail;
  }

  // Fake, LOCAL-ONLY CardShareItem rows for the preview — no post exists
  // yet, so there is no real card_share_items id/post_id to read. Reuses
  // the exact fields CardSharePostBody actually renders (snapshot_title/
  // snapshot_subtitle sourced the same way create-snapshot-post derives
  // them server-side: item.title/item.brand) plus the already-signed
  // preview image this screen's own grid already displays — never the
  // durable share-snapshots copy, which only gets created at actual post
  // time. item_id is deliberately null (not the real item id) so
  // CardSharePostBody's own tap-to-navigate is disabled here — this
  // preview is a visual confirmation, not a live interactive card; tapping
  // it should never navigate the user away from mid-compose.
  const previewCards: CardShareItem[] = selectedItems.map((item, index) => ({
    id: item.id,
    post_id: 'preview',
    item_id: null,
    snapshot_image_url: previewImageUrl(item.primary_image_id),
    snapshot_title: item.title,
    snapshot_subtitle: item.brand,
    display_order: index,
  }));

  // Adjacent swap only — matches the move-left/move-right control pair
  // rendered per thumbnail below (no drag-and-drop library in this
  // project; see the reorder strip's own comment). No-ops silently at
  // either end of the list rather than wrapping around.
  function moveSelected(id: string, direction: -1 | 1) {
    setSelectedIds((prev) => {
      const index = prev.indexOf(id);
      if (index === -1) return prev;
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  // No back history when this screen was deep-linked, reloaded directly, or
  // opened during development — fall back to the main feed, where the Create
  // menu that opens this screen always lives and where the new post appears.
  function leaveScreen() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  function toggleSelect(item: (typeof shareableItems)[number]) {
    // Primary prevention — a private card is never added to the selection
    // in the first place, regardless of how this is invoked (the grid
    // below also visually disables the Pressable itself as a second,
    // independent layer).
    if (!isPubliclyShareable(item)) return;
    const id = item.id;
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_CARDS) return prev;
      // A foreign (not-owned) preselected source item can only be posted
      // through the single-card path today — create-snapshot-post's
      // multi-item path (2-5 cards) still requires every item to belong
      // to the caller (see its own ownership query), by design (this pass
      // deliberately doesn't broaden that). Adding a second card while the
      // foreign source item is still selected would only fail confusingly
      // at Post time, so it's blocked here instead, with a clear reason —
      // removing the foreign card first (via the reorder strip's own X)
      // frees this back up for a normal multi-card, all-own-items post.
      if (sourceItem && sourceItem.user_id !== currentUserId && prev.includes(sourceItem.id)) {
        Alert.alert(
          'Cannot add more cards',
          'This card isn’t yours, so it can only be shared by itself right now — not together with your own cards.',
        );
        return prev;
      }
      return [...prev, id];
    });
  }

  async function handlePost() {
    if (!canPost || !currentUserId) return;

    // Handler-level guard, immediately before any feed-post insert — not
    // just relying on toggleSelect/the disabled grid state having kept
    // private cards out of selectedIds. Re-reads the actual item objects'
    // current privacy flags rather than trusting stale selection state.
    // resolvableItems (not shareableItems) so this still resolves a
    // foreign preselected source item correctly.
    const selectedItems = resolvableItems.filter((i) => selectedIds.includes(i.id));
    if (selectedItems.length !== selectedIds.length || selectedItems.some((i) => !isPubliclyShareable(i))) {
      Alert.alert('Cannot share', 'Private cards can’t be shared to the public feed.');
      return;
    }

    setPosting(true);

    try {
      if (selectedIds.length === 1) {
        // resolvableItems (not shareableItems) — this is the exact path a
        // foreign preselected source item posts through (copyShareSnapshotImage
        // -> copy-share-snapshot-image, whose shared authorization core now
        // permits a genuinely-public non-owned item for this single-card
        // 'post' snapshot type; see supabase/functions/_shared/
        // share-snapshot.ts). posts_insert_own RLS only checks
        // auth.uid() = user_id (the poster), not item_id ownership, so
        // this insert already worked for a foreign item_id — nothing
        // about this INSERT itself needed to change.
        const item = resolvableItems.find((i) => i.id === selectedIds[0]);
        if (!item) throw new Error('Selected card is missing an image.');

        // Copy-before-insert (Phase 3E) — a feed post is never created
        // pointing at a raw item-images URL. targetId reuses item.id
        // since no post exists yet at this point (see
        // lib/share-snapshots.ts's own module comment). This is now the
        // sole enforcement point for "the selected item must have a
        // resolvable image" on this path — a copy failure aborts the
        // whole post, surfaced to the user below.
        const snapshot = await copyShareSnapshotImage(item.id, 'post', item.id);
        if (snapshot.status !== 'ok') {
          throw new Error('Could not prepare this card’s image. Please try again.');
        }

        const { error: insertError } = await supabase.from('posts').insert({
          user_id: currentUserId,
          item_id: item.id,
          post_type: 'item',
          image_url: snapshot.publicUrl,
          caption: caption.trim() || null,
        });
        if (insertError) throw insertError;
      } else {
        // All-or-nothing (Phase 3E) — every selected card's image is
        // copied into share-snapshots and the post + card_share_items
        // rows are created together, server-side, as one unit. Either the
        // whole post exists with every card already durable, or nothing
        // was created at all — never a partially-imaged post, never a
        // raw item-images URL. See create-snapshot-post's own module
        // comment for the full invariant.
        const result = await createSnapshotPost('card_share', selectedIds, caption.trim() || null);
        if (result.status !== 'ok') {
          throw new Error('Could not prepare these cards’ images. Please try again.');
        }
      }
      // Mark the own-profile cache stale — this post now shows on
      // Profile's Posts tab. See lib/own-profile-cache.ts's own
      // invalidateOwnProfileCache comment.
      invalidateOwnProfileCache(currentUserId);
      leaveScreen();
    } catch (e) {
      // Full detail stays in the console; the user gets a stable, generic
      // message rather than a raw Supabase/Postgres error string.
      console.error('[share-card] post failed:', e);
      Alert.alert('Post failed', 'Something went wrong. Please try again.');
      // Stay on screen — selection/caption preserved so the user can retry.
    } finally {
      setPosting(false);
    }
  }

  // Foreign-repost preview image — reuses the exact same already-signed
  // urls the normal compose flow's own previewCards already resolves
  // (detail tier, falling back to the picker-grid's compact tier while
  // detail is still resolving) rather than a third signing call.
  const foreignRepostPreviewImageUrl = isForeignRepost ? previewImageUrl(sourceItem?.primary_image_id) : null;

  return (
    <>
      <Stack.Screen
        options={{
          title: isForeignRepost ? 'Repost' : 'Share Card',
          headerLeft: () => (
            <TouchableOpacity onPress={leaveScreen} hitSlop={8}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity onPress={handlePost} disabled={!canPost} hitSlop={8}>
              {posting ? (
                <ActivityIndicator size="small" color={PV2.link} />
              ) : (
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>Post</Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {/* loading (own items) OR still resolving a route-param source item —
          combined into one gate so the composer (and its "1/5 selected"
          count) never flashes an intermediate 0-selected state while a
          preselected source item is still loading in. */}
      {!!itemId && sourceLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : itemId && sourceError ? (
        // The route-preselected source item couldn't be loaded (private,
        // deleted, or otherwise ineligible) — a clear, dedicated error
        // rather than silently falling back to the normal own-items picker
        // (which would look like "pick a different card instead" without
        // ever saying why the requested one didn't show up).
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Can&apos;t share this card</Text>
          <Text style={styles.emptyBody}>{sourceError}</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={leaveScreen}>
            <Text style={styles.emptyButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      ) : isForeignRepost ? (
        // Foreign-repost restrictions — a repost of someone else's public
        // card stays a fixed single item: no own-item grid, no arrange/
        // reorder UI, no 1-5 selection. Just the (real, WYSIWYG) preview,
        // an optional caption, and Post — see SharePostPreview's own
        // itemPost prop.
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            contentContainerStyle={[styles.scroll, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
            <Text style={styles.repostNotice}>
              This card belongs to {sourceOwnerProfile?.display_name || sourceOwnerProfile?.username || 'another collector'}.
              Sharing it reposts their card to your followers — it doesn&apos;t add it to your own collection.
            </Text>

            <Text style={styles.sectionLabel}>Caption</Text>
            <TextInput
              style={styles.input}
              placeholder="Add a caption (optional)"
              placeholderTextColor={PV2.textTertiary}
              multiline
              value={caption}
              onChangeText={setCaption}
              maxLength={MAX_CHARS}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>
              {caption.length}/{MAX_CHARS}
            </Text>

            <Text style={styles.sectionLabel}>Preview</Text>
            <SharePostPreview
              avatarUrl={currentProfile?.avatar_url ?? null}
              displayName={currentProfile?.display_name || currentProfile?.username || ''}
              username={currentProfile?.username ?? ''}
              caption={caption}
              cards={[]}
              itemPost={{
                imageUrl: foreignRepostPreviewImageUrl,
                title: sourceItem!.title,
                sourceOwner: sourceOwnerProfile
                  ? {
                      id: sourceItem!.user_id,
                      username: sourceOwnerProfile.username,
                      displayName: sourceOwnerProfile.display_name,
                      avatarUrl: sourceOwnerProfile.avatar_url,
                    }
                  : null,
              }}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={[styles.scroll, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
            {browse === null ? (
              <>
                {/* Step 1 — choose where to browse. All Cards first (the
                    original single grid), then the user's root folders. */}
                <View style={styles.selectRow}>
                  <Text style={styles.sectionLabel}>Choose a collection</Text>
                  {selectedIds.length > 0 && (
                    <Text style={styles.selectedCount}>
                      {selectedIds.length}/{MAX_CARDS} selected
                    </Text>
                  )}
                </View>
                <View style={styles.folderGrid}>
                  <CollectionPreviewCard
                    imageUrl={null}
                    title="All Cards"
                    tileWidth={folderTileWidth}
                    onPress={openAllCards}
                  />
                  {rootFolders.map((folder) => {
                    const count = itemCounts[folder.id] ?? 0;
                    return (
                      <CollectionPreviewCard
                        key={folder.id}
                        imageUrl={coverSource(folder)?.uri ?? null}
                        cacheKey={coverSource(folder)?.cacheKey}
                        title={folder.name}
                        subtitle={`${count} ${count === 1 ? 'item' : 'items'}`}
                        tileWidth={folderTileWidth}
                        onPress={() => openFolder(folder)}
                      />
                    );
                  })}
                </View>
                {foldersLoading && rootFolders.length === 0 ? (
                  <ActivityIndicator style={styles.scopeState} color={PV2.link} />
                ) : foldersError && rootFolders.length === 0 ? (
                  <View style={styles.scopeState}>
                    <Text style={styles.emptyBody}>Couldn&apos;t load your collections.</Text>
                    <TouchableOpacity style={styles.emptyButton} onPress={refreshFolders}>
                      <Text style={styles.emptyButtonText}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                {/* Back up one level (to the parent folder, or the picker) —
                    never leaves the composer; Cancel does that. */}
                <TouchableOpacity
                  style={styles.backRow}
                  onPress={goUp}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Back to collections">
                  <IconSymbol name="chevron.left" size={18} color={PV2.textPrimary} />
                  <Text style={styles.backTitle} numberOfLines={1}>
                    {currentFolder ? currentFolder.name : 'All Cards'}
                  </Text>
                </TouchableOpacity>

                {childFolders.length > 0 && (
                  <View style={styles.folderGrid}>
                    {childFolders.map((folder) => (
                      <CollectionPreviewCard
                        key={folder.id}
                        imageUrl={coverSource(folder)?.uri ?? null}
                        cacheKey={coverSource(folder)?.cacheKey}
                        title={folder.name}
                        tileWidth={folderTileWidth}
                        onPress={() => openFolder(folder)}
                      />
                    ))}
                  </View>
                )}

                {/* This scope's cards. Keyed by scope, so opening a
                    different folder (or All Cards) mounts a fresh load. */}
                <ScopedCards
                  key={currentFolder?.id ?? 'all'}
                  scopeKey={currentFolder?.id ?? 'all'}
                  userId={currentUserId}
                  folderId={currentFolder?.id}
                  seed={scopeSeed}
                  onLoaded={rememberItems}>
                  {(scope) =>
                    // Seeded cards stay on screen while they refresh — the
                    // spinner / error states are only for a scope with
                    // nothing to show yet.
                    scope.loading && scope.items.length === 0 ? (
                      <ActivityIndicator style={styles.scopeState} color={PV2.link} />
                    ) : scope.error && scope.items.length === 0 ? (
                      // Distinct from the empty state below — a failed query
                      // must never look identical to "you have no cards."
                      // The raw Supabase message is only ever logged (via
                      // useAllItems's own console.error), never rendered.
                      <View style={styles.scopeState}>
                        <Text style={styles.emptyTitle}>Couldn&apos;t load your collection</Text>
                        <Text style={styles.emptyBody}>Something went wrong. Please try again.</Text>
                        <TouchableOpacity style={styles.emptyButton} onPress={scope.refresh}>
                          <Text style={styles.emptyButtonText}>Retry</Text>
                        </TouchableOpacity>
                      </View>
                    ) : scope.items.length === 0 ? (
                      currentFolder ? (
                        <Text style={styles.scopeEmpty}>
                          {childFolders.length > 0
                            ? 'No cards with photos directly in this collection.'
                            : 'No cards with photos in this collection.'}
                        </Text>
                      ) : (
                        <View style={styles.scopeState}>
                          <Text style={styles.emptyTitle}>No cards to share</Text>
                          <Text style={styles.emptyBody}>
                            Add a photo to a card in your collection before sharing it.
                          </Text>
                          <TouchableOpacity
                            style={styles.emptyButton}
                            onPress={() => router.push('/(tabs)/collection')}>
                            <Text style={styles.emptyButtonText}>Go to Collection</Text>
                          </TouchableOpacity>
                        </View>
                      )
                    ) : (
                      <>
                        <View style={styles.selectRow}>
                          <Text style={styles.sectionLabel}>
                            Choose 1{'–'}{MAX_CARDS} cards
                          </Text>
                          <Text style={styles.selectedCount}>
                            {selectedIds.length}/{MAX_CARDS} selected
                          </Text>
                        </View>
                        {selectedIds.length >= MAX_CARDS && (
                          <Text style={styles.maxHint}>Maximum {MAX_CARDS} cards</Text>
                        )}
                        {scope.items.some((i) => !isPubliclyShareable(i)) && (
                          <Text style={styles.privateHint}>
                            Dimmed cards are private — only public cards in public collections can be shared.
                          </Text>
                        )}

                        <View style={styles.grid}>
                          {scope.items.map((item, index) => {
                            const selectedIndex = selectedIds.indexOf(item.id);
                            const isSelected = selectedIndex !== -1;
                            const shareable = isPubliclyShareable(item);
                            const signedUrl = item.primary_image_id
                              ? scope.imageUrls.get(item.primary_image_id)
                              : undefined;
                            return (
                              <Pressable
                                key={item.id}
                                style={styles.slotShadow}
                                onPress={() => toggleSelect(item)}
                                disabled={!shareable}
                                accessibilityState={{ disabled: !shareable, selected: isSelected }}
                                accessibilityLabel={shareable ? undefined : 'Private card — cannot be shared to the feed'}>
                                <View style={[styles.slot, isSelected && styles.slotSelected, !shareable && styles.slotPrivate]}>
                                  {signedUrl && (
                                    // Stable cacheKey (same identity every other preview-tier
                                    // grid uses), so bytes survive signed-URL rotation and are
                                    // shared with other screens; first screenful first.
                                    <Image
                                      source={{
                                        uri: signedUrl,
                                        cacheKey: itemImageCacheKey(
                                          cacheIdentity,
                                          item.primary_image_id!,
                                          COMPACT_IMAGE_TIER,
                                          scope.servedTiers,
                                        ),
                                      }}
                                      style={styles.image}
                                      contentFit="cover"
                                      transition={150}
                                      cachePolicy="memory-disk"
                                      priority={index < PRIORITY_CARD_COUNT ? 'high' : 'low'}
                                    />
                                  )}
                                  {isSelected && (
                                    <View style={styles.selectedBadge}>
                                      <Text style={styles.selectedBadgeText}>{selectedIndex + 1}</Text>
                                    </View>
                                  )}
                                  {!shareable && (
                                    <View style={styles.privateBadge} pointerEvents="none">
                                      <Text style={styles.privateBadgeText}>Private</Text>
                                    </View>
                                  )}
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      </>
                    )
                  }
                </ScopedCards>
              </>
            )}

            {/* Step 2 — only appears once there's something to compose.
                Reorder strip, caption, and preview all live in this one
                section/page rather than a separate route (kept as a single
                scroll so caption text and card order both stay intact
                while the other is being adjusted — there's no navigation
                transition between them to lose state across). */}
            {selectedItems.length > 0 && (
              <View style={styles.composeSection}>
                <Text style={styles.sectionLabel}>Arrange your cards</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.reorderRow}>
                  {selectedItems.map((item, index) => {
                    const signedUrl = item.primary_image_id
                      ? signedItemImageUrls.get(item.primary_image_id)
                      : undefined;
                    return (
                      <View key={item.id} style={styles.reorderThumbWrap}>
                        <View style={styles.reorderThumb}>
                          {signedUrl && (
                            <Image
                              source={{
                                uri: signedUrl,
                                cacheKey: itemImageCacheKey(
                                  cacheIdentity,
                                  item.primary_image_id!,
                                  COMPACT_IMAGE_TIER,
                                  signedItemServedTiers,
                                ),
                              }}
                              style={styles.image}
                              contentFit="cover"
                              cachePolicy="memory-disk"
                            />
                          )}
                          <View style={styles.selectedBadge}>
                            <Text style={styles.selectedBadgeText}>{index + 1}</Text>
                          </View>
                          <TouchableOpacity
                            style={styles.reorderRemoveBtn}
                            onPress={() => toggleSelect(item)}
                            hitSlop={6}
                            accessibilityRole="button"
                            accessibilityLabel="Remove card from post">
                            <IconSymbol name="xmark" size={12} color={PV2.textPrimary} />
                          </TouchableOpacity>
                        </View>
                        <View style={styles.reorderControls}>
                          <TouchableOpacity
                            onPress={() => moveSelected(item.id, -1)}
                            disabled={index === 0}
                            hitSlop={6}
                            style={styles.reorderArrowBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Move card earlier">
                            <IconSymbol
                              name="chevron.left"
                              size={14}
                              color={index === 0 ? PV2.textTertiary : PV2.textPrimary}
                            />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => moveSelected(item.id, 1)}
                            disabled={index === selectedItems.length - 1}
                            hitSlop={6}
                            style={styles.reorderArrowBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Move card later">
                            <IconSymbol
                              name="chevron.right"
                              size={14}
                              color={index === selectedItems.length - 1 ? PV2.textTertiary : PV2.textPrimary}
                            />
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>

                <Text style={styles.sectionLabel}>Caption</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Add a caption (optional)"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  value={caption}
                  onChangeText={setCaption}
                  maxLength={MAX_CHARS}
                  textAlignVertical="top"
                />
                <Text style={styles.counter}>
                  {caption.length}/{MAX_CHARS}
                </Text>

                <Text style={styles.sectionLabel}>Preview</Text>
                <SharePostPreview
                  avatarUrl={currentProfile?.avatar_url ?? null}
                  displayName={currentProfile?.display_name || currentProfile?.username || ''}
                  username={currentProfile?.username ?? ''}
                  caption={caption}
                  cards={previewCards}
                />
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  headerPostDisabled: {
    color: PV2.textTertiary,
  },
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  scroll: {
    padding: 16,
    gap: 12,
  },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  selectedCount: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  maxHint: {
    fontSize: 12,
    color: PV2.textTertiary,
    marginTop: -6,
  },
  privateHint: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: -6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  folderGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FOLDER_GAP,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  backTitle: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  // Loading / error / empty inside the scroll — content-height, not the
  // full-screen flex:1 center the top-level states use.
  scopeState: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  scopeEmpty: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
    paddingVertical: 24,
  },
  slotShadow: {
    width: '31%',
    aspectRatio: 3 / 4,
    borderRadius: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 5,
    elevation: 2,
  },
  slot: {
    flex: 1,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  slotSelected: {
    borderColor: PV2.accent,
  },
  // Private, ineligible-to-share card — dimmed and non-interactive
  // (Pressable disabled), not removed from the grid entirely, so the user
  // can still see which of their own cards exist and why each is excluded.
  slotPrivate: {
    opacity: 0.55,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  privateBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  privateBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  selectedBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  composeSection: {
    gap: 12,
    marginTop: 4,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: PV2.dividerColor,
  },
  reorderRow: {
    gap: 10,
    paddingBottom: 2,
  },
  reorderThumbWrap: {
    width: 84,
    alignItems: 'center',
    gap: 6,
  },
  reorderThumb: {
    width: 84,
    aspectRatio: 3 / 4,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  reorderRemoveBtn: {
    position: 'absolute',
    top: 5,
    left: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderControls: {
    flexDirection: 'row',
    gap: 4,
  },
  reorderArrowBtn: {
    width: 30,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PV2.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    fontSize: 16,
    color: PV2.textPrimary,
    minHeight: 80,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    padding: 12,
  },
  counter: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'right',
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
    color: PV2.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  repostNotice: {
    fontSize: 13,
    color: PV2.textSecondary,
    lineHeight: 19,
    marginBottom: 4,
  },
});

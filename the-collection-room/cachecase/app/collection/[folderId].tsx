import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CollectionAddMenu } from '@/components/collection/collection-add-menu';
import { PREVIEW_CARD_ASPECT_RATIO } from '@/components/collection/collection-preview-card';
import { CollectionSearchBar } from '@/components/collection/collection-search-bar';
import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import { FolderCommentsSheet } from '@/components/collection/folder-comments-sheet';
import { ShareSheet } from '@/components/share/share-sheet';
import { FolderCoverAdjuster } from '@/components/collection/folder-cover-adjuster';
import { FolderCoverImage } from '@/components/collection/folder-cover-image';
import { getNestedFolderTileImage } from '@/components/collection/nested-folder-tile-image';
import { FolderCoverItemPicker } from '@/components/collection/folder-cover-item-picker';
import { FolderCoverMenu } from '@/components/collection/folder-cover-menu';
import { GalleryCommentsSheet } from '@/components/collection/gallery-comments-sheet';
import { FolderEditModal } from '@/components/collection/folder-edit-modal';
import { MoveItemModal } from '@/components/item-detail/move-item-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { FOLDER_COVER_ASPECT_RATIO, FOLDER_COVER_RADIUS } from '@/constants/folder-cover';
import {
  type CollectionGridEntry,
  compareGridEntriesByRecency,
  NO_PLAYER_KEY,
  itemMatchesSearch,
  useChildFolders,
  useItems,
} from '@/hooks/use-collection';
import { useFolderLikes } from '@/hooks/use-folder-likes';
import {
  invalidateSignedFolderCover,
  FOLDER_HEADER_COVER_TIER,
  peekCachedSignedFolderCover,
  prefetchFolderHeaderCover,
  useSignedFolderCovers,
} from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { COMPACT_IMAGE_TIER, DETAIL_IMAGE_TIER } from '@/lib/image-tiers';
import { folderCoverCacheKey, itemImageCacheKey } from '@/lib/private-image-cache-key';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { deleteFolderCover, uploadFolderCover } from '@/lib/storage';
import { shareElsewhere } from '@/lib/share/share-target';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, Folder, FolderCoverCrop } from '@/types';

// Wraps expo-image's Image so the hero's overlay layer can drive its
// opacity from a Reanimated shared value on the UI thread.
const AnimatedExpoImage = Animated.createAnimatedComponent(Image);

// Swipe-to-advance threshold for the hero preview — below this, the
// gesture is treated as a tap/scroll attempt, not a page change.
const HERO_SWIPE_THRESHOLD = 40;
// Fixed crossfade duration for hero image transitions (swipe or grid tap).
const HERO_TRANSITION_DURATION = 240;
// Top-biased focal crop for the hero image — expo-image's own contentFit
// "cover" + contentPosition combination, not a manual translateY hack.
// top: '0%' means the source image's own top edge is never cropped (excess
// height is trimmed from the bottom instead), so a card's face/upper body
// stays fully visible. Applied identically to every hero image layer.
const HERO_IMAGE_CONTENT_POSITION = { top: '0%', left: '50%' } as const;

// FOLDER_COVER_ASPECT_RATIO/FOLDER_COVER_RADIUS now live in
// constants/folder-cover.ts, shared with FolderCoverAdjuster/
// FolderCoverImage so the adjust-cover preview stays exactly WYSIWYG with
// this screen's own hero banner (below).

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Dense, edge-to-edge Instagram-profile-grid density. Gap is applied via
// FlatList's own contentContainerStyle/columnWrapperStyle gap support — no
// per-item margin math, no ItemSeparatorComponent (unreliable with
// numColumns > 1). GRID_PAGE_PADDING is 0 (the grid runs flush to both
// screen edges, like Instagram's) but is named explicitly, rather than left
// as an implicit assumption, so cardThumbWidth below reads as the exact
// "(available width - left/right padding - total column gaps) / columns"
// formula and stays correct if page padding is ever reintroduced.
const CARD_NUM_COLUMNS = 3;
const GRID_PAGE_PADDING = 0;
const GRID_GAP = 1;
// 0 — square, 90-degree tile corners, matching Instagram's own profile
// grid. Distinct from the shared PREVIEW_CARD_RADIUS (12, used by the
// Collection tab's horizontal previews, which stays rounded) — scoped to
// this grid's own `thumb` style only, so the Collection tab's preview
// cards are unaffected. This is the tile's only radius; `thumb`'s
// overflow:'hidden' clips both the real Image and the thumbPlaceholder
// fallback to it (neither sets its own radius), so 0 here squares off
// both at once.
const GRID_CARD_RADIUS = 0;

// Phase 2 bulk action bar — the extra vertical clearance it needs above
// the global floating tab bar's own reserved space (TAB_BAR_HEIGHT +
// insets.bottom), so the bar never overlaps the last grid row and the last
// grid row is never scrollable-behind it. Covers the bar's own gap above
// the tab pill (16, see its render-site bottom offset below) plus its
// rendered height (padding + one line of text/button content, ~54) with a
// small margin — approximate on purpose, not measured via onLayout, since
// slightly over-reserving scroll padding has no visible downside here.
const BULK_BAR_RESERVED_HEIGHT = 96;

// Default (non-card-mode) grid only — the FlatList's own `data` there is no
// longer CollectionGridEntry[] directly (which relied on FlatList's built-in
// numColumns row-grouping). To get a native sticky header (stickyHeaderIndices)
// for the black title/info panel, that panel has to be a real, independently
// addressable row inside the SAME FlatList as the grid — not a sibling
// rendered above it — so numColumns/columnWrapperStyle's automatic grouping
// (which only ever produces uniform item rows) is replaced with rows chunked
// by hand ahead of time, with the sticky bar prepended as its own row. Card
// mode (isCardMode) is untouched and still uses the original
// numColumns-based FlatList — this type/the grid-row chunking below is not
// used there.
//
// Reorder mode (and the Move list, 'moveHint'/'moveItem') swaps the grid
// rows for one compact list row per item
// ('reorderItem', after a one-line 'reorderHint') in this SAME FlatList —
// same data source, same tap-to-rank state, just a denser, scannable view.
// position is the item's place in the order Done would save (see
// reorderPositions); child folders aren't reorderable and aren't listed.
type FolderGridRow =
  | { kind: 'sticky' }
  | { kind: 'row'; entries: CollectionGridEntry[]; isLast: boolean }
  | { kind: 'empty' }
  | { kind: 'reorderHint' }
  | { kind: 'reorderItem'; item: CollectionItem; position: number }
  | { kind: 'moveHint' }
  | { kind: 'moveItem'; item: CollectionItem };

// Reorder list row — thumbnail height (card-ratio width), and the row's
// vertical padding around it: 56 + 2 * 8 = 72pt rows, several times denser
// than the 3-column card grid.
const REORDER_THUMB_HEIGHT = 56;
const REORDER_ROW_PADDING_V = 8;

// "2018 · Topps Chrome · PSA 10" — fields already on every loaded item, no
// extra fetch. Empty parts are skipped; an item with none gets no line.
function reorderRowMetadata(item: CollectionItem): string {
  const grade = [item.grading_company, item.grade].filter(Boolean).join(' ');
  return [item.year, item.brand, grade].filter(Boolean).join(' · ');
}

// The gallery for one folder. The default view (no `player` route param)
// renders every CollectionItem in the folder directly, one tile each — no
// automatic grouping by player. The same screen also still answers a
// `player` param (isCardMode below) by filtering to just that player's
// cards inside the identical grid, and keeps its own hero-carousel header
// and per-player gallery-comments thread (hooks/use-gallery-comments.ts) —
// nothing currently links to that mode, but it's left intact rather than
// deleted, since an explicit user-created-grouping feature could reuse this
// same filtered-view plumbing later; only the *automatic* player grouping
// that used to run by default has been removed.
export default function CollectionFolderScreen() {
  const params = useLocalSearchParams<{
    folderId?: string | string[];
    title?: string | string[];
    player?: string | string[];
  }>();

  // Expo Router params can be string or string[] — always take the first value.
  const folderId = Array.isArray(params.folderId) ? params.folderId[0] : params.folderId;
  const passedTitle = Array.isArray(params.title) ? params.title[0] : params.title;
  const activePlayer = Array.isArray(params.player) ? params.player[0] : params.player;

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  // Same identity the signed-image hooks below already key their own
  // caches by (hooks/use-signed-item-images.ts, hooks/
  // use-signed-folder-covers.ts) — reused here only to build stable
  // expo-image cacheKeys (Phase 2 of the private-image caching upgrade —
  // see lib/private-image-cache-key.ts). Never a second identity concept.
  const identity = currentUserId ?? 'anon';

  // Existing hook (hooks/use-collection.ts) — already filters
  // collection_items by folder_id and orders newest-first. Not duplicated,
  // and shared by both grouping mode and card mode below.
  const { items, loading, error: itemsError, refresh: refreshItems } = useItems(folderId);

  // Direct children of this folder only (never grandchildren) — nested
  // Collections Piece 1. RLS (folder_is_effectively_visible) already
  // enforces recursive ancestor privacy for whoever is viewing, so this
  // hook does no privacy filtering of its own; see hooks/use-collection.ts.
  const { folders: childFolders, refresh: refreshChildFolders } = useChildFolders(folderId);

  // Legacy app/folder/[id].tsx refreshed on focus so returning here after
  // adding a card (or from any other entry point) shows it immediately —
  // preserved since Profile/Saved/public-profile now land on this screen.
  // Child folders are refreshed the same way, e.g. after creating one.
  useFocusEffect(
    useCallback(() => {
      refreshItems();
      refreshChildFolders();
    }, [refreshItems, refreshChildFolders]),
  );

  // Folder record itself (name, owner, visibility, cover) — this screen used
  // to rely solely on the `title` route param, but now that every folder
  // entry point (Profile, public profiles, Saved) routes here instead of the
  // legacy app/folder/[id].tsx, it needs the real row to enforce ownership
  // and privacy the same way that screen did.
  const [folder, setFolder] = useState<Folder | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);
  // Distinct from "folder is null because it genuinely doesn't exist" —
  // see loadFolder below. Only a real request failure sets this.
  const [folderError, setFolderError] = useState<string | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [editVisible, setEditVisible] = useState(false);
  // Add Folder / Add Item chooser (same CollectionAddMenu the root
  // Collections screen uses) and the folder-creation sheet it can open —
  // nested Collections Piece 1. Add Item still routes through the existing
  // addCard() below; Add Folder opens CreateFolderModal with this folder's
  // id as the new folder's parent_folder_id.
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  // Folder cover/hero — FolderCoverMenu (Choose from Folder / Choose from
  // Photo Library / Remove Cover) opened from FolderEditModal's own
  // "Change Cover" row; FolderCoverItemPicker is the "Choose from Folder"
  // sub-flow, reusing this screen's own already-loaded items/signedUrls.
  const [showCoverMenu, setShowCoverMenu] = useState(false);
  const [showCoverItemPicker, setShowCoverItemPicker] = useState(false);
  // Both "Choose from Folder" (tap an item) and "Choose from Library"
  // (pick a photo, native editing disabled) converge on this single
  // FolderCoverAdjuster instance instead of saving immediately — one
  // shared crop/zoom/reposition UI for both sources, never a second
  // cropper. `kind` distinguishes them only for handleSaveAdjustedCover's
  // own persistence branch below (an 'item' cover just points at that
  // item's existing image; a 'library' cover still needs its local uri
  // uploaded to Storage first) — FolderCoverAdjuster itself only ever
  // reads the common `uri` field. Non-null exactly while the adjuster is
  // open.
  const [adjustingCover, setAdjustingCover] = useState<
    | { kind: 'item'; item: CollectionItem; uri: string }
    | { kind: 'library'; uri: string }
    | null
  >(null);
  // "Choose from Folder" pick waiting for its own 'detail' URL: the adjuster
  // frames the photo across the full hero width, where the grid's 500px
  // preview would look soft, so it opens once ONLY this one item's detail
  // URL resolves (see the effect below) instead of borrowing a preview URL.
  const [pendingCoverItem, setPendingCoverItem] = useState<CollectionItem | null>(null);
  const { urls: pendingCoverUrls } = useSignedItemImages(
    pendingCoverItem?.primary_image_id ? [pendingCoverItem.primary_image_id] : [],
    DETAIL_IMAGE_TIER,
  );
  useEffect(() => {
    const imageId = pendingCoverItem?.primary_image_id;
    if (!pendingCoverItem || !imageId) return;
    const uri = pendingCoverUrls.get(imageId);
    if (!uri) return;
    setAdjustingCover({ kind: 'item', item: pendingCoverItem, uri });
    setPendingCoverItem(null);
  }, [pendingCoverItem, pendingCoverUrls]);
  const [savingCover, setSavingCover] = useState(false);
  // iOS only — set right before closing FolderCoverMenu when the user picks
  // "Choose from Photo Library," then consumed by that Modal's onDismiss
  // (see runLibraryCoverPick below for why launchImageLibraryAsync can't
  // just be called synchronously after setShowCoverMenu(false)).
  const pendingLibraryPickRef = useRef(false);
  const [commentsVisible, setCommentsVisible] = useState(false);
  // Separate from commentsVisible/FolderCommentsSheet (whole-folder
  // comments, grouping mode) — the gallery/card-mode comment thread is its
  // own, scoped to this folder+player group. See GalleryCommentsSheet.
  const [galleryCommentsVisible, setGalleryCommentsVisible] = useState(false);

  const {
    likeCount,
    liked,
    inFlight: folderLikeInFlight,
    toggle: toggleFolderLike,
  } = useFolderLikes(folderId, currentUserId);

  // Request-identity guard — plain incrementing counter, not
  // AbortController: loadFolder is called from two places (the mount/
  // folderId-change effect below, and a Retry button), so a stale response
  // from an older call (superseded by a folderId change or a manual Retry
  // while the first was still in flight) must never win a race and commit
  // over a newer call's result. Every async continuation below re-checks
  // isCurrent() immediately before it's about to touch folder/folderError/
  // ownerProfile/folderLoading state; a superseded call's checks all fail
  // and it simply stops without touching anything.
  const folderRequestIdRef = useRef(0);

  // Reusable so both the mount/folderId-change effect below and a Retry
  // action can call the exact same loader — no duplicated fetch logic.
  //
  // error.code === 'PGRST116' is .single()'s own "legitimately no such
  // row" signal (0 rows matched) — covers both a genuinely deleted/
  // nonexistent folder and one hidden by RLS, which are indistinguishable
  // by design (RLS isn't meant to leak existence) and aren't something to
  // separate further. Any other error, or a thrown exception, is a real
  // request failure and must never be represented as "Collection not
  // found."
  const loadFolder = useCallback(async () => {
    const requestId = ++folderRequestIdRef.current;
    const isCurrent = () => folderRequestIdRef.current === requestId;

    if (!folderId) {
      if (isCurrent()) setFolderLoading(false);
      return;
    }
    setFolderLoading(true);
    try {
      const { data, error: queryError } = await supabase
        .from('folders')
        .select('*')
        .eq('id', folderId)
        .single();

      if (!isCurrent()) return;

      if (queryError) {
        if (queryError.code === 'PGRST116') {
          setFolder(null);
          setFolderError(null);
        } else {
          console.error('[CollectionFolderScreen] folder query failed:', queryError.message, queryError);
          setFolderError(queryError.message);
        }
        return;
      }

      setFolder(data as Folder);
      setFolderError(null);

      // Owner-profile enrichment — best-effort: the folder itself already
      // loaded successfully above, so a failure here must never set
      // folderError or clear `folder`, only leave ownerProfile unset. Same
      // isCurrent() guard as the primary query, since this is still part
      // of the same requestId's lifecycle.
      if (data.user_id !== currentUserId) {
        try {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('username, display_name, avatar_url')
            .eq('id', data.user_id)
            .single();
          if (!isCurrent()) return;
          if (profileError) {
            console.error(
              '[CollectionFolderScreen] owner profile lookup failed (best-effort):',
              profileError.message,
              profileError,
            );
          } else if (profile) {
            setOwnerProfile(profile as OwnerProfile);
          }
        } catch (profileErr) {
          if (!isCurrent()) return;
          console.error('[CollectionFolderScreen] owner profile lookup failed (best-effort):', profileErr);
        }
      }
    } catch (e) {
      if (!isCurrent()) return;
      // A thrown exception from the primary folder query — never converted
      // into "not found"; folderError makes the failure explicit instead.
      console.error('[CollectionFolderScreen] folder load failed:', e);
      setFolderError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      // A superseded request must never clear folderLoading out from under
      // whichever newer request is now responsible for it.
      if (isCurrent()) setFolderLoading(false);
    }
  }, [folderId, currentUserId]);

  useEffect(() => {
    loadFolder();
  }, [loadFolder]);

  const isOwner = !!currentUserId && folder?.user_id === currentUserId;
  const isPrivate = folder !== null && !folder.is_public && !isOwner;

  const [search, setSearch] = useState('');
  // The full-width CollectionSearchBar now only mounts once this is true —
  // toggled by the new header search icon (see headerTopActions below).
  // Collapsing it also clears `search`, so the grid never stays silently
  // filtered by a query the (now-hidden) bar isn't showing.
  const [searchVisible, setSearchVisible] = useState(false);

  function toggleSearch() {
    setSearchVisible((visible) => {
      if (visible) setSearch('');
      return !visible;
    });
  }

  // Phase 2 bulk move — Select mode. Local UI-only state (see
  // move-item-modal.tsx's bulk mode / move_collection_items RPC for the
  // actual move); selection never triggers its own fetch, only the FlatList
  // re-rendering the (already-loaded) tiles it's built from. Scoped to the
  // default (non-card-mode) grid only — isCardMode's per-player hero
  // gallery is a different, narrower view with its own fixed header and no
  // entry point into Select mode below, so the two can never interact.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleItemSelected(itemId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function enterSelectMode(firstItemId?: string) {
    setSelectMode(true);
    if (firstItemId) setSelectedIds(new Set([firstItemId]));
  }

  function cancelSelectMode() {
    setSelectMode(false);
    setMoveListMode(false);
    setSelectedIds(new Set());
  }

  // Resets whenever this screen is actually navigating to a different
  // folder (folderId route param changes) — a fresh mount already starts
  // with the defaults above, but this also covers the (rarer) case of the
  // same mounted screen instance being redirected to a different folderId
  // without unmounting, so a stale selection can never carry over onto the
  // wrong folder's items.
  useEffect(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setReorderMode(false);
    setRankedIds([]);
  }, [folderId]);

  // Drops any selected id that's no longer present in this folder's own
  // freshly-refetched item list — covers "item removed/moved externally
  // while Select mode is active" (e.g. deleted, or moved out from under
  // this screen by another device) without ever needing a query of its
  // own: `items` here is the same already-loaded list the grid renders
  // from (hooks/use-collection.ts's useItems, refetched on every
  // useFocusEffect refocus above).
  useEffect(() => {
    if (!selectMode || selectedIds.size === 0) return;
    const liveIds = new Set(items.map((i) => i.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const [showBulkMoveModal, setShowBulkMoveModal] = useState(false);
  // Move list — the compact multi-select list the bulk bar's (always
  // enabled) Move button opens, mirroring Reorder: pick the action first,
  // then the items. A sub-step of Select mode using selectedIds, cleared on
  // entry so the list always starts with nothing selected. Its own Move
  // button then opens the existing MoveItemModal unchanged.
  const [moveListMode, setMoveListMode] = useState(false);

  function handleEnterMoveList() {
    setSelectedIds(new Set());
    setMoveListMode(true);
  }
  // Items just moved out, hidden from this folder at once instead of
  // waiting on the background refetch. Scoped to the exact `items` array
  // they were moved from: the refetch's new array (which no longer has
  // them) replaces it as the truth automatically; if that refetch fails,
  // `items` is unchanged and they stay hidden, since the move itself
  // already succeeded server-side.
  const [movedAway, setMovedAway] = useState<{ ids: Set<string>; from: CollectionItem[] } | null>(null);

  // Mirrors app/item/[id].tsx's handleItemMoved: the modal itself already
  // confirmed the RPC committed (all-or-nothing — see
  // move_collection_items), so this only owns reacting to that confirmed
  // result, never re-validating it. refreshItems() re-fetches this folder's
  // items from the DB, which both drops the moved items from the grid AND
  // corrects this screen's own displayed count (folderStickyBar's
  // items.length label) in one call — no local splicing needed. The
  // destination folder's own count/preview (Collections tab, its own
  // folder-detail screen) isn't touched from here; both already refresh via
  // their own useFocusEffect on next visit, same as Phase 1.
  function handleBulkMoved(movedCount: number, folderName: string) {
    setMovedAway({ ids: new Set(selectedIds), from: items });
    setShowBulkMoveModal(false);
    cancelSelectMode();
    refreshItems();
    Alert.alert('Moved', `Moved ${movedCount} ${movedCount === 1 ? 'item' : 'items'} to ${folderName}`);
    // Mark the own-profile cache stale — both the source and destination
    // folder's item counts/previews on Profile's Collection tab are now
    // wrong until a fresh load. See lib/own-profile-cache.ts's own
    // invalidateOwnProfileCache comment.
    if (currentUserId) invalidateOwnProfileCache(currentUserId);
  }

  // Manual item reordering — tap-to-rank, a third mode alongside normal
  // browsing and Select mode (mutually exclusive with both; entering it
  // always exits Select mode first, per "do not mix multi-select Move and
  // freeform dragging"). rankedIds is the ONLY reorder state: an ordered
  // array of item ids, front-to-back — an item's rank is simply
  // rankedIds.indexOf(id) + 1, never a separately tracked number, so
  // removing an id from the middle "compacts" every later rank down by one
  // for free, on the very next render. `items` (hooks/use-collection.ts's
  // useItems) is never touched until Done actually persists, so Cancel
  // needs no explicit "restore" step: discarding rankedIds and switching
  // back to the normal grid (which still reads from the untouched `items`)
  // already shows the original order.
  const [reorderMode, setReorderMode] = useState(false);
  const [rankedIds, setRankedIds] = useState<string[]>([]);
  const [savingReorder, setSavingReorder] = useState(false);
  const savingReorderRef = useRef(false);

  function handleEnterReorderMode() {
    cancelSelectMode();
    setRankedIds([]);
    setReorderMode(true);
  }

  function handleReorderCancel() {
    setReorderMode(false);
    setRankedIds([]);
  }

  // Tapping an unranked item appends it (next rank = current length + 1);
  // tapping an already-ranked item removes it. Both are the same one-line
  // operation because rank is positional, not stored — see rankedIds' own
  // comment above. Deterministic under repeated tap/remove/re-add: an
  // item's rank always reflects exactly "how many currently-ranked items
  // were tapped before it, in tap order," regardless of how many times it
  // was previously added and removed.
  function toggleItemRank(itemId: string) {
    setRankedIds((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
  }

  // Drops any ranked id no longer present in this folder's own freshly-
  // refetched item list — same "external change during an active
  // in-progress mode" safety net as Select mode's own analogous effect
  // above, and for the same reason: reorder_collection_items would
  // otherwise atomically reject the whole Done call over one stale id.
  useEffect(() => {
    if (!reorderMode || rankedIds.length === 0) return;
    const liveIds = new Set(items.map((i) => i.id));
    setRankedIds((prev) => {
      const next = prev.filter((id) => liveIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function handleReorderDone() {
    if (savingReorderRef.current || !folderId) return;
    savingReorderRef.current = true;
    setSavingReorder(true);
    try {
      // Ranked items define the front of the final order, in the order
      // they were tapped; every unranked item follows, in whatever order
      // it already had (items is already sorted by the current persisted
      // sort_order — see useItems) — so ranking only 2 of 10 items moves
      // exactly those two to the front and leaves the other 8's relative
      // order untouched.
      const rankedSet = new Set(rankedIds);
      const unrankedIds = items.filter((item) => !rankedSet.has(item.id)).map((item) => item.id);
      const finalOrder = [...rankedIds, ...unrankedIds];

      const { error } = await supabase.rpc('reorder_collection_items', {
        p_folder_id: folderId,
        p_item_ids: finalOrder,
      });
      if (error) throw new Error(error.message);

      // Refetch BEFORE leaving reorder mode (rather than flipping
      // reorderMode off first) so the normal grid never briefly shows the
      // pre-reorder order while refreshItems() is still in flight.
      await refreshItems();
      setReorderMode(false);
      setRankedIds([]);
      // Mark the own-profile cache stale — this folder's preview order on
      // Profile's Collection tab is now wrong until a fresh load. See
      // lib/own-profile-cache.ts's own invalidateOwnProfileCache comment.
      if (currentUserId) invalidateOwnProfileCache(currentUserId);
    } catch (e) {
      // Stays in reorder mode with the tapped ranking intact — the user
      // can retry Done without re-tapping everything.
      Alert.alert('Reorder failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      savingReorderRef.current = false;
      setSavingReorder(false);
    }
  }

  const folderTitle = folder?.name || passedTitle || 'Collection';
  const cardThumbWidth =
    (windowWidth - GRID_PAGE_PADDING * 2 - GRID_GAP * (CARD_NUM_COLUMNS - 1)) / CARD_NUM_COLUMNS;

  // One batched call covering every item currently loaded for this folder,
  // at the small 'preview' tier — this map now backs only the grid cells
  // (and the cover item picker's grid). The card-mode hero requests its own
  // bounded 'detail' set below instead of sharing this one (item-images beta
  // privacy hardening, Phase 3B). Also carries each nested child folder's
  // first-card image id (Folder.first_item_image_id) in the SAME batch, so
  // nested folder tiles render their first card at this exact tier/cache key
  // — see getNestedFolderTileImage.
  const {
    urls: signedUrls,
    statuses: gridStatuses,
    servedTiers: gridServedTiers,
  } = useSignedItemImages(
    [...items.map((i) => i.primary_image_id), ...childFolders.map((f) => f.first_item_image_id)],
    COMPACT_IMAGE_TIER,
  );

  // The folder-level cover/hero banner (below, default view only) — same
  // privacy-enforced signed-delivery hook already used by app/saved.tsx,
  // claim-folder-picker.tsx, and pick-collection.tsx, not a new resolution
  // path. The hero is its own call, keyed on the route's folderId alone, so
  // its request goes out at mount and is never tied to (or re-keyed by) the
  // child-folder load. It signs the existing 1400px 'detail' tier (not the
  // full original) — ample for a full-width banner.
  // Child folders' tile covers (the empty-gallery fallback in
  // getNestedFolderTileImage) are one separate batched call at the small
  // preview tier, like every other tile on this grid.
  const {
    urls: heroCoverUrls,
    statuses: coverStatuses,
    servedTiers: coverHeroServedTiers,
    tokens: coverHeroTokens,
  } = useSignedFolderCovers([folderId], FOLDER_HEADER_COVER_TIER);
  const {
    urls: childCoverUrls,
    servedTiers: childCoverServedTiers,
    tokens: childCoverTokens,
  } = useSignedFolderCovers(
    childFolders.map((f) => f.id),
    COMPACT_IMAGE_TIER,
  );
  const coverUrl = folderId ? heroCoverUrls.get(folderId) : undefined;
  const coverStatus = folderId ? coverStatuses.get(folderId) : undefined;
  // This folder's cover at the small preview tier, if another surface
  // (Saved, Tagged, a picker, a parent's empty-gallery tile, the Profile
  // prewarm) already signed it this session — memory-only peek, no
  // request. Shown first and then upgraded to the detail URL (see the
  // hero's FolderCoverImage), so a warm preview never means a blank banner.
  const coverPreviewPeek = folderId ? peekCachedSignedFolderCover(identity, folderId, COMPACT_IMAGE_TIER) : null;
  // Only takes up layout space once there's an actual cover to show (or one
  // is still resolving) — a folder that has never had a cover set renders
  // exactly as it did before this feature existed, no empty placeholder
  // banner.
  const showCoverHero = coverStatus === 'loading' || coverStatus === 'ready';

  // The item grid's actual source list. With no `player` param (the
  // default view) this is simply every item in the folder — one tile per
  // CollectionItem, no automatic grouping. A `player` param (isCardMode,
  // currently unreachable from any in-app navigation — see the top-level
  // comment) still filters down to just that player's cards, reusing this
  // exact same grid rather than a second parallel one.
  const cardItems = useMemo(() => {
    const present =
      movedAway && movedAway.from === items ? items.filter((i) => !movedAway.ids.has(i.id)) : items;
    if (!activePlayer) return present;
    return activePlayer === NO_PLAYER_KEY
      ? present.filter((i) => !i.player?.trim())
      : present.filter((i) => i.player?.trim() === activePlayer);
  }, [items, activePlayer, movedAway]);

  // Hero preview — a stable collection cover, not an auto-playing slideshow.
  // Ordered newest-first (useItems already orders collection_items by
  // created_at DESC), so index 0 doubles as both "default cover" and
  // "newest item" — there's no separate per-player-group cover-selection
  // concept in the data model to draw a distinct "selected cover" from.
  const heroItems = useMemo(() => cardItems.filter((i) => !!i.primary_image_id), [cardItems]);
  const [heroIndex, setHeroIndex] = useState(0);
  // Non-null only while a transition is in flight — the overlay layer
  // renders (and fades in) exactly when this is set, then disappears once
  // the transition commits and heroIndex catches up to it.
  const [heroPendingIndex, setHeroPendingIndex] = useState<number | null>(null);
  // Tracks which item the hero is actually displaying, independent of its
  // array position — heroIndex is re-derived from this id whenever
  // heroItems changes (e.g. an item was deleted elsewhere and this screen
  // refetched on refocus, see useFocusEffect above). Without this, a
  // deletion of an unrelated, earlier item would silently swap the
  // displayed card once positions shift, and a deletion of the displayed
  // item itself would leave heroIndex stale (possibly out of bounds —
  // this is what crashed: heroItems[heroIndex].image_url on an undefined
  // element once heroItems shrank).
  const heroItemIdRef = useRef<string | null>(null);
  const heroOverlayOpacity = useSharedValue(0);
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);

  useEffect(() => {
    let isMounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (isMounted) setReduceMotionEnabled(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotionEnabled);
    return () => {
      isMounted = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    setHeroIndex(0);
    setHeroPendingIndex(null);
    // Cancel any in-flight crossfade before resetting — without this, a
    // transition that was already animating could still resolve and
    // commit a now-meaningless target after the folder/group has changed
    // out from under it.
    cancelAnimation(heroOverlayOpacity);
    heroOverlayOpacity.value = 0;
    heroItemIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, activePlayer]);

  // Re-syncs heroIndex whenever the underlying item list changes. If the
  // item being viewed still exists, follow it to its new position (so an
  // unrelated deletion elsewhere in the list doesn't swap what's on
  // screen); if it's gone, fall back to the same numeric slot clamped to
  // the new, possibly shorter array — "the next available item," per the
  // requirement. setHeroIndex uses the functional form here so this
  // correctly chains after the reset effect above when both fire in the
  // same commit (e.g. navigating into a different player group).
  useEffect(() => {
    // Cancel any in-flight crossfade first — a pending transition's target
    // may no longer exist (or may no longer be the right index) once
    // heroItems has changed, so it must not be allowed to commit.
    cancelAnimation(heroOverlayOpacity);

    if (heroItems.length === 0) {
      setHeroIndex(0);
      setHeroPendingIndex(null);
      heroOverlayOpacity.value = 0;
      heroItemIdRef.current = null;
      return;
    }

    const viewedId = heroItemIdRef.current;
    const foundIndex = viewedId ? heroItems.findIndex((i) => i.id === viewedId) : -1;

    if (foundIndex !== -1) {
      setHeroIndex(foundIndex);
      heroItemIdRef.current = heroItems[foundIndex].id;
    } else {
      setHeroIndex((prev) => {
        const clamped = Math.max(0, Math.min(prev, heroItems.length - 1));
        heroItemIdRef.current = heroItems[clamped]?.id ?? null;
        return clamped;
      });
    }
    setHeroPendingIndex(null);
    heroOverlayOpacity.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroItems]);

  // Hero images render large, so they use the 'detail' tier — but ONLY for
  // what the hero can actually show next: the displayed item, its immediate
  // neighbours (so a swipe is ready), and any in-flight pending target. Never
  // the whole folder (a folder can hold far more cards than a hero ever
  // shows), and nothing at all outside card mode, where the hero isn't
  // mounted. Grid cells keep their own 'preview' map above.
  const heroDetailIds = useMemo(() => {
    if (!activePlayer) return [];
    const indexes = [heroIndex - 1, heroIndex, heroIndex + 1, ...(heroPendingIndex !== null ? [heroPendingIndex] : [])];
    return indexes.map((i) => heroItems[i]?.primary_image_id).filter((id): id is string => !!id);
  }, [activePlayer, heroItems, heroIndex, heroPendingIndex]);
  const { urls: heroDetailUrls, servedTiers: heroServedTiers } = useSignedItemImages(heroDetailIds, DETAIL_IMAGE_TIER);

  // What a hero <Image> should show for one image: its 'detail' URL when
  // resolved, else the already-resolved grid 'preview' URL for that same
  // image as a temporary stand-in (e.g. a grid tap that jumps far from the
  // current neighbours) — each keyed by the tier actually served, so the two
  // never share an expo-image cacheKey. Null when neither has resolved.
  function heroImageSource(imageId: string): { uri: string; cacheKey: string } | null {
    const detailUri = heroDetailUrls.get(imageId);
    if (detailUri) {
      return { uri: detailUri, cacheKey: itemImageCacheKey(identity, imageId, DETAIL_IMAGE_TIER, heroServedTiers) };
    }
    const previewUri = signedUrls.get(imageId);
    if (previewUri) {
      return { uri: previewUri, cacheKey: itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, gridServedTiers) };
    }
    return null;
  }

  // Warm the cache for the hero's bounded 'detail' set (displayed item,
  // neighbours, pending target — see heroDetailIds), so a swipe or grid tap
  // never has to wait on a network fetch mid-transition. Re-runs as
  // heroDetailUrls fills in.
  useEffect(() => {
    const uris = heroDetailIds
      .map((id) => heroDetailUrls.get(id))
      .filter((u): u is string => !!u);
    if (uris.length) Image.prefetch(uris).catch(() => {});
  }, [heroDetailIds, heroDetailUrls]);

  // Single entry point for every hero change (swipe or grid tap) — decodes
  // the target image first, then runs one 240ms opacity crossfade on the UI
  // thread. No timers, no automatic advancing; only ever called from a
  // discrete user action.
  function goToHeroIndex(targetIndex: number) {
    if (targetIndex < 0 || targetIndex >= heroItems.length) return;
    if (targetIndex === heroIndex || heroPendingIndex !== null) return;

    // Re-validated against heroItems here (not just at the top of
    // goToHeroIndex) because commit runs asynchronously, after the
    // prefetch/crossfade — by the time it actually fires, heroItems may
    // have changed underneath the pending transition (e.g. a deletion
    // elsewhere refetched mid-animation). The reconciliation effect above
    // would eventually correct a bad index too, but this avoids ever
    // committing one in the first place.
    const commit = () => {
      const safeTarget = Math.max(0, Math.min(targetIndex, heroItems.length - 1));

      if (heroItems.length === 0) {
        setHeroIndex(0);
        setHeroPendingIndex(null);
        heroItemIdRef.current = null;
        heroOverlayOpacity.value = 0;
        return;
      }

      setHeroIndex(safeTarget);
      setHeroPendingIndex(null);
      heroOverlayOpacity.value = 0;
      heroItemIdRef.current = heroItems[safeTarget]?.id ?? null;
    };

    if (reduceMotionEnabled) {
      commit();
      return;
    }

    // May still be undefined if this target's signed URL hasn't resolved
    // yet (rare — the up-front prefetch effect above usually wins the
    // race) — the crossfade still proceeds either way; the overlay layer
    // below simply renders nothing until signedUrls fills in, per the
    // "no raw URL fallback" requirement, rather than blocking the gesture.
    const targetImageId = heroItems[targetIndex].primary_image_id;
    const targetUri = targetImageId ? heroDetailUrls.get(targetImageId) : undefined;
    setHeroPendingIndex(targetIndex);
    heroOverlayOpacity.value = 0;
    (targetUri ? Image.prefetch(targetUri) : Promise.resolve())
      .catch(() => {})
      .finally(() => {
        heroOverlayOpacity.value = withTiming(1, { duration: HERO_TRANSITION_DURATION }, (finished) => {
          if (finished) runOnJS(commit)();
        });
      });
  }

  function goToNextHero() {
    goToHeroIndex(heroIndex + 1);
  }

  function goToPreviousHero() {
    goToHeroIndex(heroIndex - 1);
  }

  const heroOverlayStyle = useAnimatedStyle(() => ({ opacity: heroOverlayOpacity.value }));

  const heroPan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onEnd((e) => {
      if (e.translationX <= -HERO_SWIPE_THRESHOLD) {
        runOnJS(goToNextHero)();
      } else if (e.translationX >= HERO_SWIPE_THRESHOLD) {
        runOnJS(goToPreviousHero)();
      }
    });

  // Filters what's already loaded (the full per-folder item set from
  // useItems, not a capped preview) — no new query per keystroke. Runs over
  // `cardItems`, which by default is every item in the folder (see its own
  // comment above), so this is what powers search for the default grid too.
  const filteredCardItems = useMemo(() => {
    const q = search.trim();
    if (!q) return cardItems;
    return cardItems.filter((item) => itemMatchesSearch(item, q));
  }, [cardItems, search]);

  const isCardMode = !!activePlayer;
  const screenTitle = isCardMode ? (activePlayer === NO_PLAYER_KEY ? 'Other' : activePlayer!) : folderTitle;
  const visibleCount = isCardMode ? cardItems.length : items.length;

  // Final defensive guard against the one-render-frame gap between
  // heroItems shrinking (on refetch, e.g. after a deletion elsewhere) and
  // the reconciliation effect above correcting heroIndex — clamped, never
  // reads an out-of-bounds index. The effect is what fixes *which* item
  // this settles on; this only guarantees the read itself can never crash.
  const clampedHeroDisplayIndex = heroItems.length > 0 ? Math.min(heroIndex, heroItems.length - 1) : -1;
  const activeHeroItem = clampedHeroDisplayIndex >= 0 ? heroItems[clampedHeroDisplayIndex] : null;
  const clampedHeroPendingIndex =
    heroPendingIndex !== null && heroPendingIndex >= 0 && heroPendingIndex < heroItems.length
      ? heroPendingIndex
      : null;
  const pendingHeroItem = clampedHeroPendingIndex !== null ? heroItems[clampedHeroPendingIndex] : null;

  function openItem(item: CollectionItem) {
    // Hero-carousel sync only matters while that carousel is actually
    // mounted (isCardMode) — skipping it in the default grid avoids an
    // unnecessary crossfade/prefetch on every tap there.
    if (isCardMode) {
      const heroIdx = heroItems.findIndex((i) => i.id === item.id);
      if (heroIdx !== -1) goToHeroIndex(heroIdx);
    }
    router.push({ pathname: '/item/[id]', params: { id: item.id } });
  }

  // Same /item/new + folderId/folderName params app/folder/[id].tsx and
  // app/(tabs)/collection.tsx already use — not a new creation flow.
  function addCard() {
    if (!isOwner) return;
    router.push({
      pathname: '/item/new',
      params: { folderId: folderId ?? '', folderName: folderTitle },
    });
  }

  // Share — opens the shared CacheCase Share sheet (see the ShareSheet
  // below). Share to Feed reuses the existing durable folder_share flow
  // (app/share-folder/new.tsx, preselected via folderId) for the owner AND
  // for anyone else viewing it — a non-owner can only open a folder that is
  // effectively public (RLS), and their post is a repost attributed to the
  // owner. create-snapshot-post re-checks effective public visibility
  // server-side either way. DMs only carry item/photo attachments today,
  // so Share to DM is shown as unavailable for folders.
  const [shareSheetVisible, setShareSheetVisible] = useState(false);

  function handleShareToFeed() {
    router.push({ pathname: '/share-folder/new', params: { folderId } } as never);
  }

  // Share Elsewhere — native share sheet with the folder's deep link (see
  // lib/share/share-target.ts). The owner's own folder omits the "by @"
  // part rather than guessing a handle from their email.
  function handleShareElsewhere() {
    if (!folder) return;
    shareElsewhere({
      type: 'folder',
      id: folder.id,
      title: folder.name,
      ownerUsername: isOwner ? null : (ownerProfile?.username ?? null),
    });
  }


  // Closes Edit Folder and opens FolderCoverMenu in its place — sequential,
  // not stacked, since Edit Folder has nothing left to show once the owner
  // has moved on to changing the cover.
  function openCoverMenu() {
    setEditVisible(false);
    setShowCoverMenu(true);
  }

  // Single write path for every cover change below — always sets all four
  // cover columns together (never a partial update that could leave e.g.
  // cover_source out of sync with cover_storage_path/cover_item_id/
  // cover_crop), then invalidates this folder's cached signed cover so the
  // hero re-fetches immediately instead of serving a stale cached result
  // for up to the signed-URL's own TTL. Returns the updated row on success
  // so callers can do their own best-effort Storage cleanup of whatever the
  // PREVIOUS cover pointed at — only ever after the DB write actually
  // succeeds, since deleting that object before confirming the write would
  // risk orphaning the still-active cover if the write then failed.
  async function applyCoverUpdate(patch: {
    cover_source: string;
    cover_storage_path: string | null;
    cover_item_id: string | null;
    cover_image_url: string | null;
    cover_crop: FolderCoverCrop | null;
  }): Promise<Folder | null> {
    if (!folder || !currentUserId) return null;
    try {
      const { data, error } = await supabase
        .from('folders')
        .update(patch)
        .eq('id', folder.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      if (data) {
        setFolder(data as Folder);
        invalidateSignedFolderCover(folder.id, currentUserId);
        // Single shared write path for every cover change (item, upload,
        // remove — see this function's own doc comment) — one wiring point
        // covers all three. Mark the own-profile cache stale, since this
        // folder's cover thumbnail shows on Profile's Collection tab. See
        // lib/own-profile-cache.ts's own invalidateOwnProfileCache comment.
        invalidateOwnProfileCache(currentUserId);
        return data as Folder;
      }
      return null;
    } catch (e) {
      Alert.alert('Cover update failed', e instanceof Error ? e.message : 'Something went wrong.');
      return null;
    }
  }

  // "Choose from Folder" -> tap an item no longer saves immediately — it
  // opens FolderCoverAdjuster (Adjust Cover) so the owner can frame the
  // item's photo inside the hero's actual aspect ratio first. Reuses this
  // screen's own already-resolved signedUrls (no second item/image query);
  // if that item's signed URL genuinely hasn't resolved yet, there's
  // nothing to adjust yet, so the tap is a no-op rather than opening the
  // adjuster on a blank image.
  function handleChooseFromFolderItem(item: CollectionItem) {
    if (savingCover || !item.primary_image_id) return;
    // Same no-op-if-unresolved guard as before: the picker's own (preview)
    // URL resolving is what proves this item is signable at all.
    if (!signedUrls.get(item.primary_image_id)) return;
    setShowCoverItemPicker(false);
    setShowCoverMenu(false);
    setPendingCoverItem(item);
  }

  // Single save path for both adjustingCover sources — an 'item' cover
  // never re-uploads anything (it just points cover_item_id at the
  // already-stored item image, exactly as before); a 'library' cover
  // uploads the picker's untouched local uri to Storage first (the native
  // editor no longer pre-crops it — see runLibraryCoverPick), then points
  // at that upload. Either way, `crop` (from FolderCoverAdjuster) is saved
  // the same way, since FolderCoverImage now applies it for both sources.
  async function handleSaveAdjustedCover(crop: FolderCoverCrop) {
    if (!adjustingCover || savingCover || !folder || !currentUserId) return;
    const source = adjustingCover;
    setAdjustingCover(null);
    setSavingCover(true);
    const previousUploadPath = folder.cover_source === 'upload' ? folder.cover_storage_path : null;
    try {
      if (source.kind === 'item') {
        const updated = await applyCoverUpdate({
          cover_source: 'item',
          cover_item_id: source.item.id,
          cover_storage_path: null,
          cover_image_url: null,
          cover_crop: crop,
        });
        if (updated && previousUploadPath) {
          await deleteFolderCover(previousUploadPath, currentUserId);
        }
      } else {
        const uploaded = await uploadFolderCover(source.uri, currentUserId);
        const updated = await applyCoverUpdate({
          cover_source: 'upload',
          cover_storage_path: uploaded.storagePath,
          cover_item_id: null,
          cover_image_url: uploaded.publicUrl,
          cover_crop: crop,
        });
        if (updated && previousUploadPath && previousUploadPath !== uploaded.storagePath) {
          await deleteFolderCover(previousUploadPath, currentUserId);
        }
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not upload cover image.');
    } finally {
      setSavingCover(false);
    }
  }

  function handleCancelAdjustCover() {
    setAdjustingCover(null);
  }

  // Menu-row press handler — deliberately does NOT call
  // ImagePicker.launchImageLibraryAsync() itself. FolderCoverMenu's own
  // <Modal> is still fully presented/mounted at the instant this fires, and
  // closing it via setShowCoverMenu(false) only *starts* its dismiss
  // animation — it does not complete synchronously. launchImageLibraryAsync()
  // on iOS calls through to presenting a native
  // UIImagePickerController/PHPickerViewController; presenting that while
  // FolderCoverMenu's own UIViewController-backed Modal is still
  // mid-dismissal is a documented iOS pitfall ("Attempt to present <X>
  // while a presentation is in progress") — UIKit can decline the
  // presentation outright, in which case launchImageLibraryAsync's returned
  // promise never resolves, since the native completion handler it's
  // waiting on never fires. Every OTHER expo-image-picker call site in this
  // app (profile-v2-screen.tsx's avatar picker, item/[id].tsx's add-photos)
  // either launches from a native Alert.alert (whose own dismissal is
  // already complete by the time its onPress fires — no RN Modal involved)
  // or from inline screen UI with no modal to race at all. FolderCoverMenu
  // is the only RN <Modal> immediately followed by a native picker launch
  // anywhere in this codebase, so there's no other in-app precedent to
  // directly copy — this defers to Modal's own onDismiss (iOS-only, but
  // exactly the class this bug is) instead of guessing at a delay.
  function handleChooseCoverFromLibrary() {
    if (savingCover || !folder || !currentUserId) return;
    if (Platform.OS === 'ios') {
      pendingLibraryPickRef.current = true;
      setShowCoverMenu(false);
    } else {
      // Android's Modal has no onDismiss callback, and its native photo
      // picker is a separate Activity (launched via Intent) rather than a
      // UIViewController presentation racing FolderCoverMenu's own — this
      // exact failure mode is iOS-specific, so Android keeps the original
      // immediate close-then-launch sequence.
      setShowCoverMenu(false);
      void runLibraryCoverPick();
    }
  }

  async function runLibraryCoverPick() {
    if (!folder || !currentUserId) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    // allowsEditing: false — this picker now only SELECTS a photo. Native
    // iOS/Android cropping is skipped entirely; the selected image is
    // handed straight to FolderCoverAdjuster (the same "Choose from
    // Folder" crop/zoom/reposition UI) below, converging both cover
    // sources onto one cropper instead of two different UIs. quality: 1
    // (no picker-side recompression) since the adjuster's own Save is now
    // the only place this image gets uploaded.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;

    setAdjustingCover({ kind: 'library', uri: result.assets[0].uri });
  }

  async function handleRemoveCover() {
    if (savingCover || !folder || !currentUserId) return;
    setShowCoverMenu(false);
    setSavingCover(true);
    const previousUploadPath = folder.cover_source === 'upload' ? folder.cover_storage_path : null;
    // Reverts to the same implicit default a folder starts with — no
    // separate "no cover at all" cover_source value exists, and this
    // matches that existing convention rather than inventing a new one.
    const updated = await applyCoverUpdate({
      cover_source: 'first_card',
      cover_storage_path: null,
      cover_item_id: null,
      cover_image_url: null,
      cover_crop: null,
    });
    if (updated && previousUploadPath) {
      await deleteFolderCover(previousUploadPath, currentUserId);
    }
    setSavingCover(false);
  }

  const showInitialLoading = loading && items.length === 0;

  // Failed refresh with items already on screen — kept visible below (never
  // cleared/replaced), just flagged with this lightweight inline row above
  // the grid. Same shape as the Collections-tab's refreshErrorRow/refresh()
  // pattern. Computed once, rendered in both isCardMode and grouping-mode
  // branches below rather than duplicated.
  const itemsErrorBanner =
    itemsError && items.length > 0 ? (
      <View style={styles.refreshErrorRow}>
        <Text style={styles.refreshErrorText} numberOfLines={1}>
          Couldn&apos;t refresh cards
        </Text>
        <Pressable onPress={refreshItems} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.refreshErrorRetry}>Retry</Text>
        </Pressable>
      </View>
    ) : null;

  // Mixed grid — nested Collections Piece 2. Child folders are first-class
  // tiles in the SAME 3-column grid as items (no separate "Folders"
  // section/heading), interleaved by the exact same newest-first
  // created_at ordering useItems already applies to collection_items —
  // compareGridEntriesByRecency (hooks/use-collection.ts) is the one shared
  // comparator every mixed grid/preview in the app uses, so `kind` never
  // determines position, only recency does. Not shown in isCardMode (that
  // per-player filtered gallery is a narrower slice of this folder's own
  // items, not the right place to also surface child folders).
  // Grandchildren/descendant items are deliberately never included — only
  // this folder's own direct children and direct items.
  const gridEntries = useMemo<CollectionGridEntry[]>(() => {
    if (isCardMode) {
      return filteredCardItems.map((item) => ({ kind: 'item' as const, item }));
    }
    const combined: CollectionGridEntry[] = [
      ...childFolders.map((folder) => ({ kind: 'folder' as const, folder })),
      ...filteredCardItems.map((item) => ({ kind: 'item' as const, item })),
    ];
    return combined.sort(compareGridEntriesByRecency);
  }, [isCardMode, childFolders, filteredCardItems]);

  // Default (non-card-mode) grid only — see FolderGridRow's own comment.
  // Chunked once here (not inside renderItem) so identical chunking logic
  // isn't repeated per render pass, and so isLast (for exact-parity bottom
  // spacing, see styles.manualGridRow) is known up front.
  const gridRows = useMemo(() => {
    const rows: CollectionGridEntry[][] = [];
    for (let i = 0; i < gridEntries.length; i += CARD_NUM_COLUMNS) {
      rows.push(gridEntries.slice(i, i + CARD_NUM_COLUMNS));
    }
    return rows;
  }, [gridEntries]);

  // Each item's 1-based place in the order handleReorderDone would save —
  // the SAME rule it uses (ranked ids first, in tap order; every unranked
  // item after, in its current order), so the list's numbers always preview
  // exactly what Done persists. Rows themselves stay in the current saved
  // order and never move while tapping, so the scroll position never jumps.
  const reorderPositions = useMemo(() => {
    const positions = new Map<string, number>();
    if (!reorderMode) return positions;
    rankedIds.forEach((id, index) => positions.set(id, index + 1));
    let next = rankedIds.length + 1;
    for (const item of items) {
      if (!positions.has(item.id)) positions.set(item.id, next++);
    }
    return positions;
  }, [reorderMode, rankedIds, items]);

  const stickyRowsData = useMemo<FolderGridRow[]>(() => {
    if (moveListMode && filteredCardItems.length > 0) {
      return [
        { kind: 'sticky' },
        { kind: 'moveHint' },
        ...filteredCardItems.map((item) => ({ kind: 'moveItem' as const, item })),
      ];
    }
    if (reorderMode && filteredCardItems.length > 0) {
      return [
        { kind: 'sticky' },
        { kind: 'reorderHint' },
        ...filteredCardItems.map((item) => ({
          kind: 'reorderItem' as const,
          item,
          position: reorderPositions.get(item.id) ?? 0,
        })),
      ];
    }
    if (gridRows.length === 0) return [{ kind: 'sticky' }, { kind: 'empty' }];
    return [
      { kind: 'sticky' },
      ...gridRows.map((entries, index) => ({ kind: 'row' as const, entries, isLast: index === gridRows.length - 1 })),
    ];
  }, [gridRows, reorderMode, moveListMode, filteredCardItems, reorderPositions]);

  // ── Loading / not-found / private states ────────────────────────
  // Only relevant now that non-owner traffic (public profiles, Saved,
  // shared links) can reach this screen — folder loading used to be a
  // no-op here since the Collection tab only ever opened the signed-in
  // user's own folders.
  if (folderLoading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        </SafeAreaView>
      </>
    );
  }

  if (!folder && folderError) {
    // Distinct from the legitimate not-found branch below — a real
    // query/network failure, never mistaken for "this collection doesn't
    // exist." Retry calls the same loadFolder() the mount effect uses.
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
            {/* '/collection' — COLLECTION_ROOT_ROUTE in lib/cachecase-navigation.ts,
                the tabs group's Collection root — not '/(tabs)' (Feed), since a
                folder route's natural fallback is the collection it lives in. */}
            <BackButton fallbackHref="/collection" />
          </View>
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load this collection</Text>
            <Text style={styles.emptyBody}>Check your connection and try again.</Text>
            <Pressable style={styles.emptyButton} onPress={loadFolder}>
              <Text style={styles.emptyButtonText}>Retry</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </>
    );
  }

  if (!folder) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
            {/* '/collection' — COLLECTION_ROOT_ROUTE in lib/cachecase-navigation.ts,
                the tabs group's Collection root — not '/(tabs)' (Feed), since a
                folder route's natural fallback is the collection it lives in. */}
            <BackButton fallbackHref="/collection" />
          </View>
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Collection not found</Text>
          </View>
        </SafeAreaView>
      </>
    );
  }

  if (isPrivate) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
            {/* '/collection' — COLLECTION_ROOT_ROUTE in lib/cachecase-navigation.ts,
                the tabs group's Collection root — not '/(tabs)' (Feed), since a
                folder route's natural fallback is the collection it lives in. */}
            <BackButton fallbackHref="/collection" />
          </View>
          <View style={styles.center}>
            <Text style={styles.privateIcon}>🔒</Text>
            <Text style={styles.emptyTitle}>This collection is private</Text>
            <Text style={styles.emptyBody}>Only the owner can view this collection.</Text>
          </View>
        </SafeAreaView>
      </>
    );
  }

  // Default (non-card-mode) grid's FlatList ListHeaderComponent — cover
  // banner + search bar, exactly the same JSX/styles that used to render as
  // plain siblings above the grid (see the removed block's comment further
  // up). Non-sticky: this scrolls away normally, which is what makes it
  // ListHeaderComponent rather than part of the sticky data[0] row below.
  // Always passed to FlatList (never conditionally omitted) even when both
  // conditions below are false and it renders nothing visible — omitting
  // the prop itself would shift every ScrollView child index down by one,
  // breaking stickyHeaderIndices={[1]}, which assumes this occupies index 0.
  function renderFolderListHeader() {
    return (
      <>
        {/* Folder cover/hero banner — purely a display surface, no editing
            controls here for anyone, owner included (per the design: cover
            changes go through Edit Folder → Change Cover, never a
            tap-to-edit overlay on the banner itself). Renders nothing at
            all (not even an empty placeholder) for a folder that has never
            had a cover set, so every existing folder's layout is unchanged
            until its owner opts in. */}
        {showCoverHero && (
          <View style={styles.coverHero}>
            {/* Waits for the folder row (a fast plain read, started at mount
                alongside the cover request) so the image's FIRST load already
                uses its final stable cacheKey — otherwise a cover URL that
                arrived first would download under its URL, then download
                again once the key could be built. The id check keeps a
                previous folder's row (same screen instance, new route id)
                from ever keying this folder's cover. */}
            {folder?.id === folderId && (coverUrl || coverPreviewPeek) && (
              <FolderCoverImage
                // Detail URL once signed; until then the cached preview.
                uri={coverUrl ?? coverPreviewPeek!.url}
                cacheKey={
                  !folder
                    ? undefined
                    : coverUrl
                      ? folderCoverCacheKey(
                          identity,
                          folder,
                          coverHeroServedTiers.get(folder.id) ?? FOLDER_HEADER_COVER_TIER,
                          coverHeroTokens.get(folder.id),
                        )
                      : folderCoverCacheKey(
                          identity,
                          folder,
                          coverPreviewPeek!.servedTier ?? COMPACT_IMAGE_TIER,
                          coverPreviewPeek!.token,
                        )
                }
                // While the detail bytes download, keep showing the preview.
                placeholder={
                  coverUrl && coverPreviewPeek && folder
                    ? {
                        uri: coverPreviewPeek.url,
                        cacheKey: folderCoverCacheKey(
                          identity,
                          folder,
                          coverPreviewPeek.servedTier ?? COMPACT_IMAGE_TIER,
                          coverPreviewPeek.token,
                        ),
                      }
                    : undefined
                }
                crop={
                  folder?.cover_source === 'item' || folder?.cover_source === 'upload'
                    ? (folder.cover_crop ?? null)
                    : null
                }
              />
            )}
          </View>
        )}

        {!showInitialLoading && items.length > 0 && searchVisible && (
          <CollectionSearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search players, teams..."
            style={styles.searchBar}
          />
        )}
      </>
    );
  }

  // Default (non-card-mode) grid's sticky FlatList row (data[0], kind:
  // 'sticky') — the entire black identity/title/actions panel as ONE
  // pinned unit, per the "do not split the black panel into multiple
  // independently sticky pieces" requirement. compactUserRow/titleRow
  // unchanged; the item-count + Comment/Like/Share row below them now
  // shares one line (styles.metaActionsRow) instead of two stacked ones —
  // still wrapped in one extra View (styles.folderStickyBar) so it has an opaque
  // background (matches styles.container's own PV2.bg) and the 10px gap to
  // whatever follows it (previously gridContent's own paddingTop:10; now
  // that this panel — not the grid's first row — is what directly precedes
  // that gap, the gap moved onto this wrapper instead, see
  // styles.folderStickyBar's own comment).
  function renderFolderStickyBar() {
    return (
      <View style={styles.folderStickyBar}>
        {/* Compact identity row — non-owner viewing someone else's folder
            only (public profiles, Saved). Sits above the title row now, per
            the reorganized header order; a single content-sized press
            target (not the full row width) opens that user's profile. */}
        {!isOwner && ownerProfile && (
          <View style={styles.compactUserRow}>
            <Pressable
              style={styles.compactUserPress}
              hitSlop={8}
              onPress={() =>
                router.push({ pathname: '/user/[username]', params: { username: ownerProfile.username } })
              }>
              <View style={styles.compactAvatar}>
                {ownerProfile.avatar_url ? (
                  <Image
                    source={{ uri: ownerProfile.avatar_url }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={200}
                  />
                ) : (
                  <View style={[StyleSheet.absoluteFill, styles.compactAvatarPlaceholder]}>
                    <Text style={styles.compactAvatarInitial}>
                      {(ownerProfile.display_name || ownerProfile.username).charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={styles.compactUsername} numberOfLines={1}>
                @{ownerProfile.username}
              </Text>
            </Pressable>
          </View>
        )}

        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {screenTitle}
          </Text>
        </View>

        {/* Item count (left) + Comment/Like/Share (right) now share one row
            — was a stacked item-count line above a separate full-width
            actions row. `items` is this folder's full, unpaginated
            collection_items result (hooks/use-collection.ts useItems), not
            a capped preview, so items.length is already the real total and
            needs no separate count query. The count is hidden during the
            initial load (never flashes "0 items" before the first fetch
            resolves) but an empty View still holds its slot so
            justifyContent: 'space-between' keeps the action group pinned
            right even then, rather than it re-centering/left-aligning with
            no sibling. Bookmark stays removed from this row (per the
            collection/item bookmark-removal pass) — saved_folders/
            useSavedFolder/the Saved screen are untouched. */}
        <View style={styles.metaActionsRow}>
          {showInitialLoading ? (
            <View />
          ) : (
            <Text style={styles.itemCountLabel}>
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </Text>
          )}

          <View style={styles.galleryActionsGroup}>
            <Pressable onPress={() => setCommentsVisible(true)} hitSlop={10} style={styles.iconBtn}>
              <IconSymbol name="message" size={20} color={PV2.textPrimary} />
            </Pressable>
            <Pressable onPress={toggleFolderLike} disabled={folderLikeInFlight} hitSlop={10} style={styles.likeBtn}>
              <IconSymbol
                name={liked ? 'heart.fill' : 'heart'}
                size={20}
                color={liked ? PV2.accent : PV2.textPrimary}
              />
              <Text style={[styles.likeCount, liked && styles.likeCountActive]}>{likeCount}</Text>
            </Pressable>
            <Pressable onPress={() => setShareSheetVisible(true)} hitSlop={10} style={styles.iconBtn}>
              <IconSymbol name="square.and.arrow.up" size={20} color={PV2.textPrimary} />
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // Single-tile renderer shared by BOTH grids below — card mode's original
  // numColumns-based FlatList (key supplied by its own keyExtractor, this
  // component's key prop is simply unused/harmless there) and the default
  // mode's manually-chunked rows (key required there, since those tiles are
  // built via a raw .map(), not FlatList's own renderItem+keyExtractor
  // pairing). Exactly the same JSX/styles/logic as before — only extracted
  // into a function so it isn't duplicated between the two grids.
  function renderGridTile(entry: CollectionGridEntry, key: string) {
    if (entry.kind === 'folder') {
      // First card inside the nested folder, falling back to its cover —
      // see getNestedFolderTileImage. This folder's OWN hero (above) is
      // untouched and still uses its cover.
      const tileImage = getNestedFolderTileImage(
        entry.folder,
        identity,
        { urls: signedUrls, statuses: gridStatuses, servedTiers: gridServedTiers },
        { urls: childCoverUrls, servedTiers: childCoverServedTiers, tokens: childCoverTokens },
      );
      return (
        <Pressable
          key={key}
          testID={`child-folder-${entry.folder.id}`}
          style={[styles.thumb, { width: cardThumbWidth, aspectRatio: PREVIEW_CARD_ASPECT_RATIO }]}
          // Nested folders are never a bulk-move or reorder candidate
          // (both are items-only) — disabled rather than removed from the
          // grid, so neither mode reshuffles the layout, matching how the
          // current-folder row in MoveItemModal stays visible-but-disabled
          // rather than vanishing.
          disabled={selectMode || reorderMode}
          onPress={() => {
            prefetchFolderHeaderCover(entry.folder.id);
            router.push({
              pathname: '/collection/[folderId]',
              params: { folderId: entry.folder.id, title: entry.folder.name },
            });
          }}>
          {tileImage ? (
            <Image
              source={tileImage}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.thumbPlaceholder} />
          )}
          {/* Small, subtle upper-right badge — the only thing that
              distinguishes a nested-collection tile from an ordinary item
              tile. Same dark-scrim-circle language as this screen's own
              heroCounterBadge, so it reads as "this tile is a folder"
              without competing with the cover photo underneath it.
              pointerEvents="none" so it never steals the tile's own tap
              target. */}
          <View style={styles.folderBadge} pointerEvents="none">
            <IconSymbol name="folder.fill" size={12} color="#fff" />
          </View>
        </Pressable>
      );
    }
    const isSelected = selectMode && selectedIds.has(entry.item.id);
    // Tap-to-rank — rank is purely derived from position within rankedIds
    // (1-based), never a separately-tracked number: removing an id from
    // the middle of that array automatically "compacts" every later rank
    // down by one on the very next render, with no explicit renumbering
    // step anywhere. 0 means unranked.
    const rank = reorderMode ? rankedIds.indexOf(entry.item.id) + 1 : 0;
    const isRanked = rank > 0;
    return (
      <Pressable
        key={key}
        testID={`collection-item-${entry.item.id}`}
        style={[
          styles.thumb,
          { width: cardThumbWidth, aspectRatio: PREVIEW_CARD_ASPECT_RATIO },
          isSelected && styles.thumbSelected,
          isRanked && styles.thumbRanked,
        ]}
        onPress={() => {
          if (reorderMode) toggleItemRank(entry.item.id);
          else if (selectMode) toggleItemSelected(entry.item.id);
          else openItem(entry.item);
        }}
        // Long-press only ever enters Select mode from the default (non-
        // card-mode) grid — isCardMode's per-player hero gallery has no
        // Select-mode header/bulk-action-bar of its own (see the header
        // JSX below), so entering it there would produce selection state
        // with no visible way to act on or exit it. Reorder mode has no
        // long-press of its own — tap-to-rank responds to a plain,
        // immediate tap, no hold gesture required. The long-pressed item is
        // NOT pre-selected — long-press just opens the Reorder/Move bar;
        // items are then picked for Move by tapping them.
        onLongPress={() => {
          if (!isCardMode && !selectMode && !reorderMode) enterSelectMode();
        }}
        accessibilityRole="button"
        accessibilityState={
          reorderMode ? { selected: isRanked } : selectMode ? { selected: isSelected } : undefined
        }
        accessibilityLabel={
          reorderMode
            ? isRanked
              ? `${entry.item.title ?? entry.item.player ?? 'Card'}, rank ${rank}, tap to remove`
              : `${entry.item.title ?? entry.item.player ?? 'Card'}, tap to rank`
            : undefined
        }>
        {entry.item.primary_image_id && signedUrls.get(entry.item.primary_image_id) ? (
          <Image
            source={{
              uri: signedUrls.get(entry.item.primary_image_id),
              cacheKey: itemImageCacheKey(identity, entry.item.primary_image_id, COMPACT_IMAGE_TIER, gridServedTiers),
            }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={styles.thumbPlaceholder} />
        )}
        {/* Selection checkmark — only rendered once actually selected, so
            an unselected tile in Select mode looks identical to normal
            browsing (no dimming/scrim needed for "no ambiguity": a
            selected tile always has both the accent border above AND this
            badge, never just one). */}
        {isSelected && (
          <View style={styles.selectionBadge} pointerEvents="none">
            <IconSymbol name="checkmark.circle.fill" size={22} color={PV2.accent} />
          </View>
        )}
        {/* Rank badge — the prominent numbered circle tap-to-rank replaces
            the old drag affordance with. Only rendered once actually
            ranked, same "no dimming needed, the badge+border together are
            the whole signal" convention as the selection checkmark above. */}
        {isRanked && (
          <View style={styles.rankBadge} pointerEvents="none">
            <Text style={styles.rankBadgeText}>{rank}</Text>
          </View>
        )}
      </Pressable>
    );
  }

  // Compact list row shared by the Order Items and Move lists — thumbnail,
  // title, one metadata line, and a caller-supplied trailing marker. Same
  // COMPACT-tier signed URL + cache key (signedUrls/gridServedTiers) as the
  // grid, so no new image work.
  function renderCompactItemRow(
    item: CollectionItem,
    {
      testID,
      highlighted,
      onPress,
      disabled,
      accessibilityLabel,
      trailing,
    }: {
      testID: string;
      highlighted: boolean;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel: string;
      trailing: ReactNode;
    },
  ) {
    const title = item.title ?? item.player ?? 'Card';
    const metadata = reorderRowMetadata(item);
    const imageUri = item.primary_image_id ? signedUrls.get(item.primary_image_id) : undefined;
    return (
      <Pressable
        testID={testID}
        style={({ pressed }) => [styles.reorderRow, highlighted && styles.reorderRowRanked, pressed && styles.reorderRowPressed]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: highlighted }}
        accessibilityLabel={accessibilityLabel}>
        <View style={styles.reorderThumb}>
          {item.primary_image_id && imageUri ? (
            <Image
              source={{
                uri: imageUri,
                cacheKey: itemImageCacheKey(identity, item.primary_image_id, COMPACT_IMAGE_TIER, gridServedTiers),
              }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.thumbPlaceholder} />
          )}
        </View>
        <View style={styles.reorderRowText}>
          <Text style={styles.reorderRowTitle} numberOfLines={1}>
            {title}
          </Text>
          {metadata ? (
            <Text style={styles.reorderRowMeta} numberOfLines={1}>
              {metadata}
            </Text>
          ) : null}
        </View>
        {trailing}
      </Pressable>
    );
  }

  // Order Items row — tap-to-rank, same handler/state/wording as the grid
  // tile it replaces in this mode.
  function renderReorderRow(item: CollectionItem, position: number) {
    const rank = rankedIds.indexOf(item.id) + 1;
    const isRanked = rank > 0;
    const title = item.title ?? item.player ?? 'Card';
    return renderCompactItemRow(item, {
      testID: `reorder-item-${item.id}`,
      highlighted: isRanked,
      onPress: () => toggleItemRank(item.id),
      disabled: savingReorder,
      accessibilityLabel: isRanked
        ? `${title}, rank ${rank}, tap to remove`
        : `${title}, position ${position}, tap to rank`,
      // Ranked: the same accent rank badge as the grid. Unranked: the muted
      // position it will land in if Done is tapped now.
      trailing: isRanked ? (
        <View style={styles.reorderRankBadge}>
          <Text style={styles.rankBadgeText}>{rank}</Text>
        </View>
      ) : (
        <Text style={styles.reorderPosition}>#{position}</Text>
      ),
    });
  }

  // Move list row — tap-to-select, the same selectedIds/toggleItemSelected
  // the grid's Select mode uses. Check on the right: filled accent check when
  // selected, empty ring when not.
  function renderMoveRow(item: CollectionItem) {
    const selected = selectedIds.has(item.id);
    const title = item.title ?? item.player ?? 'Card';
    return renderCompactItemRow(item, {
      testID: `move-item-${item.id}`,
      highlighted: selected,
      onPress: () => toggleItemSelected(item.id),
      accessibilityLabel: selected ? `${title}, selected, tap to deselect` : `${title}, tap to select`,
      trailing: selected ? (
        <IconSymbol name="checkmark.circle.fill" size={24} color={PV2.accent} />
      ) : (
        <View style={styles.moveCheckEmpty} />
      ),
    });
  }

  // Move list's Select All / Clear — over the rows actually listed (the
  // search-filtered set, same as the rows on screen).
  const allListedSelected =
    filteredCardItems.length > 0 && filteredCardItems.every((item) => selectedIds.has(item.id));
  function toggleSelectAllListed() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filteredCardItems) {
        if (allListedSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

  function gridTileKey(entry: CollectionGridEntry) {
    return entry.kind === 'folder' ? `folder-${entry.folder.id}` : entry.item.id;
  }

  // Exactly the same two empty states as before (same copy/styles) — now a
  // plain JSX value instead of a ListEmptyComponent function, since the
  // default grid's FlatList always has at least one row (the sticky bar),
  // so FlatList's own "data.length === 0" ListEmptyComponent trigger would
  // never fire there; this is rendered directly as data[1]'s content (kind:
  // 'empty') instead. Card mode's FlatList still has no other guaranteed
  // row, so it keeps using this via the real ListEmptyComponent prop.
  const emptyStateContent =
    search.trim() && cardItems.length > 0 ? (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No matches</Text>
        <Text style={styles.emptyBody}>Try a different search term.</Text>
      </View>
    ) : (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No cards yet</Text>
        <Text style={styles.emptyBody}>Add your first card to this collection.</Text>
        {isOwner && (
          <Pressable style={styles.emptyButton} onPress={addCard}>
            <Text style={styles.emptyButtonText}>Add Card</Text>
          </Pressable>
        )}
      </View>
    );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        {isCardMode ? (
          // Individual-card gallery — layout only for now (matches the
          // latest mockup): top bar with back/add/menu, the hero cover box,
          // then an action row (like/comment left, search/bookmark/share
          // right). Only the search icon has no handler yet — everything
          // else reuses the folder-level actions already wired below.
          <>
            <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
              <BackButton fallbackHref="/collection" />

              <View style={styles.headerTopActions}>
                {isOwner && (
                  <Pressable onPress={addCard} hitSlop={10} style={styles.iconBtn}>
                    <IconSymbol name="plus" size={24} color={PV2.textPrimary} />
                  </Pressable>
                )}
                {isOwner && (
                  <Pressable onPress={() => setEditVisible(true)} hitSlop={10} style={styles.iconBtn}>
                    <IconSymbol name="line.3.horizontal" size={22} color={PV2.textPrimary} />
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.heroSection}>
              <GestureDetector gesture={heroPan}>
                <View style={styles.heroBox}>
                  {activeHeroItem && (
                    <>
                      {/* Base layer — the committed, settled image. Never
                          animates itself; only the overlay below does.
                          contentPosition top:'0%' keeps the source image's
                          own top edge (face/upper body) fully uncropped —
                          cover-fit trims the excess from the bottom instead.
                          Resolved via the signed-delivery Edge Function
                          (item-images beta privacy hardening) — renders
                          nothing (the panel's own dark background shows
                          through) rather than falling back to a raw public
                          URL while the signed URL is still resolving. */}
                      {activeHeroItem.primary_image_id && heroImageSource(activeHeroItem.primary_image_id) && (
                        <Image
                          source={heroImageSource(activeHeroItem.primary_image_id)!}
                          style={StyleSheet.absoluteFill}
                          contentFit="cover"
                          contentPosition={HERO_IMAGE_CONTENT_POSITION}
                          cachePolicy="memory-disk"
                        />
                      )}
                      {/* Overlay — present only mid-transition, crossfades
                          the incoming image on top of the base layer. Once
                          fully opaque, heroIndex commits to match and this
                          layer unmounts with no visible change. Same
                          contentPosition as the base layer so nothing jumps
                          vertically during the crossfade. */}
                      {pendingHeroItem && pendingHeroItem.primary_image_id && heroImageSource(pendingHeroItem.primary_image_id) && (
                        <AnimatedExpoImage
                          source={heroImageSource(pendingHeroItem.primary_image_id)!}
                          style={[StyleSheet.absoluteFill, heroOverlayStyle]}
                          contentFit="cover"
                          contentPosition={HERO_IMAGE_CONTENT_POSITION}
                          cachePolicy="memory-disk"
                        />
                      )}
                      <LinearGradient
                        colors={['transparent', 'rgba(0,0,0,0.75)']}
                        style={StyleSheet.absoluteFill}
                        pointerEvents="none"
                      />
                      {heroItems.length > 1 && (
                        <View style={styles.heroCounterBadge} pointerEvents="none">
                          <Text style={styles.heroCounterText}>
                            {clampedHeroDisplayIndex + 1} / {heroItems.length}
                          </Text>
                        </View>
                      )}
                    </>
                  )}
                  <View style={styles.heroTextWrap}>
                    <Text style={styles.heroTitle} numberOfLines={1}>
                      {screenTitle}
                    </Text>
                    {!showInitialLoading && (
                      <Text style={styles.heroCount}>ITEMS {String(visibleCount).padStart(2, '0')}</Text>
                    )}
                  </View>
                </View>
              </GestureDetector>
            </View>

            {/* Same Comment/Like/Share row as the default-grid sticky bar
                above (renderFolderStickyBar) — see that block's own
                comment for why Bookmark is gone. */}
            <View style={styles.galleryActionsRow}>
              <Pressable onPress={() => setGalleryCommentsVisible(true)} hitSlop={10} style={styles.iconBtn}>
                <IconSymbol name="message" size={20} color={PV2.textPrimary} />
              </Pressable>
              <Pressable onPress={toggleFolderLike} disabled={folderLikeInFlight} hitSlop={10} style={styles.likeBtn}>
                <IconSymbol
                  name={liked ? 'heart.fill' : 'heart'}
                  size={20}
                  color={liked ? PV2.accent : PV2.textPrimary}
                />
                <Text style={[styles.likeCount, liked && styles.likeCountActive]}>{likeCount}</Text>
              </Pressable>
              <Pressable onPress={() => setShareSheetVisible(true)} hitSlop={10} style={styles.iconBtn}>
                <IconSymbol name="square.and.arrow.up" size={20} color={PV2.textPrimary} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
              {reorderMode ? (
                <Pressable onPress={handleReorderCancel} hitSlop={10} disabled={savingReorder}>
                  <Text style={[styles.selectCancelText, savingReorder && styles.selectCancelTextDisabled]}>
                    Cancel
                  </Text>
                </Pressable>
              ) : moveListMode ? (
                // Back to the grid, still in Select mode with the selection
                // kept — the outer Cancel there exits Select mode entirely.
                <Pressable onPress={() => setMoveListMode(false)} hitSlop={10}>
                  <Text style={styles.selectCancelText}>Cancel</Text>
                </Pressable>
              ) : selectMode ? (
                <Pressable onPress={cancelSelectMode} hitSlop={10}>
                  <Text style={styles.selectCancelText}>Cancel</Text>
                </Pressable>
              ) : (
                <BackButton fallbackHref="/collection" />
              )}

              {reorderMode ? (
                <View style={styles.reorderHeaderRight}>
                  <Text style={styles.selectCountText}>Reorder Items</Text>
                  <Pressable
                    onPress={handleReorderDone}
                    hitSlop={10}
                    disabled={savingReorder}
                    style={styles.reorderDoneBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Done reordering">
                    {savingReorder ? (
                      <ActivityIndicator size="small" color={PV2.accent} />
                    ) : (
                      <Text style={styles.reorderDoneText}>Done</Text>
                    )}
                  </Pressable>
                </View>
              ) : moveListMode ? (
                <View style={styles.reorderHeaderRight}>
                  <Text style={styles.selectCountText}>{selectedIds.size} Selected</Text>
                  <Pressable
                    onPress={() => setShowBulkMoveModal(true)}
                    hitSlop={10}
                    disabled={selectedIds.size === 0}
                    style={styles.reorderDoneBtn}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: selectedIds.size === 0 }}
                    accessibilityLabel={`Move ${selectedIds.size} selected`}>
                    <Text style={[styles.reorderDoneText, selectedIds.size === 0 && styles.moveHeaderBtnDisabled]}>
                      Move
                    </Text>
                  </Pressable>
                </View>
              ) : selectMode ? (
                <Text style={styles.selectCountText}>
                  {selectedIds.size} Selected
                </Text>
              ) : (
                <View style={styles.headerTopActions}>
                  {!showInitialLoading && items.length > 0 && (
                    <Pressable
                      onPress={toggleSearch}
                      hitSlop={10}
                      style={styles.iconBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Search"
                      accessibilityState={{ selected: searchVisible }}>
                      <IconSymbol
                        name="magnifyingglass"
                        size={22}
                        color={searchVisible ? PV2.accent : PV2.textPrimary}
                      />
                    </Pressable>
                  )}
                  {isOwner && (
                    <Pressable onPress={() => setShowAddMenu(true)} hitSlop={10} style={styles.iconBtn}>
                      <IconSymbol name="plus" size={24} color={PV2.textPrimary} />
                    </Pressable>
                  )}
                  {isOwner && (
                    <Pressable onPress={() => setEditVisible(true)} hitSlop={10} style={styles.iconBtn}>
                      <IconSymbol name="line.3.horizontal" size={22} color={PV2.textPrimary} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>

            {/* Cover/search (non-sticky) and the identity/title/actions
                "black panel" (sticky) used to render here as plain
                siblings, directly above the grid's own FlatList. They now
                render INSIDE that same FlatList instead — cover+search via
                ListHeaderComponent (renderFolderListHeader), the panel as
                the FlatList's own first data row (renderFolderStickyBar,
                data[0], kind: 'sticky') — so FlatList's native
                stickyHeaderIndices can pin the panel natively once it
                reaches the top, without a second nested scroll container or
                manual scrollY tracking. See renderFolderListHeader/
                renderFolderStickyBar below and the FlatList render further
                down for the actual JSX (unchanged in content/styling, only
                moved). isCardMode's own hero/actions above this branch is
                untouched — it keeps its original fixed-header layout. */}
          </>
        )}

        {showInitialLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : itemsError && items.length === 0 ? (
          // Real query/network failure with nothing already on screen —
          // distinct from the legitimate "No cards yet" empty state further
          // down. Retry calls the same refreshItems() the focus effect uses.
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load cards</Text>
            <Text style={styles.emptyBody}>Check your connection and try again.</Text>
            <Pressable style={styles.emptyButton} onPress={refreshItems}>
              <Text style={styles.emptyButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : isCardMode ? (
          // Card mode's original grid — untouched: numColumns/
          // columnWrapperStyle's automatic row-grouping, gridEntries
          // directly as data, ListEmptyComponent for the empty state. Card
          // mode has its own fixed (non-scrolling) header rendered above
          // (heroSection/galleryActionsRow) and was never part of this
          // request — no sticky behavior applies here.
          <>
            {itemsErrorBanner}
            <FlatList
              data={gridEntries}
              numColumns={CARD_NUM_COLUMNS}
              keyExtractor={(entry) => gridTileKey(entry)}
              columnWrapperStyle={styles.row}
              contentContainerStyle={[
                styles.gridContent,
                styles.cardGridContent,
                { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 },
              ]}
              onScroll={navbarOnScroll}
              scrollEventThrottle={scrollEventThrottle}
              renderItem={({ item: entry }) => renderGridTile(entry, gridTileKey(entry))}
              ListEmptyComponent={() => emptyStateContent}
            />
          </>
        ) : (
          // Default (non-card-mode) grid — the same visual grid as before,
          // now sharing one FlatList with the cover/search header
          // (ListHeaderComponent, non-sticky) and the black identity/title/
          // actions panel (data[0], kind: 'sticky') so stickyHeaderIndices
          // can pin that panel natively. See FolderGridRow/
          // renderFolderListHeader/renderFolderStickyBar's own comments.
          <>
            {itemsErrorBanner}
            <FlatList<FolderGridRow>
              data={stickyRowsData}
              keyExtractor={(row, index) =>
                row.kind === 'sticky'
                  ? 'sticky-header'
                  : row.kind === 'empty'
                    ? 'empty-state'
                    : row.kind === 'reorderHint'
                      ? 'reorder-hint'
                      : row.kind === 'reorderItem'
                        ? `reorder-${row.item.id}`
                        : row.kind === 'moveHint'
                          ? 'move-hint'
                          : row.kind === 'moveItem'
                            ? `move-${row.item.id}`
                            : `row-${index}`
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              // Called here (an already-built element), NOT passed as a bare
              // function reference. VirtualizedList's own rendering does
              // `isValidElement(ListHeaderComponent) ? ListHeaderComponent :
              // <ListHeaderComponent />` — renderFolderListHeader is a new
              // closure on every render of this screen (rank taps, the
              // reorder-save refetch, etc.), so passing the function itself
              // made every one of those re-renders look like "a different
              // component type" to React, which fully unmounted and
              // remounted the whole header subtree — including
              // FolderCoverImage's <Image> — on every single one. Passing
              // the element instead lets normal reconciliation (diffing the
              // same <View>/<FolderCoverImage> tags) take over, so the cover
              // image is updated in place, never torn down.
              ListHeaderComponent={renderFolderListHeader()}
              stickyHeaderIndices={[1]}
              contentContainerStyle={[
                styles.gridContentSticky,
                {
                  // Extra reserved space while the bulk action bar is
                  // showing (see BULK_BAR_RESERVED_HEIGHT's own comment) —
                  // otherwise the last grid row would sit directly behind
                  // it once scrolled to the bottom. The bar itself now
                  // shows for the whole of Select mode (Move disabled at 0
                  // selected, Reorder always available — see the bar's own
                  // render site), not just once something is selected.
                  paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 + (selectMode ? BULK_BAR_RESERVED_HEIGHT : 0),
                },
              ]}
              onScroll={navbarOnScroll}
              scrollEventThrottle={scrollEventThrottle}
              renderItem={({ item: row }) => {
                if (row.kind === 'sticky') return renderFolderStickyBar();
                if (row.kind === 'empty') return emptyStateContent;
                if (row.kind === 'reorderHint') {
                  return (
                    <Text style={styles.reorderHint}>
                      Tap items in the order you want them. Tap again to undo. The rest keep their current order.
                    </Text>
                  );
                }
                if (row.kind === 'reorderItem') return renderReorderRow(row.item, row.position);
                if (row.kind === 'moveHint') {
                  return (
                    <View style={styles.moveHintRow}>
                      <Text style={styles.moveHintText}>Tap items to select them.</Text>
                      <Pressable onPress={toggleSelectAllListed} hitSlop={10} accessibilityRole="button">
                        <Text style={styles.moveSelectAllText}>{allListedSelected ? 'Clear' : 'Select All'}</Text>
                      </Pressable>
                    </View>
                  );
                }
                if (row.kind === 'moveItem') return renderMoveRow(row.item);
                return (
                  <View style={[styles.manualGridRow, !row.isLast && styles.manualGridRowGap]}>
                    {row.entries.map((entry) => renderGridTile(entry, gridTileKey(entry)))}
                  </View>
                );
              }}
            />
          </>
        )}
      </SafeAreaView>

      {/* Bulk action bar — absolutely positioned above the global floating
          tab bar (components/navigation/global-floating-tab-bar.tsx:
          bottom = insets.bottom + 4, height TAB_BAR_HEIGHT), never a sibling
          inside the scrolling FlatList, so it stays fixed/accessible while
          scrolling and can never be scrolled behind the tab pill. Shown for
          the whole of Select mode now, not just once ≥1 item is selected —
          Reorder is a mode switch, not a bulk operation on the current
          selection, so it has to stay reachable at 0 selected too; Move
          alone becomes "unavailable" there via its own disabled state
          below, never by hiding the whole bar. */}
      {selectMode && !moveListMode && (
        <View style={[styles.bulkBar, { bottom: TAB_BAR_HEIGHT + insets.bottom + 16 }]} pointerEvents="box-none">
          {/* Just the two actions, centered — the selection count already
              shows in the header ("N Selected"). */}
          <View style={styles.bulkBarInner}>
            <View style={styles.bulkBarActions}>
              <Pressable style={styles.bulkBarReorderBtn} onPress={handleEnterReorderMode}>
                <Text style={styles.bulkBarReorderBtnText}>Reorder</Text>
              </Pressable>
              {/* Always enabled, like Reorder — picks the action; the items
                  are chosen in the Move list it opens, which starts clean. */}
              <Pressable style={styles.bulkBarMoveBtn} onPress={handleEnterMoveList}>
                <Text style={styles.bulkBarMoveBtnText}>Move</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {isOwner && folderId && (
        <MoveItemModal
          mode="bulk"
          visible={showBulkMoveModal}
          itemIds={Array.from(selectedIds)}
          sourceFolderId={folderId}
          currentUserId={currentUserId}
          onClose={() => setShowBulkMoveModal(false)}
          onMoved={handleBulkMoved}
        />
      )}

      {isOwner && (
        <CollectionAddMenu
          visible={showAddMenu}
          onClose={() => setShowAddMenu(false)}
          onAddFolder={() => {
            setShowAddMenu(false);
            setShowCreateFolderModal(true);
          }}
          onAddItem={() => {
            setShowAddMenu(false);
            addCard();
          }}
        />
      )}

      {isOwner && currentUserId && (
        <CreateFolderModal
          visible={showCreateFolderModal}
          userId={currentUserId}
          parentFolderId={folderId}
          onClose={() => setShowCreateFolderModal(false)}
          onCreated={() => {
            setShowCreateFolderModal(false);
            refreshChildFolders();
          }}
        />
      )}

      {isOwner && (
        <FolderEditModal
          visible={editVisible}
          folder={folder}
          currentUserId={currentUserId}
          onClose={() => setEditVisible(false)}
          onSaved={(updated) => setFolder(updated)}
          onDeleted={() => router.back()}
          onChangeCover={openCoverMenu}
        />
      )}

      {isOwner && (
        <FolderCoverMenu
          visible={showCoverMenu}
          onClose={() => setShowCoverMenu(false)}
          onDismiss={() => {
            // iOS only (see runLibraryCoverPick's own comment) — fires once
            // this Modal's dismiss animation has actually finished, which
            // is the deterministic signal handleChooseCoverFromLibrary
            // defers to instead of a guessed delay.
            if (pendingLibraryPickRef.current) {
              pendingLibraryPickRef.current = false;
              void runLibraryCoverPick();
            }
          }}
          onChooseFromFolder={() => {
            setShowCoverMenu(false);
            setShowCoverItemPicker(true);
          }}
          onChooseFromLibrary={handleChooseCoverFromLibrary}
          onRemoveCover={handleRemoveCover}
          hasCover={folder?.cover_source === 'upload' || folder?.cover_source === 'item'}
        />
      )}

      {isOwner && (
        <FolderCoverItemPicker
          visible={showCoverItemPicker}
          onClose={() => setShowCoverItemPicker(false)}
          items={items}
          signedUrls={signedUrls}
          onSelect={handleChooseFromFolderItem}
        />
      )}

      {isOwner && adjustingCover && (
        <FolderCoverAdjuster
          visible
          uri={adjustingCover.uri}
          onSave={handleSaveAdjustedCover}
          onCancel={handleCancelAdjustCover}
        />
      )}

      <ShareSheet
        visible={shareSheetVisible}
        onClose={() => setShareSheetVisible(false)}
        heading="Share Folder"
        imageUri={coverUrl ?? coverPreviewPeek?.url ?? null}
        imageShape="square"
        title={folderTitle}
        subtitle={ownerProfile ? `@${ownerProfile.username}` : null}
        feed={
          !currentUserId
            ? { kind: 'unsupported', subtitle: 'Sign in to post to your feed' }
            : isOwner && folder && !folder.is_public
              ? {
                  kind: 'blocked',
                  subtitle: 'Make this folder public to share',
                  noticeTitle: 'This folder must be public before it can be posted.',
                  noticeText: 'Change the folder’s visibility and try again.',
                  fixLabel: 'Edit Folder',
                  onFix: () => setTimeout(() => setEditVisible(true), 350),
                }
              : { kind: 'available', subtitle: 'Create a CacheCase post with this folder', onPress: handleShareToFeed }
        }
        dm={{ kind: 'unsupported', subtitle: 'Not available for folders yet' }}
        onShareElsewhere={handleShareElsewhere}
      />

      <FolderCommentsSheet
        visible={commentsVisible}
        onClose={() => setCommentsVisible(false)}
        folderId={folderId}
        folderTitle={folderTitle}
        currentUserId={currentUserId}
      />

      <GalleryCommentsSheet
        visible={galleryCommentsVisible}
        onClose={() => setGalleryCommentsVisible(false)}
        folderId={folderId}
        playerKey={activePlayer}
        galleryTitle={screenTitle}
        currentUserId={currentUserId}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  // Top row — back chevron on the left, management icons (add/menu) on the
  // right. Title + its own action row (heart/comment/bookmark/share) live
  // in a separate row below the search bar, not inline with back here.
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  headerTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Phase 2 Select mode — text buttons/label replacing headerTopActions'
  // icon row while active (see headerTop's own conditional above). Not
  // `iconBtn` (fixed 36x36 square, sized for a single glyph) — these are
  // variable-width text, so they get their own minimal hit-area padding
  // instead.
  selectCancelText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  selectCancelTextDisabled: {
    color: PV2.textTertiary,
  },
  selectCountText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  // Reorder mode header — groups the "Reorder Items" label with the Done
  // button on the header's right side (Cancel stays alone on the left, via
  // headerTop's own space-between) — see that render site's own comment
  // for why this isn't a true 3-slot centered layout.
  reorderHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  reorderDoneBtn: {
    minWidth: 40,
    alignItems: 'flex-end',
  },
  reorderDoneText: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.accent,
  },
  // Phase 2 bulk action bar — see its own render-site comment for why this
  // is absolutely positioned as a sibling of the SafeAreaView rather than
  // inside the FlatList (stays fixed while scrolling, sits above the
  // global floating tab bar). left/right match BAR_HORIZONTAL_INSET's
  // general sizing intent (a floating pill inset from both edges) without
  // importing that private constant from global-floating-tab-bar.tsx.
  bulkBar: {
    position: 'absolute',
    left: 20,
    right: 20,
  },
  bulkBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(9,10,16,0.97)',
    borderWidth: 1,
    borderColor: 'rgba(100,105,145,0.28)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  bulkBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bulkBarReorderBtn: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  bulkBarReorderBtnText: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  bulkBarMoveBtn: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  bulkBarMoveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  // Title's own full-width row — the like/comment/bookmark/share controls
  // that used to share this row (squeezing the title's available width)
  // now live in their own row below (styles.metaActionsRow, alongside the
  // item count), which carries the title-row-to-grid gap that used to live
  // here.
  titleRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 4,
    // metaActionsRow below now carries the title-to-actions-row gap (via its
    // own marginBottom), so this only needs to clear the title's descenders.
    paddingBottom: 0,
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 4,
    height: 36,
  },
  likeCount: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
    minWidth: 10,
  },
  likeCountActive: {
    color: PV2.accent,
  },
  // flex:1 (its only sibling in titleRow was removed) — takes the row's
  // full width now instead of competing for space with the action icons
  // that used to share this row.
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: '800',
    color: PV2.textPrimary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  // Item count (left) + Comment/Like/Share (right), one row — see this
  // block's own JSX comment (renderFolderStickyBar) for why an empty View
  // (not omitting the child entirely) fills this slot during initial load.
  // Owns the horizontal/vertical spacing itemCountLabel and galleryActionsRow
  // used to carry separately when they were two stacked rows.
  metaActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    marginTop: 4,
    marginBottom: 6,
  },
  // Folder metadata, not an action control — reads as part of the title
  // above it, so it uses the same muted secondary-text token as the rest of
  // this screen's metadata (compactUsername/likeCount/etc.) rather than
  // introducing a new color. No margin/padding of its own now — metaActionsRow
  // (its flex parent) owns that.
  itemCountLabel: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  // Comment/Like/Share group as it sits nested inside metaActionsRow —
  // same icon gap (24) as galleryActionsRow below, but no padding/margin of
  // its own (metaActionsRow's own paddingHorizontal already provides the
  // row's right edge). Distinct from galleryActionsRow (still used
  // unchanged by the card-mode header further down, which is NOT part of
  // this layout pass) so that row's own self-contained padding is never
  // doubled up by being nested here.
  galleryActionsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  privateIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  // Compact identity row — non-owner viewing someone else's folder only
  // (public profiles, Saved). Lightweight on purpose: just avatar +
  // @username, no name/border/background shell/chevron. The outer wrap
  // carries the page's normal horizontal padding and the row-to-title-row
  // gap; the press target itself is content-sized (alignSelf:'flex-start'),
  // not the full row width.
  compactUserRow: {
    paddingHorizontal: 12,
    // Combined with searchBar's own marginBottom (10, unchanged — so the
    // owner's own view, which never renders this row, keeps its original
    // search-to-title spacing untouched) this lands the search-to-row gap
    // at 24px, within the requested 22-28px range.
    marginTop: 14,
    // Combined with titleRow's own paddingTop (4, unchanged) this lands
    // the row-to-title gap at 16px, within the requested 14-18px range.
    marginBottom: 12,
  },
  compactUserPress: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  compactAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    flexShrink: 0,
  },
  compactAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactAvatarInitial: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  compactUsername: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  // Card-mode-only "cover" — a large gray banner holding the title/count,
  // sitting below its own headerTop row (back/add/menu) rather than having
  // those buttons float on top of it.
  heroSection: {
    paddingHorizontal: 12,
  },
  heroBox: {
    width: '100%',
    aspectRatio: 1.55,
    borderRadius: 20,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  heroTextWrap: {
    padding: 18,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: PV2.textPrimary,
  },
  heroCount: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: PV2.textSecondary,
    textTransform: 'uppercase',
  },
  heroCounterBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  heroCounterText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
  },
  // Comment / Like / Share — one row, left-aligned, evenly gapped (same
  // three-action social model as the feed's own post cards, see
  // components/feed/post-card.tsx's actionsRow). Replaces the old two-side
  // left/right split that grouped like+comment on one side and
  // bookmark+share on the other — Bookmark is gone from this row entirely
  // (removed, not hidden; saved_folders/useSavedFolder/the Saved screen are
  // untouched elsewhere).
  galleryActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
  },
  // Folder cover/hero banner — edge-to-edge (no horizontal margin, like
  // this screen's own grid below), landscape FOLDER_COVER_ASPECT_RATIO,
  // square corners (FOLDER_COVER_RADIUS = 0) — a banner, not another
  // rounded trading-card tile. backgroundColor preserves the existing dark
  // page background showing through while the signed URL is still
  // resolving (see showCoverHero's own "loading OR ready" gate above).
  coverHero: {
    width: '100%',
    aspectRatio: FOLDER_COVER_ASPECT_RATIO,
    borderRadius: FOLDER_COVER_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.bg,
    marginBottom: 8,
  },
  searchBar: {
    marginHorizontal: 12,
    marginBottom: 10,
  },
  // Default (non-card-mode) grid only — wraps compactUserRow/titleRow/
  // galleryActionsRow (rendered by renderFolderStickyBar) as ONE sticky
  // FlatList row. backgroundColor: PV2.bg matches styles.container's own
  // background exactly (this app's dark theme background IS the "black
  // panel" look — there's no separate/lighter panel color to preserve) —
  // needed explicitly here now, since once pinned this row visually floats
  // above grid rows scrolling underneath it and must stay opaque rather
  // than letting them show through. marginBottom: 10 replicates the exact
  // gap that used to come from gridContent's own paddingTop: 10, back when
  // this panel was a sibling before the FlatList and that padding applied
  // to the grid's first row instead — now that this panel is what directly
  // precedes that gap, the 10px moved here with it; gridContentSticky
  // itself carries no paddingTop for this same reason (see its own
  // comment).
  folderStickyBar: {
    backgroundColor: PV2.bg,
    marginBottom: 10,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    gap: GRID_GAP,
  },
  gridContent: {
    gap: GRID_GAP,
    paddingHorizontal: GRID_PAGE_PADDING,
    paddingTop: 10,
    // paddingBottom intentionally omitted — always overridden at the
    // FlatList call site with TAB_BAR_HEIGHT + insets.bottom + 24 (this
    // app's standard floating-nav clearance, see every other tab/stack
    // screen's own contentContainerStyle for the same pattern), so a
    // static value here would just be dead/misleading.
    flexGrow: 1,
  },
  // Default (non-card-mode) grid's own contentContainerStyle — deliberately
  // NOT gridContent (that style's `gap` would insert GRID_GAP between
  // EVERY direct FlatList child, including between ListHeaderComponent and
  // the sticky bar, and between the sticky bar and the first grid row,
  // neither of which existed before this restructuring). Vertical spacing
  // here instead comes from each row's own margin — folderStickyBar's
  // marginBottom above (sticky bar → first row) and manualGridRowGap below
  // (row → row) — reproducing gridContent's old spacing exactly rather than
  // approximating it.
  gridContentSticky: {
    paddingHorizontal: GRID_PAGE_PADDING,
    // paddingBottom intentionally omitted — see gridContent's own comment;
    // overridden the same way at this FlatList's own call site.
    flexGrow: 1,
  },
  // Default (non-card-mode) grid only — the manually-chunked replacement
  // for FlatList's own numColumns+columnWrapperStyle row grouping (see
  // FolderGridRow's comment for why). Same gap value as styles.row's own
  // (GRID_GAP) for the horizontal gap between columns within a row;
  // flexDirection: 'row' is spelled out here because, unlike
  // columnWrapperStyle (where FlatList itself supplies flexDirection:
  // 'row' and columnWrapperStyle only adds to it), this row is a plain View
  // this screen builds and styles entirely itself.
  manualGridRow: {
    flexDirection: 'row',
    gap: GRID_GAP,
  },
  // Applied to every row except the last (see stickyRowsData's own isLast)
  // — reproduces gridContent's old inter-row `gap` exactly, without also
  // adding a trailing gap after the final row that plain `gap` never would
  // have.
  manualGridRowGap: {
    marginBottom: GRID_GAP,
  },
  // Card mode only — pulls the grid up closer to the hero header below it.
  cardGridContent: {
    paddingTop: 3,
  },
  // Square-cornered (GRID_CARD_RADIUS = 0), borderless tile — this grid
  // intentionally reads as a dense, edge-to-edge Instagram-style grid, not
  // the Collection page's own bordered preview-card look. No borderWidth:
  // the Image below only fills this tile's padding-box (inside any border),
  // so even a 1px border here would sit outside the photo and silently
  // double the real GRID_GAP as visible space between adjacent photos.
  // backgroundColor is the only remaining paint — just the fallback shown
  // behind a still-loading/missing image, not a spacing source.
  thumb: {
    borderRadius: GRID_CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  thumbPlaceholder: {
    ...StyleSheet.absoluteFill,
    backgroundColor: PV2.collectorPanelBg,
  },
  // Nested-collection badge — same rgba(0,0,0,~0.5) dark-scrim-circle
  // language as heroCounterBadge above, just small and corner-anchored
  // instead of centered/larger, so it reads as "this tile is a folder"
  // without competing with the cover photo underneath it.
  folderBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Phase 2 Select mode — applied on top of `thumb` (border layers inside
  // its own overflow:hidden clip, same as any other bordered tile in this
  // app) only for a selected item tile, never for an unselected one in
  // Select mode, so a selected tile is unambiguous: border AND checkmark
  // together, always both.
  thumbSelected: {
    borderWidth: 3,
    borderColor: PV2.accent,
  },
  selectionBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: PV2.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Reorder mode (tap-to-rank) — a subtler border than thumbSelected's
  // (2px vs 3px, per "subtle selected border/overlay"), distinct enough to
  // never be confused with Select mode's own accent border even though
  // they use the same color, since the two modes are mutually exclusive
  // and never render at the same time anyway.
  thumbRanked: {
    borderWidth: 2,
    borderColor: PV2.accent,
  },
  // The prominent numbered badge tap-to-rank relies on — deliberately
  // larger and higher-contrast than selectionBadge (Select mode's plain
  // checkmark) so a rank number reads clearly at a glance across a grid of
  // many ranked tiles, not just "is this one selected or not."
  rankBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 6,
    backgroundColor: PV2.accent,
    borderWidth: 1.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankBadgeText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  // Reorder list (reorder mode only) — dark rows on the page background,
  // hairline separators, thumbnail left, rank right.
  reorderHint: {
    color: PV2.textTertiary,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  reorderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: REORDER_ROW_PADDING_V,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
    // Reserved transparent left edge so the ranked accent bar below never
    // shifts the row's content.
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  // Ranked = picked: a faint accent wash plus a thin accent bar on the left
  // edge, alongside the numbered badge on the right.
  reorderRowRanked: {
    backgroundColor: PV2.accentSoft,
    borderLeftColor: PV2.accent,
  },
  reorderRowPressed: {
    opacity: 0.7,
  },
  reorderThumb: {
    height: REORDER_THUMB_HEIGHT,
    aspectRatio: PREVIEW_CARD_ASPECT_RATIO,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  reorderRowText: {
    flex: 1,
    gap: 3,
  },
  reorderRowTitle: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  reorderRowMeta: {
    color: PV2.textSecondary,
    fontSize: 12,
  },
  reorderRankBadge: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 6,
    backgroundColor: PV2.accent,
    borderWidth: 1.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  moveHintText: {
    color: PV2.textTertiary,
    fontSize: 12,
  },
  moveSelectAllText: {
    color: PV2.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  // Unselected check — an empty ring the size of the filled check icon.
  moveCheckEmpty: {
    width: 22,
    height: 22,
    marginHorizontal: 1,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: PV2.textTertiary,
  },
  moveHeaderBtnDisabled: {
    color: PV2.textTertiary,
  },
  reorderPosition: {
    minWidth: 26,
    textAlign: 'center',
    color: PV2.textTertiary,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  emptyBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: 14,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  // Inline banner for a failed item-list refresh when cards are already on
  // screen — same shape/tokens as the Collections tab's own refreshErrorRow
  // (app/(tabs)/collection.tsx), deliberately lightweight, no toast system.
  refreshErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(232,24,26,0.35)',
  },
  refreshErrorText: {
    flex: 1,
    fontSize: 13,
    color: PV2.textSecondary,
    marginRight: 12,
  },
  refreshErrorRetry: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.accent,
  },
});

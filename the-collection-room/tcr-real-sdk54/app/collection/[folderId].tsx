import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
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

import { CacheCasePlaceholderShell } from '@/components/collection/cachecase-placeholder-shell';
import {
  CollectionPreviewCard,
  PREVIEW_CARD_ASPECT_RATIO,
  PREVIEW_CARD_RADIUS,
} from '@/components/collection/collection-preview-card';
import { CollectionSearchBar } from '@/components/collection/collection-search-bar';
import { FolderCommentsSheet } from '@/components/collection/folder-comments-sheet';
import { GalleryCommentsSheet } from '@/components/collection/gallery-comments-sheet';
import { FolderEditModal } from '@/components/collection/folder-edit-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  NO_PLAYER_KEY,
  groupItemsByPlayer,
  itemMatchesSearch,
  useItems,
  type PlayerGroup,
} from '@/hooks/use-collection';
import { useFolderLikes } from '@/hooks/use-folder-likes';
import { useSavedFolder } from '@/hooks/use-saved';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { CollectionItem, Folder } from '@/types';

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

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// Dense grid. Gap is applied via FlatList's own contentContainerStyle/
// columnWrapperStyle gap support — no per-item margin math, no
// ItemSeparatorComponent (unreliable with numColumns > 1).
const NUM_COLUMNS = 2;
// Individual-card gallery (isCardMode) uses a denser 3-column grid than the
// grouping grid above — only affects that grid's own columns/padding/tile
// width, computed separately below.
const CARD_NUM_COLUMNS = 3;
const GRID_GAP = 3;

// Restrained fixed target for the "intended initial grid" — real tiles
// always render first; ghost shells only pad up to this many total slots
// (or, once real content already meets/exceeds it, just complete whatever
// row is currently dangling). Never grows into a long trailing field of
// placeholders down the page.
const MIN_GRID_SLOTS = 4;

type GridSlot<T> = { kind: 'real'; data: T } | { kind: 'placeholder'; key: string };

function toRealSlots<T>(data: T[]): GridSlot<T>[] {
  return data.map((item) => ({ kind: 'real', data: item }));
}

// Pads with generated, local-only CacheCasePlaceholderShell tiles — never
// persisted, never tappable, never part of counts or search. Below the
// fixed minimum, pads up to exactly MIN_GRID_SLOTS; at or above it, only
// completes the currently-dangling row.
function padToMinimumGrid<T>(data: T[], keyPrefix: string, columns: number): GridSlot<T>[] {
  if (data.length === 0) return [];
  const target =
    data.length >= MIN_GRID_SLOTS ? Math.ceil(data.length / columns) * columns : MIN_GRID_SLOTS;
  const padCount = Math.max(0, target - data.length);
  const placeholders: GridSlot<T>[] = Array.from({ length: padCount }, (_, i) => ({
    kind: 'placeholder',
    key: `${keyPrefix}-${i}`,
  }));
  return [...toRealSlots(data), ...placeholders];
}

// The gallery for one folder — "a folder that holds folders": opening a
// top-level category (Basketball, Baseball, ...) first reveals its
// player groupings, and opening a grouping reveals that player's individual
// cards. Same route both times — grouping mode vs. card mode is decided
// purely by whether the `player` param is present — so there's no second
// route/file to keep in sync with this one.
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

  // Existing hook (hooks/use-collection.ts) — already filters
  // collection_items by folder_id and orders newest-first. Not duplicated,
  // and shared by both grouping mode and card mode below.
  const { items, loading, error: itemsError, refresh: refreshItems } = useItems(folderId);

  // Legacy app/folder/[id].tsx refreshed on focus so returning here after
  // adding a card (or from any other entry point) shows it immediately —
  // preserved since Profile/Saved/public-profile now land on this screen.
  useFocusEffect(useCallback(() => { refreshItems(); }, [refreshItems]));

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
  const [commentsVisible, setCommentsVisible] = useState(false);
  // Separate from commentsVisible/FolderCommentsSheet (whole-folder
  // comments, grouping mode) — the gallery/card-mode comment thread is its
  // own, scoped to this folder+player group. See GalleryCommentsSheet.
  const [galleryCommentsVisible, setGalleryCommentsVisible] = useState(false);

  const { isSaved, saving: savingBookmark, toggle: toggleSave } = useSavedFolder(folderId, currentUserId);
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

  const folderTitle = folder?.name || passedTitle || 'Collection';
  const thumbWidth = (windowWidth - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;
  const cardThumbWidth = (windowWidth - GRID_GAP * (CARD_NUM_COLUMNS - 1)) / CARD_NUM_COLUMNS;

  const groups = useMemo(() => groupItemsByPlayer(items), [items]);

  const cardItems = useMemo(() => {
    if (!activePlayer) return [];
    return activePlayer === NO_PLAYER_KEY
      ? items.filter((i) => !i.player?.trim())
      : items.filter((i) => i.player?.trim() === activePlayer);
  }, [items, activePlayer]);

  // Hero preview — a stable collection cover, not an auto-playing slideshow.
  // Ordered newest-first (useItems already orders collection_items by
  // created_at DESC), so index 0 doubles as both "default cover" and
  // "newest item" — there's no separate per-player-group cover-selection
  // concept in the data model to draw a distinct "selected cover" from.
  const heroItems = useMemo(() => cardItems.filter((i) => !!i.image_url), [cardItems]);
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

  // Warm the cache for every image in this gallery up front, so a swipe or
  // grid tap never has to wait on a network fetch mid-transition.
  useEffect(() => {
    const uris = heroItems.map((i) => i.image_url!);
    if (uris.length) Image.prefetch(uris).catch(() => {});
  }, [heroItems]);

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

    const targetUri = heroItems[targetIndex].image_url!;
    setHeroPendingIndex(targetIndex);
    heroOverlayOpacity.value = 0;
    Image.prefetch(targetUri)
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
  // useItems, not a capped preview) — no new query per keystroke. A group
  // matches if its player name matches, or any card inside it does (team,
  // title, brand — see hooks/use-collection.ts's itemMatchesSearch).
  const filteredGroups = useMemo(() => {
    const q = search.trim();
    if (!q) return groups;
    const qLower = q.toLowerCase();
    return groups.filter(
      (group) => group.label.toLowerCase().includes(qLower) || group.items.some((item) => itemMatchesSearch(item, q)),
    );
  }, [groups, search]);

  const filteredCardItems = useMemo(() => {
    const q = search.trim();
    if (!q) return cardItems;
    return cardItems.filter((item) => itemMatchesSearch(item, q));
  }, [cardItems, search]);

  // No ghost padding while a search is active — placeholders represent
  // "grow your real collection here," not a layout for search results.
  const cardSlots = useMemo(() => {
    if (search.trim()) return toRealSlots(filteredCardItems);
    return padToMinimumGrid(filteredCardItems, `item-placeholder-${folderId}`, CARD_NUM_COLUMNS);
  }, [filteredCardItems, search, folderId]);

  const groupSlots = useMemo(() => {
    if (search.trim()) return toRealSlots(filteredGroups);
    return padToMinimumGrid(filteredGroups, `folder-placeholder-${folderId}`, NUM_COLUMNS);
  }, [filteredGroups, search, folderId]);

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
    const heroIdx = heroItems.findIndex((i) => i.id === item.id);
    if (heroIdx !== -1) goToHeroIndex(heroIdx);
    router.push({ pathname: '/item/[id]', params: { id: item.id } });
  }

  function openGroup(group: PlayerGroup) {
    router.push({
      pathname: '/collection/[folderId]',
      params: { folderId: folderId ?? '', title: folderTitle, player: group.key },
    });
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

  // Same share text/deep-link pattern as the legacy app/folder/[id].tsx
  // screen this was migrated from, pointed at the canonical route.
  async function handleShare() {
    if (!folder) return;
    const handle = isOwner
      ? (session?.user?.email?.split('@')[0] ?? 'me')
      : (ownerProfile?.username ?? 'user');
    try {
      await Share.share({
        title: folder.name,
        message: `Check out "${folder.name}" by @${handle} on The Collection Room\nthecollectionroom://collection/${folderId}`,
      });
    } catch {
      // user dismissed share sheet — no-op
    }
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
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
            </Pressable>
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
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
            </Pressable>
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
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
            </Pressable>
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

  const showBookmark = !!currentUserId;

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
              <Pressable
                onPress={() => router.back()}
                hitSlop={12}
                style={styles.heroBackCircleBtn}
                accessibilityRole="button"
                accessibilityLabel="Back">
                <IconSymbol name="chevron.left" size={20} color="#fff" />
              </Pressable>

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
                          cover-fit trims the excess from the bottom instead. */}
                      <Image
                        source={{ uri: activeHeroItem.image_url! }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        contentPosition={HERO_IMAGE_CONTENT_POSITION}
                      />
                      {/* Overlay — present only mid-transition, crossfades
                          the incoming image on top of the base layer. Once
                          fully opaque, heroIndex commits to match and this
                          layer unmounts with no visible change. Same
                          contentPosition as the base layer so nothing jumps
                          vertically during the crossfade. */}
                      {pendingHeroItem && (
                        <AnimatedExpoImage
                          source={{ uri: pendingHeroItem.image_url! }}
                          style={[StyleSheet.absoluteFill, heroOverlayStyle]}
                          contentFit="cover"
                          contentPosition={HERO_IMAGE_CONTENT_POSITION}
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

            <View style={styles.galleryActionsRow}>
              <View style={styles.galleryActionsSide}>
                <Pressable onPress={toggleFolderLike} disabled={folderLikeInFlight} hitSlop={10} style={styles.likeBtn}>
                  <IconSymbol
                    name={liked ? 'heart.fill' : 'heart'}
                    size={20}
                    color={liked ? PV2.accent : PV2.textPrimary}
                  />
                  <Text style={[styles.likeCount, liked && styles.likeCountActive]}>{likeCount}</Text>
                </Pressable>
                <Pressable onPress={() => setGalleryCommentsVisible(true)} hitSlop={10} style={styles.iconBtn}>
                  <IconSymbol name="message" size={20} color={PV2.textPrimary} />
                </Pressable>
              </View>

              <View style={styles.galleryActionsSide}>
                {/* Not wired yet — layout placeholder. */}
                <Pressable hitSlop={10} style={styles.iconBtn}>
                  <IconSymbol name="magnifyingglass" size={20} color={PV2.textPrimary} />
                </Pressable>
                {showBookmark && (
                  <Pressable onPress={toggleSave} disabled={savingBookmark} hitSlop={10} style={styles.iconBtn}>
                    <IconSymbol
                      name={isSaved ? 'bookmark.fill' : 'bookmark'}
                      size={20}
                      color={isSaved ? PV2.accent : PV2.textPrimary}
                    />
                  </Pressable>
                )}
                <Pressable onPress={handleShare} hitSlop={10} style={styles.iconBtn}>
                  <IconSymbol name="square.and.arrow.up" size={20} color={PV2.textPrimary} />
                </Pressable>
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={[styles.headerTop, { paddingTop: insets.top + 10 }]}>
              <Pressable
                onPress={() => router.back()}
                hitSlop={12}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel="Back">
                <IconSymbol name="chevron.left" size={26} color={PV2.textPrimary} />
              </Pressable>

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

            {!showInitialLoading && items.length > 0 && (
              <CollectionSearchBar
                value={search}
                onChange={setSearch}
                placeholder="Search players, teams..."
                style={styles.searchBar}
              />
            )}

            {/* Compact identity row — non-owner viewing someone else's
                folder only (public profiles, Saved). Sits above the title
                row now, per the reorganized header order; a single
                content-sized press target (not the full row width) opens
                that user's profile. */}
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
              <View style={styles.titleTextArea}>
                <Text style={styles.title} numberOfLines={1}>
                  {screenTitle}
                </Text>

                <View style={styles.titleInlineActions}>
                  <Pressable onPress={toggleFolderLike} disabled={folderLikeInFlight} hitSlop={10} style={styles.likeBtn}>
                    <IconSymbol
                      name={liked ? 'heart.fill' : 'heart'}
                      size={20}
                      color={liked ? PV2.accent : PV2.textPrimary}
                    />
                    <Text style={[styles.likeCount, liked && styles.likeCountActive]}>{likeCount}</Text>
                  </Pressable>
                  <Pressable onPress={() => setCommentsVisible(true)} hitSlop={10} style={styles.iconBtn}>
                    <IconSymbol name="message" size={20} color={PV2.textPrimary} />
                  </Pressable>
                </View>
              </View>

              <View style={styles.titleActions}>
                {showBookmark && (
                  <Pressable onPress={toggleSave} disabled={savingBookmark} hitSlop={10} style={styles.iconBtn}>
                    <IconSymbol
                      name={isSaved ? 'bookmark.fill' : 'bookmark'}
                      size={20}
                      color={isSaved ? PV2.accent : PV2.textPrimary}
                    />
                  </Pressable>
                )}
                <Pressable onPress={handleShare} hitSlop={10} style={styles.iconBtn}>
                  <IconSymbol name="square.and.arrow.up" size={20} color={PV2.textPrimary} />
                </Pressable>
              </View>
            </View>
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
          <>
            {itemsErrorBanner}
            <FlatList
            data={cardSlots}
            numColumns={CARD_NUM_COLUMNS}
            keyExtractor={(slot) => (slot.kind === 'real' ? slot.data.id : slot.key)}
            columnWrapperStyle={styles.row}
            contentContainerStyle={[styles.gridContent, styles.cardGridContent]}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
            renderItem={({ item: slot }) =>
              slot.kind === 'placeholder' ? (
                <CacheCasePlaceholderShell
                  width={cardThumbWidth}
                  aspectRatio={PREVIEW_CARD_ASPECT_RATIO}
                  borderRadius={PREVIEW_CARD_RADIUS}
                  accessibilityLabel="Empty card slot"
                />
              ) : (
                <Pressable
                  testID={`collection-item-${slot.data.id}`}
                  style={[styles.thumb, { width: cardThumbWidth, aspectRatio: PREVIEW_CARD_ASPECT_RATIO }]}
                  onPress={() => openItem(slot.data)}>
                  {slot.data.image_url ? (
                    <Image
                      source={{ uri: slot.data.image_url }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      transition={150}
                    />
                  ) : (
                    <View style={styles.thumbPlaceholder} />
                  )}
                </Pressable>
              )
            }
            ListEmptyComponent={
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
              )
            }
            />
          </>
        ) : (
          <>
            {itemsErrorBanner}
            <FlatList
            data={groupSlots}
            numColumns={NUM_COLUMNS}
            keyExtractor={(slot) => (slot.kind === 'real' ? slot.data.key : slot.key)}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.gridContent}
            onScroll={navbarOnScroll}
            scrollEventThrottle={scrollEventThrottle}
            renderItem={({ item: slot }) => {
              if (slot.kind === 'placeholder') {
                return (
                  <CacheCasePlaceholderShell
                    width={thumbWidth}
                    aspectRatio={PREVIEW_CARD_ASPECT_RATIO}
                    borderRadius={PREVIEW_CARD_RADIUS}
                    accessibilityLabel="Empty folder slot"
                  />
                );
              }
              const group = slot.data;
              const cover = group.items.find((i) => i.image_url)?.image_url ?? null;
              return (
                <CollectionPreviewCard
                  testID={`collection-group-${group.key}`}
                  imageUrl={cover}
                  title={group.label}
                  subtitle={`${group.items.length} ${group.items.length === 1 ? 'card' : 'cards'}`}
                  tileWidth={thumbWidth}
                  onPress={() => openGroup(group)}
                />
              );
            }}
            ListEmptyComponent={
              search.trim() && groups.length > 0 ? (
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
              )
            }
            />
          </>
        )}
      </SafeAreaView>

      {isOwner && (
        <FolderEditModal
          visible={editVisible}
          folder={folder}
          currentUserId={currentUserId}
          onClose={() => setEditVisible(false)}
          onSaved={(updated) => setFolder(updated)}
          onDeleted={() => router.back()}
        />
      )}

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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 4,
    // Bottom padding contributes to the title-row-to-grid gap alongside
    // the grid's own top padding — together landing in the requested
    // 18-24px range.
    paddingBottom: 10,
    gap: 8,
  },
  titleTextArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  titleInlineActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
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
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: PV2.textPrimary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    flexShrink: 1,
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
  // Back button in card-mode's headerTop — same circular treatment the old
  // floating-over-the-image button used, just inline in the row now.
  heroBackCircleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Like/comment on the left, search/bookmark/share on the right — layout
  // only for now, see chat for which of these still need real handlers.
  galleryActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
  },
  galleryActionsSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  searchBar: {
    marginHorizontal: 12,
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
    paddingTop: 10,
    paddingBottom: 24,
    flexGrow: 1,
  },
  // Card mode only — pulls the grid up closer to the hero header below it.
  cardGridContent: {
    paddingTop: 3,
  },
  // Same look as CollectionPreviewCard's own tile (bordered dark panel,
  // rounded corners) so individual-card thumbnails match the Collection
  // page's photo style exactly, not a separate flatter treatment.
  thumb: {
    borderRadius: PREVIEW_CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  thumbPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: PV2.collectorPanelBg,
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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type AlertButton,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PostgrestError } from '@supabase/supabase-js';

import { fetchUserPosts, type FeedPost } from '@/components/feed/post-card';
import { TransactionsList } from '@/components/transactions/transactions-list';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  getHeroCanvasPickerThemes,
  HERO_CANVAS_THEMES,
  resolveHeroCanvasTheme,
  type HeroCanvasThemeId,
} from '@/components/profile/hero-canvas-themes';
import { useAllItems, useFolders } from '@/hooks/use-collection';
import {
  expectedRefIdForSlot,
  removeGrailSlot,
  useGrailSlots,
  type ExpectedGrailSlot,
} from '@/hooks/use-grail-slots';
import { useProfile } from '@/hooks/use-profile';
import { useSavedGrails } from '@/hooks/use-saved';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { deletePost } from '@/lib/posts';
import {
  deleteProfileImage,
  uploadAvatar,
  uploadHeroImage,
  type ProfileImageKind,
} from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, Folder, GrailChooserTarget, Profile } from '@/types';

import { GrailSlotChooser } from './grail-slot-chooser';
import { ProfileV2Collections } from './profile-v2-collections';
import { ProfileV2ExpandedDetails } from './profile-v2-expanded-details';
import { ProfileV2Grid } from './profile-v2-grid';
import { ProfileV2HeroCanvas } from './profile-v2-hero-canvas';
import { ProfileV2Identity } from './profile-v2-identity';
import { ProfileV2IdentityCard } from './profile-v2-identity-card';
import { ProfileV2ItemsGrid } from './profile-v2-items-grid';
import { ProfileV2Posts } from './profile-v2-posts';
import { ProfileV2SectionPage } from './profile-v2-section-page';
import { ProfileV2Stats } from './profile-v2-stats';
import { ProfileV2TabRow, type ProfileV2Section } from './profile-v2-tab-row';
import { ProfileV2TagEditor, TAG_EDITOR_MAX_ITEMS, TAG_EDITOR_MAX_ITEM_LENGTH } from './profile-v2-tag-editor';
import { ProfileV2Tagged } from './profile-v2-tagged';
import { PV2 } from './profile-v2-theme';

const TAGLINE_MAX_LENGTH = 80;
const LOCATION_MAX_LENGTH = 80;

// TEMP (Profile V3 cleanup pass) — the owner-only Settings cog and Saved
// bookmark shortcut are hidden from the rendered UI while these controls
// wait on a new home elsewhere in the redesigned layout. Nothing behind
// them (routes, handlers, the icons' own JSX) was removed — flip this back
// to true to restore them exactly as they were. Deliberately does not
// affect the public-viewer branch of the same row (Back + the Grails
// bookmark toggle), which isn't part of this pass.
const SHOW_OWNER_SETTINGS_AND_SAVED_ICONS = false;

// The one place the "tab row → tab content" gap is defined — matches the
// Grails→tab-row gap (ProfileV2HeroCanvas's gridStage paddingBottom 16 +
// ProfileV2TabRow's own row marginTop 10 = 26) so the tab row reads as a
// symmetric divider, gap-for-gap, between the shared showcase above it and
// whichever tab's content is below it. Both sides were brought in together
// from an initial, too-large 42/42 pass — still one shared, deliberately
// small value, not two independently-tuned numbers. Previously this same
// conceptual gap was split across tabRowInner's paddingBottom and
// tabBodyWrap's marginTop, AND each tab body (ProfileV2Posts/
// ProfileV2Collections/ProfileV2ItemsGrid) added its own additional top
// margin on top of that — three different totals for three tabs.
// Posts/Collection/Items/Tagged must all rely on this single value alone
// for their starting offset; none of them should carry their own separate
// top margin/padding before their first element.
const TAB_CONTENT_TOP_GAP = 26;

// Deliberately does NOT use `new URL(...)` as the validator. React
// Native's actual global URL (node_modules/react-native/Libraries/Blob/URL.js,
// registered by Libraries/Core/setUpXHR.js) is a small regex-based shim,
// not a spec-compliant WHATWG implementation — its constructor never
// throws for malformed input when called without a `base` argument, so a
// try/catch-around-`new URL()` pattern is silently dead code on the actual
// app runtime (the same issue was found and fixed the same way in
// profile-v2-identity.tsx's getSafeWebsiteUrl). These two plain, fully
// anchored regexes replace it — deterministic, and their behavior is
// identical between Node (where they're easy to test) and Hermes (where
// the app actually runs), since both are just standard ECMAScript regex.
//
// WEBSITE_SCHEME_PATTERN detects whether input already has a real scheme.
// It requires "://" specifically (not just any "letters-then-colon"
// prefix) — matching only "letters-then-colon" would misclassify a bare
// "hostname:port" value like "example.com:8080" as if "example.com" were
// a custom URI scheme, which is exactly the bug an earlier version of
// this function had.
//
// WEBSITE_URL_PATTERN validates the final candidate end-to-end: required
// http/https scheme, then a host made of one-or-more characters that are
// never whitespace/"/"/":"/"?"/"#" (so "javascript:alert(1)",
// "not a valid url", and "https:// example.com" all fail here — an empty
// or space-containing or colon-containing "host" can't match), an
// optional :port (digits only), and optional /path, ?query, #hash. This
// is deliberately not full RFC 3986 URL validation — just enough
// structure to accept the shapes this field needs to accept and reject
// the ones it needs to reject.
const WEBSITE_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const WEBSITE_URL_PATTERN = /^https?:\/\/[^\s/:?#]+(:\d+)?(\/[^\s?#]*)?(\?[^\s#]*)?(#\S*)?$/i;

type WebsiteNormalizeResult = { ok: true; value: string | null } | { ok: false; message: string };

function normalizeWebsiteInput(raw: string): WebsiteNormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };

  const hasScheme = WEBSITE_SCHEME_PATTERN.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  // A real (non-http/https) scheme was present before any https://
  // prepending happened — reject with the specific "wrong protocol"
  // message (ftp://, file://, etc.).
  if (hasScheme && !/^https?:\/\//i.test(candidate)) {
    return {
      ok: false,
      message: "Website must use http or https — links like javascript: or data: aren't allowed.",
    };
  }

  // Structural check — catches everything else: empty host ("https://"),
  // whitespace in the host ("https:// example.com", "not a valid url"
  // once https:// is prepended), a missing/garbled scheme ("://example.com"),
  // and any candidate that isn't cleanly scheme+host(+port)(+path)(+query)(+hash).
  if (!WEBSITE_URL_PATTERN.test(candidate)) {
    return {
      ok: false,
      message: 'Website must be a valid URL, like cachecase.app or https://cachecase.app.',
    };
  }

  // Stores the trimmed/scheme-prepended candidate itself, not a
  // re-serialized/re-cased version — only trim + conditional https://
  // prepending are the requested normalizations, nothing more.
  return { ok: true, value: candidate };
}

type ArraySection = {
  label: string;
  values: string[];
};

// Defensive re-validation of the four array fields at save time — the
// ProfileV2TagEditor already enforces these same limits at the point of
// entry (add is refused with its own Alert before it ever reaches state),
// so this should never actually trip in normal use. It exists as a second
// layer for the same reason RPCs in this codebase re-verify things the UI
// already gates.
function findArraySectionIssue(sections: ArraySection[]): string | null {
  for (const section of sections) {
    if (section.values.length > TAG_EDITOR_MAX_ITEMS) {
      return `${section.label} can have up to ${TAG_EDITOR_MAX_ITEMS} values.`;
    }
    for (const value of section.values) {
      if (value.length > TAG_EDITOR_MAX_ITEM_LENGTH) {
        return `${section.label} values must be ${TAG_EDITOR_MAX_ITEM_LENGTH} characters or fewer.`;
      }
    }
    const seen = new Set<string>();
    for (const value of section.values) {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return `${section.label} can't contain duplicate values.`;
      }
      seen.add(key);
    }
  }
  return null;
}

// Content-and-order comparison for the four preference arrays' dirty-state
// check — deliberately a plain index walk, never .sort()/.join() on either
// input (which would mutate a persisted array reference in place if it
// were ever called with one directly) and never a reference-identity (===)
// check on the arrays themselves, since a freshly-fetched `profile` after
// a mid-edit refresh() is a new array instance even when its contents are
// unchanged.
function arraysEqualOrdered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The exact set of columns handleSave's profiles.update() writes. Used for
// BOTH the update payload and the response-loss reconciliation read below,
// so there is only ever one definition of "the intended state" to drift
// out of sync.
type IntendedProfileFields = Pick<
  Profile,
  | 'hero_display_name'
  | 'display_name'
  | 'bio'
  | 'tagline'
  | 'location'
  | 'website'
  | 'favorite_sports'
  | 'favorite_teams'
  | 'collecting_categories'
  | 'collector_tags'
  | 'avatar_url'
  | 'hero_image_url'
  | 'hero_theme'
>;

// True only if the row currently holds EXACTLY the state this save attempt
// intended to write, across every column the UPDATE touched — not just the
// image URLs. A text-only or remove-to-already-null edit gives the image
// columns zero signal on their own, so partial (image-only) comparison
// would misclassify most non-image saves; comparing the full payload is
// what actually proves commit vs. non-commit.
function intendedProfileMatchesRow(intended: IntendedProfileFields, row: IntendedProfileFields): boolean {
  return (
    intended.hero_display_name === row.hero_display_name &&
    intended.display_name === row.display_name &&
    intended.bio === row.bio &&
    intended.tagline === row.tagline &&
    intended.location === row.location &&
    intended.website === row.website &&
    intended.avatar_url === row.avatar_url &&
    intended.hero_image_url === row.hero_image_url &&
    intended.hero_theme === row.hero_theme &&
    arraysEqualOrdered(intended.favorite_sports, row.favorite_sports) &&
    arraysEqualOrdered(intended.favorite_teams, row.favorite_teams) &&
    arraysEqualOrdered(intended.collecting_categories, row.collecting_categories) &&
    arraysEqualOrdered(intended.collector_tags, row.collector_tags)
  );
}

// notifications_follow_unique is a live, undocumented-in-migrations partial
// unique index on (user_id, actor_id) WHERE type = 'follow' — one row ever
// per (recipient, follower) pair, not one row per follow event, so a
// re-follow after an earlier unfollow needs the existing row refreshed
// (fresh created_at, read reset to false), not a second insert.
//
// A prior client-side attempt did this as insert-then-on-23505-delete-then-
// reinsert, but that can't work under RLS: the actor's own session can
// never SELECT the recipient's notification row (notifications_select_own
// is USING (user_id = auth.uid())), so PostgREST's row-visibility-gated
// DELETE silently affects zero rows and the replacement insert hits the
// same 23505 again. The refresh has to happen server-side, where it isn't
// constrained by the actor's own SELECT visibility — see
// create_or_refresh_follow_notification in supabase/migrations/
// 20260822120000_create_or_refresh_follow_notification_rpc.sql. That
// function is SECURITY DEFINER, derives the actor exclusively from its own
// internal auth.uid() (never a client-supplied id), and only ever writes
// the one row shaped (user_id = followedUserId, actor_id = caller, type =
// 'follow') — no broader RLS or index change involved.
async function createFollowNotification(followedUserId: string): Promise<void> {
  const { error } = await supabase.rpc('create_or_refresh_follow_notification', {
    p_followed_user_id: followedUserId,
  });
  if (error) {
    console.error('[createFollowNotification] RPC failed:', error.message);
  }
}

type Props = {
  // The profile being VIEWED — the signed-in user's own id when opened
  // from app/(tabs)/profile.tsx, or another user's resolved id when
  // opened from app/user/[username].tsx. Every data hook below is keyed
  // off this, never off the viewer's session directly.
  userId: string;
};

// The single shared profile screen — same visuals/structure whether it's
// your own profile (app/(tabs)/profile.tsx) or someone else's
// (app/user/[username].tsx resolves their username to a userId and
// renders this directly). isOwnProfile is derived here, not passed in,
// so it can never disagree with the actual signed-in session.
export function ProfileV2Screen({ userId }: Props) {
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const isOwnProfile = currentUserId === userId;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, stats, loading, refresh, adjustFollowerCount } = useProfile(userId);
  const {
    slots: grailSlots,
    loading: grailSlotsLoading,
    error: grailSlotsError,
    refresh: refreshGrailSlots,
  } = useGrailSlots(userId);
  // Explicit chooser intent, not a bare slotIndex — an 'add' can never
  // silently become a 'replace' (or vice versa) if the target slot's
  // occupancy changes while the chooser/picker is open. expectedSlotId/
  // expectedEntryType/expectedRefId (replace only) are re-verified by
  // replaceGrailSlot in one conditional UPDATE immediately before it
  // writes — this state just carries what was true when Replace was
  // chosen.
  const [grailChooserTarget, setGrailChooserTarget] = useState<GrailChooserTarget | null>(null);
  // Bookmarking a whole Grails showcase, not any single item — the same
  // saved_grails-backed hook already used by app/grails/[userId].tsx
  // (a route with no live entry point from normal browsing; this profile
  // screen is what a non-owner viewer actually lands on). null ownerId for
  // isOwnProfile mirrors that screen's own !isOwnGrails gate, so an owner
  // never gets a control to save their own showcase.
  const { isSaved: isGrailsSaved, saving: savingGrails, toggle: toggleGrailsSave } = useSavedGrails(
    !isOwnProfile ? userId : null,
    currentUserId,
  );
  // Someone else's private folders never load client-side at all — not
  // just hidden in the UI, per hooks/use-collection.ts's publicOnly.
  const { folders, previewEntries, refresh: refreshFolders } = useFolders(userId, {
    publicOnly: !isOwnProfile,
  });
  // Profile V3's Items tab — flat, all-folders view of this profile's own
  // items (see ProfileV2ItemsGrid below). Same publicOnly convention as
  // useFolders just above, so a visitor never loads a private item
  // client-side either.
  const {
    items: allItems,
    loading: allItemsLoading,
    refresh: refreshAllItems,
  } = useAllItems(userId, {
    publicOnly: !isOwnProfile,
  });
  const { onScroll: navbarOnScroll, scrollEventThrottle } = useScrollResponsiveNavbar();

  // This profile's post history for the "posts" section — chronological
  // (posts.created_at DESC), scoped to the profile being viewed
  // (`userId`), not the viewer. currentUserId is passed separately only
  // for like-state/ownership within each post — see fetchUserPosts.
  const [profilePosts, setProfilePosts] = useState<FeedPost[]>([]);
  // Distinct from "profilePosts.length === 0" — fetchUserPosts now throws
  // on a genuine query failure (it used to silently swallow it), which
  // must never be presented identically to "this user has no posts."
  const [profilePostsError, setProfilePostsError] = useState<string | null>(null);
  // An in-flight fetchUserPosts request left running past the point this
  // screen loses focus (tab switch) or userId/currentUserId changes can
  // have its underlying XHR connection torn down by the native networking
  // layer and crash with whatwg-fetch's status-0 RangeError — see
  // hooks/use-profile.ts for the full mechanism writeup. Aborted in the
  // useFocusEffect cleanup below.
  const postsControllerRef = useRef<AbortController | null>(null);
  const refreshPosts = useCallback(async () => {
    postsControllerRef.current?.abort();
    const controller = new AbortController();
    postsControllerRef.current = controller;

    setProfilePostsError(null);
    try {
      const nextPosts = await fetchUserPosts(userId, controller.signal, currentUserId);
      if (postsControllerRef.current !== controller || controller.signal.aborted) return;
      setProfilePosts(nextPosts);
    } catch (e) {
      if (controller.signal.aborted || postsControllerRef.current !== controller) return;
      console.error('[refreshPosts] failed:', e);
      setProfilePostsError(e instanceof Error ? e.message : 'Failed to load posts.');
      // Preserve any posts already loaded rather than clearing them.
    } finally {
      if (postsControllerRef.current === controller) {
        postsControllerRef.current = null;
      }
    }
  }, [userId, currentUserId]);

  // Profile V3 shell: the new ProfileV2TabRow's four pills are posts/
  // collections/items/tagged — 'cachecase' (the old default) has no pill in
  // that row anymore, so 'posts' is now the default/first-selected tab.
  const [section, setSection] = useState<ProfileV2Section>('posts');
  // Measured once off the posts section's real rendered height (see
  // ProfileV2SectionPage below) — posts is now both the default tab and the
  // tallest reachable one, so this captures a real dimension rather than a
  // hardcoded guess, with no visible flash since it's measured before the
  // user can switch to a shorter section.
  const [sectionMinHeight, setSectionMinHeight] = useState<number | undefined>(undefined);

  // ProfileV2IdentityCard's expandable details panel (ProfileV2ExpandedDetails,
  // rendered directly beneath it) — a plain, ephemeral, per-screen-instance
  // toggle. Not persisted: collapses again on next visit, same as any other
  // "revealed" UI state (e.g. `editMode` below) in this screen. Forced back
  // to false on entering edit mode (see enterEdit) — while editing, the
  // canvas's own Cancel/Save row is the profile's one active control
  // surface, so a stale expanded Edit Profile/Follow/Message row underneath
  // it would be confusing and, for the owner's "Edit Profile" button
  // specifically, an active footgun (tapping it would re-run enterEdit and
  // silently discard any in-progress unsaved edit).
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({
    heroName: '',
    displayName: '',
    bio: '',
    tagline: '',
    location: '',
    website: '',
  });
  // Profile 2.0 collector-preference arrays — local draft only, exactly
  // like editForm above; never written to `profile` until a successful
  // Save, and re-initialized from the persisted profile every time edit
  // mode is (re-)entered.
  const [favoriteSports, setFavoriteSports] = useState<string[]>([]);
  const [favoriteTeams, setFavoriteTeams] = useState<string[]>([]);
  const [collectingCategories, setCollectingCategories] = useState<string[]>([]);
  const [collectorTags, setCollectorTags] = useState<string[]>([]);
  const [newAvatarUri, setNewAvatarUri] = useState<string | null>(null);
  // Explicit removal, distinct from "no new avatar selected" (newAvatarUri
  // stays null in both cases) — same three-state model already used for
  // banner below (newXUri = replacement picked, removeX = explicit
  // removal, neither set = unchanged).
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [newHeroUri, setNewHeroUri] = useState<string | null>(null);
  const [removeHero, setRemoveHero] = useState(false);
  // Placeholder only — always overwritten by enterEdit's own
  // setSelectedTheme(resolveHeroCanvasTheme(profile?.hero_theme)) before
  // edit mode is ever reachable/visible (owner-only, profile already
  // loaded by then), so this literal value never actually shows to a
  // user. Kept in sync with DEFAULT_HERO_CANVAS_THEME for consistency,
  // not because it's functionally reachable.
  const [selectedTheme, setSelectedTheme] = useState<HeroCanvasThemeId>('base');
  const [saving, setSaving] = useState(false);
  // Synchronous re-entry lock for handleSave — `saving` (React state) only
  // reflects the UI's loading indicator and updates asynchronously, so two
  // fast taps can both fire handleSave() before disabled={saving} visually
  // updates. This ref is set the instant handleSave starts, before any
  // await, so a second call in the same tick is rejected immediately.
  const savingRef = useRef(false);

  // Follow/message state — only ever meaningful (and only ever loaded)
  // when viewing someone else's profile.
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refresh();
      refreshGrailSlots();
      refreshFolders();
      refreshAllItems();
      refreshPosts();
      return () => {
        // Only cancels the fetchUserPosts batch owned by postsControllerRef
        // — refresh/refreshGrailSlots/refreshFolders/refreshAllItems own
        // their own cancellation internally (see their respective hooks)
        // and are deliberately left untouched here.
        postsControllerRef.current?.abort();
      };
    }, [refresh, refreshGrailSlots, refreshFolders, refreshAllItems, refreshPosts]),
  );

  useFocusEffect(
    useCallback(() => {
      if (isOwnProfile || !currentUserId) return;
      supabase
        .from('follows')
        .select('follower_id')
        .eq('follower_id', currentUserId)
        .eq('following_id', userId)
        .maybeSingle()
        .then(({ data }) => setIsFollowing(!!data));
    }, [isOwnProfile, currentUserId, userId]),
  );

  async function toggleFollow() {
    if (!currentUserId || !userId || isOwnProfile || followLoading) return;
    setFollowLoading(true);
    try {
      if (isFollowing) {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', currentUserId)
          .eq('following_id', userId);
        if (error) {
          console.error('[toggleFollow] unfollow failed:', {
            follower_id: currentUserId,
            following_id: userId,
            code: error.code,
            message: error.message,
          });
          Alert.alert('Error', 'Unable to unfollow this user. Please try again.');
          return;
        }
        setIsFollowing(false);
        adjustFollowerCount(-1);
      } else {
        const { error } = await supabase
          .from('follows')
          .insert({ follower_id: currentUserId, following_id: userId });
        if (error) {
          console.error('[toggleFollow] follow failed:', {
            follower_id: currentUserId,
            following_id: userId,
            code: error.code,
            message: error.message,
          });
          Alert.alert('Error', 'Unable to follow this user. Please try again.');
          return;
        }
        setIsFollowing(true);
        adjustFollowerCount(1);
        // Notification delivery is secondary to the follow mutation above,
        // which has already succeeded — never let a notification failure
        // surface as a failed follow.
        createFollowNotification(userId);
      }
    } finally {
      setFollowLoading(false);
    }
  }

  async function handleMessage() {
    if (!currentUserId || isOwnProfile || msgLoading) return;
    setMsgLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_or_create_conversation', { other_user_id: userId });
      if (error || !data) {
        console.error('[handleMessage] get_or_create_conversation failed:', error?.message);
        Alert.alert('Couldn’t start conversation', 'Please try again.');
        return;
      }
      router.push({
        pathname: '/conversation/[id]',
        params: {
          id: data as string,
          otherUsername: profile?.username ?? '',
          otherDisplayName: profile?.display_name ?? '',
        },
      });
    } catch (e) {
      console.error('[handleMessage] unexpected error:', e);
      Alert.alert('Couldn’t start conversation', 'Please try again.');
    } finally {
      setMsgLoading(false);
    }
  }

  // Expandable profile-details panel (below ProfileV2IdentityCard) — see
  // `detailsExpanded` state below. Share follows the exact same
  // Share.share(...) + deep-link-in-message pattern already used by
  // app/collection/[folderId].tsx's own handleShare, just pointed at this
  // profile's route (app/user/[username].tsx) instead of a folder's.
  async function handleShareProfile() {
    if (!profile) return;
    // Same hero_display_name → display_name → username fallback used for
    // the rest of this screen (see the `displayName` const near the
    // bottom of this component) — recomputed here rather than referenced
    // across the function body's early-return boundaries.
    const shareName = profile.hero_display_name || profile.display_name || profile.username;
    try {
      await Share.share({
        title: shareName,
        message: `Check out @${profile.username} on CacheCase\ncachecase://user/${profile.username}`,
      });
    } catch {
      // user dismissed share sheet — no-op
    }
  }

  // Temporary owner-only entry point for testing the real
  // ownership-transfer management screen (app/transactions/[userId].tsx).
  // Always the AUTHENTICATED user's own id — never the viewed profile's
  // userId, a username, or any other caller-supplied value — matching
  // that screen's own auth guard, which only ever renders real data when
  // the route param equals the signed-in session's id.
  function handleOpenTransfers() {
    if (!isOwnProfile || !currentUserId) return;
    router.push({
      pathname: '/transactions/[userId]',
      params: { userId: currentUserId },
    });
  }

  // Any signed-in viewer can like any visible post here — this is no
  // longer only ever "your own post" now that this screen also renders
  // someone else's profile, so (unlike the old owner-only version) this
  // notifies the post's actual owner when that's someone other than the
  // viewer, matching app/(tabs)/index.tsx's own handleLike.
  async function handleLike(postId: string) {
    if (!currentUserId) return;
    const post = profilePosts.find((p) => p.id === postId);
    if (!post) return;
    const wasLiked = post.liked;

    setProfilePosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, liked: !wasLiked, likeCount: wasLiked ? p.likeCount - 1 : p.likeCount + 1 }
          : p,
      ),
    );

    if (wasLiked) {
      const { error } = await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', postId);
      if (error) {
        console.error('Unlike failed:', error.message);
      } else {
        supabase.from('notifications').delete()
          .eq('actor_id', currentUserId).eq('post_id', postId).eq('type', 'like')
          .then(({ error: e }) => { if (e) console.error('Like notif delete failed:', e.message); });
      }
    } else {
      const { error } = await supabase.from('likes').insert({ user_id: currentUserId, post_id: postId });
      if (error) {
        console.error('Like failed:', error.message);
      } else if (post.user_id !== currentUserId) {
        // Server-verified against the likes row that just committed
        // (create_or_refresh_like_notification RPC), never a direct client
        // insert.
        supabase.rpc('create_or_refresh_like_notification', { p_post_id: postId }).then(({ error: e }) => {
          if (e) console.error('Like notif failed:', e.message);
        });
      }
    }
  }

  // Owner-only (PostCard itself gates the "..." affordance to
  // currentUserId === post.user_id, same as app/(tabs)/index.tsx's own
  // handleDeletePost) — optimistic removal, spliced back into its exact
  // original position if the delete actually fails.
  async function handleDeletePost(postId: string) {
    const index = profilePosts.findIndex((p) => p.id === postId);
    if (index === -1) return;
    const removed = profilePosts[index];

    setProfilePosts((prev) => prev.filter((p) => p.id !== postId));

    const result = await deletePost(postId);
    if (result.status !== 'ok') {
      console.error('[ProfileV2Screen] handleDeletePost failed:', result.reason);
      setProfilePosts((prev) => {
        if (prev.some((p) => p.id === postId)) return prev;
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      Alert.alert('Error', 'Could not delete post. Please try again.');
    }
  }

  // Same destination/params as app/(tabs)/collection.tsx's own
  // openFolder/addItem — the compact preview below must land on the exact
  // same screen as the main Collection page, not a profile-only route.
  // Folder navigation always works, own profile or public; addFolderItem
  // (below) is owner-only.
  function openFolder(folder: Folder) {
    router.push({ pathname: '/collection/[folderId]', params: { folderId: folder.id, title: folder.name } });
  }

  function addFolderItem(folder: Folder) {
    if (!isOwnProfile) return;
    router.push({ pathname: '/item/new', params: { folderId: folder.id, folderName: folder.name } });
  }

  function openGrailAdd(slotIndex: number) {
    if (!isOwnProfile) return;
    setGrailChooserTarget({ mode: 'add', slotIndex });
  }

  // Long-press "Replace" only ever passes a slotIndex (GrailSlotPreview
  // has no reason to hold a full GrailSlot reference) — the currently
  // loaded slot is looked up here, from live grailSlots state, not
  // trusted from whatever GrailSlotPreview last rendered. If it's already
  // gone, or its ref id can't be resolved, refresh and tell the user
  // rather than opening the chooser against a target that's already
  // stale or invalid.
  function openGrailReplace(slotIndex: number) {
    if (!isOwnProfile) return;
    const slot = grailSlots.find((s) => s.slot_index === slotIndex);
    if (!slot) {
      refreshGrailSlots();
      Alert.alert('Try Again', 'That Grail slot changed. Please try again.');
      return;
    }
    const expectedRefId = expectedRefIdForSlot(slot);
    if (!expectedRefId) {
      refreshGrailSlots();
      Alert.alert('Unavailable', 'This Grail slot is no longer valid.');
      return;
    }
    setGrailChooserTarget({
      mode: 'replace',
      slotIndex,
      expectedSlotId: slot.id,
      expectedEntryType: slot.entry_type,
      expectedRefId,
    });
  }

  function closeGrailChooser() {
    setGrailChooserTarget(null);
  }

  function handleGrailItemPress(item: CollectionItem) {
    router.push({ pathname: '/item/[id]', params: { id: item.id } });
  }

  function handleGrailCollectionPress(collection: Folder) {
    router.push({ pathname: '/collection/[folderId]', params: { folderId: collection.id, title: collection.name } });
  }

  // Captures the exact row/source BEFORE the confirmation dialog opens,
  // not just the slotIndex — the confirmation targets a specific row
  // identity, and removeGrailSlot's conditional DELETE re-verifies that
  // same identity still holds at the moment of the actual delete (the
  // dialog can stay open arbitrarily long).
  function handleRemoveGrailSlot(slotIndex: number) {
    if (!isOwnProfile || !currentUserId || currentUserId !== userId) return;

    const slot = grailSlots.find((s) => s.slot_index === slotIndex);
    if (!slot) {
      refreshGrailSlots();
      Alert.alert('Try Again', 'That Grail slot changed. Please try again.');
      return;
    }
    const expectedRefId = expectedRefIdForSlot(slot);
    if (!expectedRefId) {
      refreshGrailSlots();
      Alert.alert('Unavailable', 'This Grail slot is no longer valid.');
      return;
    }
    const expected: ExpectedGrailSlot = {
      slotIndex: slot.slot_index,
      expectedSlotId: slot.id,
      expectedEntryType: slot.entry_type,
      expectedRefId,
    };

    Alert.alert(
      'Remove Grail Slot',
      'This will remove it from your Grails. It will not delete the item or collection itself.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error, conflict } = await removeGrailSlot(currentUserId, expected);
            if (error) {
              console.error('[ProfileV2Screen] removeGrailSlot failed:', error);
              await refreshGrailSlots();
              if (conflict === 'slot_conflict') {
                Alert.alert('Already Changed', 'That Grail slot changed or was already removed.');
              } else {
                Alert.alert('Error', 'Could not remove this Grail slot. Please try again.');
              }
              return;
            }
            await refreshGrailSlots();
          },
        },
      ],
    );
  }

  // Shared by enterEdit (initial open) and cancelEdit (explicit restore) —
  // both must produce identical draft state from the same persisted
  // profile, so Cancel behaves correctly even if a caller relies on it
  // directly rather than on the next enterEdit() re-initializing things.
  function resetTextAndPreferenceDraftsFromProfile() {
    setEditForm({
      heroName: profile?.hero_display_name ?? '',
      displayName: profile?.display_name ?? '',
      bio: profile?.bio ?? '',
      tagline: profile?.tagline ?? '',
      location: profile?.location ?? '',
      website: profile?.website ?? '',
    });
    setFavoriteSports(profile?.favorite_sports ?? []);
    setFavoriteTeams(profile?.favorite_teams ?? []);
    setCollectingCategories(profile?.collecting_categories ?? []);
    setCollectorTags(profile?.collector_tags ?? []);
  }

  function enterEdit() {
    if (!isOwnProfile) return;
    resetTextAndPreferenceDraftsFromProfile();
    setNewAvatarUri(null);
    setRemoveAvatar(false);
    setNewHeroUri(null);
    setRemoveHero(false);
    setSelectedTheme(resolveHeroCanvasTheme(profile?.hero_theme));
    setDetailsExpanded(false);
    setEditMode(true);
  }

  // Every editable field compared against the CURRENTLY persisted profile
  // (not a snapshot captured when edit mode began) — matching
  // resetTextAndPreferenceDraftsFromProfile's own `profile?.field ?? ''`
  // normalization exactly, so a field reads as dirty precisely when it
  // differs from what re-entering edit mode would load. Deliberately does
  // NOT run normalizeWebsiteInput on editForm.website before comparing —
  // a typed change must count as unsaved even if it would normalize to
  // the same saved URL. Compared by value, never by object/array
  // reference, so this stays correct even if `profile` is replaced by a
  // new (but content-identical) object from a mid-edit refresh() — e.g.
  // switching tabs and back on app/(tabs)/profile.tsx, which keeps this
  // screen instance (and editMode) mounted and re-fires the focus effect.
  // The one edge case this doesn't attempt to solve: if the PERSISTED
  // profile genuinely changes mid-edit (a concurrent edit from another
  // session), dirty-state reflects the draft against that new persisted
  // truth, not against what the user originally saw — judged the more
  // correct behavior for "discard" to mean "discard relative to what's
  // actually saved now," not a stale snapshot.
  const hasUnsavedProfileChanges =
    editMode &&
    (editForm.displayName !== (profile?.display_name ?? '') ||
      editForm.heroName !== (profile?.hero_display_name ?? '') ||
      editForm.tagline !== (profile?.tagline ?? '') ||
      editForm.bio !== (profile?.bio ?? '') ||
      editForm.location !== (profile?.location ?? '') ||
      editForm.website !== (profile?.website ?? '') ||
      !arraysEqualOrdered(favoriteSports, profile?.favorite_sports ?? []) ||
      !arraysEqualOrdered(favoriteTeams, profile?.favorite_teams ?? []) ||
      !arraysEqualOrdered(collectingCategories, profile?.collecting_categories ?? []) ||
      !arraysEqualOrdered(collectorTags, profile?.collector_tags ?? []) ||
      selectedTheme !== resolveHeroCanvasTheme(profile?.hero_theme) ||
      newAvatarUri !== null ||
      removeAvatar ||
      newHeroUri !== null ||
      removeHero);

  // The actual discard — identical to the old unconditional cancelEdit
  // body. No Storage or database operation happens here; it only resets
  // local draft state. Used by cancelEdit below (after confirmation, or
  // immediately when nothing is dirty) and is the only path that ever
  // clears editMode outside of a successful Save.
  function discardEditsAndClose() {
    resetTextAndPreferenceDraftsFromProfile();
    setNewAvatarUri(null);
    setRemoveAvatar(false);
    setNewHeroUri(null);
    setRemoveHero(false);
    setEditMode(false);
  }

  // Wired to both the explicit Cancel button (ProfileV2HeroCanvas's
  // onCancelPress) and the Android hardware-back listener below — same
  // function, same confirmation, same discard path either way. Never
  // shows the prompt while a save is in flight (mirrors the existing
  // Save-button saving guard, which this function didn't previously
  // respect at all).
  function cancelEdit() {
    if (saving) return;
    if (!hasUnsavedProfileChanges) {
      discardEditsAndClose();
      return;
    }
    Alert.alert(
      'Discard changes?',
      'Your unsaved profile changes will be lost.',
      [
        { text: 'Keep Editing', style: 'cancel' },
        { text: 'Discard Changes', style: 'destructive', onPress: discardEditsAndClose },
      ],
    );
  }

  // Always holds the LATEST cancelEdit closure (fresh hasUnsavedProfileChanges/
  // saving/draft values every render) without re-subscribing the listener
  // on every keystroke — the effect below only re-runs when `editMode`
  // itself toggles, not on every render.
  const cancelEditRef = useRef(cancelEdit);
  cancelEditRef.current = cancelEdit;

  // Android hardware back only — this is a no-op on iOS (there is no
  // hardwareBackPress event to fire there). Registered/removed purely by
  // `editMode`, so re-entering edit mode never accumulates duplicate
  // listeners, and it's a true no-op for visitors (editMode can only ever
  // be true when isOwnProfile, since enterEdit() early-returns otherwise).
  // Returning `true` swallows the back press only while actively editing —
  // cancelEdit() itself decides immediate-exit vs. confirm vs. (while
  // saving) do-nothing; returning `false` would let default back
  // navigation proceed underneath the open Alert, which must never happen.
  // Header/back-button and other owner controls were audited and found
  // unreachable during edit mode (see the report accompanying this
  // change) — this listener is the one system-navigation path this
  // screen can safely intercept without a broader navigation refactor;
  // tab-switch and stack swipe-back gestures are not covered here.
  useEffect(() => {
    if (!editMode) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelEditRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [editMode]);

  // Low-level pick-only helpers, shared by both avatar-edit flows below
  // (Edit Profile's stage-then-Save flow, and the direct profile-page tap's
  // stage-and-persist-immediately flow) — the permission request + picker
  // launch is identical either way; only what happens with the resulting
  // uri differs, which is left entirely to each caller.
  async function pickAvatarFromCamera(): Promise<string | null> {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return null;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) return null;
    return result.assets[0].uri;
  }

  async function pickAvatarFromLibrary(): Promise<string | null> {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return null;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) return null;
    return result.assets[0].uri;
  }

  async function launchCamera() {
    const uri = await pickAvatarFromCamera();
    if (uri) {
      setNewAvatarUri(uri);
      setRemoveAvatar(false);
    }
  }

  async function launchLibrary() {
    const uri = await pickAvatarFromLibrary();
    if (uri) {
      setNewAvatarUri(uri);
      setRemoveAvatar(false);
    }
  }

  // Edit Profile's avatar picker — stages the pick into newAvatarUri/
  // removeAvatar only; persistence happens later, only via the explicit
  // Save button (handleSave), exactly as for every other edited field.
  function pickAvatar() {
    const canRemove = !!(profile?.avatar_url || newAvatarUri);
    const options: AlertButton[] = [
      { text: 'Take Photo', onPress: launchCamera },
      { text: 'Choose from Library', onPress: launchLibrary },
    ];
    if (canRemove) {
      options.push({
        text: 'Remove Avatar',
        style: 'destructive',
        onPress: () => {
          setNewAvatarUri(null);
          setRemoveAvatar(true);
        },
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Change Photo', undefined, options);
  }

  // Persists a direct (non-Edit-Profile) avatar change through the exact
  // same canonical handleSave() used by Edit Profile's Save button — see
  // handleSave's own `directAvatar` parameter doc for why an explicit
  // argument (rather than relying on newAvatarUri/removeAvatar state) is
  // required here. newAvatarUri/removeAvatar are still set for an
  // immediate optimistic preview while the upload/update are in flight;
  // handleSave's own success path (finishSuccess) clears them and calls
  // refresh() once the real persisted avatar_url is available, so the
  // preview seamlessly becomes the real thing rather than staying a
  // dangling local file:// uri. On failure, handleSave shows its own
  // existing "Save failed" alert (unchanged) and this reverts the optimistic
  // preview back to the last-persisted avatar — there's no visible Cancel
  // control outside edit mode to let the user discard a failed pick
  // otherwise, unlike handleSave's normal (Edit Profile) failure path,
  // which deliberately leaves the draft in place for the user to retry.
  async function persistDirectAvatarChange(uri: string | null, remove: boolean) {
    setNewAvatarUri(uri);
    setRemoveAvatar(remove);
    const ok = await handleSave({ uri, remove });
    if (!ok) {
      setNewAvatarUri(null);
      setRemoveAvatar(false);
    }
  }

  async function launchCameraDirect() {
    const uri = await pickAvatarFromCamera();
    if (uri) await persistDirectAvatarChange(uri, false);
  }

  async function launchLibraryDirect() {
    const uri = await pickAvatarFromLibrary();
    if (uri) await persistDirectAvatarChange(uri, false);
  }

  // Tapping the avatar directly from the profile page (outside Edit
  // Profile) — same picker options as pickAvatar, but each selection
  // persists immediately via persistDirectAvatarChange instead of staging
  // for a separate Save step, since there's no Save button reachable here.
  function pickAvatarDirect() {
    const canRemove = !!profile?.avatar_url;
    const options: AlertButton[] = [
      { text: 'Take Photo', onPress: launchCameraDirect },
      { text: 'Choose from Library', onPress: launchLibraryDirect },
    ];
    if (canRemove) {
      options.push({
        text: 'Remove Avatar',
        style: 'destructive',
        onPress: () => persistDirectAvatarChange(null, true),
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Change Photo', undefined, options);
  }

  // Single entry point wired to the collector panel's avatar tap target —
  // routes to whichever of the two flows above applies depending on
  // whether Edit Profile is currently open.
  function handleAvatarPress() {
    if (editMode) {
      pickAvatar();
    } else {
      pickAvatarDirect();
    }
  }

  // The one canonical avatar (and every other profile field) persistence
  // path — used directly by Edit Profile's Save button (no args: reads the
  // current editForm/array/theme/avatar draft state exactly as before) AND
  // by persistDirectAvatarChange above (passes `directAvatar` explicitly).
  // An explicit argument, not newAvatarUri/removeAvatar state, is required
  // for the direct-avatar path specifically because React state updates
  // are asynchronous — setNewAvatarUri() immediately followed by a
  // synchronous call into this function would still read the PREVIOUS
  // render's (stale) state, not the just-picked uri. Returns whether the
  // save actually committed, so persistDirectAvatarChange can revert its
  // own optimistic preview on failure; the Save button ignores the return
  // value (onSavePress is typed () => void, which accepts any return type).
  async function handleSave(directAvatar?: { uri: string | null; remove: boolean }): Promise<boolean> {
    if (!isOwnProfile) return false;
    // Synchronous re-entry lock. Acquired here — after isOwnProfile but
    // before any upload/DB work — so two fast taps can't both pass this
    // point in the same tick, unlike disabled={saving}, which only updates
    // once React re-renders. NOT acquired any earlier: the validation
    // checks immediately below return early (bypassing the try/finally
    // that releases it), so acquiring before them would permanently lock
    // out every future save after the first validation failure.
    if (savingRef.current) return false;
    savingRef.current = true;

    // Full validation pass BEFORE setSaving/any upload/any DB write, in the
    // exact order requested: tagline length, website, array counts, array
    // item lengths, array duplicates. Stops at the first failure with one
    // Alert; edit mode stays open, nothing is uploaded or saved. Each early
    // return here happens before the try/finally below, so each one must
    // release savingRef itself rather than relying on the finally. Skipped
    // entirely for a direct-avatar save — it never touches any of these
    // fields (see the intendedProfileFields construction below, which
    // sources them straight from `profile` in that case), so there is
    // nothing here to validate.
    let trimmedTagline = '';
    let normalizedWebsite: string | null = null;
    if (!directAvatar) {
      trimmedTagline = editForm.tagline.trim();
      if (trimmedTagline.length > TAGLINE_MAX_LENGTH) {
        savingRef.current = false;
        Alert.alert('Tagline Too Long', `Tagline must be ${TAGLINE_MAX_LENGTH} characters or fewer.`);
        return false;
      }

      const websiteResult = normalizeWebsiteInput(editForm.website);
      if (!websiteResult.ok) {
        savingRef.current = false;
        Alert.alert('Invalid Website', websiteResult.message);
        return false;
      }
      normalizedWebsite = websiteResult.value;

      const arraySectionIssue = findArraySectionIssue([
        { label: 'Favorite Sports', values: favoriteSports },
        { label: 'Favorite Teams', values: favoriteTeams },
        { label: 'Collecting Categories', values: collectingCategories },
        { label: 'Collector Tags', values: collectorTags },
      ]);
      if (arraySectionIssue) {
        savingRef.current = false;
        Alert.alert('Check Collector Preferences', arraySectionIssue);
        return false;
      }
    }

    // Captured BEFORE any upload/state change below — these are what
    // cleanup compares the final saved URLs against once the row update
    // has actually succeeded. Never mutated after this point.
    const oldAvatarUrl = profile?.avatar_url ?? null;
    const oldHeroUrl = profile?.hero_image_url ?? null;

    setSaving(true);
    try {
      // Storage objects successfully uploaded during THIS invocation only —
      // never old/unchanged URLs, never remove-only fields, never carried
      // over from a prior attempt. An entry is added only immediately after
      // its corresponding upload helper successfully returns. Scoped
      // strictly to the upload phase below: nothing durable has been
      // written to the database yet at any point this array is read, so a
      // later field's failure can always safely best-effort delete every
      // object already uploaded in this same attempt before rethrowing.
      // profiles.update()'s own error handling further down is a
      // deliberately separate, untouched boundary — once that call has
      // been issued, DB commit state can be ambiguous in a way it never is
      // here, and this cleanup must never run for that case.
      const uploadedThisAttempt: { url: string; kind: ProfileImageKind }[] = [];

      // directAvatar (when present) takes over the avatar decision entirely
      // — see handleSave's own doc comment for why this can't just read
      // newAvatarUri/removeAvatar state for that call. Hero stays state-
      // driven unconditionally: newHeroUri/removeHero are only ever
      // non-neutral while editMode is true (enterEdit/discardEditsAndClose/
      // finishSuccess all reset them to null/false the moment it isn't), and
      // a direct-avatar save only ever happens while editMode is false — so
      // this always resolves to the current persisted hero_image_url, a
      // true no-op, for that call.
      let avatarUrl: string | null;
      let heroUrl: string | null;
      try {
        const avatarUriChoice = directAvatar ? directAvatar.uri : newAvatarUri;
        const avatarRemoveChoice = directAvatar ? directAvatar.remove : removeAvatar;
        if (avatarUriChoice) {
          try {
            avatarUrl = await uploadAvatar(avatarUriChoice, userId);
          } catch (uploadErr: unknown) {
            const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
            throw new Error(`Avatar upload failed: ${detail}`);
          }
          uploadedThisAttempt.push({ url: avatarUrl, kind: 'avatar' });
        } else if (avatarRemoveChoice) {
          avatarUrl = null;
        } else {
          avatarUrl = profile?.avatar_url ?? null;
        }

        if (newHeroUri) {
          try {
            heroUrl = await uploadHeroImage(newHeroUri, userId);
          } catch (uploadErr: unknown) {
            const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
            throw new Error(`Banner upload failed: ${detail}`);
          }
          uploadedThisAttempt.push({ url: heroUrl, kind: 'hero' });
        } else if (removeHero) {
          heroUrl = null;
        } else {
          heroUrl = profile?.hero_image_url ?? null;
        }
      } catch (uploadPhaseErr: unknown) {
        // A later field's upload failed after one or more earlier uploads
        // in this same attempt already succeeded — those are now
        // unreferenced by any row (profiles.update() below never ran) and
        // would otherwise linger as permanent orphans. Best-effort only:
        // deleteProfileImage never throws, so this can't mask or replace
        // the original, already-field-labeled upload error being rethrown
        // unchanged right after.
        await Promise.all(
          uploadedThisAttempt.map(({ url, kind }) => deleteProfileImage(url, userId, kind)),
        );
        throw uploadPhaseErr;
      }

      // The one and only definition of "what this attempt intends the row
      // to look like" — fed to BOTH the update call below and the
      // response-loss reconciliation comparison, so there's never a
      // second, independently-maintained copy of this state to drift out
      // of sync with the first. Every field OTHER than avatar_url/
      // hero_image_url is sourced from the current persisted `profile`
      // (not editForm/the preference arrays/selectedTheme) when this is a
      // direct-avatar save — editForm etc. may still hold stale or blank
      // draft values from before Edit Profile was ever opened this
      // session, and a direct-avatar save must never touch any field it
      // isn't actually changing. Echoing the persisted value back is a
      // true no-op for those columns either way.
      const intendedProfileFields: IntendedProfileFields = directAvatar
        ? {
            hero_display_name: profile?.hero_display_name ?? null,
            display_name: profile?.display_name ?? null,
            bio: profile?.bio ?? null,
            tagline: profile?.tagline ?? null,
            location: profile?.location ?? null,
            website: profile?.website ?? null,
            favorite_sports: profile?.favorite_sports ?? [],
            favorite_teams: profile?.favorite_teams ?? [],
            collecting_categories: profile?.collecting_categories ?? [],
            collector_tags: profile?.collector_tags ?? [],
            avatar_url: avatarUrl,
            hero_image_url: heroUrl,
            hero_theme: resolveHeroCanvasTheme(profile?.hero_theme),
          }
        : {
            hero_display_name: editForm.heroName.trim() || null,
            display_name: editForm.displayName.trim() || null,
            bio: editForm.bio.trim() || null,
            tagline: trimmedTagline || null,
            location: editForm.location.trim() || null,
            website: normalizedWebsite,
            favorite_sports: favoriteSports,
            favorite_teams: favoriteTeams,
            collecting_categories: collectingCategories,
            collector_tags: collectorTags,
            avatar_url: avatarUrl,
            hero_image_url: heroUrl,
            hero_theme: selectedTheme,
          };

      // Shared by every branch below that has proven (either directly or
      // via reconciliation) that the row was NOT updated to
      // intendedProfileFields: the OLD images are still exactly what the
      // (unchanged) row points to — never touch those. Any image freshly
      // uploaded THIS attempt, though, is now unreferenced by any row —
      // best-effort clean it up so it doesn't linger as an orphan.
      // deleteProfileImage never throws, so this can't mask or replace the
      // real error thrown right after, and a failure here (e.g. the
      // storage bucket has no delete permission configured yet) simply
      // leaves an orphaned file rather than causing any further problem.
      const cleanupUploadedThisAttempt = () =>
        Promise.all(uploadedThisAttempt.map(({ url, kind }) => deleteProfileImage(url, userId, kind)));

      // Shared by every branch below that has proven (either directly or
      // via reconciliation) that the row now holds intendedProfileFields —
      // only NOW is it safe to clean up whichever old Storage objects are
      // no longer referenced by this profile. Skipped entirely when the
      // URL didn't actually change (unchanged image) or when there was
      // nothing to clean up (no old image). Never deletes the newly
      // uploaded image — only the old one. Best-effort only:
      // deleteProfileImage never throws, so a cleanup failure here can
      // never be mistaken for the save itself failing.
      const finishSuccess = async () => {
        await Promise.all([
          oldAvatarUrl && oldAvatarUrl !== avatarUrl ? deleteProfileImage(oldAvatarUrl, userId, 'avatar') : Promise.resolve(),
          oldHeroUrl && oldHeroUrl !== heroUrl ? deleteProfileImage(oldHeroUrl, userId, 'hero') : Promise.resolve(),
        ]);

        await refresh();
        setNewAvatarUri(null);
        setRemoveAvatar(false);
        setNewHeroUri(null);
        setRemoveHero(false);
        setEditMode(false);
      };

      // Reads the row back and proves, from its ACTUAL current state,
      // whether intendedProfileFields ever committed — used whenever the
      // update call's own outcome can't be trusted (status === 0, a 5xx
      // response, or the call itself threw). UNKNOWN DB STATE => DELETE
      // NOTHING: if the read itself can't produce an authoritative row, no
      // Storage object — new or old — is touched, and the user stays in
      // edit mode with pending changes intact rather than risk deleting
      // something still referenced by a write we can't prove happened.
      const resolveAmbiguousUpdateOutcome = async (): Promise<boolean> => {
        let reconciledRow: IntendedProfileFields | null = null;
        try {
          const { data: reconData, error: reconError } = await supabase
            .from('profiles')
            .select(
              'hero_display_name, display_name, bio, tagline, location, website, favorite_sports, favorite_teams, collecting_categories, collector_tags, avatar_url, hero_image_url, hero_theme'
            )
            .eq('id', userId)
            .maybeSingle();
          reconciledRow = !reconError && reconData ? (reconData as IntendedProfileFields) : null;
        } catch {
          reconciledRow = null;
        }

        if (!reconciledRow) {
          Alert.alert(
            'Save status unknown',
            "We couldn't confirm whether your changes were saved. Check your connection before trying again."
          );
          return false;
        }

        if (intendedProfileMatchesRow(intendedProfileFields, reconciledRow)) {
          // The row currently holds exactly the intended state — the
          // ambiguous update DID commit.
          await finishSuccess();
          return true;
        }

        // The row provably does not hold the intended state — the
        // ambiguous update did NOT commit.
        await cleanupUploadedThisAttempt();
        throw new Error(
          __DEV__
            ? 'Failed to save profile: reconciliation proved the update did not commit'
            : 'Failed to save profile. Please try again.'
        );
      };

      const updateOutcome = await (async (): Promise<
        | { kind: 'resolved'; data: { id: string }[] | null; error: PostgrestError | null; status: number }
        | { kind: 'threw' }
      > => {
        try {
          const { data, error, status } = await supabase
            .from('profiles')
            .update(intendedProfileFields)
            .eq('id', userId)
            .select('id');
          return { kind: 'resolved', data, error, status };
        } catch {
          // The request may already have reached the server before this
          // threw, so its commit state can't be assumed either way —
          // handled identically to an ambiguous resolved response below,
          // never as a definitive failure.
          return { kind: 'threw' };
        }
      })();

      if (updateOutcome.kind === 'resolved') {
        const { data, error, status } = updateOutcome;

        if (!error && data && data.length > 0) {
          // Authoritative success — the row was updated and returned.
          await finishSuccess();
          return true;
        }

        if (!error) {
          // Zero-row "success": the request was processed without error
          // but matched/returned no row. For an authenticated user's own
          // id this should never legitimately happen, so this is treated
          // as definitive proof the row was NOT updated, not as an
          // ambiguous outcome — error is null, so there's nothing
          // non-authoritative about this response.
          if (__DEV__) {
            console.error('[handleSave] Supabase profile update returned zero rows for own id');
          }
          await cleanupUploadedThisAttempt();
          throw new Error(
            __DEV__
              ? 'Failed to save profile: update matched zero rows'
              : 'Failed to save profile. Please try again.'
          );
        }

        if (status >= 400 && status < 500) {
          // Definitive server rejection — an authoritative PostgREST 4xx
          // response means the server processed and explicitly rejected
          // the request. The row is provably unchanged.
          if (__DEV__) {
            console.error('[handleSave] Supabase profile update failed:', {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            });
          }
          await cleanupUploadedThisAttempt();
          throw new Error(
            __DEV__
              ? `Failed to save profile: ${error.message}${error.code ? ` (${error.code})` : ''}`
              : 'Failed to save profile. Please try again.'
          );
        }

        // Genuinely ambiguous/non-authoritative response: status === 0
        // (response lost), a 5xx (infrastructure/server failure — not
        // proof the database itself never committed the write), or any
        // other unexpected status. Falls through to reconciliation below
        // — DELETE NOTHING until that proves which actually happened.
        if (__DEV__) {
          console.error('[handleSave] Supabase profile update response ambiguous, reconciling:', {
            code: error.code,
            message: error.message,
            status,
          });
        }
      } else if (__DEV__) {
        console.error('[handleSave] Supabase profile update threw, reconciling');
      }

      return await resolveAmbiguousUpdateOutcome();
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
      return false;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }

  // The ONLY function ever wired to onSavePress. Deliberately declared
  // with zero parameters — ProfileV2HeroCanvas's Save TouchableOpacity
  // calls onPress={onSavePress}, and React Native always invokes an
  // onPress handler with a GestureResponderEvent argument. handleSave
  // previously WAS onSavePress directly, so that event object was being
  // passed as handleSave's own `directAvatar` parameter: truthy (any
  // object is), so handleSave read `directAvatar.uri`/`directAvatar.remove`
  // off a GestureResponderEvent (both undefined) and silently treated
  // every Edit Profile save as an avatar-untouched, other-fields-untouched
  // no-op — the exact regression this wrapper exists to make structurally
  // impossible. This function takes no parameters, so no matter what
  // TouchableOpacity passes to it, `handleSave()` below is always called
  // with truly zero arguments — directAvatar can only ever be `undefined`
  // here, which is what routes handleSave into reading the staged
  // newAvatarUri/removeAvatar (and editForm/array/selectedTheme) state,
  // exactly as it did before the direct-avatar-save refactor.
  function handleEditProfileSave() {
    return handleSave();
  }

  const avatarUri = removeAvatar ? null : (newAvatarUri ?? profile?.avatar_url ?? null);
  const heroTheme = editMode ? selectedTheme : resolveHeroCanvasTheme(profile?.hero_theme);
  const themeDef = HERO_CANVAS_THEMES.find((t) => t.id === heroTheme);
  const themeFallbackSwatch: [string, string] =
    themeDef?.kind === 'procedural' ? themeDef.swatch : ['#1C1C1E', '#0A0A0C'];

  if (loading && !profile) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      </SafeAreaView>
    );
  }

  const displayName = profile?.hero_display_name || profile?.display_name || profile?.username || '';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          showsVerticalScrollIndicator={false}
          onScroll={navbarOnScroll}
          scrollEventThrottle={scrollEventThrottle}
          stickyHeaderIndices={[1]}>

          {/* index 0 — shared profile showcase: identity card, Grails, and
              the owner/public action row. Grails renders here now — above
              the tab row, identically for every tab — instead of below it
              and hidden specifically for 'items' (the bug this restructure
              fixes). Always a stable top-level ScrollView child (never
              conditionally omitted), so stickyHeaderIndices={[1]} below
              always resolves to the tab row, regardless of
              profile/editMode state. */}
          <View>
            {profile && (
              <ProfileV2IdentityCard
                username={profile.username}
                title={displayName}
                itemCount={stats.itemCount}
                avatarUri={avatarUri}
                profileId={profile.id}
                onAvatarPress={isOwnProfile && !saving ? handleAvatarPress : undefined}
                onPress={!editMode ? () => setDetailsExpanded((v) => !v) : undefined}
                expanded={detailsExpanded}
              />
            )}

            {/* Expandable profile-details panel — opens directly beneath
                ProfileV2IdentityCard when it's tapped, closes on a second
                tap. A plain conditional render (not absolute-positioned),
                so it pushes ProfileV2HeroCanvas/the Grails grid/tab row
                down while open and lets them return to their normal
                position when it collapses — no overlay, no modal, no
                separate route. Animated.View's entering/exiting fade
                (react-native-reanimated, already a dependency elsewhere in
                this app — grail-slot-preview.tsx, premium-empty-card.tsx —
                not a new one added for this) gives the mount/unmount a
                short, smooth transition instead of an abrupt cut. */}
            {profile && detailsExpanded && !editMode && (
              <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)}>
                <ProfileV2ExpandedDetails
                  location={profile.location ?? null}
                  bio={profile.bio ?? null}
                  collectingCategories={profile.collecting_categories ?? []}
                  website={profile.website ?? null}
                  followers={stats.followerCount}
                  following={stats.followingCount}
                  mode={isOwnProfile ? 'owner' : 'public'}
                  onEditPress={isOwnProfile ? enterEdit : undefined}
                  onToggleFollow={isOwnProfile ? undefined : toggleFollow}
                  onMessagePress={isOwnProfile ? undefined : handleMessage}
                  isFollowing={isFollowing}
                  followLoading={followLoading}
                  messageLoading={msgLoading}
                  onSharePress={handleShareProfile}
                  onFollowersPress={() => router.push({ pathname: '/followers/[userId]', params: { userId } })}
                  onFollowingPress={() => router.push({ pathname: '/following/[userId]', params: { userId } })}
                />
              </Animated.View>
            )}

            {/* No longer conditioned on `section` — Grails is shared
                content above every tab now, not a per-section block, so
                the old (editMode || section !== 'items') exclusion is
                gone. Still renders during edit mode too, unchanged: the
                canvas itself owns the Cancel/Save row regardless of which
                tab was active when Edit Profile was opened. */}
            {profile && (
              // Animated.View + layout (not a plain View) purely so this
              // slides smoothly to its new position when the expandable
              // details panel above it mounts/unmounts, instead of
              // snapping straight there — the panel itself still owns the
              // actual expand/collapse (this has no entering/exiting of
              // its own, nothing here renders conditionally).
              <Animated.View style={styles.heroCanvasWrap} layout={LinearTransition.duration(200)}>
                <ProfileV2HeroCanvas
                  heroTheme={heroTheme}
                  themeFallbackSwatch={themeFallbackSwatch}
                  editMode={editMode}
                  saving={saving}
                  onCancelPress={cancelEdit}
                  onSavePress={handleEditProfileSave}>
                  {!editMode && (
                    <ProfileV2Grid
                      slots={grailSlots}
                      loading={grailSlotsLoading}
                      error={grailSlotsError}
                      onRetry={refreshGrailSlots}
                      isOwnProfile={isOwnProfile}
                      onPressEmpty={openGrailAdd}
                      onPressItem={handleGrailItemPress}
                      onPressCollection={handleGrailCollectionPress}
                      onReplace={openGrailReplace}
                      onRemove={handleRemoveGrailSlot}
                    />
                  )}
                </ProfileV2HeroCanvas>
              </Animated.View>
            )}

            {/* Owner/public control row — moved out of ProfileV2HeroCanvas
                so the canvas itself is dimensionally identical for owner
                and public view mode (same gridStage 32/32 padding, no
                action row inside either way). Owner sees Settings/Saved;
                public sees Back/Grails-bookmark. Both branches share styles.ownerActionRow/
                ownerIconBtn (not two independently-maintained style
                objects) so their outer spacing footprint is guaranteed
                identical — identity content begins at the same vertical
                offset below the canvas either way. Same handlers, icons,
                size, hitSlop, and activeOpacity as when Back lived inside
                the canvas. Hidden during edit mode — neither ever coexisted
                with Cancel/Save when it lived inside the canvas either. */}
            {/* isOwnProfile's two controls (Settings, Saved) are gated by
                SHOW_OWNER_SETTINGS_AND_SAVED_ICONS above — false hides them
                without leaving an empty, padded row behind: the whole row
                only has content in the owner case, so skipping the row
                outright (rather than rendering it empty) is what lets
                everything below reclaim that space. The public-viewer case
                (Back + Grails bookmark toggle) is untouched — its half of
                this condition is always true. */}
            {profile && !editMode && (!isOwnProfile || SHOW_OWNER_SETTINGS_AND_SAVED_ICONS) && (
              <View style={styles.ownerActionRow}>
                {isOwnProfile ? (
                  <>
                    <TouchableOpacity
                      onPress={() => router.push('/settings')}
                      hitSlop={10}
                      style={styles.ownerIconBtn}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel="Settings"
                      testID="profile-settings-button">
                      <IconSymbol name="gearshape.fill" size={18} color="#fff" accessible={false} />
                    </TouchableOpacity>
                    {/* Saved screen (app/saved.tsx) — fully built (Saved
                        Collections/Cards/Grails, already on the signed-image
                        architecture) but had no reachable entry point
                        anywhere in the app; this row's own justifyContent:
                        'space-between' plus this doc comment block's
                        "Owner sees Settings/Saved" already assumed a second
                        icon here. */}
                    <TouchableOpacity
                      onPress={() => router.push('/saved')}
                      hitSlop={10}
                      style={styles.ownerIconBtn}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel="Saved"
                      testID="profile-saved-button">
                      <IconSymbol name="bookmark.fill" size={18} color="#fff" accessible={false} />
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity
                      onPress={() => router.back()}
                      hitSlop={10}
                      style={styles.ownerIconBtn}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel="Back">
                      <IconSymbol name="chevron.left" size={18} color="#fff" />
                    </TouchableOpacity>
                    {/* Save/unsave this profile's whole Grails showcase
                        (saved_grails via useSavedGrails above) — the visible
                        control the live QA pass couldn't find, since it was
                        only ever wired into app/grails/[userId].tsx, a route
                        nothing in normal browsing actually navigates to.
                        This profile screen is the real, live surface a
                        non-owner views someone else's Grails on. */}
                    {currentUserId && (
                      <TouchableOpacity
                        onPress={toggleGrailsSave}
                        disabled={savingGrails}
                        hitSlop={10}
                        style={styles.ownerIconBtn}
                        activeOpacity={0.75}
                        accessibilityRole="button"
                        accessibilityLabel={isGrailsSaved ? 'Remove Grails bookmark' : 'Bookmark Grails'}
                        accessibilityState={{ selected: isGrailsSaved, disabled: savingGrails }}
                        testID="profile-grails-bookmark-button">
                        <IconSymbol
                          name={isGrailsSaved ? 'bookmark.fill' : 'bookmark'}
                          size={18}
                          color={isGrailsSaved ? PV2.accent : '#fff'}
                          accessible={false}
                        />
                      </TouchableOpacity>
                    )}
                  </>
                )}
              </View>
            )}
          </View>

          {/* index 1 — sticky tab row. A stable slot (an empty, zero-height
              View, never an omitted one) whenever it has nothing to show —
              edit mode, or before `profile` has loaded — so
              stickyHeaderIndices={[1]} above always pins the tab row
              specifically, not whichever child happens to be second that
              render. Opaque PV2.bg background is required once this pins
              to the top: ProfileV2TabRow's own row has no background
              between/around its pills, so without this, content scrolling
              underneath would show through the gaps once pinned.
              tabRowStickyFilled adds extra opaque space BELOW the pills
              (paddingBottom only — the pills' own position is set by
              ProfileV2TabRow's own marginTop, unaffected by padding added
              after it) so bright scrolling imagery has a solid buffer
              before it reaches the pill borders, without moving the pills
              themselves. Applied only alongside a real ProfileV2TabRow, so
              an empty tabRowSticky (edit mode, or before `profile` loads)
              still collapses to true zero height. */}
          <View style={[styles.tabRowSticky, profile && !editMode && styles.tabRowStickyFilled]}>
            {profile && !editMode && <ProfileV2TabRow active={section} onChange={setSection} />}
          </View>

          {/* index 2 — selected tab body (or the edit form), scrolling
              underneath the sticky tab row above. */}
          <View style={styles.tabBodyWrap}>
          {editMode ? (
            /* ── Edit Mode (owner only — unreachable otherwise, since
                 enterEdit early-returns and nothing renders the trigger
                 for a public view) ── */
            <View style={styles.editSection}>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.displayName}
                onChangeText={(v) => setEditForm((p) => ({ ...p, displayName: v }))}
                placeholder="Display name"
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={50}
                accessibilityLabel="Display name"
              />

              <Text style={styles.fieldLabel}>Hero Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.heroName}
                onChangeText={(v) => setEditForm((p) => ({ ...p, heroName: v }))}
                placeholder="Knicks Vault, Griffey Guy, The Ruler…"
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={40}
                accessibilityLabel="Hero display name"
              />
              <Text style={styles.fieldHint}>
                Shown large on your profile. Leave blank to use your display name.
              </Text>

              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabelInRow}>Tagline</Text>
                <Text style={styles.charCounter}>
                  {editForm.tagline.length}/{TAGLINE_MAX_LENGTH}
                </Text>
              </View>
              <TextInput
                style={styles.fieldInput}
                value={editForm.tagline}
                onChangeText={(v) => setEditForm((p) => ({ ...p, tagline: v }))}
                placeholder="Vintage hoops. Modern grails."
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={TAGLINE_MAX_LENGTH}
                accessibilityLabel="Tagline"
              />

              <Text style={styles.fieldLabel}>Bio</Text>
              <TextInput
                style={[styles.fieldInput, styles.bioInput]}
                value={editForm.bio}
                onChangeText={(v) => setEditForm((p) => ({ ...p, bio: v }))}
                placeholder="Tell people about yourself..."
                placeholderTextColor="rgba(255,255,255,0.35)"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={160}
                accessibilityLabel="Bio"
              />

              <Text style={styles.fieldLabel}>Location</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.location}
                onChangeText={(v) => setEditForm((p) => ({ ...p, location: v }))}
                placeholder="Las Vegas, NV"
                placeholderTextColor="rgba(255,255,255,0.35)"
                maxLength={LOCATION_MAX_LENGTH}
                accessibilityLabel="Location"
              />
              <Text style={styles.fieldHint}>City/region only — never precise coordinates.</Text>

              <Text style={styles.fieldLabel}>Website</Text>
              <TextInput
                style={styles.fieldInput}
                value={editForm.website}
                onChangeText={(v) => setEditForm((p) => ({ ...p, website: v }))}
                placeholder="cachecase.app"
                placeholderTextColor="rgba(255,255,255,0.35)"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="Website"
              />

              <Text style={styles.fieldLabel}>Hero Theme</Text>
              <View style={styles.themeRow}>
                {getHeroCanvasPickerThemes().map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    style={[
                      styles.themeSwatch,
                      selectedTheme === t.id && styles.themeSwatchSelected,
                    ]}
                    onPress={() => setSelectedTheme(t.id)}
                    activeOpacity={0.8}>
                    {t.kind === 'image' ? (
                      <Image
                        source={t.asset.source}
                        style={styles.themeSwatchFill}
                        contentFit="cover"
                        contentPosition={t.asset.focalPoint}
                      />
                    ) : (
                      <LinearGradient
                        colors={t.swatch}
                        style={styles.themeSwatchFill}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      />
                    )}
                    <Text style={styles.themeSwatchLabel}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.sectionHeader}>Collector Preferences</Text>
              <ProfileV2TagEditor
                label="Favorite Sports"
                values={favoriteSports}
                onChange={setFavoriteSports}
                placeholder="Basketball"
              />
              <ProfileV2TagEditor
                label="Favorite Teams"
                values={favoriteTeams}
                onChange={setFavoriteTeams}
                placeholder="Lakers"
              />
              <ProfileV2TagEditor
                label="Collecting Categories"
                values={collectingCategories}
                onChange={setCollectingCategories}
                placeholder="Rookie Cards"
              />
              <ProfileV2TagEditor
                label="Collector Tags"
                values={collectorTags}
                onChange={setCollectorTags}
                placeholder="Grader, Vintage, PC Only"
              />
            </View>
          ) : (
            /* ── View Mode ──
                 ProfileV2TabRow (the four pills) now renders up top, directly
                 under ProfileV2IdentityCard — see the Profile V3 shell block
                 near the start of this ScrollView. Nothing here selects a
                 section anymore; this block only renders whichever
                 section's content is currently active. */
            <>
              {/* One shared, fixed-minHeight container for whichever section
                  is active — measured once off the posts section (now the
                  default/starting tab). Other sections then hold the same
                  floor instead of shrinking the page and shifting everything
                  below it. */}
              <ProfileV2SectionPage
                minHeight={sectionMinHeight}
                onLayout={(e) => {
                  if (section === 'posts' && sectionMinHeight === undefined) {
                    setSectionMinHeight(e.nativeEvent.layout.height);
                  }
                }}>
                {section === 'cachecase' && (
                  <>
                    <ProfileV2Identity
                      displayName={displayName}
                      username={profile?.username ?? ''}
                      tagline={profile?.tagline ?? null}
                      bio={profile?.bio ?? null}
                      location={profile?.location ?? null}
                      website={profile?.website ?? null}
                      createdAt={profile?.created_at ?? null}
                      mode={isOwnProfile ? 'owner' : 'public'}
                      onEditPress={isOwnProfile ? enterEdit : undefined}
                      onFollowPress={isOwnProfile ? undefined : toggleFollow}
                      onMessagePress={isOwnProfile ? undefined : handleMessage}
                      isFollowing={isFollowing}
                      followLoading={followLoading}
                      messageLoading={msgLoading}
                    />

                    <ProfileV2Stats followers={stats.followerCount} following={stats.followingCount} />
                  </>
                )}

                {section === 'posts' && (
                  <ProfileV2Posts
                    posts={profilePosts}
                    currentUserId={currentUserId}
                    onUserPress={(username) => router.push({ pathname: '/user/[username]', params: { username } })}
                    onPostPress={(postId) => router.push({ pathname: '/post/[id]', params: { id: postId } })}
                    onLike={handleLike}
                    onDelete={handleDeletePost}
                    error={profilePostsError}
                    onRetry={refreshPosts}
                  />
                )}

                {section === 'collections' && (
                  <ProfileV2Collections
                    folders={folders}
                    previewEntries={previewEntries}
                    onOpenFolder={openFolder}
                    onOpenItem={handleGrailItemPress}
                    onOpenChildFolder={openFolder}
                    onAddItem={isOwnProfile ? addFolderItem : undefined}
                    onCreatePress={isOwnProfile ? () => router.push('/(tabs)/collection' as any) : undefined}
                  />
                )}

                {section === 'transfer' && isOwnProfile && (
                  <TransactionsList currentUserId={currentUserId} onViewAll={handleOpenTransfers} />
                )}

                {section === 'items' && (
                  <ProfileV2ItemsGrid
                    items={allItems}
                    loading={allItemsLoading}
                    onPressItem={handleGrailItemPress}
                  />
                )}

                {/* "Tagged" tab label unchanged — its content is now the
                    existing bookmark/save repository (hooks/use-saved.ts),
                    not the old (never-implemented) tagged-content path.
                    Same navigation handlers Grails already uses for an
                    item/collection tap — no parallel navigation path. */}
                {section === 'tagged' && (
                  <ProfileV2Tagged
                    userId={userId}
                    isOwnProfile={isOwnProfile}
                    onPressItem={handleGrailItemPress}
                    onPressFolder={handleGrailCollectionPress}
                  />
                )}

              </ProfileV2SectionPage>
            </>
          )}
          </View>

        </ScrollView>
      </KeyboardAvoidingView>

      <GrailSlotChooser target={grailChooserTarget} onClose={closeGrailChooser} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {},
  // No margin — the identity header→grid gap is now owned entirely by
  // ProfileV2HeroCanvas's own gridStage.paddingTop (Profile V3
  // background-removal/spacing pass), so the grid sits almost flush
  // under the header instead of being pushed down an extra step here.
  heroCanvasWrap: {},
  // Opaque backdrop for the sticky tab row (ScrollView's stickyHeaderIndices
  // index 1) — matches the screen's own background so scrolled content
  // underneath doesn't show through ProfileV2TabRow's own transparent gaps
  // once this is pinned to the top. No height/padding of its own: when
  // empty (edit mode, or before `profile` loads) it must collapse to zero,
  // not just render an empty colored strip.
  tabRowSticky: {
    backgroundColor: PV2.bg,
  },
  // Extra solid space below the pills only — does not move them (their own
  // marginTop, inside ProfileV2TabRow, is untouched) and does not affect
  // the sticky pin threshold (governed by this wrapper's own top edge,
  // unaffected by its bottom padding). Trimmed from 8 to 4 — 8 read as too
  // much extra box beneath the pills.
  tabRowStickyFilled: {
    paddingBottom: 4,
  },
  // The one shared gap between the (sticky) tab row and whichever tab's
  // content follows — TAB_CONTENT_TOP_GAP, matching the Grails→tab-row gap
  // for a symmetric divider. Every tab body relies on this alone for its
  // starting offset now; ProfileV2Posts/ProfileV2Collections/
  // ProfileV2ItemsGrid no longer carry their own separate top margin (that
  // was the actual source of the three tabs starting at three different
  // heights).
  tabBodyWrap: {
    marginTop: TAB_CONTENT_TOP_GAP,
  },
  ownerActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
  },
  ownerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editSection: {
    padding: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    marginTop: 16,
    marginBottom: 6,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 6,
  },
  fieldLabelInRow: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
  },
  charCounter: {
    fontSize: 11,
    fontWeight: '500',
    color: PV2.textTertiary,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
    marginTop: 28,
    marginBottom: 4,
  },
  fieldHint: {
    fontSize: 12,
    color: PV2.textTertiary,
    marginTop: 5,
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.panel,
    color: '#fff',
  },
  bioInput: {
    height: 100,
    paddingTop: 12,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 12,
  },
  themeSwatch: {
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  themeSwatchSelected: {
    borderColor: PV2.accent,
  },
  themeSwatchFill: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  themeSwatchLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: PV2.textSecondary,
  },
});

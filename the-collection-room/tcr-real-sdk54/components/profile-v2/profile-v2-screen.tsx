import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type AlertButton,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

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
import { useFolders } from '@/hooks/use-collection';
import {
  expectedRefIdForSlot,
  removeGrailSlot,
  useGrailSlots,
  type ExpectedGrailSlot,
} from '@/hooks/use-grail-slots';
import { useProfile } from '@/hooks/use-profile';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import {
  deleteProfileImage,
  uploadAvatar,
  uploadBadgeImage,
  uploadHeroImage,
  type ProfileImageKind,
} from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectionItem, Folder, GrailChooserTarget, Profile } from '@/types';

import { GrailSlotChooser } from './grail-slot-chooser';
import { ProfileV2CollectorPanel, type PrototypeCollectorStats } from './profile-v2-collector-panel';
import { ProfileV2Collections } from './profile-v2-collections';
import { ProfileV2Grid } from './profile-v2-grid';
import { ProfileV2HeroCanvas } from './profile-v2-hero-canvas';
import { ProfileV2Identity } from './profile-v2-identity';
import { ProfileV2Posts } from './profile-v2-posts';
import { ProfileV2Preferences } from './profile-v2-preferences';
import { ProfileV2SectionPage } from './profile-v2-section-page';
import { ProfileV2Selector, type ProfileV2Section } from './profile-v2-selector';
import { ProfileV2Stats } from './profile-v2-stats';
import { ProfileV2TagEditor, TAG_EDITOR_MAX_ITEMS, TAG_EDITOR_MAX_ITEM_LENGTH } from './profile-v2-tag-editor';
import { PV2 } from './profile-v2-theme';

// Values with no corresponding column/table yet (see PrototypeCollectorStats
// in profile-v2-collector-panel.tsx). Kept in exactly one place, clearly
// named, rather than inlined in JSX — swap these out if/when the real data
// lands (an authentications table, an ownership-transfer history, a
// collector registry id).
const prototypeCollectorStats: PrototypeCollectorStats = {
  authenticated: 0,
  transferred: 0,
  collectorId: 'CCA #1',
};

const TAGLINE_MAX_LENGTH = 80;
const LOCATION_MAX_LENGTH = 80;

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
  | 'showcase_badge_url'
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
    intended.showcase_badge_url === row.showcase_badge_url &&
    arraysEqualOrdered(intended.favorite_sports, row.favorite_sports) &&
    arraysEqualOrdered(intended.favorite_teams, row.favorite_teams) &&
    arraysEqualOrdered(intended.collecting_categories, row.collecting_categories) &&
    arraysEqualOrdered(intended.collector_tags, row.collector_tags)
  );
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
  // Someone else's private folders never load client-side at all — not
  // just hidden in the UI, per hooks/use-collection.ts's publicOnly.
  const { folders, previewItems, refresh: refreshFolders } = useFolders(userId, {
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

  const [section, setSection] = useState<ProfileV2Section>('cachecase');
  // Measured once off the cachecase section's real rendered height (see
  // ProfileV2SectionPage below) — cachecase is both the default tab and the
  // tallest, so this captures a real "Grails" dimension rather than a
  // hardcoded guess, with no visible flash since it's measured before the
  // user can switch to a shorter section.
  const [sectionMinHeight, setSectionMinHeight] = useState<number | undefined>(undefined);

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
  // banner/badge below (newXUri = replacement picked, removeX = explicit
  // removal, neither set = unchanged).
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [newHeroUri, setNewHeroUri] = useState<string | null>(null);
  const [removeHero, setRemoveHero] = useState(false);
  const [newBadgeUri, setNewBadgeUri] = useState<string | null>(null);
  const [removeBadge, setRemoveBadge] = useState(false);
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
      refreshPosts();
      return () => {
        // Only cancels the fetchUserPosts batch owned by postsControllerRef
        // — refresh/refreshGrailSlots/refreshFolders own their own
        // cancellation internally (see their respective hooks) and are
        // deliberately left untouched here.
        postsControllerRef.current?.abort();
      };
    }, [refresh, refreshGrailSlots, refreshFolders, refreshPosts]),
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
        // Notify the followed user (unique index makes this idempotent on re-follow)
        supabase.from('notifications').insert({
          user_id: userId,
          actor_id: currentUserId,
          type: 'follow',
        }).then(({ error: notifError }) => {
          if (notifError && notifError.code !== '23505') console.error('Follow notif failed:', notifError.message);
        });
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
        supabase.from('notifications').insert({
          user_id: post.user_id,
          actor_id: currentUserId,
          type: 'like',
          post_id: postId,
        }).then(({ error: e }) => {
          if (e && e.code !== '23505') console.error('Like notif failed:', e.message);
        });
      }
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
    setNewBadgeUri(null);
    setRemoveBadge(false);
    setSelectedTheme(resolveHeroCanvasTheme(profile?.hero_theme));
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
      removeHero ||
      newBadgeUri !== null ||
      removeBadge);

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
    setNewBadgeUri(null);
    setRemoveBadge(false);
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

  async function launchCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewAvatarUri(result.assets[0].uri);
      setRemoveAvatar(false);
    }
  }

  async function launchLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewAvatarUri(result.assets[0].uri);
      setRemoveAvatar(false);
    }
  }

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

  async function pickBadgeFromLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewBadgeUri(result.assets[0].uri);
      setRemoveBadge(false);
    }
  }

  async function pickBadgeFromCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setNewBadgeUri(result.assets[0].uri);
      setRemoveBadge(false);
    }
  }

  function pickBadge() {
    const canRemove = !!(profile?.showcase_badge_url || newBadgeUri);
    const options: AlertButton[] = [
      { text: 'Take Photo', onPress: pickBadgeFromCamera },
      { text: 'Choose from Library', onPress: pickBadgeFromLibrary },
    ];
    if (canRemove) {
      options.push({
        text: 'Remove Badge',
        style: 'destructive',
        onPress: () => {
          setNewBadgeUri(null);
          setRemoveBadge(true);
        },
      });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Change Badge', undefined, options);
  }

  async function handleSave() {
    if (!isOwnProfile) return;
    // Synchronous re-entry lock. Acquired here — after isOwnProfile but
    // before any upload/DB work — so two fast taps can't both pass this
    // point in the same tick, unlike disabled={saving}, which only updates
    // once React re-renders. NOT acquired any earlier: the validation
    // checks immediately below return early (bypassing the try/finally
    // that releases it), so acquiring before them would permanently lock
    // out every future save after the first validation failure.
    if (savingRef.current) return;
    savingRef.current = true;

    // Full validation pass BEFORE setSaving/any upload/any DB write, in the
    // exact order requested: tagline length, website, array counts, array
    // item lengths, array duplicates. Stops at the first failure with one
    // Alert; edit mode stays open, nothing is uploaded or saved. Each early
    // return here happens before the try/finally below, so each one must
    // release savingRef itself rather than relying on the finally.
    const trimmedTagline = editForm.tagline.trim();
    if (trimmedTagline.length > TAGLINE_MAX_LENGTH) {
      savingRef.current = false;
      Alert.alert('Tagline Too Long', `Tagline must be ${TAGLINE_MAX_LENGTH} characters or fewer.`);
      return;
    }

    const websiteResult = normalizeWebsiteInput(editForm.website);
    if (!websiteResult.ok) {
      savingRef.current = false;
      Alert.alert('Invalid Website', websiteResult.message);
      return;
    }

    const arraySectionIssue = findArraySectionIssue([
      { label: 'Favorite Sports', values: favoriteSports },
      { label: 'Favorite Teams', values: favoriteTeams },
      { label: 'Collecting Categories', values: collectingCategories },
      { label: 'Collector Tags', values: collectorTags },
    ]);
    if (arraySectionIssue) {
      savingRef.current = false;
      Alert.alert('Check Collector Preferences', arraySectionIssue);
      return;
    }

    // Captured BEFORE any upload/state change below — these are what
    // cleanup compares the final saved URLs against once the row update
    // has actually succeeded. Never mutated after this point.
    const oldAvatarUrl = profile?.avatar_url ?? null;
    const oldHeroUrl = profile?.hero_image_url ?? null;
    const oldBadgeUrl = profile?.showcase_badge_url ?? null;

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

      let avatarUrl: string | null;
      let heroUrl: string | null;
      let badgeUrl: string | null;
      try {
        if (newAvatarUri) {
          try {
            avatarUrl = await uploadAvatar(newAvatarUri, userId);
          } catch (uploadErr: unknown) {
            const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
            throw new Error(`Avatar upload failed: ${detail}`);
          }
          uploadedThisAttempt.push({ url: avatarUrl, kind: 'avatar' });
        } else if (removeAvatar) {
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

        if (newBadgeUri) {
          try {
            badgeUrl = await uploadBadgeImage(newBadgeUri, userId);
          } catch (uploadErr: unknown) {
            const detail = uploadErr instanceof Error ? uploadErr.message : 'unknown';
            throw new Error(`Badge upload failed: ${detail}`);
          }
          uploadedThisAttempt.push({ url: badgeUrl, kind: 'badge' });
        } else if (removeBadge) {
          badgeUrl = null;
        } else {
          badgeUrl = profile?.showcase_badge_url ?? null;
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
      // of sync with the first.
      const intendedProfileFields: IntendedProfileFields = {
        hero_display_name: editForm.heroName.trim() || null,
        display_name: editForm.displayName.trim() || null,
        bio: editForm.bio.trim() || null,
        tagline: trimmedTagline || null,
        location: editForm.location.trim() || null,
        website: websiteResult.value,
        favorite_sports: favoriteSports,
        favorite_teams: favoriteTeams,
        collecting_categories: collectingCategories,
        collector_tags: collectorTags,
        avatar_url: avatarUrl,
        hero_image_url: heroUrl,
        hero_theme: selectedTheme,
        showcase_badge_url: badgeUrl,
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
          oldBadgeUrl && oldBadgeUrl !== badgeUrl ? deleteProfileImage(oldBadgeUrl, userId, 'badge') : Promise.resolve(),
        ]);

        await refresh();
        setNewAvatarUri(null);
        setRemoveAvatar(false);
        setNewHeroUri(null);
        setRemoveHero(false);
        setNewBadgeUri(null);
        setRemoveBadge(false);
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
      const resolveAmbiguousUpdateOutcome = async (): Promise<void> => {
        let reconciledRow: IntendedProfileFields | null = null;
        try {
          const { data: reconData, error: reconError } = await supabase
            .from('profiles')
            .select(
              'hero_display_name, display_name, bio, tagline, location, website, favorite_sports, favorite_teams, collecting_categories, collector_tags, avatar_url, hero_image_url, hero_theme, showcase_badge_url'
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
          return;
        }

        if (intendedProfileMatchesRow(intendedProfileFields, reconciledRow)) {
          // The row currently holds exactly the intended state — the
          // ambiguous update DID commit.
          await finishSuccess();
          return;
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
          return;
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

      await resolveAmbiguousUpdateOutcome();
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }

  const avatarUri = removeAvatar ? null : (newAvatarUri ?? profile?.avatar_url ?? null);
  const badgeUri = removeBadge ? null : (newBadgeUri ?? profile?.showcase_badge_url ?? null);
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
          scrollEventThrottle={scrollEventThrottle}>

          {profile && (
            <ProfileV2CollectorPanel
              avatarUri={avatarUri}
              displayName={displayName}
              username={profile?.username ?? ''}
              vaultTotal={stats.itemCount}
              graded={stats.gradedCount}
              prototype={prototypeCollectorStats}
              onAvatarPress={isOwnProfile ? pickAvatar : undefined}
            />
          )}

          {profile && (
            <View style={styles.heroCanvasWrap}>
            <ProfileV2HeroCanvas
              heroTheme={heroTheme}
              themeFallbackSwatch={themeFallbackSwatch}
              editMode={editMode}
              saving={saving}
              onCancelPress={cancelEdit}
              onSavePress={handleSave}>
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
            </View>
          )}

          {/* Owner/public control row — moved out of ProfileV2HeroCanvas
              so the canvas itself is dimensionally identical for owner
              and public view mode (same gridStage 32/32 padding, no
              action row inside either way). Owner sees Settings/Saved;
              public sees Back. Both branches share styles.ownerActionRow/
              ownerIconBtn (not two independently-maintained style
              objects) so their outer spacing footprint is guaranteed
              identical — identity content begins at the same vertical
              offset below the canvas either way. Same handlers, icons,
              size, hitSlop, and activeOpacity as when Back lived inside
              the canvas. Hidden during edit mode — neither ever coexisted
              with Cancel/Save when it lived inside the canvas either. */}
          {profile && !editMode && (
            <View style={styles.ownerActionRow}>
              {isOwnProfile ? (
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
              ) : (
                <TouchableOpacity
                  onPress={() => router.back()}
                  hitSlop={10}
                  style={styles.ownerIconBtn}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel="Back">
                  <IconSymbol name="chevron.left" size={18} color="#fff" />
                </TouchableOpacity>
              )}
            </View>
          )}

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

              <TouchableOpacity style={styles.badgeEditRow} onPress={pickBadge} activeOpacity={0.8}>
                <View style={styles.badgeEditPreview}>
                  {badgeUri ? (
                    <Image source={{ uri: badgeUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : null}
                </View>
                <Text style={styles.badgeEditLabel}>
                  {badgeUri ? 'Change Collector Badge' : 'Add Collector Badge'}
                </Text>
              </TouchableOpacity>
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
            /* ── View Mode ── */
            <>
              <ProfileV2Selector active={section} onChange={setSection} isOwnProfile={isOwnProfile} />

              {/* One shared, fixed-minHeight container for whichever section
                  is active — measured once off the cachecase section (now
                  the profile identity/stats overview), since cachecase is
                  still the default/starting tab. Other sections then hold
                  the same floor instead of shrinking the page and shifting
                  everything below it. */}
              <ProfileV2SectionPage
                minHeight={sectionMinHeight}
                onLayout={(e) => {
                  if (section === 'cachecase' && sectionMinHeight === undefined) {
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
                    error={profilePostsError}
                    onRetry={refreshPosts}
                  />
                )}

                {section === 'collections' && (
                  <ProfileV2Collections
                    folders={folders}
                    previewItems={previewItems}
                    onOpenFolder={openFolder}
                    onAddItem={isOwnProfile ? addFolderItem : undefined}
                    onCreatePress={isOwnProfile ? () => router.push('/(tabs)/collection' as any) : undefined}
                  />
                )}

                {section === 'transfer' && isOwnProfile && (
                  <TransactionsList currentUserId={currentUserId} onViewAll={handleOpenTransfers} />
                )}

              </ProfileV2SectionPage>

              {/* Own read-only Collector Profile section — same data for
                  owner and visitor. Moved to be the final profile section,
                  below all selector/tab content, per the requested layout.
                  Renders nothing at all (including its own header) when
                  every preference array is empty. */}
              <ProfileV2Preferences
                favoriteSports={profile?.favorite_sports ?? []}
                favoriteTeams={profile?.favorite_teams ?? []}
                collectingCategories={profile?.collecting_categories ?? []}
                collectorTags={profile?.collector_tags ?? []}
              />
            </>
          )}

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
  // Shifts the whole ProfileV2HeroCanvas (theme background, Top 9, and
  // its identityHeader/action rail) down as one unit, off the very top
  // edge of the screen. Deliberately outside profile-v2-hero-canvas.tsx
  // itself — the canvas has no padding/height changes here, only its
  // position within the ScrollView moves.
  heroCanvasWrap: {
    marginTop: 12,
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
  badgeEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
  },
  badgeEditPreview: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  badgeEditLabel: {
    color: PV2.link,
    fontSize: 14,
    fontWeight: '600',
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

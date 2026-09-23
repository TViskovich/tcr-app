import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import { ItemActionBar } from '@/components/item-detail/item-action-bar';
import { ItemCommentsSheet } from '@/components/item-detail/item-comments-sheet';
import { ItemDescription } from '@/components/item-detail/item-description';
import { ItemIdentity } from '@/components/item-detail/item-identity';
import { buildItemImageList, ItemImageCarousel, type CarouselImage } from '@/components/item-detail/item-image-carousel';
import { ItemImageGalleryManager } from '@/components/item-detail/item-image-gallery-manager';
import { ItemMetadataSection, type MetadataRow } from '@/components/item-detail/item-metadata-section';
import { ItemOwnerRow } from '@/components/item-detail/item-owner-row';
import { MoveItemModal } from '@/components/item-detail/move-item-modal';
import { RelatedItemsGrid } from '@/components/item-detail/related-items-grid';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useGrails } from '@/hooks/use-grails';
import { useItemImages } from '@/hooks/use-item-images';
import { useItemLikes } from '@/hooks/use-item-likes';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useRegisteredCardForItem } from '@/hooks/use-registered-card';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { getComicBookDetails, updateComicBookItem } from '@/lib/comic-book-items';
import {
  COMIC_EDITION_OPTIONS,
  COMIC_GRADING_COMPANY_OPTIONS,
  COMIC_KEY_TYPE_OPTIONS,
  COMIC_PRINTING_OPTIONS,
  COMIC_RAW_CONDITION_OPTIONS,
  COMIC_SPECIAL_COVER_FINISH_OPTIONS,
} from '@/lib/comic-book-options';
import { cleanupOrphanedItemImages, materializeLegacyItemImage, MAX_ITEM_IMAGES } from '@/lib/item-images';
import { getPokemonCardDetails, updatePokemonItem } from '@/lib/pokemon-items';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import { navigateToProfile } from '@/lib/profile-navigation';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { ComicBookDetails, ComicConditionType, CollectionItem, PokemonCardDetails } from '@/types';

type EditForm = {
  title: string;
  player: string;
  team: string;
  year: string;
  brand: string;
  grade: string;
  gradingCompany: string;
  serialNumber: string;
  estimatedValue: string;
  description: string;
};

// Pokémon's own edit-form shape (Phase 2 — supabase/migrations/
// 20260917120000_create_pokemon_card_details.sql /
// 20260917120100_create_pokemon_item_rpcs.sql), mirroring app/item/new.tsx's
// PokemonFormState. No title field — collection_items.title is derived
// server-side from pokemonName by update_pokemon_item, same as at creation.
type PokemonEditForm = {
  pokemonName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  language: string;
  edition: string;
  holoType: string;
  gradingCompany: string;
  grade: string;
  estimatedValue: string;
  description: string;
};

// Comic Book's own edit-form shape (Phase 3 — supabase/migrations/
// 20260917130000_create_comic_book_details.sql /
// 20260917130100_create_comic_book_item_rpcs.sql), mirroring
// app/item/new.tsx's ComicFormState. No title field — collection_items.title
// is derived server-side from seriesTitle (plus issueNumber) by
// update_comic_book_item, same as at creation.
type ComicEditForm = {
  seriesTitle: string;
  issueNumber: string;
  publisher: string;
  publicationYear: string;
  volume: string;
  coverVariant: string;
  printing: string;
  conditionType: ComicConditionType;
  condition: string;
  gradingCompany: string;
  grade: string;
  certificationNumber: string;
  labelType: string;
  pageQuality: string;
  isKeyIssue: boolean;
  keyTypes: string[];
  keyDescription: string;
  characters: string;
  storyArc: string;
  writer: string;
  interiorArtist: string;
  coverArtist: string;
  edition: string;
  variantName: string;
  variantArtist: string;
  incentiveRatio: string;
  retailerExclusive: string;
  specialCoverFinish: string;
  countryMarket: string;
  isSigned: boolean;
  signedBy: string;
  signatureAuthentication: string;
  isRestored: boolean;
  restorationNotes: string;
  estimatedValue: string;
  description: string;
};

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

function itemToForm(item: CollectionItem): EditForm {
  return {
    title: item.title ?? '',
    player: item.player ?? '',
    team: item.team ?? '',
    year: item.year?.toString() ?? '',
    brand: item.brand ?? '',
    grade: item.grade ?? '',
    gradingCompany: item.grading_company ?? '',
    serialNumber: item.serial_number ?? '',
    estimatedValue: item.estimated_value?.toString() ?? '',
    description: item.description ?? '',
  };
}

function pokemonItemToForm(item: CollectionItem, details: PokemonCardDetails | null): PokemonEditForm {
  return {
    pokemonName: details?.pokemon_name ?? '',
    setName: details?.set_name ?? '',
    cardNumber: details?.card_number ?? '',
    rarity: details?.rarity ?? '',
    language: details?.language ?? '',
    edition: details?.edition ?? '',
    holoType: details?.holo_type ?? '',
    gradingCompany: details?.grading_company ?? '',
    grade: details?.grade ?? '',
    estimatedValue: item.estimated_value?.toString() ?? '',
    description: item.description ?? '',
  };
}

function comicItemToForm(item: CollectionItem, details: ComicBookDetails | null): ComicEditForm {
  return {
    seriesTitle: details?.series_title ?? '',
    issueNumber: details?.issue_number ?? '',
    publisher: details?.publisher ?? '',
    publicationYear: details?.publication_year?.toString() ?? '',
    volume: details?.volume ?? '',
    coverVariant: details?.cover_variant ?? '',
    printing: details?.printing ?? '',
    conditionType: details?.condition_type ?? 'raw',
    condition: details?.condition ?? '',
    gradingCompany: details?.grading_company ?? '',
    grade: details?.grade ?? '',
    certificationNumber: details?.certification_number ?? '',
    labelType: details?.label_type ?? '',
    pageQuality: details?.page_quality ?? '',
    isKeyIssue: details?.is_key_issue ?? false,
    keyTypes: details?.key_types ?? [],
    keyDescription: details?.key_description ?? '',
    characters: details?.characters ?? '',
    storyArc: details?.story_arc ?? '',
    writer: details?.writer ?? '',
    interiorArtist: details?.interior_artist ?? '',
    coverArtist: details?.cover_artist ?? '',
    edition: details?.edition ?? '',
    variantName: details?.variant_name ?? '',
    variantArtist: details?.variant_artist ?? '',
    incentiveRatio: details?.incentive_ratio ?? '',
    retailerExclusive: details?.retailer_exclusive ?? '',
    specialCoverFinish: details?.special_cover_finish ?? '',
    countryMarket: details?.country_market ?? '',
    isSigned: details?.is_signed ?? false,
    signedBy: details?.signed_by ?? '',
    signatureAuthentication: details?.signature_authentication ?? '',
    isRestored: details?.is_restored ?? false,
    restorationNotes: details?.restoration_notes ?? '',
    estimatedValue: item.estimated_value?.toString() ?? '',
    description: item.description ?? '',
  };
}

// Player is the primary identity (matches how collectors actually refer to
// a card); the item's own title/brand/year become supporting detail lines
// instead. Falls back to the item's own title, then a generic label, if
// there's no player set.
// Same formatting convention already used for dates elsewhere in this
// registry-adjacent screen family (e.g. app/registry/[id].tsx's own
// formatDate) — not shared, since each is a small, standalone helper.
// Accepts a possibly-missing/malformed value and never returns a
// renderable "Invalid Date" string: null covers both "no timestamp" and
// "unparseable timestamp" identically, so the call site can gate on one
// simple truthiness check either way.
function formatTransferredOutDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildIdentity(item: CollectionItem): { title: string; subtitleLines: (string | null)[] } {
  const title = item.player?.trim() || item.title?.trim() || 'Untitled Item';
  const yearAndSet = [item.year != null ? String(item.year) : null, item.brand]
    .filter(Boolean)
    .join(' ') || null;
  const cardTitle = item.title && item.title.trim() !== title ? item.title : null;
  return { title, subtitleLines: [yearAndSet, cardTitle] };
}

function buildMetadataRows(item: CollectionItem): MetadataRow[] {
  return [
    { label: 'Player', value: item.player },
    { label: 'Team', value: item.team },
    { label: 'Year', value: item.year != null ? String(item.year) : null },
    { label: 'Set', value: item.brand },
    { label: 'Grade', value: item.grade },
    { label: 'Grading Company', value: item.grading_company },
    { label: 'Serial Number', value: item.serial_number },
    { label: 'Estimated Value', value: item.estimated_value != null ? `$${item.estimated_value.toFixed(2)}` : null },
  ];
}

// Pokémon's own identity/metadata builders — item.title IS the Pokémon name
// (derived server-side, see pokemonItemToForm's own comment above), so no
// "player vs title" fallback logic is needed here the way buildIdentity
// above has for sports cards; the set/card-number line is this type's
// closest equivalent to buildIdentity's yearAndSet line.
function buildPokemonIdentity(
  item: CollectionItem,
  details: PokemonCardDetails | null,
): { title: string; subtitleLines: (string | null)[] } {
  const title = item.title?.trim() || 'Untitled Item';
  const setLine = [details?.set_name, details?.card_number ? `#${details.card_number}` : null]
    .filter(Boolean)
    .join(' ') || null;
  return { title, subtitleLines: [setLine, details?.rarity ?? null] };
}

function buildPokemonMetadataRows(item: CollectionItem, details: PokemonCardDetails | null): MetadataRow[] {
  return [
    { label: 'Pokémon', value: details?.pokemon_name ?? null },
    { label: 'Set', value: details?.set_name ?? null },
    { label: 'Card #', value: details?.card_number ?? null },
    { label: 'Rarity', value: details?.rarity ?? null },
    { label: 'Language', value: details?.language ?? null },
    { label: 'Edition', value: details?.edition ?? null },
    { label: 'Holo Type', value: details?.holo_type ?? null },
    { label: 'Grading Company', value: details?.grading_company ?? null },
    { label: 'Grade', value: details?.grade ?? null },
    { label: 'Estimated Value', value: item.estimated_value != null ? `$${item.estimated_value.toFixed(2)}` : null },
  ];
}

// Comics' own identity/metadata builders — item.title IS "Series #Issue"
// (derived server-side, see comicItemToForm's own comment above). Only the
// active Raw-or-Graded condition group is ever surfaced here, matching the
// form's own conditional rendering; Key Issue/Signed/Restored's conditional
// fields are likewise only included when their own toggle is on.
function buildComicIdentity(
  item: CollectionItem,
  details: ComicBookDetails | null,
): { title: string; subtitleLines: (string | null)[] } {
  const title = item.title?.trim() || 'Untitled Item';
  const publisherLine = [details?.publisher, details?.publication_year ? String(details.publication_year) : null]
    .filter(Boolean)
    .join(' · ') || null;
  return { title, subtitleLines: [publisherLine, details?.is_key_issue ? 'Key Issue' : null] };
}

function buildComicMetadataRows(item: CollectionItem, details: ComicBookDetails | null): MetadataRow[] {
  const isGraded = details?.condition_type === 'graded';
  return [
    { label: 'Series / Title', value: details?.series_title ?? null },
    { label: 'Issue Number', value: details?.issue_number ?? null },
    { label: 'Publisher', value: details?.publisher ?? null },
    { label: 'Publication Year', value: details?.publication_year != null ? String(details.publication_year) : null },
    { label: 'Volume', value: details?.volume ?? null },
    { label: 'Cover / Variant', value: details?.cover_variant ?? null },
    { label: 'Printing', value: details?.printing ?? null },
    { label: 'Condition Type', value: isGraded ? 'Graded' : 'Raw' },
    { label: 'Condition', value: !isGraded ? details?.condition ?? null : null },
    { label: 'Grading Company', value: isGraded ? details?.grading_company ?? null : null },
    { label: 'Grade', value: isGraded ? details?.grade ?? null : null },
    { label: 'Certification Number', value: isGraded ? details?.certification_number ?? null : null },
    { label: 'Label Type', value: isGraded ? details?.label_type ?? null : null },
    { label: 'Page Quality', value: isGraded ? details?.page_quality ?? null : null },
    { label: 'Key Type', value: details?.is_key_issue && details.key_types.length > 0 ? details.key_types.join(', ') : null },
    { label: 'Key Description', value: details?.is_key_issue ? details?.key_description ?? null : null },
    { label: 'Characters', value: details?.characters ?? null },
    { label: 'Story Arc / Event', value: details?.story_arc ?? null },
    { label: 'Writer', value: details?.writer ?? null },
    { label: 'Interior Artist', value: details?.interior_artist ?? null },
    { label: 'Cover Artist', value: details?.cover_artist ?? null },
    { label: 'Edition', value: details?.edition ?? null },
    { label: 'Variant Name', value: details?.variant_name ?? null },
    { label: 'Variant Artist', value: details?.variant_artist ?? null },
    { label: 'Incentive Ratio', value: details?.incentive_ratio ?? null },
    { label: 'Retailer Exclusive', value: details?.retailer_exclusive ?? null },
    { label: 'Special Cover / Finish', value: details?.special_cover_finish ?? null },
    { label: 'Country / Market', value: details?.country_market ?? null },
    { label: 'Signed By', value: details?.is_signed ? details?.signed_by ?? null : null },
    { label: 'Signature Authentication', value: details?.is_signed ? details?.signature_authentication ?? null : null },
    { label: 'Restoration Notes', value: details?.is_restored ? details?.restoration_notes ?? null : null },
    { label: 'Estimated Value', value: item.estimated_value != null ? `$${item.estimated_value.toFixed(2)}` : null },
  ];
}

function EditField({
  label,
  value,
  onChange,
  extra,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  extra?: object;
}) {
  return (
    <View style={editStyles.wrap}>
      <Text style={editStyles.label}>{label}</Text>
      <TextInput
        style={editStyles.input}
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor="#999"
        {...extra}
      />
    </View>
  );
}

// A labeled Switch row for one of Comics' three boolean toggles in Edit mode
// (Key Issue, Signed, Restored) — same visual language as this screen's own
// Private Item toggle further down (editStyles.toggleRow/toggleTextArea/
// toggleTitle/toggleHint), reused across the three since Comics needs it
// more than once here.
function EditToggleRow({
  label,
  sublabel,
  value,
  onValueChange,
}: {
  label: string;
  sublabel: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={editStyles.toggleRow}>
      <View style={editStyles.toggleTextArea}>
        <Text style={editStyles.toggleTitle}>{label}</Text>
        <Text style={editStyles.toggleHint}>{sublabel}</Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: '#0a7ea4' }} />
    </View>
  );
}

// Custom header bar — replaces the native Stack header entirely for this
// screen (every Stack.Screen below sets headerShown: false). react-navigation's
// native header picks up the OS's own rounded/"Liquid Glass" pill chrome
// around header bar items on iOS 18+ — confirmed on-device, and not
// something any headerLeft/headerRight style prop can suppress, since it's
// applied by the native header itself rather than by anything this app
// controls (see components/ui/back-button.tsx's own doc comment on the same
// finding). Rendering the header row as plain in-screen content is the only
// way to guarantee a bare chevron here. leftSlot/rightSlot are both
// HEADER_SIDE_WIDTH wide regardless of their actual content (a 44px
// BackButton vs. "Cancel"/"Edit"/"Save" text) so the title in between is
// truly centered on the row, not just centered between two unequal-width
// controls.
const HEADER_SIDE_WIDTH = 70;
const HEADER_ROW_HEIGHT = 44;

function ItemDetailHeaderBar({
  insetsTop,
  title,
  left,
  right,
}: {
  insetsTop: number;
  title: string;
  left: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={[headerBarStyles.bar, { paddingTop: insetsTop }]}>
      <View style={headerBarStyles.row}>
        <View style={headerBarStyles.slotLeft}>{left}</View>
        <Text style={headerBarStyles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={headerBarStyles.slotRight}>{right}</View>
      </View>
    </View>
  );
}

const headerBarStyles = StyleSheet.create({
  bar: {
    backgroundColor: PV2.bg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: HEADER_ROW_HEIGHT,
  },
  slotLeft: {
    width: HEADER_SIDE_WIDTH,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  slotRight: {
    width: HEADER_SIDE_WIDTH,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 12,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: PV2.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Permanent layout/component architecture for the item detail screen — see
// components/item-detail/*. Order: hero image → action bar (placeholder,
// unwired) → identity → owner card (non-owners only) → description →
// metadata → related items grid → owner-only management actions. Edit mode
// keeps its existing metadata form UI; the hero area swaps to
// ItemImageGalleryManager (add/remove/reorder/set cover) instead.
export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string; fromGrails?: string }>();
  const { session } = useAuth();
  const router = useRouter();
  const currentUserId = session?.user?.id;
  // Same identity useSignedItemImages itself keys its cache by
  // (hooks/use-signed-item-images.ts's own `session?.user?.id ?? 'anon'`)
  // — reused here only to build the carousel's stable expo-image cacheKeys
  // (Phase 2 of the private-image caching upgrade — see
  // lib/private-image-cache-key.ts). Never a second identity concept. Named
  // `cacheIdentity` (not `identity`) — this file already has an unrelated
  // local `identity` further down (buildIdentity(item)'s own title/
  // subtitle display data).
  const cacheIdentity = currentUserId ?? 'anon';
  const insets = useSafeAreaInsets();
  const { onScroll: navbarOnScroll, scrollEventThrottle: navbarScrollEventThrottle } =
    useScrollResponsiveNavbar();

  const [item, setItem] = useState<CollectionItem | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  // Pokémon-specific metadata (Phase 2) — fetched alongside the base item
  // only when item.item_type === 'pokemon' (see fetchItem below), never for
  // any other type and never for list/preview surfaces elsewhere in the
  // app, so this stays a single extra query scoped to item detail/edit only.
  // pokemonForm mirrors form/EditForm's own separate-state pattern.
  const [pokemonDetails, setPokemonDetails] = useState<PokemonCardDetails | null>(null);
  const [pokemonForm, setPokemonForm] = useState<PokemonEditForm | null>(null);
  const isPokemonItem = item?.item_type === 'pokemon';
  // Comic Book-specific metadata (Phase 3) — same fetched-alongside-the-base-
  // item, only-when-needed pattern as pokemonDetails/pokemonForm above.
  const [comicDetails, setComicDetails] = useState<ComicBookDetails | null>(null);
  const [comicForm, setComicForm] = useState<ComicEditForm | null>(null);
  const isComicBookItem = item?.item_type === 'comic_book';
  // Item-level privacy (Model A, most-restrictive-wins — see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Kept separate from `form`/EditForm (same convention as
  // folder-edit-modal.tsx's editIsPublic vs. its rename field) since it's a
  // boolean switch, not a text field. Seeded from the item's own current
  // value in enterEdit()/cancelEdit() below — this is an existing item
  // being edited, so it starts from what it already is, not from the
  // parent folder (that seeding only applies to a brand-new item, in
  // app/item/new.tsx).
  const [editItemIsPublic, setEditItemIsPublic] = useState(true);
  const editItemIsPrivate = !editItemIsPublic;
  const [saving, setSaving] = useState(false);
  const [grailsLoading, setGrailsLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  // Phase 1 item move — single-item only (see components/item-detail/
  // move-item-modal.tsx). Kept as a top-level bool here, not folded into
  // editMode: Move is reachable from the edit form but is its own
  // independent action/modal, not a form field.
  const [showMoveModal, setShowMoveModal] = useState(false);
  // Multi-photo "Add Photos" queue — handleAddPhotos below seeds this from
  // however many library assets the user multi-selected in one pass, then
  // PhotoAdjuster is shown once per entry (see the render below) so every
  // photo gets the same crop/adjust step a single photo already got,
  // rather than uploading the raw, unedited picker output. photoQueue is
  // cleared (empty array) whenever there's nothing pending; queueIndex is
  // only meaningful while it isn't.
  const [photoQueue, setPhotoQueue] = useState<{ uri: string; width: number; height: number }[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueAdjustedUris, setQueueAdjustedUris] = useState<string[]>([]);

  const isOwner = !!currentUserId && item?.user_id === currentUserId;
  // Sender Transferred-Out Item Lifecycle — a top-level derived flag, not
  // a separate query: collection_status already comes back on the same
  // row this screen fetches by id. Used both to gate the header Edit
  // button below and to swap the entire view-mode action area for the
  // historical state (see the single top-level conditional further down,
  // rather than hiding many individual buttons).
  const isTransferredOut = item?.collection_status === 'transferred_out';

  // Item-level social row (Comment/Like/Share) — Like is the optimistic
  // item_likes toggle, same shape as hooks/use-folder-likes.ts's own
  // toggle(). Comment (below) opens ItemCommentsSheet, which owns its own
  // useItemComments call internally (mounted-gated, same convention as
  // FolderCommentsSheet/GalleryCommentsSheet) — this screen only tracks
  // whether that sheet is open. Not owner-gated — everyone (including the
  // owner) can comment/like/share, matching the collection detail screen.
  const { likeCount: itemLikeCount, liked: itemLiked, inFlight: itemLikeInFlight, toggle: toggleItemLike } =
    useItemLikes(id, currentUserId);
  const [itemCommentsVisible, setItemCommentsVisible] = useState(false);

  const { isFull, isInGrails, addToGrails, removeFromGrails } = useGrails(currentUserId);
  // Not gated on isOwner — RLS (registered_cards_select_visible) already
  // restricts what a non-owner can read (public rows, or their own), so
  // this only lets an already-permitted read happen. It has to run for
  // every viewer because the CacheCase ID button in ItemActionBar (below)
  // is visible to everyone, not just the owner; the owner-only register/
  // edit UI stays gated separately, at the JSX level (see isOwner &&
  // below), unaffected by this. The hook's own automatic effect only ever
  // performs a SELECT (see hooks/use-registered-card.ts) — registerItem()
  // is a separate function, never auto-invoked.
  const {
    registeredCard,
    loading: registryLoading,
    registering,
    registerItem,
    retrySnapshotImage,
  } = useRegisteredCardForItem(item?.id);
  const {
    images: galleryImages,
    loading: galleryLoading,
    mutating: galleryMutating,
    refresh: refreshGalleryImages,
    addImages: addGalleryImages,
    removeImage: removeGalleryImage,
    setPrimary: setPrimaryGalleryImage,
    reorder: reorderGalleryImages,
  } = useItemImages(item?.id);

  useEffect(() => {
    async function fetchItem() {
      const { data } = await supabase
        .from('collection_items')
        .select('*')
        .eq('id', id)
        .single();

      if (data) {
        setItem(data);
        setForm(itemToForm(data));

        // Always fetched now (not just for non-owners) — the Instagram-style
        // ItemOwnerRow above the image shows the owner's identity
        // regardless of viewer, same as the owner-only card further down
        // still does for non-owners only (that block's own !isOwner check
        // is unaffected by this).
        const { data: profile } = await supabase
          .from('profiles')
          .select('username, display_name, avatar_url')
          .eq('id', data.user_id)
          .single();
        if (profile) setOwnerProfile(profile as OwnerProfile);

        // Pokémon detail row — only ever fetched here (item detail/edit),
        // never for folder grids, search, saved, or profile preview tiles,
        // so this stays exactly one extra query, only when actually needed
        // (see pokemonDetails' own comment above).
        if (data.item_type === 'pokemon') {
          try {
            const details = await getPokemonCardDetails(data.id);
            setPokemonDetails(details);
            setPokemonForm(pokemonItemToForm(data, details));
          } catch (e) {
            if (__DEV__) console.error('[ItemDetail] pokemon_card_details fetch failed:', e);
          }
        }

        // Comic Book detail row — only ever fetched here, same reasoning as
        // pokemonDetails above.
        if (data.item_type === 'comic_book') {
          try {
            const details = await getComicBookDetails(data.id);
            setComicDetails(details);
            setComicForm(comicItemToForm(data, details));
          } catch (e) {
            if (__DEV__) console.error('[ItemDetail] comic_book_details fetch failed:', e);
          }
        }
      }
      setFetching(false);
    }
    fetchItem();
  }, [id, currentUserId]);

  // Legacy items (and, defensively, any item whose creation-time gallery
  // row is somehow missing) predate this feature and only have
  // collection_items.image_url — self-heal into a real gallery row on
  // entering edit mode so the gallery manager always operates on real rows
  // (the migration's backfill already does this in bulk for every item
  // that existed at deploy time; this covers the rare gap).
  async function enterEdit() {
    if (!isOwner) return;
    if (item) {
      setForm(itemToForm(item));
      setEditItemIsPublic(item.is_public);
      if (item.item_type === 'pokemon') {
        setPokemonForm(pokemonItemToForm(item, pokemonDetails));
      }
      if (item.item_type === 'comic_book') {
        setComicForm(comicItemToForm(item, comicDetails));
      }
    }
    if (!galleryLoading && galleryImages.length === 0 && item?.image_url && currentUserId) {
      try {
        await materializeLegacyItemImage(item.id, currentUserId, item.image_url);
        await refreshGalleryImages();
      } catch {
        // Best-effort — edit mode still opens; the gallery manager simply
        // starts empty and the next successful add becomes primary.
      }
    }
    setEditMode(true);
  }

  function cancelEdit() {
    if (item) {
      setForm(itemToForm(item));
      setEditItemIsPublic(item.is_public);
      if (item.item_type === 'pokemon') {
        setPokemonForm(pokemonItemToForm(item, pokemonDetails));
      }
      if (item.item_type === 'comic_book') {
        setComicForm(comicItemToForm(item, comicDetails));
      }
    }
    setEditMode(false);
  }

  function updatePokemonField(key: keyof PokemonEditForm) {
    return (value: string) =>
      setPokemonForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateComicField(key: keyof ComicEditForm) {
    return (value: string) =>
      setComicForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function setComicFieldValue<K extends keyof ComicEditForm>(key: K, value: ComicEditForm[K]) {
    setComicForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateField(key: keyof EditForm) {
    return (value: string) =>
      setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleAddPhotos() {
    if (!item || !currentUserId) return;
    const remaining = MAX_ITEM_IMAGES - galleryImages.length;
    if (remaining <= 0) {
      Alert.alert('Limit reached', `You can add up to ${MAX_ITEM_IMAGES} photos per item.`);
      return;
    }
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
    });
    if (result.canceled || !result.assets.length) return;

    // Queue every selected asset through PhotoAdjuster (one at a time, in
    // the order iOS returned them) instead of uploading the raw picker
    // output directly — see the PhotoAdjuster render below and
    // handleQueuedPhotoAdjusted/handleQueuedPhotoSkipped.
    setQueueAdjustedUris([]);
    setQueueIndex(0);
    setPhotoQueue(result.assets.map((asset) => ({ uri: asset.uri, width: asset.width, height: asset.height })));
  }

  // Runs once the queue is done — either every photo was adjusted/skipped,
  // or the user hit Cancel partway through — and uploads whatever was
  // actually adjusted. Can run with anywhere from 0 to photoQueue.length
  // uris.
  async function finishPhotoQueue(adjustedUris: string[]) {
    setPhotoQueue([]);
    setQueueIndex(0);
    setQueueAdjustedUris([]);
    if (adjustedUris.length === 0 || !currentUserId) return;
    try {
      const { failed } = await addGalleryImages(currentUserId, adjustedUris);
      if (failed > 0) {
        Alert.alert(
          'Some photos failed',
          `${failed} of ${adjustedUris.length} photo${adjustedUris.length === 1 ? '' : 's'} could not be uploaded. The rest were added.`,
        );
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    }
  }

  function handleQueuedPhotoAdjusted(uri: string) {
    const adjusted = [...queueAdjustedUris, uri];
    if (queueIndex + 1 < photoQueue.length) {
      setQueueAdjustedUris(adjusted);
      setQueueIndex(queueIndex + 1);
    } else {
      finishPhotoQueue(adjusted);
    }
  }

  // Skip discards only the current photo and continues to the next one —
  // distinct from Cancel below, which stops the whole remaining queue.
  function handleQueuedPhotoSkipped() {
    if (queueIndex + 1 < photoQueue.length) {
      setQueueIndex(queueIndex + 1);
    } else {
      finishPhotoQueue(queueAdjustedUris);
    }
  }

  // Cancel stops the ENTIRE remaining queue (this photo plus every
  // unprocessed one after it) but keeps whatever was already accepted via
  // Use Photo earlier in this same batch — never silently treated the same
  // as Skip.
  function handleQueueCancelled() {
    finishPhotoQueue(queueAdjustedUris);
  }

  async function handleRemovePhoto(imageId: string) {
    try {
      await removeGalleryImage(imageId);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not remove photo.');
    }
  }

  async function handleSetPrimaryPhoto(imageId: string) {
    try {
      await setPrimaryGalleryImage(imageId);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not update cover photo.');
    }
  }

  async function handleReorderPhotos(orderedIds: string[]) {
    try {
      await reorderGalleryImages(orderedIds);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not reorder photos.');
    }
  }

  // Pokémon edit-save — routes through update_pokemon_item (lib/pokemon-items.ts)
  // instead of a plain client update, so the common collection_items fields
  // and pokemon_card_details are written atomically in one transaction, same
  // reasoning as create_pokemon_item at creation time. item_type itself is
  // never part of either payload — treated as fixed once the item exists
  // (also enforced independently at the database privilege level, see that
  // RPC's own header comment).
  async function handleSavePokemon() {
    if (!item || !pokemonForm || !currentUserId) return;
    if (!pokemonForm.pokemonName.trim()) {
      Alert.alert('Pokémon name required', 'Please enter the Pokémon name for this card.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updatePokemonItem(item.id, {
        estimatedValue: pokemonForm.estimatedValue ? parseFloat(pokemonForm.estimatedValue) : null,
        description: pokemonForm.description.trim() || null,
        isPublic: editItemIsPublic,
        pokemonName: pokemonForm.pokemonName.trim() || null,
        setName: pokemonForm.setName.trim() || null,
        cardNumber: pokemonForm.cardNumber.trim() || null,
        rarity: pokemonForm.rarity.trim() || null,
        language: pokemonForm.language.trim() || null,
        edition: pokemonForm.edition.trim() || null,
        holoType: pokemonForm.holoType.trim() || null,
        gradingCompany: pokemonForm.gradingCompany.trim() || null,
        grade: pokemonForm.grade.trim() || null,
      });
      // The RPC returns only the updated collection_items row — the detail
      // row is rebuilt locally from the exact values just submitted (the
      // RPC applied the same trim/NULLIF rules server-side) rather than a
      // second round-trip re-read, same "trust what was just sent" pattern
      // handleSave below already uses for the sports-card common fields.
      const updatedDetails: PokemonCardDetails = {
        item_id: item.id,
        pokemon_name: pokemonForm.pokemonName.trim() || null,
        set_name: pokemonForm.setName.trim() || null,
        card_number: pokemonForm.cardNumber.trim() || null,
        rarity: pokemonForm.rarity.trim() || null,
        language: pokemonForm.language.trim() || null,
        edition: pokemonForm.edition.trim() || null,
        holo_type: pokemonForm.holoType.trim() || null,
        grading_company: pokemonForm.gradingCompany.trim() || null,
        grade: pokemonForm.grade.trim() || null,
      };
      setItem(updated);
      setEditItemIsPublic(updated.is_public);
      setPokemonDetails(updatedDetails);
      setPokemonForm(pokemonItemToForm(updated, updatedDetails));
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  // Comic edit-save — routes through update_comic_book_item (lib/comic-book-items.ts)
  // instead of a plain client update, same atomic-write reasoning as
  // handleSavePokemon above. item_type itself is never part of the payload —
  // fixed once the item exists.
  async function handleSaveComic() {
    if (!item || !comicForm || !currentUserId) return;
    if (!comicForm.seriesTitle.trim()) {
      Alert.alert('Series / Title required', 'Please enter the series or title for this comic.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateComicBookItem(item.id, {
        estimatedValue: comicForm.estimatedValue ? parseFloat(comicForm.estimatedValue) : null,
        description: comicForm.description.trim() || null,
        isPublic: editItemIsPublic,
        seriesTitle: comicForm.seriesTitle.trim() || null,
        issueNumber: comicForm.issueNumber.trim() || null,
        publisher: comicForm.publisher.trim() || null,
        publicationYear: comicForm.publicationYear ? parseInt(comicForm.publicationYear, 10) : null,
        volume: comicForm.volume.trim() || null,
        coverVariant: comicForm.coverVariant.trim() || null,
        printing: comicForm.printing.trim() || null,
        conditionType: comicForm.conditionType,
        condition: comicForm.condition.trim() || null,
        gradingCompany: comicForm.gradingCompany.trim() || null,
        grade: comicForm.grade.trim() || null,
        certificationNumber: comicForm.certificationNumber.trim() || null,
        labelType: comicForm.labelType.trim() || null,
        pageQuality: comicForm.pageQuality.trim() || null,
        isKeyIssue: comicForm.isKeyIssue,
        keyTypes: comicForm.keyTypes,
        keyDescription: comicForm.keyDescription.trim() || null,
        characters: comicForm.characters.trim() || null,
        storyArc: comicForm.storyArc.trim() || null,
        writer: comicForm.writer.trim() || null,
        interiorArtist: comicForm.interiorArtist.trim() || null,
        coverArtist: comicForm.coverArtist.trim() || null,
        edition: comicForm.edition.trim() || null,
        variantName: comicForm.variantName.trim() || null,
        variantArtist: comicForm.variantArtist.trim() || null,
        incentiveRatio: comicForm.incentiveRatio.trim() || null,
        retailerExclusive: comicForm.retailerExclusive.trim() || null,
        specialCoverFinish: comicForm.specialCoverFinish.trim() || null,
        countryMarket: comicForm.countryMarket.trim() || null,
        isSigned: comicForm.isSigned,
        signedBy: comicForm.signedBy.trim() || null,
        signatureAuthentication: comicForm.signatureAuthentication.trim() || null,
        isRestored: comicForm.isRestored,
        restorationNotes: comicForm.restorationNotes.trim() || null,
      });
      // Same "trust what was just sent" reconstruction handleSavePokemon
      // already uses, rather than a second round-trip re-read — the RPC
      // applied the same trim/NULLIF/conditional-nulling rules server-side.
      const updatedDetails: ComicBookDetails = {
        item_id: item.id,
        series_title: comicForm.seriesTitle.trim() || null,
        issue_number: comicForm.issueNumber.trim() || null,
        publisher: comicForm.publisher.trim() || null,
        publication_year: comicForm.publicationYear ? parseInt(comicForm.publicationYear, 10) : null,
        volume: comicForm.volume.trim() || null,
        cover_variant: comicForm.coverVariant.trim() || null,
        printing: comicForm.printing.trim() || null,
        condition_type: comicForm.conditionType,
        condition: comicForm.conditionType === 'raw' ? comicForm.condition.trim() || null : null,
        grading_company: comicForm.conditionType === 'graded' ? comicForm.gradingCompany.trim() || null : null,
        grade: comicForm.conditionType === 'graded' ? comicForm.grade.trim() || null : null,
        certification_number: comicForm.conditionType === 'graded' ? comicForm.certificationNumber.trim() || null : null,
        label_type: comicForm.conditionType === 'graded' ? comicForm.labelType.trim() || null : null,
        page_quality: comicForm.conditionType === 'graded' ? comicForm.pageQuality.trim() || null : null,
        is_key_issue: comicForm.isKeyIssue,
        key_types: comicForm.isKeyIssue ? comicForm.keyTypes : [],
        key_description: comicForm.isKeyIssue ? comicForm.keyDescription.trim() || null : null,
        characters: comicForm.characters.trim() || null,
        story_arc: comicForm.storyArc.trim() || null,
        writer: comicForm.writer.trim() || null,
        interior_artist: comicForm.interiorArtist.trim() || null,
        cover_artist: comicForm.coverArtist.trim() || null,
        edition: comicForm.edition.trim() || null,
        variant_name: comicForm.variantName.trim() || null,
        variant_artist: comicForm.variantArtist.trim() || null,
        incentive_ratio: comicForm.incentiveRatio.trim() || null,
        retailer_exclusive: comicForm.retailerExclusive.trim() || null,
        special_cover_finish: comicForm.specialCoverFinish.trim() || null,
        country_market: comicForm.countryMarket.trim() || null,
        is_signed: comicForm.isSigned,
        signed_by: comicForm.isSigned ? comicForm.signedBy.trim() || null : null,
        signature_authentication: comicForm.isSigned ? comicForm.signatureAuthentication.trim() || null : null,
        is_restored: comicForm.isRestored,
        restoration_notes: comicForm.isRestored ? comicForm.restorationNotes.trim() || null : null,
      };
      setItem(updated);
      setEditItemIsPublic(updated.is_public);
      setComicDetails(updatedDetails);
      setComicForm(comicItemToForm(updated, updatedDetails));
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!item || !currentUserId) return;
    if (item.item_type === 'pokemon') {
      await handleSavePokemon();
      return;
    }
    if (item.item_type === 'comic_book') {
      await handleSaveComic();
      return;
    }
    if (!form) return;
    setSaving(true);
    try {
      // image_url is no longer written here — it's owned exclusively by the
      // gallery helpers (lib/item-images.ts), which keep it synced to
      // whichever photo is currently primary as soon as a gallery action
      // happens, independent of this Save button.
      const { data: updated, error } = await supabase
        .from('collection_items')
        .update({
          title: form.title.trim() || null,
          player: form.player.trim() || null,
          team: form.team.trim() || null,
          year: form.year ? parseInt(form.year, 10) : null,
          brand: form.brand.trim() || null,
          grade: form.grade.trim() || null,
          grading_company: form.gradingCompany.trim() || null,
          serial_number: form.serialNumber.trim() || null,
          estimated_value: form.estimatedValue ? parseFloat(form.estimatedValue) : null,
          description: form.description.trim() || null,
          is_public: editItemIsPublic,
        })
        .eq('id', item.id)
        .select()
        .single();

      if (error) throw new Error('Failed to save changes. Please try again.');
      if (updated) {
        setItem(updated);
        setForm(itemToForm(updated));
        setEditItemIsPublic(updated.is_public);
      }
      setEditMode(false);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  // Move Item — the modal itself owns the folder picker UI and the
  // folder_id UPDATE (including its own error handling/re-entrancy guard);
  // this screen only owns reflecting the confirmed result: update local
  // `item` state so the new folder is visible immediately (no refetch
  // needed), close the picker, and show a brief non-blocking confirmation.
  // Source/destination folder screens (Collections tab, folder detail) are
  // not told about this directly — both already re-fetch their own folder/
  // item queries on every useFocusEffect refocus, so navigating back to
  // either after a move picks it up automatically, same as every other
  // cross-screen mutation in this app.
  // MoveItemModal now returns only the destination folder id (it shares
  // move_collection_items with bulk mode, which only ever returns a moved
  // row count, not full rows) — a move never touches anything about the
  // item besides its folder_id, so patching that one field locally is
  // exactly as correct as replacing the whole row would be, with no extra
  // round-trip.
  function handleItemMoved(destinationFolderId: string, folderName: string) {
    setItem((prev) => (prev ? { ...prev, folder_id: destinationFolderId } : prev));
    setShowMoveModal(false);
    Alert.alert('Moved', `Moved to ${folderName}`);
  }

  // Reconciliation for the two ambiguous delete outcomes (resolved {error}
  // and thrown exception) — both can mean either "never committed" or
  // "committed but the response was lost", and the two are indistinguishable
  // from the client's perspective without an authoritative re-read.
  //
  // Queries by id only, with no .eq('user_id', ...) filter — but this is
  // always the CALLER'S OWN just-attempted delete (handleDelete is
  // owner-gated), and items_select_public's owner clause (auth.uid() =
  // collection_items.user_id) grants the owner full read access regardless
  // of either the folder's or the item's own is_public flag (see
  // supabase/migrations/20260819120000_enforce_collection_folder_privacy.sql
  // and 20260825120000_add_collection_item_privacy.sql). So a null result
  // here still reliably means "this row does not exist" for this specific
  // caller, never "exists but hidden from this viewer" — this is
  // authoritative for "does the item still exist", which is the only
  // question that matters for reconciling a delete this user already
  // issued. (It is NOT authoritative in general — a non-owner's SELECT can
  // return null for a row that exists but is private to them; that's an
  // intentional RLS property, not a bug, and irrelevant here since this
  // function is never called for anyone but the owner.)
  //
  // Catches its own read failure internally so it never rethrows into a
  // second reconciliation attempt.
  async function reconcileItemDeleteAfterError(itemId: string, capturedPaths: string[]) {
    try {
      const { data, error } = await supabase
        .from('collection_items')
        .select('id')
        .eq('id', itemId)
        .maybeSingle();

      if (error) {
        console.error('[ItemDetail] reconciliation read failed:', error.message, error);
        Alert.alert(
          'Delete status unknown',
          "We couldn't confirm whether the item was deleted. Refresh your collection before trying again.",
        );
        return;
      }

      if (data === null) {
        await cleanupOrphanedItemImages(capturedPaths);
        router.back();
        return;
      }

      console.error('[ItemDetail] reconciliation confirms item still exists:', { itemId });
      Alert.alert('Delete failed', 'This item could not be deleted. Please try again.');
    } catch (e) {
      console.error('[ItemDetail] reconciliation read threw:', e);
      Alert.alert(
        'Delete status unknown',
        "We couldn't confirm whether the item was deleted. Refresh your collection before trying again.",
      );
    }
  }

  // deletingRef is the actual re-entry lock: it's acquired synchronously
  // here, before Alert.alert is even shown, so a second tap on the delete
  // button while the confirmation dialog is already open bails out above
  // without ever queueing a second dialog. It's released on Cancel and on
  // Android's outside-tap/back-button dismissal (onDismiss below); on
  // Delete it stays held through the whole mutation and is only released in
  // the mutation's own finally. `settled` (local per invocation, not state)
  // distinguishes "a button already claimed this dismissal" from a bare
  // onDismiss, since Android fires onDismiss after every button press too —
  // without that guard, onDismiss would immediately re-release the lock
  // while the Delete mutation it just started is still in flight.
  // `deleting` (React state) is separate: it only reflects the actual
  // mutation/loading window, for button UI, not the confirmation-dialog
  // window.
  function handleDelete() {
    if (deletingRef.current) return;
    deletingRef.current = true;

    let settled = false;

    const title = isTransferredOut ? 'Remove from Collection?' : 'Delete Item';
    const body = isTransferredOut
      ? 'This permanently removes this historical item from your collection. It will not affect the transferred Cache ID or the recipient\'s ownership.'
      : 'Are you sure? This cannot be undone.';
    Alert.alert(
      title,
      body,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            settled = true;
            deletingRef.current = false;
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            settled = true;
            if (!currentUserId) {
              deletingRef.current = false;
              return;
            }

            setDeleting(true);

            // Gallery storage_path values must be captured before the
            // parent DELETE — ON DELETE CASCADE destroys the
            // collection_item_images rows the instant it commits, so this
            // is the last point they're readable. Best-effort only: Storage
            // cleanup must never block the authoritative item deletion.
            let capturedPaths: string[] = [];
            try {
              const { data: galleryRows, error: galleryReadError } = await supabase
                .from('collection_item_images')
                .select('storage_path')
                .eq('item_id', id);
              if (!galleryReadError && galleryRows) {
                capturedPaths = galleryRows.map((r) => r.storage_path).filter((p): p is string => !!p);
              }
            } catch (galleryReadErr) {
              if (__DEV__) {
                console.warn('[ItemDetail] pre-delete gallery path capture failed:', galleryReadErr);
              }
            }

            // No manual posts cleanup here — posts.item_id is FK'd to
            // collection_items(id) ON DELETE SET NULL (see supabase/
            // schema.sql), so any post referencing this item is preserved
            // (its own image_url/caption are already denormalized onto the
            // post row at creation time) and just loses its "view original
            // card" link, exactly like the card_share_items/
            // rate_my_grail_cards snapshot pattern. A manual delete()...
            // eq('item_id', id) here would be a second, non-atomic
            // destructive operation — if it succeeded but the item delete
            // below then failed, the user's feed post would be gone while
            // the collection item survived.

            try {
              // .select('id') is what makes a silently-zero-row delete (e.g.
              // an RLS/ownership mismatch) detectable at all — without it, a
              // DELETE whose WHERE clause (id + the RLS USING policy)
              // matches nothing still returns { error: null },
              // indistinguishable from success. The .eq('user_id',
              // currentUserId) is a defense-in-depth client-side ownership
              // check on top of RLS, not a replacement for it.
              const { data: deletedRows, error: deleteError } = await supabase
                .from('collection_items')
                .delete()
                .eq('id', id)
                .eq('user_id', currentUserId)
                .select('id');

              if (deleteError) {
                console.error('[ItemDetail] delete failed:', deleteError.message, deleteError);
                await reconcileItemDeleteAfterError(id, capturedPaths);
                return;
              }

              if (!deletedRows || deletedRows.length === 0) {
                console.error('[ItemDetail] delete returned zero rows:', { itemId: id, currentUserId });
                Alert.alert('Delete failed', 'No item was deleted. Check ownership and database permissions.');
                return;
              }

              await cleanupOrphanedItemImages(capturedPaths);
              router.back();
            } catch (e) {
              console.error('[ItemDetail] delete threw:', e);
              await reconcileItemDeleteAfterError(id, capturedPaths);
            } finally {
              deletingRef.current = false;
              setDeleting(false);
            }
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          if (!settled) {
            deletingRef.current = false;
          }
        },
      },
    );
  }

  function handleRegisterPress() {
    if (!item || !isOwner || registering) return;
    Alert.alert(
      'Register with CacheCase?',
      'Registration creates a permanent CacheCase identity and provenance record for this physical card.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Register',
          onPress: async () => {
            const { error, registeredCardId } = await registerItem({
              serialNumber: item.serial_number,
              gradeCompany: item.grading_company,
              grade: item.grade,
            });
            if (!error) return;

            // registeredCardId is only present when the registered_cards
            // row itself was created — i.e. the failure is scoped to the
            // durable image copy, not the registration itself. Retrying
            // here re-invokes only that copy (via retrySnapshotImage), and
            // never register_card again, so it can't produce a duplicate
            // registration or the "already registered" rejection a full
            // re-registration attempt would hit.
            if (registeredCardId) {
              Alert.alert('Registry image not saved', error, [
                { text: 'Later', style: 'cancel' },
                {
                  text: 'Retry',
                  onPress: async () => {
                    const { error: retryError } = await retrySnapshotImage(registeredCardId);
                    if (retryError) {
                      Alert.alert('Retry failed', retryError);
                    }
                  },
                },
              ]);
            } else {
              Alert.alert('Registration failed', error);
            }
          },
        },
      ],
    );
  }

  function handleViewRegistry() {
    if (!registeredCard) return;
    router.push({ pathname: '/registry/[id]', params: { id: registeredCard.id } });
  }

  // Consolidated CacheCase ID entry point — replaces the old ItemActionBar
  // logo button's placeholder sheet. Reuses handleViewRegistry rather than
  // duplicating the navigation call.
  function handleCacheCaseIdPress() {
    if (registryLoading) return;
    if (registeredCard) {
      handleViewRegistry();
      return;
    }
    Alert.alert('Not Registered', 'This card has not been registered with CacheCase yet.');
  }

  // Same native Share.share()+deep-link pattern as
  // app/collection/[folderId].tsx's own handleShare — not a new share
  // mechanism, just the existing one pointed at an item deep link instead
  // of a collection one. item.title (not the richer, type-specific
  // `identity.title` computed just below, near the JSX) — plain and
  // available regardless of item_type, and this function is defined well
  // above that computation.
  async function handleShare() {
    if (!item) return;
    const handle = isOwner
      ? (session?.user?.email?.split('@')[0] ?? 'me')
      : (ownerProfile?.username ?? 'user');
    const title = item.title || 'this card';
    try {
      await Share.share({
        title,
        message: `Check out "${title}" by @${handle} on The Collection Room\nthecollectionroom://item/${item.id}`,
      });
    } catch {
      // user dismissed share sheet — no-op
    }
  }

  async function handleGrailsToggle() {
    if (!item) return;
    setGrailsLoading(true);
    if (isInGrails(item.id)) {
      await removeFromGrails(item.id);
    } else {
      await addToGrails(item.id);
    }
    setGrailsLoading(false);
  }

  // View-mode carousel now renders through the signed-delivery Edge
  // Function (item-images beta privacy hardening, Phase 3) instead of each
  // row's raw public image_url — one batched call for the whole gallery,
  // fired the moment `galleryImages` itself is known (see useItemImages),
  // never waiting on anything else first.
  const galleryImageIds = useMemo(() => galleryImages.map((img) => img.id), [galleryImages]);
  const { urls: signedGalleryUrls, statuses: signedGalleryStatuses } = useSignedItemImages(galleryImageIds);

  // Gallery STRUCTURE vs. IMAGE AVAILABILITY are deliberately separate here.
  // One carouselImages entry per gallery row, ALWAYS — never filtered down
  // to only the rows whose signed URL has resolved so far. That filtering
  // used to be exactly what made a 2-photo item render as a single,
  // non-paginated image for however long signing took: galleryImageUrls
  // (the old plain string[]) only grew to length 2 once BOTH signed URLs
  // were in, so ItemImageCarousel never even learned a second photo
  // existed until then. Now `carouselImages.length` reflects the gallery
  // row count immediately; a still-unresolved row just carries `uri:
  // undefined` and its own real `status` ('loading' or 'unavailable', read
  // straight off useSignedItemImages' existing statuses map — no second
  // signing call) and fills in, in place, once its own url resolves — the
  // array's own length/order never changes at that point, only that one
  // entry's `uri`/`status`. This is also what lets ItemImageCarousel show
  // an honest "still loading" spinner instead of "No image" for a slide
  // that simply hasn't resolved yet (see CarouselImage's own status
  // comment in item-image-carousel.tsx). Falls back to the legacy single
  // image_url only when the gallery genuinely has no rows yet (a rare gap
  // Phase 1A's backfill — and enterEdit's self-heal — mostly close); that
  // narrow fallback has no real collection_item_images.id (a stable
  // synthetic one is used purely as a React/FlatList key) and no signing
  // status at all — it's either a real, permanent uri or nothing, so
  // `status` is left unset there, which ItemImageCarousel already treats
  // as "not loading" (i.e. genuinely unavailable, never a fake spinner).
  const carouselImages: CarouselImage[] = useMemo(() => {
    if (galleryImages.length > 0) {
      return galleryImages.map((img) => ({
        id: img.id,
        uri: signedGalleryUrls.get(img.id),
        status: signedGalleryStatuses.get(img.id),
        cacheKey: itemImageCacheKey(cacheIdentity, img.id),
      }));
    }
    return buildItemImageList([item?.image_url]).map((uri, i) => ({
      id: `legacy-${item?.id ?? 'unknown'}-${i}`,
      uri,
    }));
  }, [galleryImages, signedGalleryUrls, signedGalleryStatuses, cacheIdentity, item?.image_url, item?.id]);

  const headerTitle = editMode ? 'Edit Item' : (item?.title ?? 'Item Detail');

  if (fetching) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <ItemDetailHeaderBar
          insetsTop={insets.top}
          title="Item Detail"
          left={<BackButton fallbackHref="/(tabs)" />}
        />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </View>
    );
  }

  if (!item || !form) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <ItemDetailHeaderBar
          insetsTop={insets.top}
          title="Item Not Found"
          left={<BackButton fallbackHref="/(tabs)" />}
        />
        <View style={styles.center}>
          <Text style={styles.errorText}>Item not found.</Text>
        </View>
      </View>
    );
  }

  const identity = isPokemonItem
    ? buildPokemonIdentity(item, pokemonDetails)
    : isComicBookItem
      ? buildComicIdentity(item, comicDetails)
      : buildIdentity(item);
  const metadataRows = isPokemonItem
    ? buildPokemonMetadataRows(item, pokemonDetails)
    : isComicBookItem
      ? buildComicMetadataRows(item, comicDetails)
      : buildMetadataRows(item);
  const transferredOutDateLabel = formatTransferredOutDate(item.transferred_out_at);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Non-owner viewers get no header-right control — unchanged from
          before. The ItemActionBar bookmark that used to sit lower on the
          screen is gone (Bookmark-removal pass); that row's right-hand
          slot is now Share (handleShare, below), shown for every viewer
          including the owner. */}
      <ItemDetailHeaderBar
        insetsTop={insets.top}
        title={headerTitle}
        left={
          editMode ? (
            <TouchableOpacity onPress={cancelEdit} style={styles.headerBtn}>
              <Text style={[styles.headerBtnText, styles.cancelBtnText]}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <BackButton fallbackHref="/(tabs)" />
          )
        }
        right={
          isOwner && !isTransferredOut ? (
            editMode ? (
              <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.headerBtn}>
                {saving ? (
                  <ActivityIndicator size="small" color="#0a7ea4" />
                ) : (
                  <Text style={styles.headerBtnText}>Save</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={enterEdit} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Edit</Text>
              </TouchableOpacity>
            )
          ) : undefined
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? undefined : 'height'}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          onScroll={navbarOnScroll}
          scrollEventThrottle={navbarScrollEventThrottle}>

          {/* Instagram-style owner identity row — avatar + @username,
              directly above the hero image below. Shown for every viewer
              (owner included, same as Instagram's own post header), purely
              a navigation/identity row: no edit affordance, and it doesn't
              affect the existing owner-only card further down the screen
              (that one stays gated to !isOwner). */}
          {ownerProfile && (
            <ItemOwnerRow
              username={ownerProfile.username}
              avatarUrl={ownerProfile.avatar_url}
              onPress={() =>
                navigateToProfile(router, currentUserId, item?.user_id ?? '', ownerProfile.username)
              }
            />
          )}

          {/* Hero — edit mode shows the editable gallery manager (add/
              remove/reorder/set cover); view mode shows the swipeable
              carousel. Both read from the same useItemImages data, so what
              you arrange in edit mode is exactly what view mode swipes
              through. The carousel's own tap is reserved for a future
              full-screen viewer. */}
          {editMode ? (
            <ItemImageGalleryManager
              images={galleryImages}
              loading={galleryLoading}
              mutating={galleryMutating}
              maxImages={MAX_ITEM_IMAGES}
              onAdd={handleAddPhotos}
              onRemove={handleRemovePhoto}
              onSetPrimary={handleSetPrimaryPhoto}
              onReorder={handleReorderPhotos}
            />
          ) : (
            <ItemImageCarousel images={carouselImages} />
          )}

          {editMode ? (
            /* ── Edit Mode (owner only) — existing form, plus the Private
                Item toggle below (same dynamic label/helper pattern as
                create-folder-modal.tsx / folder-edit-modal.tsx). ── */
            <View style={styles.editSection}>
              {isPokemonItem ? (
                pokemonForm && (
                  <>
                    {/* Pokémon Details */}
                    <Text style={editStyles.sectionHeader}>Pokémon Details</Text>
                    <EditField label="Pokémon" value={pokemonForm.pokemonName} onChange={updatePokemonField('pokemonName')} />
                    <EditField label="Set" value={pokemonForm.setName} onChange={updatePokemonField('setName')} />
                    <EditField label="Card Number" value={pokemonForm.cardNumber} onChange={updatePokemonField('cardNumber')} />
                    <EditField label="Rarity" value={pokemonForm.rarity} onChange={updatePokemonField('rarity')} />
                    <EditField label="Language" value={pokemonForm.language} onChange={updatePokemonField('language')} />
                    <EditField label="Edition" value={pokemonForm.edition} onChange={updatePokemonField('edition')} />
                    <EditField label="Holo Type" value={pokemonForm.holoType} onChange={updatePokemonField('holoType')} />

                    {/* Grading */}
                    <Text style={editStyles.sectionHeader}>Grading</Text>
                    <EditField label="Grading Company" value={pokemonForm.gradingCompany} onChange={updatePokemonField('gradingCompany')} />
                    <EditField label="Grade" value={pokemonForm.grade} onChange={updatePokemonField('grade')} extra={{ autoCapitalize: 'characters' }} />

                    {/* Value & Notes */}
                    <Text style={editStyles.sectionHeader}>Value & Notes</Text>
                    <EditField label="Estimated Value ($)" value={pokemonForm.estimatedValue} onChange={updatePokemonField('estimatedValue')} extra={{ keyboardType: 'decimal-pad' }} />
                    <View style={editStyles.wrap}>
                      <Text style={editStyles.label}>Description</Text>
                      <TextInput
                        style={[editStyles.input, { height: 100, paddingTop: 12 }]}
                        value={pokemonForm.description}
                        onChangeText={updatePokemonField('description')}
                        placeholder="Description"
                        placeholderTextColor="#999"
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                      />
                    </View>
                  </>
                )
              ) : isComicBookItem ? (
                comicForm && (
                  <>
                    {/* Main Comic Information */}
                    <Text style={editStyles.sectionHeader}>Comic Details</Text>
                    <EditField label="Series / Title" value={comicForm.seriesTitle} onChange={updateComicField('seriesTitle')} />
                    <EditField label="Issue Number" value={comicForm.issueNumber} onChange={updateComicField('issueNumber')} />
                    <EditField label="Publisher" value={comicForm.publisher} onChange={updateComicField('publisher')} />
                    <EditField
                      label="Publication Year"
                      value={comicForm.publicationYear}
                      onChange={updateComicField('publicationYear')}
                      extra={{ keyboardType: 'number-pad', maxLength: 4 }}
                    />
                    <EditField label="Volume" value={comicForm.volume} onChange={updateComicField('volume')} />
                    <EditField label="Cover / Variant" value={comicForm.coverVariant} onChange={updateComicField('coverVariant')} />
                    <SelectField
                      label="Printing"
                      value={comicForm.printing || null}
                      options={COMIC_PRINTING_OPTIONS}
                      onChange={(v) => setComicFieldValue('printing', v)}
                    />

                    {/* Condition */}
                    <Text style={editStyles.sectionHeader}>Condition</Text>
                    <SelectField
                      label="Condition Type"
                      value={comicForm.conditionType === 'graded' ? 'Graded' : 'Raw'}
                      options={['Raw', 'Graded']}
                      onChange={(v) => setComicFieldValue('conditionType', v === 'Graded' ? 'graded' : 'raw')}
                    />
                    {comicForm.conditionType === 'raw' ? (
                      <SelectField
                        label="Condition"
                        value={comicForm.condition || null}
                        options={COMIC_RAW_CONDITION_OPTIONS}
                        onChange={(v) => setComicFieldValue('condition', v)}
                      />
                    ) : (
                      <>
                        <SelectField
                          label="Grading Company"
                          value={comicForm.gradingCompany || null}
                          options={COMIC_GRADING_COMPANY_OPTIONS}
                          onChange={(v) => setComicFieldValue('gradingCompany', v)}
                        />
                        <EditField label="Grade" value={comicForm.grade} onChange={updateComicField('grade')} extra={{ autoCapitalize: 'characters' }} />
                        <EditField label="Certification Number" value={comicForm.certificationNumber} onChange={updateComicField('certificationNumber')} />
                        <EditField label="Label Type" value={comicForm.labelType} onChange={updateComicField('labelType')} />
                        <EditField label="Page Quality" value={comicForm.pageQuality} onChange={updateComicField('pageQuality')} />
                      </>
                    )}

                    {/* Key Issue */}
                    <Text style={editStyles.sectionHeader}>Key Issue</Text>
                    <EditToggleRow
                      label="Key Issue"
                      sublabel="This issue has notable collector significance"
                      value={comicForm.isKeyIssue}
                      onValueChange={(v) => setComicFieldValue('isKeyIssue', v)}
                    />
                    {comicForm.isKeyIssue && (
                      <>
                        <MultiSelectField
                          label="Key Type"
                          values={comicForm.keyTypes}
                          options={COMIC_KEY_TYPE_OPTIONS}
                          onChange={(v) => setComicFieldValue('keyTypes', v)}
                        />
                        <View style={editStyles.wrap}>
                          <Text style={editStyles.label}>Key Description</Text>
                          <TextInput
                            style={[editStyles.input, { height: 80, paddingTop: 12 }]}
                            value={comicForm.keyDescription}
                            onChangeText={updateComicField('keyDescription')}
                            placeholder="e.g. First full appearance of Venom"
                            placeholderTextColor="#999"
                            multiline
                            numberOfLines={3}
                            textAlignVertical="top"
                          />
                        </View>
                      </>
                    )}

                    {/* Additional Details */}
                    <CollapsibleSection title="Additional Details">
                      <EditField label="Characters" value={comicForm.characters} onChange={updateComicField('characters')} />
                      <EditField label="Story Arc / Event" value={comicForm.storyArc} onChange={updateComicField('storyArc')} />
                      <EditField label="Writer" value={comicForm.writer} onChange={updateComicField('writer')} />
                      <EditField label="Interior Artist" value={comicForm.interiorArtist} onChange={updateComicField('interiorArtist')} />
                      <EditField label="Cover Artist" value={comicForm.coverArtist} onChange={updateComicField('coverArtist')} />
                      <SelectField
                        label="Edition"
                        value={comicForm.edition || null}
                        options={COMIC_EDITION_OPTIONS}
                        onChange={(v) => setComicFieldValue('edition', v)}
                      />
                      <EditField label="Variant Name" value={comicForm.variantName} onChange={updateComicField('variantName')} />
                      <EditField label="Variant Artist" value={comicForm.variantArtist} onChange={updateComicField('variantArtist')} />
                      <EditField label="Incentive Ratio" value={comicForm.incentiveRatio} onChange={updateComicField('incentiveRatio')} />
                      <EditField label="Retailer Exclusive" value={comicForm.retailerExclusive} onChange={updateComicField('retailerExclusive')} />
                      <SelectField
                        label="Special Cover / Finish"
                        value={comicForm.specialCoverFinish || null}
                        options={COMIC_SPECIAL_COVER_FINISH_OPTIONS}
                        onChange={(v) => setComicFieldValue('specialCoverFinish', v)}
                      />
                      <EditField label="Country / Market" value={comicForm.countryMarket} onChange={updateComicField('countryMarket')} />

                      <EditToggleRow
                        label="Signed"
                        sublabel="This copy has been autographed"
                        value={comicForm.isSigned}
                        onValueChange={(v) => setComicFieldValue('isSigned', v)}
                      />
                      {comicForm.isSigned && (
                        <>
                          <EditField label="Signed By" value={comicForm.signedBy} onChange={updateComicField('signedBy')} />
                          <EditField
                            label="Signature Authentication"
                            value={comicForm.signatureAuthentication}
                            onChange={updateComicField('signatureAuthentication')}
                          />
                        </>
                      )}

                      <EditToggleRow
                        label="Restored"
                        sublabel="This copy has undergone restoration work"
                        value={comicForm.isRestored}
                        onValueChange={(v) => setComicFieldValue('isRestored', v)}
                      />
                      {comicForm.isRestored && (
                        <View style={editStyles.wrap}>
                          <Text style={editStyles.label}>Restoration Notes</Text>
                          <TextInput
                            style={[editStyles.input, { height: 80, paddingTop: 12 }]}
                            value={comicForm.restorationNotes}
                            onChangeText={updateComicField('restorationNotes')}
                            placeholder="Restoration Notes"
                            placeholderTextColor="#999"
                            multiline
                            numberOfLines={3}
                            textAlignVertical="top"
                          />
                        </View>
                      )}
                    </CollapsibleSection>

                    {/* Value & Notes */}
                    <Text style={editStyles.sectionHeader}>Value & Notes</Text>
                    <EditField label="Estimated Value ($)" value={comicForm.estimatedValue} onChange={updateComicField('estimatedValue')} extra={{ keyboardType: 'decimal-pad' }} />
                    <View style={editStyles.wrap}>
                      <Text style={editStyles.label}>Description</Text>
                      <TextInput
                        style={[editStyles.input, { height: 100, paddingTop: 12 }]}
                        value={comicForm.description}
                        onChangeText={updateComicField('description')}
                        placeholder="Description"
                        placeholderTextColor="#999"
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                      />
                    </View>
                  </>
                )
              ) : (
                <>
                  <Text style={editStyles.sectionHeader}>Card Details</Text>
                  <EditField label="Title" value={form.title} onChange={updateField('title')} />
                  <EditField label="Player" value={form.player} onChange={updateField('player')} />
                  <EditField label="Team" value={form.team} onChange={updateField('team')} />
                  <EditField label="Year" value={form.year} onChange={updateField('year')} extra={{ keyboardType: 'number-pad', maxLength: 4 }} />

                  <Text style={editStyles.sectionHeader}>Card Info</Text>
                  <EditField label="Brand" value={form.brand} onChange={updateField('brand')} />
                  <EditField label="Grade" value={form.grade} onChange={updateField('grade')} extra={{ autoCapitalize: 'characters' }} />
                  <EditField label="Grading Company" value={form.gradingCompany} onChange={updateField('gradingCompany')} />
                  <EditField label="Serial Number" value={form.serialNumber} onChange={updateField('serialNumber')} />

                  <Text style={editStyles.sectionHeader}>Value</Text>
                  <EditField label="Estimated Value ($)" value={form.estimatedValue} onChange={updateField('estimatedValue')} extra={{ keyboardType: 'decimal-pad' }} />

                  <Text style={editStyles.sectionHeader}>Notes</Text>
                  <View style={editStyles.wrap}>
                    <Text style={editStyles.label}>Description</Text>
                    <TextInput
                      style={[editStyles.input, { height: 100, paddingTop: 12 }]}
                      value={form.description}
                      onChangeText={updateField('description')}
                      placeholder="Description"
                      placeholderTextColor="#999"
                      multiline
                      numberOfLines={4}
                      textAlignVertical="top"
                    />
                  </View>
                </>
              )}

              {/* Private Item toggle — editItemIsPublic is the field that's
                  actually persisted (see handleSave's update above);
                  editItemIsPrivate is display-only. */}
              <View style={editStyles.toggleRow}>
                <View style={editStyles.toggleTextArea}>
                  <Text style={editStyles.toggleTitle}>
                    {editItemIsPrivate ? 'Private Item' : 'Public Item'}
                  </Text>
                  <Text style={editStyles.toggleHint}>
                    {editItemIsPrivate ? 'Only you can view this item.' : 'Anyone can view this item.'}
                  </Text>
                </View>
                <Switch
                  value={editItemIsPrivate}
                  onValueChange={(value) => setEditItemIsPublic(!value)}
                  trackColor={{ true: '#0a7ea4' }}
                />
              </View>

              {/* Move Item — Phase 1 (single item, no bulk/drag-drop). Opens
                  MoveItemModal's folder picker; that modal owns the actual
                  UPDATE + its own error/re-entrancy handling, this screen
                  only reacts to a confirmed move via handleItemMoved. */}
              <Text style={editStyles.sectionHeader}>Organization</Text>
              <TouchableOpacity
                style={editStyles.moveRow}
                onPress={() => setShowMoveModal(true)}
                activeOpacity={0.7}>
                <Text style={editStyles.moveRowLabel}>Move to Another Folder</Text>
                <IconSymbol name="chevron.right" size={16} color={PV2.textTertiary} />
              </TouchableOpacity>

              {/* Delete Item — moved here from the normal Item Detail view
                  (Save/Cancel live in the header, not this form body, so
                  this is already well separated from them by scroll
                  distance alone; the top divider/spacing below adds a
                  further visual break from the privacy toggle above).
                  Reuses handleDelete unchanged — same confirmation Alert,
                  same DB/Storage cleanup, same navigation, same
                  reconciliation-on-error path as before. */}
              <View style={editStyles.deleteSection}>
                <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={deleting}>
                  <Text style={styles.deleteText}>Delete Item</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : isTransferredOut ? (
            /* ── Transferred Out — one top-level conditional replacing the
                whole normal action area, rather than hiding many
                individual controls. No edit, register, relink, custody,
                transfer, or gallery-edit action exists in this branch at
                all — only the three explicitly allowed actions below. The
                item's own identity/description/metadata still render, as
                historical information. */
            <>
              <View style={styles.transferredOutBanner}>
                <Text style={styles.transferredOutTitle}>Transferred Out</Text>
                <Text style={styles.transferredOutBody}>This card is no longer in your collection.</Text>
                {transferredOutDateLabel && (
                  <Text style={styles.transferredOutDate}>Transferred on {transferredOutDateLabel}</Text>
                )}
              </View>

              <ItemIdentity title={identity.title} subtitleLines={identity.subtitleLines} />

              <ItemDescription description={item.description} />

              <ItemMetadataSection rows={metadataRows} />

              {isOwner && (
                <View style={styles.ownerActions}>
                  {item.transferred_registered_card_id && (
                    <>
                      <TouchableOpacity
                        style={styles.transferredOutActionButton}
                        onPress={() =>
                          router.push({
                            pathname: '/registry/[id]',
                            params: { id: item.transferred_registered_card_id! },
                          })
                        }
                        activeOpacity={0.8}>
                        <Text style={styles.transferredOutActionText}>View Registry</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.transferredOutActionButton}
                        onPress={() =>
                          router.push({
                            pathname: '/registry-history/[id]',
                            params: { id: item.transferred_registered_card_id! },
                          })
                        }
                        activeOpacity={0.8}>
                        <Text style={styles.transferredOutActionText}>View Registry History</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} disabled={deleting}>
                    <Text style={styles.deleteText}>Remove from Collection</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            /* ── View Mode — the new permanent layout ── */
            <>
              <ItemActionBar
                onPressCacheCaseId={handleCacheCaseIdPress}
                onPressComment={() => setItemCommentsVisible(true)}
                liked={itemLiked}
                likeCount={itemLikeCount}
                likeInFlight={itemLikeInFlight}
                onPressLike={toggleItemLike}
                onPressShare={handleShare}
              />

              <ItemIdentity title={identity.title} subtitleLines={identity.subtitleLines} />

              {/* Owner card — only ever reachable for non-owners, since
                  entering edit mode is gated to isOwner above. */}
              {!isOwner && ownerProfile && (
                <TouchableOpacity
                  style={styles.ownerCard}
                  onPress={() =>
                    router.push({
                      pathname: '/user/[username]',
                      params: { username: ownerProfile.username },
                    })
                  }
                  activeOpacity={0.7}>
                  <View style={styles.ownerAvatar}>
                    {ownerProfile.avatar_url ? (
                      <Image
                        source={{ uri: ownerProfile.avatar_url }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={200}
                      />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, styles.ownerAvatarPlaceholder]}>
                        <Text style={styles.ownerAvatarInitial}>
                          {(ownerProfile.display_name || ownerProfile.username).charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.ownerName}>
                    {ownerProfile.display_name || ownerProfile.username}
                  </Text>
                  <Text style={styles.ownerUsername}>@{ownerProfile.username}</Text>
                </TouchableOpacity>
              )}

              <ItemDescription description={item.description} />

              <ItemMetadataSection rows={metadataRows} />

              <RelatedItemsGrid />

              {isOwner && (
                <View style={styles.ownerActions}>
                  {/* Registry remains sports-card-only (Phase 2 of
                      multi-collectible-type support) — this owner-only
                      register action, the only path that ever calls
                      register_card()/populates registry snapshot fields, is
                      hidden entirely for every other item_type. The
                      read-only CacheCase ID button in ItemActionBar above
                      stays visible for every type (registeredCard is simply
                      always null for a non-sports-card item, so it already
                      shows "Not Registered" harmlessly with no RPC call). */}
                  {item.item_type === 'sports_card' &&
                    (registryLoading ? (
                      <View style={styles.registryLoadingWrap}>
                        <ActivityIndicator size="small" color={PV2.textTertiary} />
                      </View>
                    ) : registeredCard ? null : (
                      <TouchableOpacity
                        style={styles.registerButton}
                        onPress={handleRegisterPress}
                        disabled={registering}
                        activeOpacity={0.8}>
                        {registering ? (
                          <>
                            <ActivityIndicator color="#fff" />
                            <Text style={styles.registerButtonText}>Registering…</Text>
                          </>
                        ) : (
                          <>
                            <Text style={styles.registerButtonText}>Register with CacheCase</Text>
                            <Text style={styles.registerButtonSubtext}>
                              Create a permanent CacheCase identity and provenance record for this physical card.
                            </Text>
                          </>
                        )}
                      </TouchableOpacity>
                    ))}

                  {(() => {
                    const inGrails = isInGrails(item.id);
                    const disabled = !inGrails && isFull;
                    return (
                      <TouchableOpacity
                        style={[
                          styles.grailsButton,
                          inGrails && styles.grailsButtonRemove,
                          disabled && styles.grailsButtonDisabled,
                        ]}
                        onPress={handleGrailsToggle}
                        disabled={grailsLoading || disabled}
                        activeOpacity={0.8}>
                        {grailsLoading ? (
                          <ActivityIndicator color={inGrails ? '#C9952C' : '#fff'} />
                        ) : (
                          <Text
                            style={[
                              styles.grailsText,
                              inGrails && styles.grailsTextRemove,
                              disabled && styles.grailsTextDisabled,
                            ]}>
                            {inGrails ? 'Remove from Grails' : disabled ? 'Grails Full' : 'Add to Grails'}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })()}
                </View>
              )}
            </>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {isOwner && (
        <MoveItemModal
          mode="single"
          visible={showMoveModal}
          item={item}
          currentUserId={currentUserId}
          onClose={() => setShowMoveModal(false)}
          onMoved={handleItemMoved}
        />
      )}

      {photoQueue.length > 0 && (
        <PhotoAdjuster
          uri={photoQueue[queueIndex].uri}
          imageWidth={photoQueue[queueIndex].width}
          imageHeight={photoQueue[queueIndex].height}
          progressLabel={photoQueue.length > 1 ? `Photo ${queueIndex + 1} of ${photoQueue.length}` : undefined}
          onUse={handleQueuedPhotoAdjusted}
          onSkip={photoQueue.length > 1 ? handleQueuedPhotoSkipped : undefined}
          onCancel={handleQueueCancelled}
        />
      )}

      <ItemCommentsSheet
        visible={itemCommentsVisible}
        onClose={() => setItemCommentsVisible(false)}
        itemId={id}
        itemTitle={item.title || 'Card'}
        currentUserId={currentUserId}
      />
    </View>
  );
}

const editStyles = StyleSheet.create({
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.40)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.50)',
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: PV2.collectorPanelBg,
    color: PV2.textPrimary,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    padding: 16,
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  toggleTextArea: {
    flex: 1,
    marginRight: 12,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  toggleHint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.50)',
    marginTop: 2,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  moveRowLabel: {
    fontSize: 15,
    color: PV2.textPrimary,
  },
  // Visually separates the destructive Delete Item action (below) from the
  // normal editable controls above it (fields, then the privacy toggle) —
  // same top-divider convention as the view-mode ownerActions section.
  deleteSection: {
    marginTop: 28,
    paddingTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerBtn: {
    paddingHorizontal: 4,
  },
  headerBtnText: {
    color: '#0a7ea4',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelBtnText: {
    color: '#687076',
  },
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    paddingBottom: 48,
  },
  // Owner profile — shrinks to content so only the avatar+name area is tappable
  ownerCard: {
    flexDirection: 'column',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 16,
    gap: 4,
  },
  ownerAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
    marginBottom: 2,
  },
  ownerAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerAvatarInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  ownerName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  ownerUsername: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
    textAlign: 'center',
  },
  // Owner-only management actions — kept at the very bottom, out of the
  // primary browsing flow, per the "understated" design direction.
  ownerActions: {
    marginTop: 32,
    paddingHorizontal: 20,
    gap: 12,
  },
  registryLoadingWrap: {
  minHeight: 104,
  paddingVertical: 18,
  alignItems: 'center',
  justifyContent: 'center',
},
registerButton: {
  backgroundColor: '#A08CDC',
  borderRadius: 12,
  paddingVertical: 15,
  paddingHorizontal: 18,
  alignItems: 'center',
  gap: 5,
},
registerButtonText: {
  color: '#fff',
  fontSize: 16,
  fontWeight: '700',
},
registerButtonSubtext: {
  color: 'rgba(255,255,255,0.82)',
  fontSize: 12,
  textAlign: 'center',
  lineHeight: 17,
  maxWidth: 290,
},
registryStatusCard: {
  borderRadius: 12,
  borderWidth: 1,
  borderColor: 'rgba(160,140,220,0.38)',
  backgroundColor: 'rgba(160,140,220,0.10)',
  paddingVertical: 16,
  paddingHorizontal: 18,
  alignItems: 'center',
  gap: 9,
},
registryStatusRow: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 7,
},
registryStatusDot: {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: '#34C759',
},
registryStatusText: {
  color: 'rgba(255,255,255,0.86)',
  fontSize: 13,
  fontWeight: '700',
  letterSpacing: 0.3,
  textTransform: 'uppercase',
},
registryCcId: {
  color: '#fff',
  fontSize: 20,
  fontWeight: '800',
  letterSpacing: 1.2,
},
registryViewButton: {
  marginTop: 5,
  minHeight: 40,
  paddingVertical: 10,
  paddingHorizontal: 20,
  borderRadius: 20,
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.24)',
  backgroundColor: 'rgba(255,255,255,0.07)',
  alignItems: 'center',
  justifyContent: 'center',
},
registryViewButtonText: {
  color: '#fff',
  fontSize: 14,
  fontWeight: '700',
},
  grailsButton: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  grailsButtonRemove: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#C9952C',
  },
  grailsButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  grailsText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  grailsTextRemove: {
    color: '#C9952C',
  },
  grailsTextDisabled: {
    color: '#999',
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: '#FF3B30',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  deleteText: {
    color: '#FF3B30',
    fontSize: 16,
    fontWeight: '600',
  },
  transferredOutBanner: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  transferredOutTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.accent,
  },
  transferredOutBody: {
    marginTop: 4,
    fontSize: 13,
    color: PV2.textSecondary,
  },
  transferredOutDate: {
    marginTop: 8,
    fontSize: 12,
    color: PV2.textTertiary,
  },
  transferredOutActionButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PV2.border,
    backgroundColor: PV2.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transferredOutActionText: {
    color: PV2.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  editSection: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
  },
});

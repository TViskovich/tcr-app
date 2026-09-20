import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoAdjuster } from '@/components/collection/photo-adjuster';
import { CollapsibleSection } from '@/components/item-detail/collapsible-section';
import { PendingItemGalleryManager, type PendingItemPhoto } from '@/components/item-detail/pending-item-gallery-manager';
import { MultiSelectField, SelectField } from '@/components/item-detail/select-field';
import { AnchoredMenu, menuStyles, useAnchoredMenu } from '@/components/profile-v2/profile-v2-anchored-menu';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { createComicBookItem } from '@/lib/comic-book-items';
import {
  COMIC_EDITION_OPTIONS,
  COMIC_GRADING_COMPANY_OPTIONS,
  COMIC_KEY_TYPE_OPTIONS,
  COMIC_PRINTING_OPTIONS,
  COMIC_RAW_CONDITION_OPTIONS,
  COMIC_SPECIAL_COVER_FINISH_OPTIONS,
} from '@/lib/comic-book-options';
import { addItemImages, MAX_ITEM_IMAGES } from '@/lib/item-images';
import { createPokemonItem } from '@/lib/pokemon-items';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';
import type { CollectibleItemType, ComicConditionType } from '@/types';

// Collectible Type — Phase 1 (see supabase/migrations/
// 20260916120000_add_collection_item_type.sql). Sports Card, Pokémon (Phase
// 2 — supabase/migrations/20260917120000_create_pokemon_card_details.sql /
// 20260917120100_create_pokemon_item_rpcs.sql), and Comic Book (Phase 3 —
// supabase/migrations/20260917130000_create_comic_book_details.sql /
// 20260917130100_create_comic_book_item_rpcs.sql) all have real metadata
// forms now; Figurine still renders a temporary shell (below) and blocks
// Save until its own detail table/form exists.
const COLLECTIBLE_TYPES: { value: CollectibleItemType; label: string }[] = [
  { value: 'sports_card', label: 'Sports Card' },
  { value: 'pokemon', label: 'Pokémon' },
  { value: 'figurine', label: 'Figurine' },
  { value: 'comic_book', label: 'Comic Book' },
];

type FormState = {
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

const INITIAL_FORM: FormState = {
  title: '',
  player: '',
  team: '',
  year: '',
  brand: '',
  grade: '',
  gradingCompany: '',
  serialNumber: '',
  estimatedValue: '',
  description: '',
};

// Pokémon has no Title field of its own — collection_items.title is derived
// server-side from pokemonName by create_pokemon_item/update_pokemon_item
// (see lib/pokemon-items.ts) — and reuses estimatedValue/description from
// the common Value & Notes section rather than duplicating them here.
type PokemonFormState = {
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

const INITIAL_POKEMON_FORM: PokemonFormState = {
  pokemonName: '',
  setName: '',
  cardNumber: '',
  rarity: '',
  language: '',
  edition: '',
  holoType: '',
  gradingCompany: '',
  grade: '',
  estimatedValue: '',
  description: '',
};

// Comic Book's own form shape (Phase 3 — supabase/migrations/
// 20260917130000_create_comic_book_details.sql /
// 20260917130100_create_comic_book_item_rpcs.sql), mirroring
// PokemonFormState's own separate-state pattern. No title field —
// collection_items.title is derived server-side from seriesTitle (plus
// issueNumber, when present) by create_comic_book_item, same as Pokémon
// derives it from pokemonName. conditionType/isKeyIssue/isSigned/isRestored
// gate which of the conditional field groups below are shown; keyTypes is
// the one multi-select field in this form.
type ComicFormState = {
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

const INITIAL_COMIC_FORM: ComicFormState = {
  seriesTitle: '',
  issueNumber: '',
  publisher: '',
  publicationYear: '',
  volume: '',
  coverVariant: '',
  printing: '',
  conditionType: 'raw',
  condition: '',
  gradingCompany: '',
  grade: '',
  certificationNumber: '',
  labelType: '',
  pageQuality: '',
  isKeyIssue: false,
  keyTypes: [],
  keyDescription: '',
  characters: '',
  storyArc: '',
  writer: '',
  interiorArtist: '',
  coverArtist: '',
  edition: '',
  variantName: '',
  variantArtist: '',
  incentiveRatio: '',
  retailerExclusive: '',
  specialCoverFinish: '',
  countryMarket: '',
  isSigned: false,
  signedBy: '',
  signatureAuthentication: '',
  isRestored: false,
  restorationNotes: '',
  estimatedValue: '',
  description: '',
};

// The subset of ComicFormState's own keys whose value is a plain string —
// excludes conditionType/isKeyIssue/keyTypes/isSigned/isRestored, which
// need their own dedicated controls (SelectField/MultiSelectField/Switch)
// rather than a bare TextInput. Named here (vs. inlined at comicField's own
// call site) purely for readability.
type ComicStringField = {
  [K in keyof ComicFormState]: ComicFormState[K] extends string ? K : never;
}[keyof ComicFormState];

function field(label: string, key: keyof FormState, form: FormState, update: (k: keyof FormState) => (v: string) => void, extra?: object) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={fieldStyles.input}
        value={form[key]}
        onChangeText={update(key)}
        placeholderTextColor={PV2.textTertiary}
        placeholder={label}
        {...extra}
      />
    </View>
  );
}

// Same shape as field() above, parameterized over PokemonFormState instead
// of FormState — kept as its own small function (matching this screen's own
// existing field()/EditField split-by-screen precedent in app/item/[id].tsx)
// rather than generifying field() itself, since the two forms' underlying
// state shapes are genuinely unrelated.
function pokemonField(
  label: string,
  key: keyof PokemonFormState,
  form: PokemonFormState,
  update: (k: keyof PokemonFormState) => (v: string) => void,
  extra?: object,
) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={fieldStyles.input}
        value={form[key]}
        onChangeText={update(key)}
        placeholderTextColor={PV2.textTertiary}
        placeholder={label}
        {...extra}
      />
    </View>
  );
}

// Same shape as field()/pokemonField() above, parameterized over the string
// fields of ComicFormState — kept as its own small function for the same
// reason pokemonField is its own function rather than a generified field().
function comicField(
  label: string,
  key: ComicStringField,
  form: ComicFormState,
  update: (k: keyof ComicFormState) => (v: string) => void,
  extra?: object,
) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      <TextInput
        style={fieldStyles.input}
        value={form[key]}
        onChangeText={update(key)}
        placeholderTextColor={PV2.textTertiary}
        placeholder={label}
        {...extra}
      />
    </View>
  );
}

// A labeled Switch row for one of Comics' three boolean toggles (Key Issue,
// Signed, Restored) — same visual language as the screen's own Public/
// Private toggle further down (toggleRow/toggleTextArea/toggleLabel/
// toggleSub), just reusable across the three since Comics needs it more
// than once in one screen (unlike that single Public/Private instance).
function comicToggleRow(label: string, sublabel: string, value: boolean, onValueChange: (v: boolean) => void) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleTextArea}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleSub}>{sublabel}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: PV2.collectorPanelBg, true: PV2.accent }}
        thumbColor="#fff"
      />
    </View>
  );
}

// Custom header bar — replaces the native Stack header entirely for this
// screen (headerShown: false below), same reasoning already proven out in
// app/item/[id].tsx's own ItemDetailHeaderBar: react-navigation's native
// header wraps ANY headerLeft content in the OS's own rounded/"Liquid
// Glass" pill chrome on iOS 18+ — confirmed on-device, and not something
// any Stack.Screen option (headerBackTitle included — tried first, didn't
// suppress it) can fix, since it's applied by the native header itself,
// not by anything this app controls (see components/ui/back-button.tsx's
// own doc comment on the same finding). Rendering the header row as plain
// in-screen content is the only way to guarantee a bare chevron. Kept as
// its own small local copy rather than importing item/[id].tsx's
// (module-private) ItemDetailHeaderBar — this screen only ever needs a
// bare left slot + centered title, no right-side action button.
const HEADER_ROW_HEIGHT = 44;
const HEADER_SIDE_WIDTH = 70;

function AddItemHeaderBar({ insetsTop, title, left }: { insetsTop: number; title: string; left: ReactNode }) {
  return (
    <View style={[headerBarStyles.bar, { paddingTop: insetsTop }]}>
      <View style={headerBarStyles.row}>
        <View style={headerBarStyles.slotLeft}>{left}</View>
        <Text style={headerBarStyles.title} numberOfLines={1}>
          {title}
        </Text>
        {/* Empty slot matching slotLeft's width so the title is truly
            centered on the row, not just centered between two unequal-
            width controls (same convention as ItemDetailHeaderBar). */}
        <View style={headerBarStyles.slotRight} />
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
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: PV2.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
});

export default function AddItemScreen() {
  const { session } = useAuth();
  const { folderId, folderName, mode } = useLocalSearchParams<{
    folderId: string;
    folderName: string;
    // Set only by the Collections screen's "+ Add" → Add Item entry point
    // (app/(tabs)/collection.tsx), which has no folder selected yet. This
    // is a preview/navigation-only visit — the user can look around (pick
    // a photo, crop it, fill in fields) but handleSubmit below refuses to
    // actually persist anything, and the submit button is disabled with
    // copy explaining why. Deliberately an explicit mode rather than
    // inferring "preview" from a missing folderId, since a missing
    // folderId shouldn't silently change behavior elsewhere if this
    // screen ever gains another no-folderId entry point.
    mode?: string;
  }>();
  const isPreviewOnly = mode === 'preview';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // A create/edit form, not a scrollable browsing list — no scroll-hide
  // effect, but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  // Photos accepted into the pending gallery (already run through
  // PhotoAdjuster) — nothing here is uploaded until Save. See
  // PendingItemPhoto's own comment for why this is a distinct local-only
  // shape rather than the persisted CollectionItemImage.
  const [pendingPhotos, setPendingPhotos] = useState<PendingItemPhoto[]>([]);
  const [coverId, setCoverId] = useState<string | null>(null);
  // Assets picked (library or camera) but not yet run through PhotoAdjuster
  // — adjustQueue[adjustIndex] is whichever one PhotoAdjuster is currently
  // showing; both reset to empty/0 once the whole queue is done or
  // cancelled (see the queue handlers below).
  const [adjustQueue, setAdjustQueue] = useState<{ uri: string; width: number; height: number }[]>([]);
  const [adjustIndex, setAdjustIndex] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [pokemonForm, setPokemonForm] = useState<PokemonFormState>(INITIAL_POKEMON_FORM);
  const [comicForm, setComicForm] = useState<ComicFormState>(INITIAL_COMIC_FORM);
  // Collectible Type — defaults to Sports Card. Sports Card, Pokémon, and
  // Comic Book all have real forms (see COLLECTIBLE_TYPES above); Figurine
  // still swaps the metadata section below for a temporary shell and
  // disables Save (isSupportedType gate on handleSubmit and the submit
  // button both).
  const [itemType, setItemType] = useState<CollectibleItemType>('sports_card');
  const isSportsCard = itemType === 'sports_card';
  const isPokemon = itemType === 'pokemon';
  const isComicBook = itemType === 'comic_book';
  const isSupportedType = isSportsCard || isPokemon || isComicBook;
  const selectedTypeLabel = COLLECTIBLE_TYPES.find((t) => t.value === itemType)?.label ?? 'Sports Card';
  // Shared anchored-dropdown mechanics (measure trigger, open a Modal-hosted
  // box just under it, close on outside tap or selection) — see
  // components/profile-v2/profile-v2-anchored-menu.tsx, already used for
  // the profile panel's Follow/Following menu. Reused as-is rather than
  // building a second dropdown primitive for this screen.
  const {
    open: typeMenuOpen,
    anchor: typeMenuAnchor,
    triggerRef: typeMenuTriggerRef,
    openMenu: openTypeMenu,
    closeMenu: closeTypeMenu,
  } = useAnchoredMenu();
  // Item-level privacy (Model A, most-restrictive-wins — see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Defaults to public; seeded from the parent folder's current is_public
  // below so the UI starts in a state that matches the folder, then stays
  // independently editable. There's no parent folder yet in preview mode
  // (no folderId), so it just stays at its public default there.
  const [isPublic, setIsPublic] = useState(true);
  const isPrivate = !isPublic;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    let cancelled = false;
    supabase
      .from('folders')
      .select('is_public')
      .eq('id', folderId)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setIsPublic(data.is_public);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  function update(key: keyof FormState) {
    return (value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updatePokemon(key: keyof PokemonFormState) {
    return (value: string) => setPokemonForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateComic(key: keyof ComicFormState) {
    return (value: string) => setComicForm((prev) => ({ ...prev, [key]: value }));
  }

  function setComicField<K extends keyof ComicFormState>(key: K, value: ComicFormState[K]) {
    setComicForm((prev) => ({ ...prev, [key]: value }));
  }

  function makeLocalPhotoId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function handleAddPhotosPress() {
    Alert.alert('Add Photos', undefined, [
      { text: 'Take Photo', onPress: pickFromCamera },
      { text: 'Choose from Library', onPress: pickFromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function pickFromLibrary() {
    const remaining = MAX_ITEM_IMAGES - pendingPhotos.length;
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

    // Queue every selected asset through PhotoAdjuster one at a time, in
    // the order the picker returned them — nothing is uploaded here, only
    // staged for adjustment (see handleAdjustedPhotoUsed below).
    setAdjustQueue(result.assets.map((asset) => ({ uri: asset.uri, width: asset.width, height: asset.height })));
    setAdjustIndex(0);
  }

  async function pickFromCamera() {
    const remaining = MAX_ITEM_IMAGES - pendingPhotos.length;
    if (remaining <= 0) {
      Alert.alert('Limit reached', `You can add up to ${MAX_ITEM_IMAGES} photos per item.`);
      return;
    }
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your camera.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (result.canceled || !result.assets.length) return;
    const asset = result.assets[0];
    // One at a time, same as the library path just with a single entry —
    // the user can tap Add Photos again afterward for another camera shot
    // or another library batch, right up to the 10-photo cap.
    setAdjustQueue([{ uri: asset.uri, width: asset.width, height: asset.height }]);
    setAdjustIndex(0);
  }

  // Accept the current queue entry's adjusted photo into the pending
  // gallery, then advance. The very first photo ever accepted becomes
  // Cover by default (functional update: only when nothing is Cover yet).
  function handleAdjustedPhotoUsed(adjustedUri: string) {
    const current = adjustQueue[adjustIndex];
    const newPhoto: PendingItemPhoto = {
      id: makeLocalPhotoId(),
      originalUri: current.uri,
      adjustedUri,
      width: current.width,
      height: current.height,
    };
    setPendingPhotos((prev) => [...prev, newPhoto]);
    setCoverId((prev) => prev ?? newPhoto.id);
    advanceAdjustQueue();
  }

  // Skip discards only the current photo (never added to pendingPhotos)
  // and continues to the next queued one.
  function handleAdjustedPhotoSkipped() {
    advanceAdjustQueue();
  }

  function advanceAdjustQueue() {
    if (adjustIndex + 1 < adjustQueue.length) {
      setAdjustIndex(adjustIndex + 1);
    } else {
      setAdjustQueue([]);
      setAdjustIndex(0);
    }
  }

  // Cancel stops the whole remaining queue (this photo plus every
  // unprocessed one after it) — whatever was already accepted via Use
  // Photo earlier in this same batch stays in pendingPhotos untouched.
  function handleAdjustQueueCancelled() {
    setAdjustQueue([]);
    setAdjustIndex(0);
  }

  function handleSetCover(id: string) {
    setCoverId(id);
  }

  // Removing the Cover photo promotes the first remaining pending photo
  // (matching remove_item_image's own "promote sort_order 0" convention
  // for persisted galleries — see lib/item-images.ts); Cover becomes null
  // if no photos remain.
  function handleRemovePendingPhoto(id: string) {
    const next = pendingPhotos.filter((p) => p.id !== id);
    setPendingPhotos(next);
    if (coverId === id) setCoverId(next[0]?.id ?? null);
  }

  async function handleSubmit() {
    // Defense in depth alongside the disabled submit button below — this
    // Collections-level entry point has no folder assigned yet, so nothing
    // may be persisted from it regardless of how handleSubmit is reached.
    if (isPreviewOnly) return;
    // Same defense-in-depth pattern for Collectible Type: Figurine/Comic
    // Book have no metadata form yet, so nothing may be persisted for them
    // regardless of how handleSubmit is reached.
    if (!isSupportedType) return;
    if (pendingPhotos.length === 0) {
      Alert.alert('Photo required', 'Please add at least one photo for this item.');
      return;
    }
    // Pokémon's one required field — collection_items.title is derived from
    // this server-side (see create_pokemon_item), so it also guarantees the
    // item never ends up with a null title. Mirrors the Photo required
    // check's own pattern: validate, alert, bail before any write.
    if (isPokemon && !pokemonForm.pokemonName.trim()) {
      Alert.alert('Pokémon name required', 'Please enter the Pokémon name for this card.');
      return;
    }
    // Comics' one required field — collection_items.title is derived from
    // this server-side (see create_comic_book_item), same reasoning as
    // Pokémon's pokemonName check above.
    if (isComicBook && !comicForm.seriesTitle.trim()) {
      Alert.alert('Series / Title required', 'Please enter the series or title for this comic.');
      return;
    }
    if (!session?.user?.id) return;
    const userId = session.user.id;

    setLoading(true);
    try {
      // Item row first, with no image_url yet (nullable — see
      // types/index.ts's CollectionItem) — nothing is uploaded until the
      // item itself exists, so a failure here leaves nothing to clean up.
      // Sports Card keeps the original plain insert (its own RLS already
      // covers it in one statement); Pokémon goes through create_pokemon_item
      // instead, which also atomically inserts pokemon_card_details in the
      // same transaction — see lib/pokemon-items.ts.
      let item: { id: string };
      if (isSportsCard) {
        const { data, error: itemError } = await supabase
          .from('collection_items')
          .insert({
            folder_id: folderId,
            user_id: userId,
            item_type: itemType,
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
            is_public: isPublic,
          })
          .select()
          .single();

        if (itemError || !data) throw new Error('Failed to save item. Please try again.');
        item = data;
      } else {
        // createPokemonItem/createComicBookItem already throw a real Error
        // with the RPC's own message (e.g. a folder-ownership or validation
        // failure) — let it propagate to this function's own outer catch
        // below rather than genericizing it, unlike the Sports Card branch
        // above (which has no useful message of its own to preserve from a
        // plain postgrest {error} result).
        item = isPokemon
          ? await createPokemonItem(folderId, {
              estimatedValue: pokemonForm.estimatedValue ? parseFloat(pokemonForm.estimatedValue) : null,
              description: pokemonForm.description.trim() || null,
              isPublic,
              pokemonName: pokemonForm.pokemonName.trim() || null,
              setName: pokemonForm.setName.trim() || null,
              cardNumber: pokemonForm.cardNumber.trim() || null,
              rarity: pokemonForm.rarity.trim() || null,
              language: pokemonForm.language.trim() || null,
              edition: pokemonForm.edition.trim() || null,
              holoType: pokemonForm.holoType.trim() || null,
              gradingCompany: pokemonForm.gradingCompany.trim() || null,
              grade: pokemonForm.grade.trim() || null,
            })
          : await createComicBookItem(folderId, {
              estimatedValue: comicForm.estimatedValue ? parseFloat(comicForm.estimatedValue) : null,
              description: comicForm.description.trim() || null,
              isPublic,
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
      }

      // Cover first, then the rest in their existing pending order —
      // addItemImages marks array index 0 primary for a brand-new item's
      // first-ever batch and always ends up at sort_order 0 (matching
      // set_primary_item_image/reorder_item_images' own "primary is always
      // sort_order 0" convention — see lib/item-images.ts), so ordering the
      // upload list this way is what makes the chosen Cover actually land
      // as the persisted primary/sort_order-0 row.
      const orderedUris = [
        ...pendingPhotos.filter((p) => p.id === coverId).map((p) => p.adjustedUri),
        ...pendingPhotos.filter((p) => p.id !== coverId).map((p) => p.adjustedUri),
      ];

      // Reuses the exact same upload+insert+reconciliation path Edit Item's
      // "Add Photos" already relies on (see lib/item-images.ts's
      // addItemImages) — parallel per-photo upload, one atomic batch
      // INSERT for the DB rows, and safe Storage cleanup on a definitive or
      // reconciled-ambiguous rejection. Nothing new invented for the
      // Storage/Postgres boundary itself.
      const { added, failed } = await addItemImages(item.id, userId, orderedUris);

      if (added.length === 0) {
        // Every upload failed — this is the one failure mode addItemImages
        // can't already guard against on its own for a BRAND NEW item
        // (Edit Item never hits this, since that item already had content
        // before "Add Photos" was even tapped): a fresh item with zero
        // photos and a null image_url. Explicit, targeted compensating
        // delete — not a fake cross-system transaction — so this never
        // leaves a photo-less item behind.
        await supabase.from('collection_items').delete().eq('id', item.id);
        throw new Error('Could not upload any photos. Please try again.');
      }

      if (failed > 0) {
        Alert.alert(
          'Some photos failed',
          `${failed} of ${orderedUris.length} photo${orderedUris.length === 1 ? '' : 's'} could not be uploaded. The item was created with the rest.`,
        );
      }

      // No back history when this screen was deep-linked, reloaded directly,
      // or opened during development — fall back to the folder we just added
      // to (if we know which one), otherwise the canonical Collection tab.
      if (router.canGoBack()) {
        router.back();
      } else if (folderId) {
        router.replace({ pathname: '/collection/[folderId]', params: { folderId } });
      } else {
        router.replace('/collection');
      }
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Matches handleSubmit's own existing no-back-history fallback below
  // (folderId known → back to that folder; otherwise the Collection tab) —
  // same destination either way, just reached via Back instead of Save.
  const headerTitle = folderName ? `Add to ${folderName}` : 'Add Item';

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AddItemHeaderBar
        insetsTop={insets.top}
        title={headerTitle}
        left={
          <BackButton
            fallbackHref={folderId ? { pathname: '/collection/[folderId]', params: { folderId } } : '/collection'}
          />
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
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>

          <PendingItemGalleryManager
            photos={pendingPhotos}
            coverId={coverId}
            maxImages={MAX_ITEM_IMAGES}
            onAdd={handleAddPhotosPress}
            onRemove={handleRemovePendingPhoto}
            onSetCover={handleSetCover}
          />

          {/* Collectible Type — item_type persisted on submit (see
              handleSubmit's insert above). Sports Card, Pokémon, and Comic
              Book each show their own real form below; Figurine still swaps
              the metadata section for a temporary shell and disables Save
              (see isSupportedType gating throughout this screen) until its
              own detail table/form exists. */}
          <View style={fieldStyles.wrap}>
            <Text style={fieldStyles.label}>Collectible Type</Text>
            <Pressable
              ref={typeMenuTriggerRef}
              style={styles.typeSelectTrigger}
              onPress={openTypeMenu}
              accessibilityRole="button"
              accessibilityLabel="Collectible Type"
              accessibilityHint="Opens collectible type options">
              <Text style={styles.typeSelectValue}>{selectedTypeLabel}</Text>
              <Text style={styles.typeSelectChevron}>▾</Text>
            </Pressable>
          </View>

          <AnchoredMenu visible={typeMenuOpen} anchor={typeMenuAnchor} onRequestClose={closeTypeMenu}>
            {COLLECTIBLE_TYPES.map((option) => {
              const selected = option.value === itemType;
              return (
                <Pressable
                  key={option.value}
                  style={styles.typeMenuItem}
                  onPress={() => {
                    setItemType(option.value);
                    closeTypeMenu();
                  }}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected }}>
                  <Text style={[menuStyles.itemLabel, styles.typeMenuItemLabel]}>{option.label}</Text>
                  {selected && <IconSymbol name="checkmark.circle.fill" size={16} color={PV2.accent} />}
                </Pressable>
              );
            })}
          </AnchoredMenu>

          {isSportsCard ? (
            <>
              {/* Card Details */}
              <Text style={styles.sectionHeader}>Card Details</Text>
              {field('Player', 'player', form, update)}
              {field('Title', 'title', form, update)}
              {field('Team', 'team', form, update)}
              {field('Year', 'year', form, update, { keyboardType: 'number-pad', maxLength: 4 })}

              {/* Card Info */}
              <Text style={styles.sectionHeader}>Card Info</Text>
              {field('Brand', 'brand', form, update)}
              {field('Grade', 'grade', form, update, { autoCapitalize: 'characters' })}
              {field('Grading Company', 'gradingCompany', form, update)}
              {field('Serial Number', 'serialNumber', form, update)}

              {/* Value */}
              <Text style={styles.sectionHeader}>Value</Text>
              {field('Estimated Value ($)', 'estimatedValue', form, update, { keyboardType: 'decimal-pad' })}

              {/* Notes */}
              <Text style={styles.sectionHeader}>Notes</Text>
              <View style={fieldStyles.wrap}>
                <Text style={fieldStyles.label}>Description</Text>
                <TextInput
                  style={[fieldStyles.input, styles.multiline]}
                  value={form.description}
                  onChangeText={update('description')}
                  placeholder="Description"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>
            </>
          ) : isPokemon ? (
            <>
              {/* Pokémon Details */}
              <Text style={styles.sectionHeader}>Pokémon Details</Text>
              {pokemonField('Pokémon', 'pokemonName', pokemonForm, updatePokemon)}
              {pokemonField('Set', 'setName', pokemonForm, updatePokemon)}
              {pokemonField('Card Number', 'cardNumber', pokemonForm, updatePokemon)}
              {pokemonField('Rarity', 'rarity', pokemonForm, updatePokemon)}
              {pokemonField('Language', 'language', pokemonForm, updatePokemon)}
              {pokemonField('Edition', 'edition', pokemonForm, updatePokemon)}
              {pokemonField('Holo Type', 'holoType', pokemonForm, updatePokemon)}

              {/* Grading */}
              <Text style={styles.sectionHeader}>Grading</Text>
              {pokemonField('Grading Company', 'gradingCompany', pokemonForm, updatePokemon)}
              {pokemonField('Grade', 'grade', pokemonForm, updatePokemon, { autoCapitalize: 'characters' })}

              {/* Value & Notes — reuses the same common fields (estimated_value/
                  description) as the Sports Card form, just on pokemonForm's
                  own local state instead of form's. */}
              <Text style={styles.sectionHeader}>Value & Notes</Text>
              {pokemonField('Estimated Value ($)', 'estimatedValue', pokemonForm, updatePokemon, { keyboardType: 'decimal-pad' })}
              <View style={fieldStyles.wrap}>
                <Text style={fieldStyles.label}>Description</Text>
                <TextInput
                  style={[fieldStyles.input, styles.multiline]}
                  value={pokemonForm.description}
                  onChangeText={updatePokemon('description')}
                  placeholder="Description"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>
            </>
          ) : isComicBook ? (
            <>
              {/* Main Comic Information — the compact, always-visible field
                  set (Series/Title through Condition Type), matching this
                  screen's own "most-used fields first" convention. */}
              <Text style={styles.sectionHeader}>Comic Details</Text>
              {comicField('Series / Title', 'seriesTitle', comicForm, updateComic)}
              {comicField('Issue Number', 'issueNumber', comicForm, updateComic)}
              {comicField('Publisher', 'publisher', comicForm, updateComic)}
              {comicField('Publication Year', 'publicationYear', comicForm, updateComic, {
                keyboardType: 'number-pad',
                maxLength: 4,
              })}
              {comicField('Volume', 'volume', comicForm, updateComic)}
              {comicField('Cover / Variant', 'coverVariant', comicForm, updateComic)}
              <SelectField
                label="Printing"
                value={comicForm.printing || null}
                options={COMIC_PRINTING_OPTIONS}
                onChange={(v) => setComicField('printing', v)}
              />

              {/* Condition — Condition Type gates which of Raw's single
                  field vs. Graded's five fields shows below it; the other
                  group is never rendered at all (see comicForm.conditionType
                  below), matching the spec's "never show both" requirement. */}
              <Text style={styles.sectionHeader}>Condition</Text>
              <SelectField
                label="Condition Type"
                value={comicForm.conditionType === 'graded' ? 'Graded' : 'Raw'}
                options={['Raw', 'Graded']}
                onChange={(v) => setComicField('conditionType', v === 'Graded' ? 'graded' : 'raw')}
              />
              {comicForm.conditionType === 'raw' ? (
                <SelectField
                  label="Condition"
                  value={comicForm.condition || null}
                  options={COMIC_RAW_CONDITION_OPTIONS}
                  onChange={(v) => setComicField('condition', v)}
                />
              ) : (
                <>
                  <SelectField
                    label="Grading Company"
                    value={comicForm.gradingCompany || null}
                    options={COMIC_GRADING_COMPANY_OPTIONS}
                    onChange={(v) => setComicField('gradingCompany', v)}
                  />
                  {comicField('Grade', 'grade', comicForm, updateComic, { autoCapitalize: 'characters' })}
                  {comicField('Certification Number', 'certificationNumber', comicForm, updateComic)}
                  {comicField('Label Type', 'labelType', comicForm, updateComic)}
                  {comicField('Page Quality', 'pageQuality', comicForm, updateComic)}
                </>
              )}

              {/* Key Issue — Key Type/Key Description only ever render when
                  the toggle is on (see comicForm.isKeyIssue below). */}
              <Text style={styles.sectionHeader}>Key Issue</Text>
              {comicToggleRow(
                'Key Issue',
                'This issue has notable collector significance',
                comicForm.isKeyIssue,
                (v) => setComicField('isKeyIssue', v),
              )}
              {comicForm.isKeyIssue && (
                <>
                  <MultiSelectField
                    label="Key Type"
                    values={comicForm.keyTypes}
                    options={COMIC_KEY_TYPE_OPTIONS}
                    onChange={(v) => setComicField('keyTypes', v)}
                  />
                  <View style={fieldStyles.wrap}>
                    <Text style={fieldStyles.label}>Key Description</Text>
                    <TextInput
                      style={[fieldStyles.input, styles.multiline]}
                      value={comicForm.keyDescription}
                      onChangeText={updateComic('keyDescription')}
                      placeholder="e.g. First full appearance of Venom"
                      placeholderTextColor={PV2.textTertiary}
                      multiline
                      numberOfLines={3}
                      textAlignVertical="top"
                    />
                  </View>
                </>
              )}

              {/* Additional Details — collapsed by default so the default
                  form stays compact; every field here is genuinely optional
                  collector detail, per the spec. */}
              <CollapsibleSection title="Additional Details">
                {comicField('Characters', 'characters', comicForm, updateComic)}
                {comicField('Story Arc / Event', 'storyArc', comicForm, updateComic)}
                {comicField('Writer', 'writer', comicForm, updateComic)}
                {comicField('Interior Artist', 'interiorArtist', comicForm, updateComic)}
                {comicField('Cover Artist', 'coverArtist', comicForm, updateComic)}
                <SelectField
                  label="Edition"
                  value={comicForm.edition || null}
                  options={COMIC_EDITION_OPTIONS}
                  onChange={(v) => setComicField('edition', v)}
                />
                {comicField('Variant Name', 'variantName', comicForm, updateComic)}
                {comicField('Variant Artist', 'variantArtist', comicForm, updateComic)}
                {comicField('Incentive Ratio', 'incentiveRatio', comicForm, updateComic, {
                  placeholder: 'e.g. 1:25',
                })}
                {comicField('Retailer Exclusive', 'retailerExclusive', comicForm, updateComic)}
                <SelectField
                  label="Special Cover / Finish"
                  value={comicForm.specialCoverFinish || null}
                  options={COMIC_SPECIAL_COVER_FINISH_OPTIONS}
                  onChange={(v) => setComicField('specialCoverFinish', v)}
                />
                {comicField('Country / Market', 'countryMarket', comicForm, updateComic)}

                {comicToggleRow('Signed', 'This copy has been autographed', comicForm.isSigned, (v) =>
                  setComicField('isSigned', v),
                )}
                {comicForm.isSigned && (
                  <>
                    {comicField('Signed By', 'signedBy', comicForm, updateComic)}
                    {comicField('Signature Authentication', 'signatureAuthentication', comicForm, updateComic)}
                  </>
                )}

                {comicToggleRow(
                  'Restored',
                  'This copy has undergone restoration work',
                  comicForm.isRestored,
                  (v) => setComicField('isRestored', v),
                )}
                {comicForm.isRestored && (
                  <View style={fieldStyles.wrap}>
                    <Text style={fieldStyles.label}>Restoration Notes</Text>
                    <TextInput
                      style={[fieldStyles.input, styles.multiline]}
                      value={comicForm.restorationNotes}
                      onChangeText={updateComic('restorationNotes')}
                      placeholder="Restoration Notes"
                      placeholderTextColor={PV2.textTertiary}
                      multiline
                      numberOfLines={3}
                      textAlignVertical="top"
                    />
                  </View>
                )}
              </CollapsibleSection>

              {/* Value & Notes — reuses the same common fields (estimated_value/
                  description) as the Sports Card/Pokémon forms, just on
                  comicForm's own local state instead of form's/pokemonForm's. */}
              <Text style={styles.sectionHeader}>Value & Notes</Text>
              {comicField('Estimated Value ($)', 'estimatedValue', comicForm, updateComic, { keyboardType: 'decimal-pad' })}
              <View style={fieldStyles.wrap}>
                <Text style={fieldStyles.label}>Description</Text>
                <TextInput
                  style={[fieldStyles.input, styles.multiline]}
                  value={comicForm.description}
                  onChangeText={updateComic('description')}
                  placeholder="Description"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>
            </>
          ) : (
            // Temporary shell — no fake sports-card fields for these types.
            // The real per-type metadata form/detail table lands in a later
            // phase; for now this just explains why Save is disabled.
            <View style={styles.comingSoonShell}>
              <Text style={styles.comingSoonTitle}>{selectedTypeLabel} details coming soon</Text>
              <Text style={styles.comingSoonBody}>
                We&apos;re still building the {selectedTypeLabel.toLowerCase()} info form. You can add photos and
                pick a folder now, but saving is disabled until that form ships.
              </Text>
            </View>
          )}

          {/* Private Item toggle — same dynamic label/helper pattern as
              create-folder-modal.tsx / folder-edit-modal.tsx. isPublic is
              the field that's actually persisted (see handleSubmit's
              insert above); isPrivate is display-only. Sharing an existing
              item to the feed is a separate, dedicated flow
              (app/share-card/new.tsx) — this screen only creates the item
              itself. */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextArea}>
              <Text style={styles.toggleLabel}>{isPrivate ? 'Private Item' : 'Public Item'}</Text>
              <Text style={styles.toggleSub}>
                {isPrivate ? 'Only you can view this item.' : 'Anyone can view this item.'}
              </Text>
            </View>
            <Switch
              value={isPrivate}
              onValueChange={(value) => setIsPublic(!value)}
              trackColor={{ false: PV2.collectorPanelBg, true: PV2.accent }}
              thumbColor="#fff"
            />
          </View>

          {/* Submit — disabled entirely in preview mode (no folder assigned
              yet) or when the selected Collectible Type has no metadata
              form yet, with copy explaining why in either case, so the user
              can never come away thinking an item was saved when it
              wasn't. */}
          <TouchableOpacity
            style={[styles.submitButton, (loading || isPreviewOnly || !isSupportedType) && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={loading || isPreviewOnly || !isSupportedType}>
            {loading ? (
              <ActivityIndicator color={PV2.textPrimary} />
            ) : (
              <Text style={styles.submitText}>
                {isPreviewOnly
                  ? 'Folder assignment required'
                  : !isSupportedType
                    ? `${selectedTypeLabel} not yet supported`
                    : 'Save Item'}
              </Text>
            )}
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>

      {adjustQueue.length > 0 && (
        <PhotoAdjuster
          uri={adjustQueue[adjustIndex].uri}
          imageWidth={adjustQueue[adjustIndex].width}
          imageHeight={adjustQueue[adjustIndex].height}
          progressLabel={adjustQueue.length > 1 ? `Photo ${adjustIndex + 1} of ${adjustQueue.length}` : undefined}
          onUse={handleAdjustedPhotoUsed}
          onSkip={adjustQueue.length > 1 ? handleAdjustedPhotoSkipped : undefined}
          onCancel={handleAdjustQueueCancelled}
        />
      )}
    </>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
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
});

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: PV2.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
  },
  multiline: {
    height: 100,
    paddingTop: 12,
  },
  // Trigger — same visual spec as fieldStyles.input below (border/radius/
  // background/font all match the rest of the form's text inputs), just a
  // row layout so the chevron sits at the right edge and a minHeight since
  // this one has no multi-line text to guarantee its own height.
  typeSelectTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: PV2.collectorPanelBg,
  },
  typeSelectValue: {
    fontSize: 15,
    color: PV2.textPrimary,
  },
  typeSelectChevron: {
    fontSize: 15,
    color: PV2.textSecondary,
    marginLeft: 8,
  },
  // Menu items — AnchoredMenu's box stretches its children to the anchor's
  // width by default (no alignItems override), so this row layout naturally
  // fills the same width as typeSelectTrigger above it.
  typeMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  typeMenuItemLabel: {
    flex: 1,
    textAlign: 'left',
    fontSize: 15,
  },
  comingSoonShell: {
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    padding: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 6,
  },
  comingSoonBody: {
    fontSize: 13,
    color: PV2.textSecondary,
    lineHeight: 18,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PV2.panel,
    borderRadius: 10,
    padding: 16,
    marginTop: 8,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: PV2.border,
  },
  toggleTextArea: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: PV2.textPrimary,
  },
  toggleSub: {
    fontSize: 12,
    color: PV2.textSecondary,
    marginTop: 2,
  },
  submitButton: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitDisabled: {
    backgroundColor: PV2.accentSoft,
  },
  submitText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

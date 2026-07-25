export type Folder = {
  id: string;
  user_id: string;
  name: string;
  cover_image_url: string | null;
  cover_source: string; // 'upload' | 'first_card'
  color: string | null; // FolderColorKey (components/collection/folder-card.tsx) or null = auto (name-hash)
  is_public: boolean;
  created_at: string;
};

export type CollectionItem = {
  id: string;
  folder_id: string;
  user_id: string;
  title: string | null;
  year: number | null;
  brand: string | null;
  player: string | null;
  team: string | null;
  grade: string | null;
  grading_company: string | null;
  serial_number: string | null;
  estimated_value: number | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
};

// One photo in an item's gallery (supabase/migrations/20260721120000_
// create_collection_item_images.sql). collection_items.image_url stays in
// sync with whichever row here has is_primary = true — it's the legacy
// cached cover field every other screen (folder/feed/related-items
// previews) still reads.
export type CollectionItemImage = {
  id: string;
  item_id: string;
  user_id: string;
  image_url: string;
  storage_path: string | null;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
};

export type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  hero_display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  hero_image_url: string | null;
  hero_theme: string | null;
  showcase_badge_url: string | null;
  created_at: string;
};

export type Post = {
  id: string;
  user_id: string;
  post_type: 'item' | 'text' | 'rate_my_grails' | 'card_share';
  item_id: string | null;
  image_url: string | null;
  content: string | null;
  caption: string | null;
  created_at: string;
};

export type ShowcaseItem = {
  id: string;
  user_id: string;
  item_id: string;
  display_order: number;
  note: string | null;
  badge_type: string | null;
  added_at: string;
  item: CollectionItem;
};

// Snapshot of one grail at the moment a Rate My Grails post was created —
// deliberately denormalized (snapshot_*) so the post keeps rendering even if
// the source collection_item is later edited or deleted. item_id is only an
// optional "view original card" link, never required for rendering.
export type RateMyGrailCard = {
  id: string;
  post_id: string;
  item_id: string | null;
  snapshot_image_url: string;
  snapshot_title: string | null;
  snapshot_subtitle: string | null;
  display_order: number;
};

// Snapshot of one card in a "Share Card" carousel post (post_type
// 'card_share', 2-5 items — a single shared card just uses post_type
// 'item' directly, see app/item/new.tsx). Denormalized for the same reason
// as RateMyGrailCard above: the carousel keeps rendering correctly even if
// the source collection_item is later edited or deleted. item_id becomes
// null (not the row deleted) when the source item is removed — snapshot
// fields are the only thing a renderer should ever trust.
export type CardShareItem = {
  id: string;
  post_id: string;
  item_id: string | null;
  snapshot_image_url: string | null;
  snapshot_title: string | null;
  snapshot_subtitle: string | null;
  display_order: number;
};

export type GrailRating = {
  post_id: string;
  rater_user_id: string;
  score: number;
  updated_at: string;
};

// The canonical, polymorphic backing for the profile tab's 3x3 "Grail"
// grid (supabase/migrations/20260723_create_profile_grail_slots.sql).
// hooks/use-grails.ts exposes an item-only compatibility view of this over
// the legacy ShowcaseItem shape for the three pre-existing consumers
// (Rate My Grails, the /grails/[userId] showcase page, and item-detail's
// Add/Remove button) — components that need the full polymorphic slot
// (the profile grid itself) use hooks/use-grail-slots.ts directly.
export type GrailSlotEntryType = 'item' | 'collection';

export type GrailSlot = {
  id: string;
  user_id: string;
  slot_index: number;
  entry_type: GrailSlotEntryType;
  item_id: string | null;
  collection_id: string | null;
  created_at: string;
  item?: CollectionItem | null; // joined via select('*, item:collection_items(*)')
  collection?: Folder | null; // joined via select('*, collection:folders(*)')
  // Hook-attached, non-DB fields for collection slots — populated once by
  // hooks/use-grail-slots.ts's single batched preview query, never
  // derived or re-queried per-render.
  previewImages?: string[];
  collectionItemCount?: number;
};

// Result of trying to write a profile_grail_slots row that hit a unique
// violation (Postgres SQLSTATE 23505). Not every 23505 means the same
// thing: profile_grail_slots_unique_item / _unique_collection means the
// source is already assigned to a different slot; the table's own
// UNIQUE(user_id, slot_index) means the exact slot was concurrently
// claimed out from under this write. null covers both "no error" and "an
// unrecognized 23505" — callers fall back to a generic save-failure
// message in the latter case rather than guessing.
export type GrailSlotConflict = 'duplicate_source' | 'slot_conflict' | null;

export type GrailChooserMode = 'add' | 'replace';

// The "Add to Grails" chooser's explicit intent for whichever slot it's
// currently targeting — tracked as a discriminated union (not just a
// bare slotIndex number) specifically so an intended empty-slot add can
// never silently become a replacement (or vice versa) if the slot's
// occupancy changes while the chooser/picker is open. An 'add' target
// has nothing to verify against (it's supposed to be empty); a
// 'replace' target carries the exact row identity + current source it
// expects to still be there — hooks/use-grail-slots.ts's
// replaceGrailSlot re-verifies all of it in one conditional UPDATE
// immediately before writing.
export type GrailChooserTarget =
  | {
      mode: 'add';
      slotIndex: number;
    }
  | {
      mode: 'replace';
      slotIndex: number;
      expectedSlotId: string;
      expectedEntryType: GrailSlotEntryType;
      expectedRefId: string;
    };

// ============================================================================
// CacheCase Registry (supabase/migrations/20260725160000_
// align_card_registry_with_live_foundation.sql) — Phase 2A, database
// foundation only. No route/UI code reads these yet.
//
// card_types/registered_cards are NOT the table shapes originally proposed
// in 20260725150000 (that migration was never applied — it failed against
// a pre-existing, differently-shaped live prototype dated 2026-07-09, well
// before this repo's migration history). These types match the real,
// reconciled live schema instead: existing column names were kept
// (brand/set_name/player_name/cc_id/serial_number/grade_company/grade/
// cert_number/trust_score), not renamed to match the original proposal.
// ============================================================================

// Catalog-level description shared by many physical copies. Not itself a
// registry identity — see RegisteredCard. No dedup is attempted yet; two
// rows can describe the same real-world card type.
export type CardType = {
  id: string;
  year: number | null;
  brand: string | null;
  set_name: string | null;
  player_name: string | null;
  team: string | null;
  card_number: string | null;
  parallel: string | null;
  variation: string | null;
  print_run: number | null;
  created_at: string;
  created_by: string | null;
};

// 'owner_registered' is the live default/initial status, kept alongside
// the originally-planned active/inactive/owner_account_deleted (see
// registered_cards_status_check).
export type RegisteredCardStatus = 'owner_registered' | 'active' | 'inactive' | 'owner_account_deleted';
export type RegisteredCardVisibility = 'public' | 'unlisted' | 'private';

// The permanent identity for ONE physical card. cc_id is the existing,
// unchanged "CC-XXXX-XXXX" format (generated by the pre-existing
// generate_cc_id() + trg_set_registered_card_cc_id trigger, hardened but
// not replaced) — stored exactly as displayed, never stripped to a bare
// canonical form. serial_number is free text (matches
// collection_items.serial_number's existing convention elsewhere in this
// app), not a split numerator/denominator. Every write goes through
// register_card() / link_registered_card_collection_item() /
// unlink_registered_card_collection_item() — registered_cards has no
// direct-INSERT or direct-UPDATE RLS policy, so a plain
// .from('registered_cards').update(...) client call will always be
// rejected regardless of auth state.
export type RegisteredCard = {
  id: string;
  cc_id: string;
  card_type_id: string | null;
  current_owner_id: string | null;
  created_by: string | null;
  collection_item_id: string | null;
  serial_number: string | null;
  grade_company: string | null;
  grade: string | null;
  cert_number: string | null;
  trust_score: number;
  status: RegisteredCardStatus;
  visibility: RegisteredCardVisibility;
  created_at: string;
  updated_at: string;
  card_type?: CardType | null; // joined via select('*, card_type:card_types(*)')
};

// Ownership-transfer event types are deliberately not included yet — no
// transfer workflow exists in this phase (see registry_events_event_type_check
// in the migration above).
export type RegistryEventType =
  | 'registered'
  | 'item_linked'
  | 'item_unlinked'
  | 'status_changed'
  | 'grading_updated';

// Append-only provenance timeline row. Never updated or deleted by ordinary
// users — RLS on registry_events has no UPDATE/DELETE policy, and no
// direct-INSERT policy either (every row is written by one of the three
// registered_cards RPCs above).
export type RegistryEvent = {
  id: string;
  registered_card_id: string;
  event_type: RegistryEventType;
  actor_id: string | null;
  from_owner_id: string | null;
  to_owner_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

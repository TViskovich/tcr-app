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
  // Registry-owned certificate identity (supabase/migrations/20260729130000_
  // add_registered_cards_snapshot_fields.sql / 20260729131000_
  // populate_snapshot_in_register_card.sql) — set once by register_card at
  // registration time, never touched by collection_item edits or by
  // ownership transfer's collection_item_id clearing. Canonical for display;
  // a linked collection_item is an owner-specific organizational
  // connection, not the source of truth. Not directly owner-editable — a
  // future correction flow would use a separate audited RPC/event. null on
  // cards registered without a linked collection item, and on any card
  // registered before this migration whose collection_item_id was already
  // null at backfill time (no source data existed to backfill from).
  snapshot_image_url: string | null;
  snapshot_title: string | null;
  snapshot_player: string | null;
  snapshot_year: number | null;
  snapshot_brand: string | null;
  snapshot_set_name: string | null;
  snapshot_team: string | null;
  snapshot_card_number: string | null;
  snapshot_variation: string | null;
  // Durable snapshot image tracking (supabase/migrations/20260729140000_
  // add_registry_snapshot_image_tracking.sql / 20260729141000_
  // set_snapshot_image_status_in_register_card.sql). snapshot_image_url
  // above remains a provisional/legacy value (from the still-public
  // item-images bucket) — once snapshot_image_status is 'ready',
  // snapshot_image_storage_path identifies the durable copy in the
  // private registry-images bucket, fetched only via a short-lived signed
  // URL from the get-registry-snapshot-image-url Edge Function. A signed
  // URL is never persisted here or anywhere else.
  snapshot_image_status: RegistrySnapshotImageStatus | null;
  snapshot_image_storage_path: string | null;
  snapshot_image_error_code: RegistrySnapshotImageErrorCode | null;
  snapshot_image_updated_at: string | null;
  // Registry Status v1 (supabase/migrations/20260731120000_
  // add_registry_custody_status.sql). Independent of `status` above —
  // `status` is the registration/account lifecycle field
  // (owner_registered/active/inactive/owner_account_deleted), left
  // completely unchanged by this feature. custody_status tracks where the
  // physical card currently stands. Changed only via
  // update_registered_card_custody_status, which also writes a
  // 'status_changed' registry_events row — never editable directly.
  custody_status: CustodyStatus;
  card_type?: CardType | null; // joined via select('*, card_type:card_types(*)')
};

export type RegistrySnapshotImageStatus = 'pending' | 'ready' | 'failed' | 'unavailable';

// Physical custody/condition status — independent of RegisteredCardStatus
// (registration lifecycle) above. Mirrors the live registry_custody_status
// Postgres enum exactly. Default 'owned' at registration; every other
// value is only ever reached via update_registered_card_custody_status.
export type CustodyStatus =
  | 'owned'
  | 'in_transfer'
  | 'on_loan'
  | 'submitted_for_grading'
  | 'missing'
  | 'stolen'
  | 'destroyed'
  | 'archived';

// Mirrors supabase/functions/_shared/registry-image.ts's
// SnapshotImageErrorCode exactly — kept in sync deliberately rather than
// shared (Deno Edge Function code and the Expo app don't share a build
// step). Never a raw exception message, URL, token, or Storage SDK
// response — only ever one of these fixed codes.
export type RegistrySnapshotImageErrorCode =
  | 'source_missing'
  | 'source_unauthorized'
  | 'invalid_type'
  | 'file_too_large'
  | 'download_failed'
  | 'upload_failed'
  | 'database_update_failed'
  | 'state_changed';

// Ownership-transfer event types added by supabase/migrations/
// 20260729120000_create_ownership_transfers.sql. No ownership_transfer_accepted
// event exists — acceptance and the completed transfer happen atomically
// via accept_ownership_transfer, recorded as a single ownership_transferred
// event.
export type RegistryEventType =
  | 'registered'
  | 'item_linked'
  | 'item_unlinked'
  | 'status_changed'
  | 'grading_updated'
  | 'ownership_transferred';

// Append-only provenance timeline row. Never updated or deleted by ordinary
// users — RLS on registry_events has no UPDATE/DELETE policy, and no
// direct-INSERT policy either (every row is written by one of the three
// registered_cards RPCs above, or by one of the four ownership_transfers
// RPCs below).
export type RegistryEvent = {
  id: string;
  registered_card_id: string;
  event_type: RegistryEventType;
  actor_id: string | null;
  from_owner_id: string | null;
  to_owner_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  // Registry Status v1 — populated only for status_changed events; both
  // null for every other event type. First-class typed fields, not folded
  // into metadata.
  old_custody_status: CustodyStatus | null;
  new_custody_status: CustodyStatus | null;
};

// ============================================================================
// Ownership transfer (supabase/migrations/20260729120000_
// create_ownership_transfers.sql) — Phase A, schema + RPCs only. No route/UI
// code reads or writes this yet.
// ============================================================================

export type OwnershipTransferStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type OwnershipTransferReason = 'sale' | 'trade' | 'gift' | 'other';

// A transfer proposal for one registered card. Unlike RegisteredCard/
// RegistryEvent, this is NOT publicly readable — RLS restricts SELECT to
// from_owner_id/to_owner_id only. Every write goes through
// initiate_ownership_transfer() / accept_ownership_transfer() /
// decline_ownership_transfer() / cancel_ownership_transfer() — no direct
// client INSERT/UPDATE/DELETE policy exists. `accepted` is the terminal
// state of this private proposal row; it is distinct from the public
// `ownership_transferred` registry_events entry produced atomically
// alongside it.
export type OwnershipTransfer = {
  id: string;
  registered_card_id: string;
  from_owner_id: string;
  to_owner_id: string;
  status: OwnershipTransferStatus;
  reason: OwnershipTransferReason | null;
  created_at: string;
  resolved_at: string | null;
};

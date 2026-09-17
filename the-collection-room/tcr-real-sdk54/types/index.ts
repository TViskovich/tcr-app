// Non-destructive pan/zoom framing for a cover_source = 'item' folder cover
// — see supabase/migrations/20260901130000_add_folder_cover_crop.sql for
// the full field contract and lib/folder-cover-crop.ts for the shared math
// that produces/consumes it. x/y are the referenced item image's own
// normalized focal point (0-1); scale is a zoom multiplier relative to
// "just covers the hero frame, no gaps" (1 = that baseline).
export type FolderCoverCrop = {
  x: number;
  y: number;
  scale: number;
};

export type Folder = {
  id: string;
  user_id: string;
  name: string;
  cover_image_url: string | null;
  cover_source: string; // 'upload' | 'first_card' | 'item'
  // Canonical item-images Storage object path for an 'upload' cover — null
  // for 'first_card'/'item' folders by design (both are derived
  // server-side from a collection_items row, never a folder-owned object).
  // Added in Phase 3D (item-images beta privacy hardening); cover_image_url
  // remains for transitional/legacy display only.
  cover_storage_path: string | null;
  // The owner-picked item for cover_source = 'item' (see
  // supabase/migrations/20260901120000_add_folder_cover_item_id.sql) — null
  // for 'upload'/'first_card' folders by design. ON DELETE SET NULL if the
  // referenced item is later deleted.
  cover_item_id: string | null;
  // Only ever meaningful when cover_source = 'item'; null for
  // 'upload'/'first_card' covers, and for 'item' covers picked before this
  // feature existed (those still render with the original centered
  // contentFit="cover" behavior — see FolderCoverImage).
  cover_crop: FolderCoverCrop | null;
  color: string | null; // FolderColorKey (components/collection/folder-card.tsx) or null = auto (name-hash)
  is_public: boolean;
  created_at: string;
  // Self-referencing "category" parent (supabase/migrations/
  // 20260715120000_folder_hierarchy.sql) — null for a top-level folder.
  // Arbitrarily nestable (no DB depth limit); ownership-of-parent and
  // cycle prevention are enforced server-side via RLS
  // (folders_insert_own/folders_update_own), never re-checked client-side.
  // Privacy is inherited recursively up the chain — also enforced entirely
  // server-side (folder_is_effectively_visible), never duplicated here.
  parent_folder_id: string | null;
};

// Collectible type discriminator (supabase/migrations/
// 20260916120000_add_collection_item_type.sql). 'sports_card' is the
// default for every item created before this field existed — the Sports
// Card fields on CollectionItem below remain the only ones with real forms;
// the other three types are UI shells only until their own detail tables
// and forms are built (see item_type's own architecture note in that
// migration).
export type CollectibleItemType = 'sports_card' | 'pokemon' | 'figurine' | 'comic_book';

export type CollectionItem = {
  id: string;
  folder_id: string;
  user_id: string;
  item_type: CollectibleItemType;
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
  // Manual folder ordering (supabase/migrations/
  // 20260912120000_add_collection_item_manual_ordering.sql) — the ONE
  // source of truth for "this folder's items in order": the folder grid,
  // the Collections-tab preview row, and Grail-slot collection previews
  // all sort by this ascending, never by created_at/updated_at. Not
  // client-writable directly (no UPDATE grant on this column at all) —
  // every change goes through reorder_collection_items or
  // move_collection_items. New items are assigned a value below the
  // folder's current minimum by a DB trigger, so they keep appearing first
  // exactly like before this column existed, with no insert-call-site
  // changes anywhere.
  sort_order: number;
  // Item-level privacy (Model A, most-restrictive-wins — see
  // supabase/migrations/20260825120000_add_collection_item_privacy.sql).
  // Effective visibility to a non-owner is folder.is_public AND this — a
  // private folder still hides everything inside it regardless of this
  // flag; an item inside a public folder may independently be private.
  // The owner always has full access regardless of either flag.
  is_public: boolean;
  // Sender Transferred-Out Item Lifecycle (supabase/migrations/
  // 20260804120000_add_collection_item_transferred_out_state.sql). Set to
  // 'transferred_out' exactly once, atomically, by accept_ownership_transfer —
  // never client-writable (a dedicated column-privilege REVOKE blocks
  // ordinary authenticated updates to all three of these fields; see that
  // migration's own follow-up, 20260804120500_fix_collection_items_column_privileges.sql).
  // Only two values in this pass — never widen to a plain string.
  collection_status: 'active' | 'transferred_out';
  transferred_out_at: string | null;
  transferred_registered_card_id: string | null;
  // Client-only, not a DB column — the id of this item's primary
  // collection_item_images row (is_primary = true), attached by
  // lib/item-images.ts's attachPrimaryImageIds() after the base
  // collection_items query. Item-images beta privacy hardening (Phase 3):
  // this is the only identifier the signed-delivery Edge Function accepts,
  // so any live-collection read surface that renders item.image_url
  // directly needs this populated instead. Non-optional (always assign it
  // explicitly, e.g. via attachPrimaryImageIds) rather than `?:` — an
  // optional modifier here previously conflicted with
  // attachPrimaryImageIds's own non-optional return type in type-predicate
  // filters (e.g. hooks/use-saved.ts's `.filter((x): x is SavedCardEntry
  // => ...)`). A raw `.select('*')` result cast via `as CollectionItem[]`
  // is a type assertion, not a structural check, so this doesn't require
  // every existing cast site to literally include the field — only
  // attachPrimaryImageIds's callers get a real value; anything cast
  // without going through it should be treated as effectively unresolved
  // (null) rather than trusted as an unset field.
  primary_image_id: string | null;
};

// Pokémon-specific metadata (supabase/migrations/
// 20260917120000_create_pokemon_card_details.sql) — strictly 1:1 with a
// CollectionItem whose item_type is 'pokemon'; item_id IS the primary key,
// not a separate id. Written only via create_pokemon_item/
// update_pokemon_item (lib/pokemon-items.ts) — never a direct client
// insert/update, even though RLS would technically allow one, to keep the
// common-fields/detail-fields write always atomic (see those RPCs' own
// header comment in the migration above).
export type PokemonCardDetails = {
  item_id: string;
  pokemon_name: string | null;
  set_name: string | null;
  card_number: string | null;
  rarity: string | null;
  language: string | null;
  edition: string | null;
  holo_type: string | null;
  grading_company: string | null;
  grade: string | null;
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
  // Profile 2.0 — collector identity + preferences (infrastructure only;
  // no editing UI yet). tagline/website/location are nullable free text;
  // the four array fields are NOT NULL with an empty-array default in the
  // database, so they're always a real array here too, never null.
  tagline: string | null;
  website: string | null;
  location: string | null;
  favorite_sports: string[];
  favorite_teams: string[];
  collecting_categories: string[];
  collector_tags: string[];
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

// One of a normal text post's 0-4 attached images (post_type 'text' —
// supabase/migrations/20260911150000_create_post_images.sql). Unlike
// RateMyGrailCard/CardShareItem, image_url here is not itself called
// "snapshot_*" but is the exact same kind of value: always an already-
// durable, always-public share-snapshots URL, resolved and copied there
// BEFORE this row is ever written (see lib/share-snapshots.ts's
// createTextPost) — never a raw item-images signed/private URL, and never
// expected to expire. item_id becomes null (row kept, not deleted) if the
// source item is later removed, for a 'item'-sourced image — same
// denormalized "view original card" convention as the other two snapshot
// types; image_url alone is always sufficient to render this row.
export type PostImage = {
  id: string;
  post_id: string;
  item_id: string | null;
  image_url: string;
  source_type: 'library' | 'item';
  sort_order: number;
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
  // derived or re-queried per-render. previewImageIds are
  // collection_item_images.id values (one per distinct item in the
  // folder, primary image only) — never raw/public URLs; a renderer
  // resolves them through useSignedItemImages, same as primary_image_id
  // on an item slot.
  previewImageIds?: string[];
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

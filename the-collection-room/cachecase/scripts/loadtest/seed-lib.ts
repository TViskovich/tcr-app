/// <reference types="node" />
// Shared building blocks for the staging seed scripts (seed-pilot.ts,
// seed-dataset.ts): deterministic ids, the Plan shape, plan validation,
// idempotent writes, and read-only verification.
//
// Everything here works on a Plan — the complete set of rows and Storage
// objects a seed expects to exist — so --dry-run, --seed and --verify all
// reason about exactly the same data.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { SEED_TAG, STAGING_PROJECT_REF } from './staging.ts';
import { renderPlaceholderCard } from './synthetic-jpeg.ts';

export const REQUIRED_BUCKETS = ['item-images', 'share-snapshots'];
// app/(tabs)/index.tsx queryFeed: last 30 days, these post types.
export const FEED_WINDOW_DAYS = 30;
export const FEED_POST_TYPES = ['item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'];
export const DAY_MS = 24 * 60 * 60 * 1000;

const INSERT_BATCH = 500;
const READ_CHUNK = 100;
const PAGE_SIZE = 1000;
const STORAGE_CONCURRENCY = 4;

// ── Ids ─────────────────────────────────────────────────────────────────

// Fixed namespace for every seed's UUIDv5 ids. Never change it: the pilot
// data already in staging was created with it, and reruns recognise rows
// only through these ids.
const ID_NAMESPACE = 'c4c3a5e1-6f0b-4d8e-9a57-2b1e7d0f4a19';

export function seedId(key: string): string {
  const namespace = Buffer.from(ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(`${SEED_TAG}/${key}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Plan ────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;
// One generated JPEG; label/variant drive renderPlaceholderCard.
export type Upload = { bucket: string; path: string; label: string; variant: number };
export type SeedUser = { username: string; id: string; n: string; index: number };
export type PublicUrl = (bucket: string, path: string) => string;

export type Plan = {
  folders: Row[];
  // Cover fields for seed folders still in the app-invalid state
  // cover_source 'upload' with no file (see applyFolderCoverFixes).
  folderCoverFixes: Row[];
  items: Row[];
  images: Row[];
  posts: Row[];
  cardShareItems: Row[];
  comments: Row[];
  likes: Row[];
  follows: Row[];
  conversations: Row[];
  participants: Row[];
  messages: Row[];
  uploads: Upload[];
};

export function emptyPlan(): Plan {
  return {
    folders: [], folderCoverFixes: [], items: [], images: [], posts: [], cardShareItems: [], comments: [],
    likes: [], follows: [], conversations: [], participants: [], messages: [], uploads: [],
  };
}

type TableSpec = {
  field: Exclude<keyof Plan, 'uploads' | 'folderCoverFixes'>;
  table: string;
  label: string;
  // Composite primary key (no id column), else rows are keyed by id.
  keys?: [string, string];
  // Fields --verify compares against the plan (ownership/relationships).
  checkFields: string[];
};

// Insert order: every table after the ones it references.
export const TABLE_SPECS: TableSpec[] = [
  { field: 'folders', table: 'folders', label: 'folders', checkFields: ['user_id', 'parent_folder_id', 'is_public'] },
  { field: 'items', table: 'collection_items', label: 'collection items', checkFields: ['user_id', 'folder_id', 'is_public'] },
  { field: 'images', table: 'collection_item_images', label: 'item image rows', checkFields: ['user_id', 'item_id', 'storage_path'] },
  { field: 'posts', table: 'posts', label: 'posts', checkFields: ['user_id', 'post_type'] },
  { field: 'cardShareItems', table: 'card_share_items', label: 'share card items', checkFields: ['post_id', 'item_id'] },
  { field: 'follows', table: 'follows', label: 'follows', keys: ['follower_id', 'following_id'], checkFields: [] },
  { field: 'likes', table: 'likes', label: 'likes', keys: ['user_id', 'post_id'], checkFields: [] },
  { field: 'comments', table: 'comments', label: 'comments', checkFields: ['user_id', 'post_id'] },
  { field: 'conversations', table: 'conversations', label: 'conversations', checkFields: [] },
  { field: 'participants', table: 'conversation_participants', label: 'conversation participants', keys: ['conversation_id', 'user_id'], checkFields: [] },
  { field: 'messages', table: 'messages', label: 'messages', checkFields: ['conversation_id', 'sender_id'] },
];

const rowKey = (row: Row, keys?: [string, string]) => (keys ? `${row[keys[0]]}|${row[keys[1]]}` : (row.id as string));

// Union of plans; on a key collision the EARLIER plan's row wins. Seed
// scripts pass the pilot plan first, so rows that already exist from the
// pilot keep their pilot definition.
export function mergePlans(...plans: Plan[]): Plan {
  const merged = emptyPlan();
  const dedupe = (rows: Row[], keys?: [string, string]) => {
    const seen = new Map<string, Row>();
    for (const row of rows) if (!seen.has(rowKey(row, keys))) seen.set(rowKey(row, keys), row);
    return [...seen.values()];
  };
  for (const spec of TABLE_SPECS) merged[spec.field] = dedupe(plans.flatMap((p) => p[spec.field]), spec.keys);
  merged.folderCoverFixes = dedupe(plans.flatMap((p) => p.folderCoverFixes));
  const uploads = new Map<string, Upload>();
  for (const u of plans.flatMap((p) => p.uploads)) if (!uploads.has(`${u.bucket}/${u.path}`)) uploads.set(`${u.bucket}/${u.path}`, u);
  merged.uploads = [...uploads.values()];
  return merged;
}

// Offline stand-in for Storage's getPublicUrl (same URL shape), so a dry run
// needs no client.
export const offlinePublicUrl: PublicUrl = (bucket, path) =>
  `https://${STAGING_PROJECT_REF}.supabase.co/storage/v1/object/public/${bucket}/${path}`;

// ── Validation (in memory, before any write) ────────────────────────────

// The service role bypasses RLS, so this re-checks what RLS and the app
// would otherwise guarantee. Returns every violation found.
export function validatePlan(plan: Plan, users: SeedUser[], publicUrl: PublicUrl, now: number): string[] {
  const problems: string[] = [];
  const userIds = new Set(users.map((u) => u.id));
  const folders = new Map(plan.folders.map((f) => [f.id as string, f]));
  const items = new Map(plan.items.map((i) => [i.id as string, i]));
  const posts = new Map(plan.posts.map((p) => [p.id as string, p]));
  const uploaded = new Set(plan.uploads.map((u) => `${u.bucket}/${u.path}`));
  const snapshotUrls = new Set(plan.uploads.filter((u) => u.bucket === 'share-snapshots').map((u) => publicUrl(u.bucket, u.path)));

  const effectivelyPublic = (folderId: string): boolean => {
    for (let id: string | null = folderId, depth = 0; id; depth++) {
      const f = folders.get(id);
      if (!f || depth > 20 || f.is_public !== true) return false;
      id = (f.parent_folder_id as string | null) ?? null;
    }
    return true;
  };

  for (const f of plan.folders) {
    if (!userIds.has(f.user_id as string)) problems.push(`folder ${f.id}: owner is not a seed user`);
    const parentId = f.parent_folder_id as string | null;
    if (parentId) {
      const parent = folders.get(parentId);
      if (!parent) problems.push(`folder ${f.id}: parent not in plan`);
      else if (parent.user_id !== f.user_id) problems.push(`folder ${f.id}: parent owned by another user`);
      const seen = new Set<string>();
      for (let id: string | null = parentId; id; id = (folders.get(id)?.parent_folder_id as string | null) ?? null) {
        if (seen.has(id) || id === f.id) {
          problems.push(`folder ${f.id}: parent cycle`);
          break;
        }
        seen.add(id);
      }
    }
  }
  for (const fix of plan.folderCoverFixes) {
    const folder = folders.get(fix.id as string);
    if (!folder || folder.user_id !== fix.user_id) problems.push(`cover fix ${fix.id}: folder missing or owner mismatch`);
    const path = fix.cover_storage_path as string | null;
    if (path && (!path.startsWith(`${fix.user_id}/`) || !uploaded.has(`item-images/${path}`))) {
      problems.push(`cover fix ${fix.id}: cover object missing or outside the owner's prefix`);
    }
  }
  for (const f of plan.folders) {
    const path = f.cover_storage_path as string | null | undefined;
    if (path && (!path.startsWith(`${f.user_id}/`) || !uploaded.has(`item-images/${path}`))) {
      problems.push(`folder ${f.id}: cover object missing or outside the owner's prefix`);
    }
  }
  for (const i of plan.items) {
    const folder = folders.get(i.folder_id as string);
    if (!folder) problems.push(`item ${i.id}: folder not in plan`);
    else if (folder.user_id !== i.user_id) problems.push(`item ${i.id}: folder owned by another user`);
  }
  for (const img of plan.images) {
    const item = items.get(img.item_id as string);
    const path = img.storage_path as string;
    if (!item) problems.push(`image ${img.id}: item not in plan`);
    else if (item.user_id !== img.user_id) problems.push(`image ${img.id}: owner differs from item owner`);
    if (!path.startsWith(`${img.user_id}/${img.item_id}/`)) problems.push(`image ${img.id}: path outside {owner}/{item}/`);
    if (!uploaded.has(`item-images/${path}`)) problems.push(`image ${img.id}: no Storage object planned`);
  }
  const primaries = new Map<string, number>();
  for (const img of plan.images) if (img.is_primary) primaries.set(img.item_id as string, (primaries.get(img.item_id as string) ?? 0) + 1);
  for (const [itemId, count] of primaries) if (count > 1) problems.push(`item ${itemId}: ${count} primary images`);

  const windowStart = now - (FEED_WINDOW_DAYS - 2) * DAY_MS;
  for (const p of plan.posts) {
    if (!userIds.has(p.user_id as string)) problems.push(`post ${p.id}: author is not a seed user`);
    const at = Date.parse(p.created_at as string);
    if (!(at >= windowStart && at <= now)) problems.push(`post ${p.id}: created_at outside the feed window`);
  }
  for (const c of plan.cardShareItems) {
    const post = posts.get(c.post_id as string);
    const item = items.get(c.item_id as string);
    if (!post || post.post_type !== 'card_share') problems.push(`share card ${c.id}: not on a card_share post`);
    if (!item) problems.push(`share card ${c.id}: item not in plan`);
    else {
      if (post && item.user_id !== post.user_id) problems.push(`share card ${c.id}: item not owned by the poster`);
      if (item.is_public !== true || !effectivelyPublic(item.folder_id as string)) problems.push(`share card ${c.id}: item is not public`);
    }
    if (!snapshotUrls.has(c.snapshot_image_url as string)) problems.push(`share card ${c.id}: snapshot object not planned`);
  }
  for (const l of plan.likes) {
    if (!userIds.has(l.user_id as string) || !posts.has(l.post_id as string)) problems.push(`like ${rowKey(l, ['user_id', 'post_id'])}: unknown user or post`);
  }
  for (const c of plan.comments) {
    if (!userIds.has(c.user_id as string) || !posts.has(c.post_id as string)) problems.push(`comment ${c.id}: unknown user or post`);
  }
  for (const f of plan.follows) {
    if (f.follower_id === f.following_id) problems.push(`follow ${f.follower_id}: follows self`);
    if (!userIds.has(f.follower_id as string) || !userIds.has(f.following_id as string)) problems.push('follow: unknown user');
  }
  const members = new Map<string, Set<string>>();
  for (const p of plan.participants) {
    if (!userIds.has(p.user_id as string)) problems.push(`participant in ${p.conversation_id}: not a seed user`);
    const set = members.get(p.conversation_id as string) ?? new Set<string>();
    set.add(p.user_id as string);
    members.set(p.conversation_id as string, set);
  }
  for (const c of plan.conversations) {
    if (members.get(c.id as string)?.size !== 2) problems.push(`conversation ${c.id}: needs exactly 2 distinct participants`);
  }
  for (const m of plan.messages) {
    if (!members.get(m.conversation_id as string)?.has(m.sender_id as string)) problems.push(`message ${m.id}: sender is not a participant`);
  }
  return problems;
}

// ── Images ──────────────────────────────────────────────────────────────

const rendered = new Map<string, Uint8Array>();
export function renderUpload(upload: Upload): Uint8Array {
  const key = `${upload.label}/${upload.variant}`;
  let bytes = rendered.get(key);
  if (!bytes) {
    bytes = renderPlaceholderCard(upload.label, upload.variant);
    rendered.set(key, bytes);
  }
  return bytes;
}

// ── Reporting ───────────────────────────────────────────────────────────

const formatBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

// Expected records, Storage objects and bytes (rendered in memory, so the
// numbers are exact), and the request counts a full seed would make.
export function describePlan(plan: Plan): { totalBytes: number } {
  console.log('');
  console.log('  expected records');
  for (const spec of TABLE_SPECS) console.log(`    ${spec.label.padEnd(28)} ${String(plan[spec.field].length).padStart(6)}`);
  console.log(`    ${'folder cover fixes'.padEnd(28)} ${String(plan.folderCoverFixes.length).padStart(6)}`);

  let totalBytes = 0;
  let largest = 0;
  console.log('');
  console.log('  Storage objects');
  for (const bucket of REQUIRED_BUCKETS) {
    const uploads = plan.uploads.filter((u) => u.bucket === bucket);
    const bytes = uploads.reduce((sum, u) => {
      const size = renderUpload(u).length;
      largest = Math.max(largest, size);
      return sum + size;
    }, 0);
    totalBytes += bytes;
    console.log(`    ${bucket.padEnd(28)} ${String(uploads.length).padStart(6)} objects  ${formatBytes(bytes)}`);
  }
  console.log(`    ${'total'.padEnd(28)} ${String(plan.uploads.length).padStart(6)} objects  ${formatBytes(totalBytes)} (largest ${formatBytes(largest)})`);

  const insertRequests = TABLE_SPECS.reduce((sum, s) => sum + Math.ceil(plan[s.field].length / INSERT_BATCH) + 1, 0);
  console.log('');
  console.log('  requests for a full --seed (upper bounds)');
  console.log(`    Storage existence checks (HEAD)   ${plan.uploads.length}`);
  console.log(`    Storage uploads (only missing)    ${plan.uploads.length}`);
  console.log(`    database write batches            ~${insertRequests + plan.folderCoverFixes.length}`);
  console.log('    image transformations             0 (seeding never requests a transformed image)');
  console.log(`  in-app notification rows created by the message trigger: up to ${plan.messages.length}`);
  return { totalBytes };
}

// ── Read-only preflight ─────────────────────────────────────────────────

export async function missingBuckets(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.storage.listBuckets();
  if (error) throw new Error(`Listing Storage buckets failed: ${error.message}`);
  const existing = new Set((data ?? []).map((b) => b.id));
  return REQUIRED_BUCKETS.filter((b) => !existing.has(b));
}

// Every user must exist AND carry this seed's tag — a real account is never
// written to.
export async function loadSeedUsers(admin: SupabaseClient, usernames: string[]): Promise<SeedUser[]> {
  const { data, error } = await admin.from('profiles').select('id, username').in('username', usernames);
  if (error) throw new Error(`Profile lookup failed: ${error.message}`);
  const byUsername = new Map((data ?? []).map((p) => [p.username as string, p.id as string]));

  const users: SeedUser[] = [];
  for (const [index, username] of usernames.entries()) {
    const id = byUsername.get(username);
    if (!id) throw new Error(`Seed user ${username} has no profile — run create-test-user.ts first.`);
    const { data: auth, error: authError } = await admin.auth.admin.getUserById(id);
    if (authError || !auth.user) throw new Error(`Auth lookup for ${username} failed: ${authError?.message ?? 'not found'}`);
    if (auth.user.app_metadata?.seed !== SEED_TAG) throw new Error(`${username} is not tagged seed=${SEED_TAG}; refusing to touch it.`);
    users.push({ username, id, n: username.slice(-2), index });
  }
  return users;
}

// The app's get_or_create_conversation reuses an existing conversation
// between two users, so a second (non-seed) one would appear as a duplicate
// in both inboxes. Refuses if any planned pair already shares another one.
export async function assertNoForeignConversations(admin: SupabaseClient, plan: Plan) {
  const planned = new Map<string, string>(); // "a|b" -> planned conversation id
  const byConversation = new Map<string, string[]>();
  for (const p of plan.participants) {
    byConversation.set(p.conversation_id as string, [...(byConversation.get(p.conversation_id as string) ?? []), p.user_id as string]);
  }
  for (const [id, pair] of byConversation) planned.set([...pair].sort().join('|'), id);

  const userIds = [...new Set(plan.participants.map((p) => p.user_id as string))];
  const actual = new Map<string, Set<string>>();
  for (const ids of chunks(userIds, 10)) {
    const rows = await fetchAllPages((from, to) =>
      admin.from('conversation_participants').select('conversation_id, user_id').in('user_id', ids).order('conversation_id').order('user_id').range(from, to),
    );
    for (const r of rows) {
      const set = actual.get(r.conversation_id as string) ?? new Set<string>();
      set.add(r.user_id as string);
      actual.set(r.conversation_id as string, set);
    }
  }
  const clashes = [...actual].filter(([id, set]) => {
    if (set.size !== 2) return false;
    const plannedId = planned.get([...set].sort().join('|'));
    return plannedId !== undefined && plannedId !== id;
  });
  if (clashes.length) {
    throw new Error(`${clashes.length} planned user pair(s) already share a conversation not created by this seed; nothing was written.`);
  }
}

// ── Writes ──────────────────────────────────────────────────────────────

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

// Uploads only objects that don't exist yet (never overwrites), a few at a
// time. Runs before any row is written, so no row points at a missing file.
async function ensureObjects(admin: SupabaseClient, uploads: Upload[]) {
  let present = 0;
  let uploaded = 0;
  await runPool(uploads, STORAGE_CONCURRENCY, async (u) => {
    const { data: exists } = await admin.storage.from(u.bucket).exists(u.path);
    if (exists) {
      present++;
      return;
    }
    const { error } = await admin.storage
      .from(u.bucket)
      .upload(u.path, renderUpload(u), { contentType: 'image/jpeg', upsert: false });
    if (error) {
      // Lost a race with a concurrent run: the object exists, which is the goal.
      const statusCode = (error as { statusCode?: string }).statusCode;
      if (statusCode === '409' || /already exists|duplicate/i.test(error.message)) {
        present++;
        return;
      }
      throw new Error(`Uploading to ${u.bucket} failed: ${error.message}`);
    }
    uploaded++;
  });
  console.log(`  storage: ${uploaded} uploaded, ${present} already present`);
}

// ON CONFLICT DO NOTHING in batches. Rows are grouped by their exact column
// set first: a bulk insert sends NULL for any column a row omits, which
// would override column defaults (e.g. folders.cover_source).
async function insertMissing(admin: SupabaseClient, spec: TableSpec, rows: Row[]) {
  if (!rows.length) return;
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join(',');
    groups.set(signature, [...(groups.get(signature) ?? []), row]);
  }
  for (const group of groups.values()) {
    for (const batch of chunks(group, INSERT_BATCH)) {
      const { error } = await admin.from(spec.table).upsert(batch, {
        onConflict: spec.keys ? spec.keys.join(',') : 'id',
        ignoreDuplicates: true,
      });
      if (error) throw new Error(`Writing ${spec.table} failed: ${error.message}`);
    }
  }
  console.log(`  ${spec.table}: ${rows.length} ensured`);
}

// Seed folders still in the app-invalid state (cover_source 'upload' with
// no file — the pilot seed's original shape) get a real cover. The guard
// means a folder that already has a cover, or any later change, is never
// overwritten.
async function applyFolderCoverFixes(admin: SupabaseClient, fixes: Row[]) {
  // Read first, so only folders actually in the invalid state are written.
  const needsFix = new Set<string>();
  for (const ids of chunks(fixes.map((f) => f.id as string), READ_CHUNK)) {
    const { data, error } = await admin.from('folders').select('id, cover_source, cover_storage_path').in('id', ids);
    if (error) throw new Error(`Reading folder covers failed: ${error.message}`);
    for (const f of data ?? []) if (f.cover_source === 'upload' && !f.cover_storage_path) needsFix.add(f.id);
  }
  let fixed = 0;
  for (const fix of fixes.filter((f) => needsFix.has(f.id as string))) {
    const { id, user_id, ...cover } = fix;
    const { data, error } = await admin
      .from('folders')
      .update(cover)
      .eq('id', id as string)
      .eq('user_id', user_id as string)
      .eq('cover_source', 'upload')
      .is('cover_storage_path', null)
      .select('id');
    if (error) throw new Error(`Fixing folder cover failed: ${error.message}`);
    fixed += data?.length ?? 0;
  }
  if (fixes.length) console.log(`  folder covers: ${fixed} fixed, ${fixes.length - fixed} already valid`);
  if (fixed !== needsFix.size) throw new Error(`Folder cover fix touched ${fixed} of ${needsFix.size} folders; stopping.`);
}

// Posts are inserted once and never updated, so they age. Any seed post
// older than `refreshAfterDays` is moved back to its planned date, keeping
// the dataset inside the feed's rolling 30-day window on every rerun.
async function refreshPostDates(admin: SupabaseClient, posts: Row[], now: number, refreshAfterDays: number) {
  const cutoff = now - refreshAfterDays * DAY_MS;
  const planned = new Map(posts.map((p) => [p.id as string, p.created_at as string]));
  let refreshed = 0;
  for (const ids of chunks([...planned.keys()], READ_CHUNK)) {
    const { data, error } = await admin.from('posts').select('id, created_at').in('id', ids);
    if (error) throw new Error(`Reading post dates failed: ${error.message}`);
    for (const row of data ?? []) {
      if (Date.parse(row.created_at) >= cutoff) continue;
      const { error: updateError } = await admin.from('posts').update({ created_at: planned.get(row.id) }).eq('id', row.id);
      if (updateError) throw new Error(`Refreshing post date failed: ${updateError.message}`);
      refreshed++;
    }
  }
  console.log(`  post dates: ${refreshed} refreshed into the feed window`);
}

export async function seedPlan(admin: SupabaseClient, plan: Plan, now: number) {
  await ensureObjects(admin, plan.uploads);
  for (const spec of TABLE_SPECS) {
    if (spec.field === 'folders') {
      // Parents before children (one nesting level in every seed).
      await insertMissing(admin, spec, plan.folders.filter((f) => !f.parent_folder_id));
      await insertMissing(admin, spec, plan.folders.filter((f) => f.parent_folder_id));
      continue;
    }
    await insertMissing(admin, spec, plan[spec.field]);
  }
  await applyFolderCoverFixes(admin, plan.folderCoverFixes);
  await refreshPostDates(admin, plan.posts, now, FEED_WINDOW_DAYS - 5);
}

// ── Verify (read-only) ──────────────────────────────────────────────────

type Check = { label: string; expected: number; found: number; note?: string };

export async function fetchAllPages(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Read failed: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

// Rows present by id, and how many differ from the plan in `fields`.
async function checkById(admin: SupabaseClient, label: string, table: string, rows: Row[], fields: string[]): Promise<Check> {
  const actual = new Map<string, Row>();
  for (const ids of chunks(rows.map((r) => r.id as string), READ_CHUNK)) {
    const { data, error } = await admin.from(table).select(['id', ...fields].join(', ')).in('id', ids);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    for (const r of (data ?? []) as unknown as Row[]) actual.set(r.id as string, r);
  }
  const mismatched = rows.filter((r) => {
    const found = actual.get(r.id as string);
    return found && fields.some((f) => found[f] !== r[f]);
  }).length;
  return { label, expected: rows.length, found: actual.size, note: mismatched ? `${mismatched} differ from plan` : undefined };
}

async function checkByKey(admin: SupabaseClient, label: string, table: string, rows: Row[], [k1, k2]: [string, string]): Promise<Check> {
  const present = new Set<string>();
  const firstKeys = [...new Set(rows.map((r) => r[k1] as string))];
  for (const ids of chunks(firstKeys, 10)) {
    const found = await fetchAllPages((from, to) =>
      admin.from(table).select(`${k1}, ${k2}`).in(k1, ids).order(k1).order(k2).range(from, to),
    );
    for (const r of found) present.add(`${r[k1]}|${r[k2]}`);
  }
  return { label, expected: rows.length, found: rows.filter((r) => present.has(`${r[k1]}|${r[k2]}`)).length };
}

export async function verifyPlan(admin: SupabaseClient, plan: Plan, now: number): Promise<boolean> {
  const checks: Check[] = [];
  for (const spec of TABLE_SPECS) {
    const rows = plan[spec.field];
    checks.push(
      spec.keys
        ? await checkByKey(admin, spec.label, spec.table, rows, spec.keys)
        : await checkById(admin, spec.label, spec.table, rows, spec.checkFields),
    );
  }
  if (plan.folderCoverFixes.length) {
    checks.push(await checkById(admin, 'folder covers', 'folders', plan.folderCoverFixes, ['cover_source', 'cover_storage_path']));
  }

  for (const bucket of REQUIRED_BUCKETS) {
    const uploads = plan.uploads.filter((u) => u.bucket === bucket);
    let found = 0;
    // exists() resolves false for a missing object (HTTP 400/404) and
    // throws on any other failure, which stops the run.
    await runPool(uploads, STORAGE_CONCURRENCY * 2, async (u) => {
      const { data } = await admin.storage.from(bucket).exists(u.path);
      if (data) found++;
    });
    checks.push({ label: `storage ${bucket}`, expected: uploads.length, found });
  }

  // The feed's own filters. Posts are readable by every viewer
  // (posts_select_public), so this matches what users see.
  const windowStart = new Date(now - FEED_WINDOW_DAYS * DAY_MS).toISOString();
  let inWindow = 0;
  for (const ids of chunks(plan.posts.map((p) => p.id as string), READ_CHUNK)) {
    const { count, error } = await admin
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .in('id', ids)
      .in('post_type', FEED_POST_TYPES)
      .gte('created_at', windowStart);
    if (error) throw new Error(`Feed check failed: ${error.message}`);
    inWindow += count ?? 0;
  }
  checks.push({ label: 'posts in feed window', expected: plan.posts.length, found: inWindow });

  console.log('');
  console.log('  check                        expected   found');
  for (const c of checks) {
    const status = c.found === c.expected && !c.note ? 'ok' : c.note ?? 'MISSING';
    console.log(`  ${c.label.padEnd(28)} ${String(c.expected).padStart(8)} ${String(c.found).padStart(7)}   ${status}`);
  }
  const complete = checks.every((c) => c.found === c.expected && !c.note);
  console.log('');
  console.log(complete ? 'Seed data is complete.' : 'Seed data is incomplete (see above).');
  return complete;
}

/// <reference types="node" />
// Removes the loadtest-v1 synthetic CONTENT from CacheCase STAGING while
// keeping the 30 synthetic accounts (auth users + profiles) for reuse.
//
//   node scripts/loadtest/cleanup-dataset.ts --dry-run [--details]   read-only: exactly what would go
//   node scripts/loadtest/cleanup-dataset.ts --verify                read-only: what exists, orphans,
//                                                                     foreign references, account status
//   node scripts/loadtest/cleanup-dataset.ts --cleanup --confirm=ickqkzvqddkhqyxnbzox
//
// What counts as synthetic (seed metadata + ownership + deterministic ids):
//   - the 30 accounts lt_user_01…30, each of which must carry
//     app_metadata.seed = loadtest-v1 (otherwise nothing runs);
//   - folders, items, item images and posts OWNED by those accounts — the
//     seeded rows (reported as "planned", recognised by their UUIDv5 ids)
//     plus anything those accounts created during load testing ("extra");
//   - follows and notifications where BOTH users are synthetic;
//   - conversations whose participants are ALL synthetic, plus seed-id
//     conversations left with no participants;
//   - Storage objects under a synthetic account's own prefix in item-images
//     and share-snapshots, and under a synthetic conversation in
//     dm-attachments.
//
// Never touched: auth users, profiles, avatars, anything owned by a
// non-synthetic account, and synthetic activity that points at real data
// (e.g. a synthetic user's like on a real post, or a follow of a real user)
// — those are reported as "kept".
//
// Foreign references block cleanup: if any non-synthetic account has data
// that a delete here would cascade away or unlink (a like, comment, repost,
// saved card, registry link, … on synthetic content), --cleanup refuses and
// lists them, and nothing is deleted.
//
// Retry-safe: every run rediscovers the current state and deletes by id, so
// a partial failure is finished by running it again.

import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_USERS, buildFullPlan, usernamesFor } from './dataset-plan.ts';
import { chunks, fetchAllPages, loadSeedUsers, mergePlans, type Row, type SeedUser } from './seed-lib.ts';
import { STAGING_PROJECT_REF, createAdminClient, loadStagingConfig, runMain } from './staging.ts';

const USER_BUCKETS = ['item-images', 'share-snapshots'];
const DM_BUCKET = 'dm-attachments';
const READ_CHUNK = 100;
const DELETE_CHUNK = 100;
const LIST_LIMIT = 1000;

// ── Reads ───────────────────────────────────────────────────────────────

// Every row of `table` whose `column` is in `values` (chunked and paged).
async function selectIn(
  admin: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: Iterable<string>,
  orderBy: string[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const chunk of chunks([...new Set(values)], READ_CHUNK)) {
    rows.push(
      ...(await fetchAllPages((from, to) => {
        let query = admin.from(table).select(columns).in(column, chunk);
        for (const o of orderBy) query = query.order(o);
        return query.range(from, to);
      })),
    );
  }
  return rows;
}

// All object paths under `prefix`, descending into folders.
async function listRecursive(admin: SupabaseClient, bucket: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [prefix];
  while (queue.length) {
    const dir = queue.shift()!;
    for (let offset = 0; ; offset += LIST_LIMIT) {
      const { data, error } = await admin.storage
        .from(bucket)
        .list(dir, { limit: LIST_LIMIT, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`Listing ${bucket}/${dir} failed: ${error.message}`);
      for (const entry of data ?? []) {
        const path = `${dir}/${entry.name}`;
        // Folders come back without an id.
        if (entry.id === null) queue.push(path);
        else files.push(path);
      }
      if ((data?.length ?? 0) < LIST_LIMIT) break;
    }
  }
  return files;
}

function snapshotPath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const marker = '/object/public/share-snapshots/';
  const at = url.indexOf(marker);
  return at === -1 ? null : decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
}

// ── Inventory ───────────────────────────────────────────────────────────

type Planned = { folders: Set<string>; items: Set<string>; posts: Set<string>; conversations: Set<string> };

type Inventory = {
  folders: Row[]; // id, parent_folder_id, cover_storage_path
  itemIds: string[];
  images: Row[]; // id, item_id, storage_path
  deletablePostIds: string[];
  keptPostIds: string[];
  referencedSnapshots: Set<string>;
  syntheticConversations: string[];
  orphanConversations: string[];
  mixedConversations: string[];
  messageCount: number;
  follows: Row[]; // both synthetic
  keptFollows: number;
  notificationIds: string[]; // both synthetic
  likesCascading: number;
  keptLikes: number;
  commentsCascading: number;
  keptComments: number;
  storage: Map<string, string[]>; // bucket -> paths (user prefixes)
  dmObjects: string[];
  avatarObjects: number;
};

async function discover(admin: SupabaseClient, users: SeedUser[]): Promise<Inventory> {
  const U = new Set(users.map((u) => u.id));
  const uids = [...U];

  const folders = await selectIn(admin, 'folders', 'id, parent_folder_id, cover_storage_path', 'user_id', uids, ['id']);
  const itemIds = (await selectIn(admin, 'collection_items', 'id', 'user_id', uids, ['id'])).map((r) => r.id as string);
  const images = await selectIn(admin, 'collection_item_images', 'id, item_id, storage_path', 'user_id', uids, ['id']);

  // A synthetic post is deletable unless it reposts/quotes a post that is
  // not itself deletable (i.e. real content) — resolved to a fixed point.
  const posts = await selectIn(admin, 'posts', 'id, repost_of_post_id, quote_of_post_id, folder_cover_snapshot_url', 'user_id', uids, ['id']);
  const deletable = new Set(posts.map((p) => p.id as string));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of posts) {
      if (!deletable.has(p.id as string)) continue;
      const refs = [p.repost_of_post_id, p.quote_of_post_id].filter(Boolean) as string[];
      if (refs.some((r) => !deletable.has(r))) {
        deletable.delete(p.id as string);
        changed = true;
      }
    }
  }
  const deletablePostIds = [...deletable];
  const keptPostIds = posts.map((p) => p.id as string).filter((id) => !deletable.has(id));

  // Snapshot objects the remaining rows still point at (for orphan checks).
  const referencedSnapshots = new Set<string>();
  for (const p of posts) {
    const path = snapshotPath(p.folder_cover_snapshot_url);
    if (path) referencedSnapshots.add(path);
  }
  for (const table of ['card_share_items', 'rate_my_grail_cards', 'folder_share_items']) {
    for (const r of await selectIn(admin, table, 'id, snapshot_image_url', 'post_id', posts.map((p) => p.id as string), ['id'])) {
      const path = snapshotPath(r.snapshot_image_url);
      if (path) referencedSnapshots.add(path);
    }
  }

  // Conversations: synthetic only if every participant is synthetic.
  const mine = await selectIn(admin, 'conversation_participants', 'conversation_id, user_id', 'user_id', uids, ['conversation_id', 'user_id']);
  const allParticipants = await selectIn(
    admin,
    'conversation_participants',
    'conversation_id, user_id',
    'conversation_id',
    mine.map((r) => r.conversation_id as string),
    ['conversation_id', 'user_id'],
  );
  const members = new Map<string, string[]>();
  for (const r of allParticipants) members.set(r.conversation_id as string, [...(members.get(r.conversation_id as string) ?? []), r.user_id as string]);
  const syntheticConversations = [...members].filter(([, ids]) => ids.every((id) => U.has(id))).map(([id]) => id);
  const mixedConversations = [...members].filter(([, ids]) => !ids.every((id) => U.has(id))).map(([id]) => id);

  // Seed-id conversations that lost every participant (nothing else can
  // find them: conversations have no owner column).
  const planned = plannedIds(users);
  const existingPlanned = (await selectIn(admin, 'conversations', 'id', 'id', planned.conversations, ['id'])).map((r) => r.id as string);
  const plannedWithMembers = new Set(
    (await selectIn(admin, 'conversation_participants', 'conversation_id', 'conversation_id', existingPlanned, ['conversation_id'])).map(
      (r) => r.conversation_id as string,
    ),
  );
  const orphanConversations = existingPlanned.filter((id) => !plannedWithMembers.has(id));

  let messageCount = 0;
  for (const chunk of chunks([...syntheticConversations, ...orphanConversations], READ_CHUNK)) {
    const { count, error } = await admin.from('messages').select('id', { count: 'exact', head: true }).in('conversation_id', chunk);
    if (error) throw new Error(`Counting messages failed: ${error.message}`);
    messageCount += count ?? 0;
  }

  const followRows = await selectIn(admin, 'follows', 'follower_id, following_id', 'follower_id', uids, ['follower_id', 'following_id']);
  const follows = followRows.filter((f) => U.has(f.following_id as string));

  const notificationIds = (await selectIn(admin, 'notifications', 'id, actor_id', 'user_id', uids, ['id']))
    .filter((n) => U.has(n.actor_id as string))
    .map((n) => n.id as string);

  const likes = await selectIn(admin, 'likes', 'user_id, post_id', 'user_id', uids, ['user_id', 'post_id']);
  const comments = await selectIn(admin, 'comments', 'id, post_id', 'user_id', uids, ['id']);

  const storage = new Map<string, string[]>();
  for (const bucket of USER_BUCKETS) {
    const paths: string[] = [];
    for (const uid of uids) paths.push(...(await listRecursive(admin, bucket, uid)));
    storage.set(bucket, paths);
  }
  const dmObjects: string[] = [];
  for (const id of [...syntheticConversations, ...orphanConversations]) dmObjects.push(...(await listRecursive(admin, DM_BUCKET, id)));
  let avatarObjects = 0;
  for (const uid of uids) avatarObjects += (await listRecursive(admin, 'avatars', uid)).length;

  return {
    folders,
    itemIds,
    images,
    deletablePostIds,
    keptPostIds,
    referencedSnapshots,
    syntheticConversations,
    orphanConversations,
    mixedConversations,
    messageCount,
    follows,
    keptFollows: followRows.length - follows.length,
    notificationIds,
    likesCascading: likes.filter((l) => deletable.has(l.post_id as string)).length,
    keptLikes: likes.filter((l) => !deletable.has(l.post_id as string)).length,
    commentsCascading: comments.filter((c) => deletable.has(c.post_id as string)).length,
    keptComments: comments.filter((c) => !deletable.has(c.post_id as string)).length,
    storage,
    dmObjects,
    avatarObjects,
  };
}

// Ids the seed scripts generate for any --users value (2–30), so seeded
// rows are reported as "planned" and participant-less seed conversations
// can still be found.
function plannedIds(users: SeedUser[]): Planned {
  const noUrl = () => '';
  const now = Date.now();
  const plan = mergePlans(...Array.from({ length: users.length - 1 }, (_, i) => buildFullPlan(users.slice(0, i + 2), noUrl, now)));
  return {
    folders: new Set(plan.folders.map((r) => r.id as string)),
    items: new Set(plan.items.map((r) => r.id as string)),
    posts: new Set(plan.posts.map((r) => r.id as string)),
    conversations: new Set(plan.conversations.map((r) => r.id as string)),
  };
}

// ── Foreign references ──────────────────────────────────────────────────

// Data owned by a NON-synthetic account that deleting synthetic content
// would cascade away (or unlink via SET NULL). Any hit blocks --cleanup.
async function findForeignReferences(admin: SupabaseClient, users: SeedUser[], inv: Inventory): Promise<{ label: string; count: number }[]> {
  const U = new Set(users.map((u) => u.id));
  const posts = inv.deletablePostIds;
  const items = inv.itemIds;
  const folders = inv.folders.map((f) => f.id as string);
  const synthetic = new Set([...inv.syntheticConversations, ...inv.orphanConversations]);
  const postSet = new Set(posts);
  const notSynthetic = (column: string) => (r: Row) => !U.has(r[column] as string);

  const checks: [string, () => Promise<Row[]>, (r: Row) => boolean][] = [
    ['likes on synthetic posts', () => selectIn(admin, 'likes', 'user_id, post_id', 'post_id', posts, ['user_id', 'post_id']), notSynthetic('user_id')],
    ['comments on synthetic posts', () => selectIn(admin, 'comments', 'id, user_id', 'post_id', posts, ['id']), notSynthetic('user_id')],
    ['reposts of synthetic posts', () => selectIn(admin, 'posts', 'id, user_id', 'repost_of_post_id', posts, ['id']), notSynthetic('user_id')],
    ['quotes of synthetic posts', () => selectIn(admin, 'posts', 'id, user_id', 'quote_of_post_id', posts, ['id']), notSynthetic('user_id')],
    ['notifications about synthetic posts', () => selectIn(admin, 'notifications', 'id, user_id', 'post_id', posts, ['id']), notSynthetic('user_id')],
    ['posts linking synthetic items', () => selectIn(admin, 'posts', 'id, user_id', 'item_id', items, ['id']), notSynthetic('user_id')],
    ['posts linking synthetic folders', () => selectIn(admin, 'posts', 'id, user_id', 'folder_id', folders, ['id']), notSynthetic('user_id')],
    ...(['card_share_items', 'rate_my_grail_cards', 'folder_share_items', 'post_images'] as const).map(
      (table) =>
        [`${table} on other posts linking synthetic items`, () => selectIn(admin, table, 'id, post_id', 'item_id', items, ['id']), (r: Row) => !postSet.has(r.post_id as string)] as [
          string,
          () => Promise<Row[]>,
          (r: Row) => boolean,
        ],
    ),
    ['item likes on synthetic items', () => selectIn(admin, 'item_likes', 'user_id, item_id', 'item_id', items, ['user_id', 'item_id']), notSynthetic('user_id')],
    ['item comments on synthetic items', () => selectIn(admin, 'item_comments', 'id, user_id', 'item_id', items, ['id']), notSynthetic('user_id')],
    ['saved synthetic items', () => selectIn(admin, 'saved_cards', 'user_id, item_id', 'item_id', items, ['user_id', 'item_id']), notSynthetic('user_id')],
    ['showcase entries of synthetic items', () => selectIn(admin, 'profile_showcase_items', 'id, user_id', 'item_id', items, ['id']), notSynthetic('user_id')],
    ['grail slots holding synthetic items', () => selectIn(admin, 'profile_grail_slots', 'id, user_id', 'item_id', items, ['id']), notSynthetic('user_id')],
    ['grail slots holding synthetic folders', () => selectIn(admin, 'profile_grail_slots', 'id, user_id', 'collection_id', folders, ['id']), notSynthetic('user_id')],
    ['registry cards linked to synthetic items', () => selectIn(admin, 'registered_cards', 'id, current_owner_id', 'collection_item_id', items, ['id']), notSynthetic('current_owner_id')],
    ['messages attaching synthetic items', () => selectIn(admin, 'messages', 'id, conversation_id', 'attachment_item_id', items, ['id']), (r: Row) => !synthetic.has(r.conversation_id as string)],
    ['folder likes on synthetic folders', () => selectIn(admin, 'folder_likes', 'user_id, folder_id', 'folder_id', folders, ['user_id', 'folder_id']), notSynthetic('user_id')],
    ['folder comments on synthetic folders', () => selectIn(admin, 'folder_comments', 'id, user_id', 'folder_id', folders, ['id']), notSynthetic('user_id')],
    ['gallery comments on synthetic folders', () => selectIn(admin, 'gallery_comments', 'id, user_id', 'folder_id', folders, ['id']), notSynthetic('user_id')],
    ['saved synthetic folders', () => selectIn(admin, 'saved_folders', 'user_id, folder_id', 'folder_id', folders, ['user_id', 'folder_id']), notSynthetic('user_id')],
    ['folders nested in synthetic folders', () => selectIn(admin, 'folders', 'id, user_id', 'parent_folder_id', folders, ['id']), notSynthetic('user_id')],
  ];

  const found: { label: string; count: number }[] = [];
  for (const [label, read, isForeign] of checks) {
    const count = (await read()).filter(isForeign).length;
    if (count) found.push({ label, count });
  }
  return found;
}

// ── Reporting ───────────────────────────────────────────────────────────

function report(inv: Inventory, planned: Planned, details: boolean) {
  const split = (ids: string[], set: Set<string>) => {
    const p = ids.filter((id) => set.has(id)).length;
    return `${ids.length} (${p} planned, ${ids.length - p} extra)`;
  };
  const folderIds = inv.folders.map((f) => f.id as string);
  const list = (label: string, values: string[]) => {
    if (!details || !values.length) return;
    console.log(`      ${label}:`);
    for (const v of values) console.log(`        ${v}`);
  };

  console.log('');
  console.log('  Would be removed, in order:');
  console.log(`    1. dm-attachments objects in synthetic conversations   ${inv.dmObjects.length}`);
  list('paths', inv.dmObjects);
  console.log(`    2. notifications between synthetic accounts             ${inv.notificationIds.length}`);
  list('ids', inv.notificationIds);
  console.log(`    3. synthetic conversations                              ${inv.syntheticConversations.length} (+${inv.orphanConversations.length} with no participants)`);
  console.log(`         cascades: participants, ${inv.messageCount} messages, their notifications`);
  list('ids', [...inv.syntheticConversations, ...inv.orphanConversations]);
  console.log(`    4. follows between synthetic accounts                   ${inv.follows.length}`);
  list('follower > following', inv.follows.map((f) => `${f.follower_id} > ${f.following_id}`));
  console.log(`    5. synthetic posts                                      ${split(inv.deletablePostIds, planned.posts)}`);
  console.log(`         cascades: ${inv.likesCascading} likes and ${inv.commentsCascading} comments by synthetic users, Share Card/grail/folder-share/photo rows`);
  list('ids', inv.deletablePostIds);
  console.log(`    6. synthetic folders (leaf-first)                       ${split(folderIds, planned.folders)}`);
  console.log(`         cascades: ${inv.itemIds.length} items ${split(inv.itemIds, planned.items).replace(/^\d+ /, '')}, ${inv.images.length} item image rows, item likes/comments/saves`);
  list('ids', folderIds);
  console.log('    7. any synthetic items left outside synthetic folders   (re-checked at run time)');
  for (const [bucket, paths] of inv.storage) {
    console.log(`    8. ${`${bucket} objects under synthetic prefixes`.padEnd(52)} ${paths.length}`);
    list('paths', paths);
  }

  console.log('');
  console.log('  Kept (synthetic activity that touches real data, or account data):');
  console.log(`    posts reposting/quoting non-synthetic posts            ${inv.keptPostIds.length}`);
  console.log(`    likes / comments on non-synthetic posts                ${inv.keptLikes} / ${inv.keptComments}`);
  console.log(`    follows of non-synthetic accounts                      ${inv.keptFollows}`);
  console.log(`    conversations with a non-synthetic participant         ${inv.mixedConversations.length}`);
  console.log(`    avatar objects (account data)                          ${inv.avatarObjects}`);
}

// Synthetic content still present (0 everywhere = clean). "Kept" data is
// not counted.
function remaining(inv: Inventory): [string, number][] {
  return [
    ['folders', inv.folders.length],
    ['items', inv.itemIds.length],
    ['item image rows', inv.images.length],
    ['posts', inv.deletablePostIds.length],
    ['conversations', inv.syntheticConversations.length + inv.orphanConversations.length],
    ['messages', inv.messageCount],
    ['follows', inv.follows.length],
    ['notifications', inv.notificationIds.length],
    ...[...inv.storage].map(([bucket, paths]) => [`${bucket} objects`, paths.length] as [string, number]),
    ['dm-attachments objects', inv.dmObjects.length],
  ];
}

// Integrity issues within synthetic data (read-only).
function orphans(inv: Inventory): string[] {
  const out: string[] = [];
  const itemObjects = new Set(inv.storage.get('item-images') ?? []);
  const snapshotObjects = new Set(inv.storage.get('share-snapshots') ?? []);
  const referenced = new Set<string>([
    ...inv.images.map((i) => i.storage_path as string),
    ...(inv.folders.map((f) => f.cover_storage_path).filter(Boolean) as string[]),
  ]);
  const unreferencedItems = [...itemObjects].filter((p) => !referenced.has(p)).length;
  const unreferencedSnapshots = [...snapshotObjects].filter((p) => !inv.referencedSnapshots.has(p)).length;
  const missingImages = inv.images.filter((i) => !itemObjects.has(i.storage_path as string)).length;
  const missingCovers = inv.folders.filter((f) => f.cover_storage_path && !itemObjects.has(f.cover_storage_path as string)).length;
  const missingSnapshots = [...inv.referencedSnapshots].filter((p) => !snapshotObjects.has(p)).length;
  if (unreferencedItems) out.push(`${unreferencedItems} item-images objects not referenced by any image row or folder cover`);
  if (unreferencedSnapshots) out.push(`${unreferencedSnapshots} share-snapshots objects not referenced by any post`);
  if (missingImages) out.push(`${missingImages} item image rows whose Storage object is missing`);
  if (missingCovers) out.push(`${missingCovers} folder covers whose Storage object is missing`);
  if (missingSnapshots) out.push(`${missingSnapshots} post snapshots whose Storage object is missing`);
  if (inv.orphanConversations.length) out.push(`${inv.orphanConversations.length} seed conversations with no participants`);
  return out;
}

// ── Cleanup ─────────────────────────────────────────────────────────────

async function deleteByIds(admin: SupabaseClient, table: string, ids: string[]) {
  for (const chunk of chunks(ids, DELETE_CHUNK)) {
    const { error } = await admin.from(table).delete().in('id', chunk);
    if (error) throw new Error(`Deleting from ${table} failed: ${error.message}`);
  }
  console.log(`  ${table}: ${ids.length} deleted (cascades included)`);
}

async function removeObjects(admin: SupabaseClient, bucket: string, paths: string[]) {
  for (const chunk of chunks(paths, DELETE_CHUNK)) {
    const { error } = await admin.storage.from(bucket).remove(chunk);
    if (error) throw new Error(`Removing ${bucket} objects failed: ${error.message}`);
  }
  console.log(`  storage ${bucket}: ${paths.length} removed`);
}

async function cleanup(admin: SupabaseClient, users: SeedUser[], inv: Inventory) {
  const uids = users.map((u) => u.id);

  // 1. DM images first: their paths are keyed by conversation id, which is
  //    unrecoverable once the conversation rows are gone.
  await removeObjects(admin, DM_BUCKET, inv.dmObjects);
  // 2. Synthetic↔synthetic notifications (follow/like ones don't cascade).
  await deleteByIds(admin, 'notifications', inv.notificationIds);
  // 3. Conversations before items, so no message row is ever updated by an
  //    item's attachment SET NULL. Cascades participants and messages.
  await deleteByIds(admin, 'conversations', [...inv.syntheticConversations, ...inv.orphanConversations]);
  // 4. Follows between synthetic accounts (composite key).
  const byFollower = new Map<string, string[]>();
  for (const f of inv.follows) byFollower.set(f.follower_id as string, [...(byFollower.get(f.follower_id as string) ?? []), f.following_id as string]);
  for (const [follower, following] of byFollower) {
    const { error } = await admin.from('follows').delete().eq('follower_id', follower).in('following_id', following);
    if (error) throw new Error(`Deleting follows failed: ${error.message}`);
  }
  console.log(`  follows: ${inv.follows.length} deleted`);
  // 5. Posts (cascades likes, comments, Share Card/grail/folder-share/photo rows).
  await deleteByIds(admin, 'posts', inv.deletablePostIds);
  // 6. Folders leaf-first, so no child is ever re-parented by SET NULL.
  //    Cascades items, image rows, item likes/comments/saves.
  const parentOf = new Map(inv.folders.map((f) => [f.id as string, (f.parent_folder_id as string | null) ?? null]));
  let deletedFolders = 0;
  for (let pass = 0; parentOf.size; pass++) {
    if (pass > 50) throw new Error('Folder nesting did not resolve; stopping.');
    const parents = new Set([...parentOf.values()].filter(Boolean));
    const leaves = [...parentOf.keys()].filter((id) => !parents.has(id));
    if (!leaves.length) throw new Error('Folder parent cycle detected; stopping.');
    for (const chunk of chunks(leaves, DELETE_CHUNK)) {
      const { error } = await admin.from('folders').delete().in('id', chunk);
      if (error) throw new Error(`Deleting folders failed: ${error.message}`);
    }
    leaves.forEach((id) => parentOf.delete(id));
    deletedFolders += leaves.length;
  }
  console.log(`  folders: ${deletedFolders} deleted (cascades included)`);
  // 7. Items a synthetic account owns outside its own folders (shouldn't
  //    exist; re-read now, after the folder cascade).
  const leftover = (await selectIn(admin, 'collection_items', 'id', 'user_id', uids, ['id'])).map((r) => r.id as string);
  if (leftover.length) await deleteByIds(admin, 'collection_items', leftover);
  // 8. Storage under each synthetic account's prefix — after the rows, and
  //    re-listed on every run, so a failure here is finished by rerunning.
  for (const [bucket, paths] of inv.storage) await removeObjects(admin, bucket, paths);
}

// ── Entry ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const modes = ['--dry-run', '--verify', '--cleanup'].filter((m) => args.includes(m));
  if (modes.length !== 1) throw new Error('Pass exactly one of --dry-run, --verify or --cleanup.');
  const mode = modes[0];
  if (mode === '--cleanup' && !args.includes(`--confirm=${STAGING_PROJECT_REF}`)) {
    throw new Error(`--cleanup deletes data: add --confirm=${STAGING_PROJECT_REF} to proceed.`);
  }

  const config = loadStagingConfig();
  console.log(`Target project: ${config.ref} (staging) — ${mode}`);
  const admin = createAdminClient(config);

  // All 30 accounts must exist and be tagged; they are never deleted.
  const users = await loadSeedUsers(admin, usernamesFor(MAX_USERS));
  console.log(`Synthetic accounts: ${users.length} found, all tagged`);

  const planned = plannedIds(users);
  const inv = await discover(admin, users);
  const foreign = await findForeignReferences(admin, users, inv);

  if (mode !== '--verify') report(inv, planned, args.includes('--details'));

  if (foreign.length) {
    console.log('');
    console.log('  Non-synthetic data that cleanup would delete or unlink:');
    for (const f of foreign) console.log(`    ${f.label.padEnd(52)} ${f.count}`);
  }

  if (mode === '--verify') {
    console.log('');
    console.log('  Synthetic content present:');
    for (const [label, n] of remaining(inv)) console.log(`    ${label.padEnd(28)} ${n}`);
    const issues = orphans(inv);
    console.log('');
    console.log(issues.length ? '  Orphans / integrity issues:' : '  Orphans / integrity issues: none');
    for (const issue of issues) console.log(`    ${issue}`);
    return;
  }
  if (mode === '--dry-run') {
    console.log('');
    console.log(foreign.length ? '--cleanup would REFUSE (see non-synthetic data above).' : 'Dry run only — nothing was deleted.');
    return;
  }

  if (foreign.length) throw new Error('Refusing to clean up: non-synthetic data depends on synthetic content (listed above). Nothing was deleted.');

  console.log('');
  console.log('Cleaning up…');
  await cleanup(admin, users, inv);

  // Final verification: content gone, all 30 accounts (auth + profile) intact.
  console.log('');
  console.log('Final verification');
  const after = await discover(admin, users);
  const left = remaining(after).filter(([, n]) => n > 0);
  for (const [label, n] of left) console.log(`  still present: ${label} ${n}`);
  const accounts = await loadSeedUsers(admin, usernamesFor(MAX_USERS));
  const { count: profiles, error } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .in('id', accounts.map((u) => u.id));
  if (error) throw new Error(`Profile check failed: ${error.message}`);
  console.log(`  synthetic accounts: ${accounts.length} auth users, ${profiles ?? 0} profiles`);
  if (left.length || accounts.length !== MAX_USERS || profiles !== MAX_USERS) {
    process.exitCode = 1;
    console.log('Cleanup incomplete — rerun the same command to finish (it is retry-safe).');
  } else {
    console.log('Clean: no synthetic content remains; all 30 synthetic accounts are intact.');
  }
}

runMain(main);

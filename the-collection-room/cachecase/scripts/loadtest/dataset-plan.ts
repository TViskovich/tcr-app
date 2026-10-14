// The 5/30-user load-test dataset plan, moved unchanged from seed-dataset.ts
// so other scripts (cleanup-dataset.ts) can rebuild the same deterministic
// ids without running a seed. Do not change keys, paths or layout here:
// existing staging rows are recognised only through them.

import { PILOT_USERNAMES, buildPilotPlan } from './pilot-plan.ts';
import { DAY_MS, emptyPlan, mergePlans, seedId, type Plan, type PublicUrl, type SeedUser } from './seed-lib.ts';
import { SEED_TAG } from './staging.ts';

export const MAX_USERS = 30;

const ITEMS_PER_USER = 25;
const FOLDERS = [
  { name: 'LT Binder A', parent: null, isPublic: true, cover: 'first_card' },
  { name: 'LT Binder B', parent: null, isPublic: true, cover: 'first_card' },
  { name: 'LT Showcase', parent: null, isPublic: true, cover: 'upload' },
  { name: 'LT Binder A Inserts', parent: 0, isPublic: true, cover: 'first_card' },
  { name: 'LT Private Vault', parent: null, isPublic: false, cover: 'upload' },
] as const;
// Folder for each item. The first 10 match the pilot layout exactly.
const ITEM_FOLDERS = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4];
// Posts 0–2 match the pilot. Share Cards use items 0–5, all public.
const POSTS: ({ type: 'card_share'; items: [number, number] } | { type: 'text' })[] = [
  { type: 'card_share', items: [0, 1] },
  { type: 'card_share', items: [2, 3] },
  { type: 'text' },
  { type: 'card_share', items: [4, 5] },
  { type: 'text' },
];
const TEAMS = ['Load Test Club', 'Staging United', 'Fixture FC', 'Seed City'];
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function buildDatasetPlan(users: SeedUser[], publicUrl: PublicUrl, now: number): Plan {
  const plan = emptyPlan();
  const iso = (ms: number) => new Date(ms).toISOString();
  const postIdsByUser: string[][] = [];

  for (const user of users) {
    const key = (k: string) => seedId(`${user.username}/${k}`);
    const folderIds = FOLDERS.map((_, f) => key(`folder/${f}`));

    FOLDERS.forEach((folder, f) => {
      let coverPath: string | null = null;
      if (folder.cover === 'upload') {
        coverPath = `${user.id}/covers/${folderIds[f]}-${SEED_TAG}.jpg`;
        plan.uploads.push({ bucket: 'item-images', path: coverPath, label: `${user.n}--${f + 1}`, variant: 900 + user.index * FOLDERS.length + f });
      }
      // Same shape the app writes (create-folder-modal: first_card;
      // folder detail cover upload: path + public URL string).
      const cover = {
        cover_source: folder.cover,
        cover_storage_path: coverPath,
        cover_image_url: coverPath ? publicUrl('item-images', coverPath) : null,
      };
      plan.folders.push({
        id: folderIds[f],
        user_id: user.id,
        name: folder.name,
        is_public: folder.isPublic,
        parent_folder_id: folder.parent === null ? null : folderIds[folder.parent],
        ...cover,
      });
      plan.folderCoverFixes.push({ id: folderIds[f], user_id: user.id, ...cover });
    });

    const itemIds: string[] = [];
    for (let i = 0; i < ITEMS_PER_USER; i++) {
      const itemId = key(`item/${i}`);
      itemIds.push(itemId);
      const itemNumber = String(i + 1).padStart(2, '0');
      const label = `${user.n}-${itemNumber}`;
      const folder = FOLDERS[ITEM_FOLDERS[i]];
      const primaryPath = `${user.id}/${itemId}/${SEED_TAG}.jpg`;
      plan.items.push({
        id: itemId,
        folder_id: folderIds[ITEM_FOLDERS[i]],
        user_id: user.id,
        item_type: 'sports_card',
        title: `Load Test Card ${label}`,
        player: `Synthetic Player ${itemNumber}`,
        team: TEAMS[(user.index + i) % TEAMS.length],
        year: 1990 + ((user.index * 7 + i) % 35),
        brand: 'CacheCase Seed',
        is_public: folder.isPublic,
        image_url: publicUrl('item-images', primaryPath),
      });

      const images = [{ suffix: '', idKey: `image/${i}`, sort: 0, primary: true, variant: user.index * ITEMS_PER_USER + i }];
      if (i % 2 === 0) images.push({ suffix: '-2', idKey: `image/${i}/1`, sort: 1, primary: false, variant: 500 + user.index * ITEMS_PER_USER + i });
      for (const img of images) {
        const path = `${user.id}/${itemId}/${SEED_TAG}${img.suffix}.jpg`;
        plan.images.push({
          id: key(img.idKey),
          item_id: itemId,
          user_id: user.id,
          image_url: publicUrl('item-images', path),
          storage_path: path,
          sort_order: img.sort,
          is_primary: img.primary,
        });
        plan.uploads.push({ bucket: 'item-images', path, label, variant: img.variant });
      }
    }

    // 1–21 days back, with a per-user minute offset so users' posts never
    // share a timestamp (the feed orders by created_at).
    const postIds: string[] = [];
    POSTS.forEach((shape, p) => {
      const postId = key(`post/${p}`);
      postIds.push(postId);
      const ageDays = 1 + ((user.index * 5 + p * 4) % 21);
      const createdAt = iso(now - ageDays * DAY_MS - ((user.index * 37) % 60) * MINUTE_MS);
      if (shape.type === 'text') {
        plan.posts.push({
          id: postId,
          user_id: user.id,
          post_type: 'text',
          content: `Synthetic load-test post ${p + 1} from ${user.username}. Not a real collector.`,
          created_at: createdAt,
        });
        return;
      }
      plan.posts.push({
        id: postId,
        user_id: user.id,
        post_type: 'card_share',
        caption: `Load test share ${p + 1} from ${user.username}`,
        created_at: createdAt,
      });
      shape.items.forEach((i, order) => {
        const item = plan.items.find((row) => row.id === itemIds[i])!;
        const snapshotPath = `${user.id}/card_share/${postId}/${item.id}-${SEED_TAG}.jpg`;
        plan.cardShareItems.push({
          id: key(`post/${p}/card/${order}`),
          post_id: postId,
          item_id: item.id,
          snapshot_image_url: publicUrl('share-snapshots', snapshotPath),
          snapshot_title: item.title,
          snapshot_subtitle: item.brand,
          display_order: order,
        });
        const source = plan.uploads.find((u) => u.path === `${user.id}/${item.id}/${SEED_TAG}.jpg`)!;
        plan.uploads.push({ ...source, bucket: 'share-snapshots', path: snapshotPath });
      });
    });
    postIdsByUser.push(postIds);
  }

  // Follows: user i follows the next 6–10 users (wrapping); with 5 users,
  // everyone follows everyone.
  const count = users.length;
  const following: number[][] = users.map((_, i) => {
    const k = Math.min(count - 1, 6 + (i % 5));
    return Array.from({ length: k }, (_, d) => (i + d + 1) % count);
  });
  following.forEach((targets, i) => {
    for (const j of targets) {
      plan.follows.push({ follower_id: users[i].id, following_id: users[j].id });
      // Likes on roughly two-thirds of each followed user's posts.
      postIdsByUser[j].forEach((postId, p) => {
        if ((i + j + p) % 3 !== 0) plan.likes.push({ user_id: users[i].id, post_id: postId });
      });
    }
    // Comments: posts 0 and 2 of the first followed user, 1 and 3 of the second.
    [[0, 0], [0, 2], [1, 1], [1, 3]].forEach(([nth, p], c) => {
      const j = targets[nth];
      if (j === undefined) return;
      plan.comments.push({
        id: seedId(`${users[i].username}/comment/${users[j].username}/${p}`),
        user_id: users[i].id,
        post_id: postIdsByUser[j][p],
        body: `Load test comment from ${users[i].username}`,
        // Within the last day — always after the post (posts are ≥ ~1 day old).
        created_at: iso(now - (6 + ((i + c) % 12)) * HOUR_MS),
      });
    });
  });

  // Conversations: each user with the users 1 and 5 places on (1 and 2 for
  // a small set), so everyone has 2–4. The pilot pair keeps its own
  // conversation from pilot-plan.ts.
  const offsets = count <= 6 ? [1, 2] : [1, 5];
  const pairs = new Map<string, [SeedUser, SeedUser]>();
  users.forEach((_, i) => {
    for (const o of offsets) {
      const j = (i + o) % count;
      if (j === i) continue;
      const [a, b] = [users[i], users[j]].sort((x, y) => x.index - y.index);
      pairs.set(`${a.username}+${b.username}`, [a, b]);
    }
  });
  pairs.delete(`${PILOT_USERNAMES[0]}+${PILOT_USERNAMES[1]}`);
  [...pairs].forEach(([pairKey, [a, b]], pairIndex) => {
    const conversationId = seedId(`conversation/${pairKey}`);
    const messageCount = 8 + ((a.index * 7 + b.index * 3) % 13);
    const start = now - (1 + (pairIndex % 6)) * DAY_MS - ((pairIndex * 13) % 60) * MINUTE_MS;
    const gap = (4 + (pairIndex % 5)) * MINUTE_MS;
    // last_message_at starts at the first message; the bump trigger moves
    // it forward (GREATEST) as messages are inserted.
    plan.conversations.push({ id: conversationId, created_at: iso(start), last_message_at: iso(start) });
    plan.participants.push({ conversation_id: conversationId, user_id: a.id }, { conversation_id: conversationId, user_id: b.id });
    for (let m = 0; m < messageCount; m++) {
      const sender = (m + pairIndex) % 2 === 0 ? a : b;
      plan.messages.push({
        id: seedId(`conversation/${pairKey}/message/${m}`),
        conversation_id: conversationId,
        sender_id: sender.id,
        body: `Load test message ${m + 1} from ${sender.username}`,
        created_at: iso(start + m * gap),
      });
    }
  });

  return plan;
}

export const usernamesFor = (count: number) => Array.from({ length: count }, (_, i) => `lt_user_${String(i + 1).padStart(2, '0')}`);

export function buildFullPlan(users: SeedUser[], publicUrl: PublicUrl, now: number): Plan {
  // Pilot FIRST: on any shared key its row wins, so existing pilot rows are
  // reused exactly as they were written.
  return mergePlans(buildPilotPlan(users.slice(0, 2), publicUrl, now), buildDatasetPlan(users, publicUrl, now));
}

// The pilot dataset (lt_user_01, lt_user_02), moved unchanged from
// seed-pilot.ts so seed-dataset.ts can include it: the same keys produce the
// same ids and Storage paths, so the larger dataset reuses the pilot rows
// already in staging instead of duplicating them. Do not change keys,
// paths or the item/folder layout here.

import { SEED_TAG } from './staging.ts';
import { DAY_MS, emptyPlan, seedId, type Plan, type PublicUrl, type Row, type SeedUser } from './seed-lib.ts';

export const PILOT_USERNAMES = ['lt_user_01', 'lt_user_02'];
export const PILOT_ITEMS_PER_USER = 10;
// Folder index (0–3) for each item: 3 / 3 / 2 in the top-level folders,
// 2 in the nested one.
export const PILOT_ITEM_FOLDERS = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3];

// Everything the pilot seed writes, derived only from the two user ids and
// the project's public Storage URL. Timestamps are relative to `now`; they
// only matter on first insert (existing rows are never updated).
export function buildPilotPlan(users: SeedUser[], publicUrl: PublicUrl, now: number): Plan {
  const plan = emptyPlan();
  const iso = (ms: number) => new Date(ms).toISOString();
  const postsByUser = new Map<string, Row[]>();

  for (const user of users) {
    const key = (k: string) => seedId(`${user.username}/${k}`);

    // Folders: three top-level, the fourth nested under the first.
    const folderIds = [0, 1, 2, 3].map((f) => key(`folder/${f}`));
    const folderNames = ['LT Binder A', 'LT Binder B', 'LT Showcase', 'LT Binder A Inserts'];
    folderIds.forEach((id, f) =>
      plan.folders.push({
        id,
        user_id: user.id,
        name: folderNames[f],
        is_public: true,
        parent_folder_id: f === 3 ? folderIds[0] : null,
      }),
    );

    // Items, each with one generated image (primary) in item-images.
    const items: Row[] = [];
    for (let i = 0; i < PILOT_ITEMS_PER_USER; i++) {
      const itemId = key(`item/${i}`);
      const imageId = key(`image/${i}`);
      const itemNumber = String(i + 1).padStart(2, '0');
      const storagePath = `${user.id}/${itemId}/${SEED_TAG}.jpg`;
      const imageUrl = publicUrl('item-images', storagePath);
      const item = {
        id: itemId,
        folder_id: folderIds[PILOT_ITEM_FOLDERS[i]],
        user_id: user.id,
        item_type: 'sports_card',
        title: `Load Test Card ${user.n}-${itemNumber}`,
        player: `Synthetic Player ${itemNumber}`,
        team: 'Load Test Club',
        year: 2000 + i,
        brand: 'CacheCase Seed',
        is_public: true,
        image_url: imageUrl,
      };
      items.push(item);
      plan.items.push(item);
      plan.images.push({
        id: imageId,
        item_id: itemId,
        user_id: user.id,
        image_url: imageUrl,
        storage_path: storagePath,
        sort_order: 0,
        is_primary: true,
      });
      plan.uploads.push({
        bucket: 'item-images',
        path: storagePath,
        label: `${user.n}-${itemNumber}`,
        variant: user.index * PILOT_ITEMS_PER_USER + i,
      });
    }

    // Posts: two Share Cards (items 1+2, 3+4) and one text post, dated
    // 1–14 days back so they sit well inside the 30-day feed window.
    const posts: Row[] = [];
    const ageDays = user.index === 0 ? [1, 6, 12] : [2, 8, 14];
    for (let p = 0; p < 2; p++) {
      const postId = key(`post/${p}`);
      const post = {
        id: postId,
        user_id: user.id,
        post_type: 'card_share',
        caption: `Load test share ${p + 1} from ${user.username}`,
        created_at: iso(now - ageDays[p] * DAY_MS),
      };
      posts.push(post);
      plan.posts.push(post);
      [items[p * 2], items[p * 2 + 1]].forEach((item, order) => {
        // Same layout the create-snapshot-post Edge Function writes:
        // {user}/card_share/{group}/{item}-…, here with a fixed name.
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
    }
    const textPost = {
      id: key('post/2'),
      user_id: user.id,
      post_type: 'text',
      content: `Synthetic load-test post from ${user.username}. Not a real collector.`,
      created_at: iso(now - ageDays[2] * DAY_MS),
    };
    posts.push(textPost);
    plan.posts.push(textPost);
    postsByUser.set(user.id, posts);
  }

  // Between the two users.
  const [a, b] = users;
  plan.follows.push({ follower_id: a.id, following_id: b.id }, { follower_id: b.id, following_id: a.id });
  for (const [liker, author] of [[a, b], [b, a]] as const) {
    const theirPosts = postsByUser.get(author.id)!;
    // Likes on every post of the other user; comments on two of them.
    theirPosts.forEach((post) => plan.likes.push({ user_id: liker.id, post_id: post.id }));
    theirPosts.slice(0, 2).forEach((post, c) =>
      plan.comments.push({
        id: seedId(`${liker.username}/comment/${c}`),
        user_id: liker.id,
        post_id: post.id,
        body: `Load test comment ${c + 1} from ${liker.username}`,
        created_at: iso(Date.parse(post.created_at as string) + (c + 1) * 60 * 60 * 1000),
      }),
    );
  }

  // One conversation, 10 alternating messages 7 minutes apart, 2 days ago.
  // last_message_at starts at the first message — the bump trigger only
  // ever moves it forward (GREATEST), so it ends at the last one.
  const conversationId = seedId(`conversation/${a.username}+${b.username}`);
  const firstMessageAt = now - 2 * DAY_MS;
  plan.conversations.push({ id: conversationId, created_at: iso(firstMessageAt), last_message_at: iso(firstMessageAt) });
  plan.participants.push({ conversation_id: conversationId, user_id: a.id }, { conversation_id: conversationId, user_id: b.id });
  for (let m = 0; m < 10; m++) {
    const sender = m % 2 === 0 ? a : b;
    plan.messages.push({
      id: seedId(`conversation/${a.username}+${b.username}/message/${m}`),
      conversation_id: conversationId,
      sender_id: sender.id,
      body: `Load test message ${m + 1} of 10 from ${sender.username}`,
      created_at: iso(firstMessageAt + m * 7 * 60 * 1000),
    });
  }

  return plan;
}

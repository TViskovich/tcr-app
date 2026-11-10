/// <reference types="node" />
// Collector blocking (20261112120000_add_user_blocks.sql) — end-to-end
// against the LOCAL Supabase stack, through PostgREST exactly as the app (or
// a hostile client calling the API directly) would. Disposable collectors
// A, B and C are created with the Auth admin API and removed afterwards.
//
// Covers: block / unblock / idempotency / self-block / malformed calls;
// block-list privacy; every guarded interaction in BOTH directions; DM
// history kept, new messages refused; visibility of profiles, posts,
// collections, Grails, follows, notifications and search; signed-out
// limits; bystander C unaffected; follow/tag cleanup; notification
// suppression and no unread resurfacing after unblock; account-deletion
// cascade; concurrent block-vs-follow / block-vs-message races; the
// 1000-block cap under concurrent requests.
//
// Prerequisite: local Supabase with the migration applied (no Edge
// Functions needed). Run:  node scripts/integration/user-blocking.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'user-blocking-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
function sql(statement: string) {
  return execFileSync('supabase', ['db', 'query', '--local', '-o', 'csv', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

type U = { id: string; email: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const email = `ub${run}${key}@example.test`;
  const password = `Ub-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username: `ub${run}${key}` }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, email, db };
}
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  sql(`DELETE FROM auth.users WHERE email LIKE 'ubcap%@example.invalid'`);
  return ids.length;
}

const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};
// A refused write: the guard's token, nothing returned.
const refused = (r: { error: { message?: string; code?: string } | null }, token: string | RegExp = 'account_unavailable') =>
  !!r.error && (typeof token === 'string' ? (r.error.message ?? '').includes(token) : token.test(r.error.message ?? ''));
// Reposts/quotes: the existing posts_repost_guard runs first and, reading
// posts under the caller's RLS, no longer sees the hidden post — its own
// neutral "not found" error; user_block_guard_repost/_quote are the backstop.
const POST_GONE = /account_unavailable|repost target not found|quoted post not found/;
const count = async (db: SupabaseClient, table: string, filter: (q: any) => any) => {
  const { count: n, error } = await filter(db.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
};

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const C = await createUser('c');

  step('0. Fixtures (before any block)');
  // Folders are inserted without RETURNING, as the app does (the existing
  // folders_select_public policy can't see a row inside its own INSERT).
  const folder = async (u: U, name: string) => {
    must(await u.db.from('folders').insert({ user_id: u.id, name, is_public: true }), `${name} insert`);
    return (must(await admin.from('folders').select('id').eq('user_id', u.id).eq('name', name).single(), `${name} read`)) as { id: string };
  };
  const FA = await folder(A, 'ub A binder');
  const FB = await folder(B, 'ub B binder');
  const [IA] = must(await A.db.from('collection_items').insert({ folder_id: FA.id, user_id: A.id, title: `ubalpha${run} card`, is_public: true, collection_status: 'active', item_type: 'sports_card' }).select('id'), 'A item') as { id: string }[];
  const [IB] = must(await B.db.from('collection_items').insert({ folder_id: FB.id, user_id: B.id, title: `ubbeta${run} card`, is_public: true, collection_status: 'active', item_type: 'sports_card' }).select('id'), 'B item') as { id: string }[];
  const [PA] = must(await A.db.from('posts').insert({ user_id: A.id, content: 'ub post by A', post_type: 'text' }).select('id'), 'A post') as { id: string }[];
  const [PB] = must(await B.db.from('posts').insert({ user_id: B.id, content: 'ub post by B', post_type: 'text' }).select('id'), 'B post') as { id: string }[];
  must(await C.db.from('posts').insert({ user_id: C.id, content: 'ub post by C', post_type: 'text' }), 'C post');
  must(await A.db.from('profile_grail_slots').insert({ user_id: A.id, slot_index: 0, entry_type: 'item', item_id: IA.id }), 'A grail');
  must(await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id }), 'B follows A');
  must(await A.db.from('follows').insert({ follower_id: A.id, following_id: B.id }), 'A follows B');
  must(await C.db.from('follows').insert({ follower_id: C.id, following_id: A.id }), 'C follows A');
  must(await B.db.from('likes').insert({ user_id: B.id, post_id: PA.id }), 'B likes A post');
  must(await B.db.rpc('create_or_refresh_like_notification', { p_post_id: PA.id }), 'B like notification');
  must(await B.db.rpc('create_or_refresh_follow_notification', { p_followed_user_id: A.id }), 'B follow notification');
  const tagAB = await A.db.from('collection_item_tags').insert({ item_id: IA.id, tagged_user_id: B.id, tagged_by: A.id });
  const tagBA = await B.db.from('collection_item_tags').insert({ item_id: IB.id, tagged_user_id: A.id, tagged_by: B.id });
  check('fixtures: tags in both directions exist before the block', !tagAB.error && !tagBA.error, tagAB.error ?? tagBA.error);
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'A–B conversation') as string;
  must(await A.db.from('messages').insert({ conversation_id: conv, sender_id: A.id, body: 'hi B' }), 'A→B message');
  must(await B.db.from('messages').insert({ conversation_id: conv, sender_id: B.id, body: 'hi A' }), 'B→A message');
  const convBC = must(await B.db.rpc('get_or_create_conversation', { other_user_id: C.id }), 'B–C conversation') as string;
  const historyBefore = await count(admin, 'messages', (q) => q.eq('conversation_id', conv));
  check('fixtures: A has unread notifications from B before the block',
    (await count(admin, 'notifications', (q) => q.eq('user_id', A.id).eq('actor_id', B.id).eq('read', false))) >= 2);

  step('1. Block: contract, idempotency, malformed calls');
  const b1 = await A.db.rpc('block_collector', { p_user_id: B.id });
  check('A blocks B', !b1.error && b1.data?.status === 'blocked' && b1.data?.already_blocked === false, b1.error ?? b1.data);
  const b2 = await A.db.rpc('block_collector', { p_user_id: B.id });
  check('blocking again is idempotent (already_blocked)', b2.data?.already_blocked === true, b2.error ?? b2.data);
  check('self-block is refused', refused(await A.db.rpc('block_collector', { p_user_id: A.id }), 'cannot_block_self'));
  check('null target is refused', refused(await A.db.rpc('block_collector', { p_user_id: null })));
  check('unknown collector gets the neutral token', refused(await A.db.rpc('block_collector', { p_user_id: randomUUID() })));
  const bad = await A.db.rpc('block_collector', { p_user_id: 'not-a-uuid' });
  check('a malformed id is rejected by the API', !!bad.error, bad.error?.code);
  const anonBlock = await anon.rpc('block_collector', { p_user_id: B.id });
  check('signed-out callers cannot block', !!anonBlock.error, anonBlock.error?.code);

  step('2. Block-list privacy');
  check('A sees its own block (and only that)', (await count(A.db, 'user_blocks', (q) => q)) === 1);
  check('B cannot see that A blocked them', (await count(B.db, 'user_blocks', (q) => q)) === 0);
  check('C cannot read anyone else\'s list', (await count(C.db, 'user_blocks', (q) => q)) === 0);
  const anonRead = await anon.from('user_blocks').select('*');
  check('signed-out cannot read block lists', !!anonRead.error || (anonRead.data ?? []).length === 0, anonRead.error?.code);
  check('B\'s block status reveals nothing about A\'s block', (await B.db.rpc('get_block_status', { p_user_id: A.id })).data?.blocked_by_me === false);
  check('A\'s block status shows the block', (await A.db.rpc('get_block_status', { p_user_id: B.id })).data?.blocked_by_me === true);
  const list = (await A.db.rpc('list_blocked_collectors', {})).data as { user_id: string; username: string }[];
  check('A\'s list shows B by username', list?.length === 1 && list[0].user_id === B.id && list[0].username === `ub${run}b`, list);
  check('B cannot insert a block directly', !!(await B.db.from('user_blocks').insert({ blocker_id: B.id, blocked_id: C.id })).error);
  const directDelete = await A.db.from('user_blocks').delete().eq('blocker_id', A.id);
  check('A cannot delete a block directly (only unblock_collector)', !!directDelete.error && (await count(A.db, 'user_blocks', (q) => q)) === 1, directDelete.error?.code);

  step('3. Cleanup on block');
  check('follows in both directions were removed',
    (await count(admin, 'follows', (q) => q.in('follower_id', [A.id, B.id]).in('following_id', [A.id, B.id]))) === 0);
  check('C\'s follow of A is untouched', (await count(admin, 'follows', (q) => q.eq('follower_id', C.id).eq('following_id', A.id))) === 1);
  check('tags in both directions were removed', (await count(admin, 'collection_item_tags', (q) => q.in('item_id', [IA.id, IB.id]))) === 0);
  check('notifications between A and B were kept but marked read',
    (await count(admin, 'notifications', (q) => q.eq('user_id', A.id).eq('actor_id', B.id))) >= 2
    && (await count(admin, 'notifications', (q) => q.eq('user_id', A.id).eq('actor_id', B.id).eq('read', false))) === 0);
  check('DM history is untouched', (await count(admin, 'messages', (q) => q.eq('conversation_id', conv))) === historyBefore);

  step('4. Interactions refused — B (blocked) → A, direct API');
  const tryAs = (u: U) => ({
    follow: (t: U) => u.db.from('follows').insert({ follower_id: u.id, following_id: t.id }),
    like: (p: string) => u.db.from('likes').insert({ user_id: u.id, post_id: p }),
    comment: (p: string) => u.db.from('comments').insert({ user_id: u.id, post_id: p, body: 'x' }),
    rate: (p: string) => u.db.from('grail_ratings').insert({ rater_user_id: u.id, post_id: p, score: 5 }),
    itemLike: (i: string) => u.db.from('item_likes').insert({ user_id: u.id, item_id: i }),
    itemComment: (i: string) => u.db.from('item_comments').insert({ user_id: u.id, item_id: i, body: 'x' }),
    folderLike: (f: string) => u.db.from('folder_likes').insert({ user_id: u.id, folder_id: f }),
    folderComment: (f: string) => u.db.from('folder_comments').insert({ user_id: u.id, folder_id: f, body: 'x' }),
    galleryComment: (f: string) => u.db.from('gallery_comments').insert({ user_id: u.id, folder_id: f, body: 'x', player_key: 'p' }),
    saveItem: (i: string) => u.db.from('saved_cards').insert({ user_id: u.id, item_id: i }),
    saveFolder: (f: string) => u.db.from('saved_folders').insert({ user_id: u.id, folder_id: f }),
    saveGrails: (t: U) => u.db.from('saved_grails').insert({ user_id: u.id, owner_id: t.id }),
    repost: (p: string) => u.db.from('posts').insert({ user_id: u.id, post_type: 'repost', repost_of_post_id: p }),
    quote: (p: string) => u.db.from('posts').insert({ user_id: u.id, post_type: 'quote', quote_of_post_id: p, content: 'q' }),
    openDm: (t: U) => u.db.rpc('get_or_create_conversation', { other_user_id: t.id }),
    message: (c: string) => u.db.from('messages').insert({ conversation_id: c, sender_id: u.id, body: 'x' }),
    shareItemInDm: (c: string, i: string) => u.db.from('messages').insert({ conversation_id: c, sender_id: u.id, body: 'look', attachment_type: 'item', attachment_item_id: i }),
  });
  const bTry = tryAs(B);
  const aTry = tryAs(A);
  const writesBefore = Number(sql(`SELECT (SELECT count(*) FROM public.likes)+(SELECT count(*) FROM public.comments)+(SELECT count(*) FROM public.follows)+(SELECT count(*) FROM public.grail_ratings)+(SELECT count(*) FROM public.item_likes)+(SELECT count(*) FROM public.item_comments)+(SELECT count(*) FROM public.folder_likes)+(SELECT count(*) FROM public.folder_comments)+(SELECT count(*) FROM public.gallery_comments)+(SELECT count(*) FROM public.saved_cards)+(SELECT count(*) FROM public.saved_folders)+(SELECT count(*) FROM public.saved_grails)+(SELECT count(*) FROM public.posts)+(SELECT count(*) FROM public.messages)+(SELECT count(*) FROM public.conversations) AS n`).trim().split('\n').pop());
  check('B cannot follow A', refused(await bTry.follow(A)));
  check('B cannot like A\'s post', refused(await bTry.like(PA.id)));
  check('B cannot comment on A\'s post', refused(await bTry.comment(PA.id)));
  check('B cannot rate A\'s post', refused(await bTry.rate(PA.id)));
  check('B cannot like A\'s item', refused(await bTry.itemLike(IA.id)));
  check('B cannot comment on A\'s item', refused(await bTry.itemComment(IA.id)));
  check('B cannot like A\'s collection', refused(await bTry.folderLike(FA.id)));
  check('B cannot comment on A\'s collection', refused(await bTry.folderComment(FA.id)));
  check('B cannot comment in A\'s gallery', refused(await bTry.galleryComment(FA.id)));
  check('B cannot save A\'s item', refused(await bTry.saveItem(IA.id)));
  check('B cannot save A\'s collection', refused(await bTry.saveFolder(FA.id)));
  check('B cannot save A\'s Grails', refused(await bTry.saveGrails(A)));
  check('B cannot tag A', refused(await B.db.from('collection_item_tags').insert({ item_id: IB.id, tagged_user_id: A.id, tagged_by: B.id }), 'tag_user_not_found'));
  check('B cannot repost A\'s post', refused(await bTry.repost(PA.id), POST_GONE));
  check('B cannot quote A\'s post', refused(await bTry.quote(PA.id), POST_GONE));
  check('B cannot open a conversation with A', refused(await bTry.openDm(A)));
  check('B cannot message A in the existing conversation', refused(await bTry.message(conv)));
  check('B cannot share A\'s item into a conversation with C', refused(await bTry.shareItemInDm(convBC, IA.id)));

  step('5. Interactions refused — A (blocker) → B');
  check('A cannot follow B', refused(await aTry.follow(B)));
  check('A cannot like B\'s post', refused(await aTry.like(PB.id)));
  check('A cannot comment on B\'s post', refused(await aTry.comment(PB.id)));
  check('A cannot rate B\'s post', refused(await aTry.rate(PB.id)));
  check('A cannot like or save B\'s item', refused(await aTry.itemLike(IB.id)) && refused(await aTry.saveItem(IB.id)));
  check('A cannot tag B', refused(await A.db.from('collection_item_tags').insert({ item_id: IA.id, tagged_user_id: B.id, tagged_by: A.id }), 'tag_user_not_found'));
  check('A cannot repost or quote B\'s post', refused(await aTry.repost(PB.id), POST_GONE) && refused(await aTry.quote(PB.id), POST_GONE));
  check('A cannot open a conversation with B', refused(await aTry.openDm(B)));
  check('A cannot message B in the existing conversation', refused(await aTry.message(conv)));
  const writesAfter = Number(sql(`SELECT (SELECT count(*) FROM public.likes)+(SELECT count(*) FROM public.comments)+(SELECT count(*) FROM public.follows)+(SELECT count(*) FROM public.grail_ratings)+(SELECT count(*) FROM public.item_likes)+(SELECT count(*) FROM public.item_comments)+(SELECT count(*) FROM public.folder_likes)+(SELECT count(*) FROM public.folder_comments)+(SELECT count(*) FROM public.gallery_comments)+(SELECT count(*) FROM public.saved_cards)+(SELECT count(*) FROM public.saved_folders)+(SELECT count(*) FROM public.saved_grails)+(SELECT count(*) FROM public.posts)+(SELECT count(*) FROM public.messages)+(SELECT count(*) FROM public.conversations) AS n`).trim().split('\n').pop());
  check('none of the refused attempts wrote anything', writesAfter === writesBefore, { writesBefore, writesAfter });

  step('6. Notifications while blocked');
  await B.db.rpc('create_or_refresh_like_notification', { p_post_id: PA.id }); // B's pre-block like still exists
  check('refreshing B\'s old like notification does not make it unread',
    (await count(admin, 'notifications', (q) => q.eq('user_id', A.id).eq('actor_id', B.id).eq('read', false))) === 0);
  check('A cannot see notifications from B', (await count(A.db, 'notifications', (q) => q.eq('actor_id', B.id))) === 0);
  check('A still sees others\' notifications (C\'s follow is not a notification here; the query works)', (await A.db.from('notifications').select('id')).error === null);

  step('7. Visibility');
  check('B cannot see A\'s profile', (await count(B.db, 'profiles', (q) => q.eq('id', A.id))) === 0);
  check('B cannot find A by username', (await count(B.db, 'profiles', (q) => q.ilike('username', `ub${run}a`))) === 0);
  check('B cannot see A\'s posts, collections, items or Grails',
    (await count(B.db, 'posts', (q) => q.eq('user_id', A.id))) === 0 && (await count(B.db, 'folders', (q) => q.eq('user_id', A.id))) === 0
    && (await count(B.db, 'collection_items', (q) => q.eq('user_id', A.id))) === 0 && (await count(B.db, 'profile_grail_slots', (q) => q.eq('user_id', A.id))) === 0);
  check('B cannot see who follows A', (await count(B.db, 'follows', (q) => q.eq('following_id', A.id))) === 0);
  const sItems = await B.db.rpc('search_profile_items', { p_owner_id: A.id, p_query: `ubalpha${run}`, p_limit: 20, p_offset: 0 });
  const sFolder = await B.db.rpc('search_collection_items', { p_folder_id: FA.id, p_query: `ubalpha${run}`, p_limit: 20, p_offset: 0 });
  check('search returns none of A\'s items to B', !sItems.error && (sItems.data ?? []).length === 0 && !sFolder.error && (sFolder.data ?? []).length === 0, sItems.error ?? sFolder.error);
  check('A can still open B\'s profile (to unblock)', (await count(A.db, 'profiles', (q) => q.eq('id', B.id))) === 1);
  check('A does not see B\'s posts or items',
    (await count(A.db, 'posts', (q) => q.eq('user_id', B.id))) === 0 && (await count(A.db, 'collection_items', (q) => q.eq('user_id', B.id))) === 0);
  check('A does not see B\'s like on A\'s post', (await count(A.db, 'likes', (q) => q.eq('post_id', PA.id).eq('user_id', B.id))) === 0);
  check('both still read the full DM history',
    (await count(A.db, 'messages', (q) => q.eq('conversation_id', conv))) === historyBefore
    && (await count(B.db, 'messages', (q) => q.eq('conversation_id', conv))) === historyBefore);
  check('C sees A and B and their posts',
    (await count(C.db, 'profiles', (q) => q.in('id', [A.id, B.id]))) === 2 && (await count(C.db, 'posts', (q) => q.in('user_id', [A.id, B.id]))) === 2);
  check('C can still interact with both', !(await tryAs(C).like(PA.id)).error && !(await tryAs(C).like(PB.id)).error && !(await tryAs(C).follow(B)).error);
  check('(limitation) signed-out reads of A\'s public profile and posts still work',
    (await count(anon, 'profiles', (q) => q.eq('id', A.id))) === 1 && (await count(anon, 'posts', (q) => q.eq('user_id', A.id))) === 1);

  step('8. Unblock');
  const u1 = await A.db.rpc('unblock_collector', { p_user_id: B.id });
  check('A unblocks B', u1.data?.was_blocked === true, u1.error ?? u1.data);
  check('unblocking again is idempotent', (await A.db.rpc('unblock_collector', { p_user_id: B.id })).data?.was_blocked === false);
  check('no old notification resurfaces as unread',
    (await count(A.db, 'notifications', (q) => q.eq('actor_id', B.id).eq('read', false))) === 0
    && (await count(A.db, 'notifications', (q) => q.eq('actor_id', B.id))) >= 2);
  check('follows and tags are not restored',
    (await count(admin, 'follows', (q) => q.in('follower_id', [A.id, B.id]).in('following_id', [A.id, B.id]))) === 0
    && (await count(admin, 'collection_item_tags', (q) => q.in('item_id', [IA.id, IB.id]))) === 0);
  check('content is visible again both ways',
    (await count(B.db, 'profiles', (q) => q.eq('id', A.id))) === 1 && (await count(A.db, 'posts', (q) => q.eq('user_id', B.id))) === 1);
  check('B can follow and message A again', !(await bTry.follow(A)).error && !(await bTry.message(conv)).error);

  step('9. Concurrency: block vs follow / message (20 races each)');
  let followSurvived = 0, followRaces = 0, messageAfterBlock = 0;
  for (let i = 0; i < 20; i++) {
    await admin.from('follows').delete().eq('follower_id', B.id).eq('following_id', A.id);
    const jitter = Math.floor(Math.random() * 6);
    const [, fr] = await Promise.all([
      (async () => { await sleep(jitter); return A.db.rpc('block_collector', { p_user_id: B.id }); })(),
      (async () => { await sleep(5 - jitter); return bTry.follow(A); })(),
    ]);
    if (!fr.error) followRaces++;
    followSurvived += await count(admin, 'follows', (q) => q.eq('follower_id', B.id).eq('following_id', A.id));
    await A.db.rpc('unblock_collector', { p_user_id: B.id });
  }
  check(`no follow survives a completed block (${followRaces}/20 follows committed before their block)`, followSurvived === 0, { followSurvived });
  for (let i = 0; i < 20; i++) {
    const jitter = Math.floor(Math.random() * 6);
    const [br, mr] = await Promise.all([
      (async () => { await sleep(jitter); return A.db.rpc('block_collector', { p_user_id: B.id }); })(),
      (async () => { await sleep(5 - jitter); return B.db.from('messages').insert({ conversation_id: conv, sender_id: B.id, body: `race ${i}` }).select('created_at'); })(),
    ]);
    if (!mr.error && !br.error) {
      const blockedAt = sql(`SELECT created_at FROM public.user_blocks WHERE blocker_id='${A.id}' AND blocked_id='${B.id}'`).trim().split('\n').pop();
      if (blockedAt && new Date(mr.data![0].created_at) > new Date(blockedAt)) messageAfterBlock++;
    }
    await A.db.rpc('unblock_collector', { p_user_id: B.id });
  }
  check('no message is accepted after a block commits (any accepted race message predates the block)', messageAfterBlock === 0, { messageAfterBlock });

  step('10. The 1000-block cap under concurrent requests');
  sql(`INSERT INTO auth.users (id, email, raw_user_meta_data) SELECT gen_random_uuid(), 'ubcap${run}' || g || '@example.invalid', jsonb_build_object('username', 'uc${run}' || g) FROM generate_series(1, 1003) g`);
  sql(`INSERT INTO public.user_blocks (blocker_id, blocked_id) SELECT '${C.id}', u.id FROM auth.users u WHERE u.email LIKE 'ubcap${run}%' ORDER BY u.email LIMIT 998`);
  const free = sql(`SELECT u.id FROM auth.users u WHERE u.email LIKE 'ubcap${run}%' AND NOT EXISTS (SELECT 1 FROM public.user_blocks b WHERE b.blocker_id='${C.id}' AND b.blocked_id=u.id) LIMIT 5`).trim().split('\n').slice(1);
  const capRuns = await Promise.all(free.map((id) => C.db.rpc('block_collector', { p_user_id: id })));
  const ok = capRuns.filter((r) => !r.error).length;
  const limited = capRuns.filter((r) => refused(r, 'block_limit_reached')).length;
  const total = Number(sql(`SELECT count(*) FROM public.user_blocks WHERE blocker_id='${C.id}'`).trim().split('\n').pop());
  check(`5 concurrent blocks at 998: exactly 2 succeed, 3 hit the cap, total stays 1000 (got ${ok}/${limited}/${total})`, ok === 2 && limited === 3 && total === 1000);
  const t0 = Date.now();
  const feed = await C.db.from('posts').select('id').order('created_at', { ascending: false }).limit(20);
  check(`a feed query with 1000 blocks still answers (${Date.now() - t0} ms)`, !feed.error);

  step('11. Account deletion cascades');
  must(await A.db.rpc('block_collector', { p_user_id: B.id }), 'A blocks B again');
  await admin.auth.admin.deleteUser(B.id);
  check('deleting the blocked account removes the block', Number(sql(`SELECT count(*) FROM public.user_blocks WHERE blocker_id='${A.id}'`).trim().split('\n').pop()) === 0);
}

console.log(`Local Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted: ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

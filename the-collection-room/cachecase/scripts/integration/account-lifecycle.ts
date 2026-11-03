/// <reference types="node" />
// Account lifecycle (Dashboard Milestone 2, Checkpoint 1) — end-to-end check
// through the REAL APIs (PostgREST, Storage, Edge Functions, Auth) against
// the LOCAL Supabase stack, with disposable collectors:
//   A — scheduled for deletion, then restored
//   B — another collector
//   anon — a signed-out visitor
// The service role only creates/deletes the accounts and calls the
// server-only transition functions (as the future Edge Functions will).
//
// Run (Node 24 runs .ts directly):
//   node scripts/integration/account-lifecycle.ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'account-lifecycle-it';

const results: { name: string; ok: boolean }[] = [];
let section = '';
const step = (s: string) => {
  section = s;
  console.log(`\n${s}`);
};
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name: `[${section}] ${name}`, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}

type User = { id: string; email: string; password: string; username: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);

async function createUser(key: string): Promise<User> {
  const username = `al${run}${key}`;
  const email = `${username}@example.test`;
  const password = `al-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { id: data.user.id, email, password, username, db, token: s.session.access_token };
}

async function sweep() {
  const ids: string[] = [];
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
  if (!ids.length) return 0;
  await admin.from('account_lifecycle').delete().in('user_id', ids).eq('state', 'pending_deletion');
  await admin.from('registered_cards').delete().in('created_by', ids);
  for (const bucket of ['avatars', 'item-images']) {
    for (const id of ids) {
      const { data: objs } = await admin.storage.from(bucket).list(id, { limit: 100 });
      const paths: string[] = [];
      for (const o of objs ?? []) {
        if (o.id) paths.push(`${id}/${o.name}`);
        else {
          const { data: inner } = await admin.storage.from(bucket).list(`${id}/${o.name}`, { limit: 100 });
          for (const i of inner ?? []) paths.push(`${id}/${o.name}/${i.name}`);
        }
      }
      if (paths.length) await admin.storage.from(bucket).remove(paths);
    }
  }
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

const fn = async (name: string, body: unknown, token?: string) => {
  const res = await fetch(`${st.API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token ?? st.ANON_KEY}` },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json: json as Record<string, unknown> | null };
};
// Inside the local stack, Storage signs URLs for the internal gateway host;
// point them at the local API so this script can fetch them.
const reachable = (url: string) => url.replace(/^https?:\/\/[^/]+/, st.API_URL);
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const count = async (c: SupabaseClient, table: string, col: string, val: string) => {
  const { count: n, error } = await c.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');

  // A's content, through A's own client (RLS applies).
  const folderId = randomUUID();
  const itemId = randomUUID();
  const imageId = randomUUID();
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  must(await A.db.from('folders').insert({ id: folderId, user_id: A.id, name: 'AL binder', is_public: true }), 'folder');
  must(await A.db.from('collection_items').insert({ id: itemId, folder_id: folderId, user_id: A.id, title: 'AL rookie', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'item');
  const imagePath = `${A.id}/${itemId}/primary.jpg`;
  must(await A.db.storage.from('item-images').upload(imagePath, jpeg, { contentType: 'image/jpeg' }), 'item image upload');
  must(await A.db.from('collection_item_images').insert({ id: imageId, item_id: itemId, user_id: A.id, image_url: imagePath, storage_path: imagePath }), 'image row');
  const avatarPath = `${A.id}/avatar.jpg`;
  must(await A.db.storage.from('avatars').upload(avatarPath, jpeg, { contentType: 'image/jpeg' }), 'avatar upload');
  const avatarUrl = admin.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl;
  must(await A.db.from('profile_grail_slots').insert({ user_id: A.id, slot_index: 0, entry_type: 'item', item_id: itemId }), 'grail');
  const cardRaw = must(await A.db.rpc('register_card', { p_collection_item_id: itemId, p_visibility: 'public' }), 'register_card');
  const cardId = typeof cardRaw === 'string' ? cardRaw : (cardRaw as { id: string }).id;
  const { data: cardRow } = await admin.from('registered_cards').select('cc_id').eq('id', cardId).single();
  const ccId = (cardRow as { cc_id: string }).cc_id;

  step('1. Baseline: A is active');
  check('B sees A\'s profile and item', (await count(B.db, 'profiles', 'id', A.id)) === 1 && (await count(B.db, 'collection_items', 'id', itemId)) === 1);
  const signedB = await fn('get-collection-item-image-signed-url', { image_ids: [imageId] }, B.token);
  const earlyUrl = (signedB.json?.results as { status: string; signed_url?: string }[] | undefined)?.[0];
  check('B gets a signed URL for A\'s public image', earlyUrl?.status === 'ok', signedB);
  const pub = await fn('get-public-registry-card', { cc_id: ccId });
  check('public registry lookup returns A\'s card with A\'s name', pub.json?.status === 'ok' &&
    JSON.stringify(pub.json?.data).includes(A.username), pub.json);

  step('2. Schedule (service role only)');
  const asA = await A.db.rpc('schedule_account_deletion', { p_user_id: A.id });
  check('A cannot call the schedule function through the API', !!asA.error, asA.error);
  const sched = await admin.rpc('schedule_account_deletion', { p_user_id: A.id });
  check('service role schedules A', !sched.error && (sched.data as { state: string }).state === 'pending_deletion', sched.error);
  const probe = await B.db.rpc('account_is_hidden', { p_user_id: A.id });
  check('the hidden-account helper is not callable through the API', !!probe.error, probe.error?.code);
  const probeSchema = await B.db.schema('private' as 'public').rpc('account_is_hidden', { p_user_id: A.id });
  check('the private schema is not exposed through the API', !!probeSchema.error, probeSchema.error?.code);

  step('3. Hidden from B and anonymous visitors (REST)');
  for (const [label, c] of [['B', B.db], ['anon', anon]] as const) {
    check(`${label}: no profile`, (await count(c, 'profiles', 'id', A.id)) === 0);
    check(`${label}: no collection`, (await count(c, 'folders', 'id', folderId)) === 0);
    check(`${label}: no item`, (await count(c, 'collection_items', 'id', itemId)) === 0);
    check(`${label}: no Grails`, (await count(c, 'profile_grail_slots', 'user_id', A.id)) === 0);
    check(`${label}: no registry card`, (await count(c, 'registered_cards', 'id', cardId)) === 0);
  }
  const lifecycleB = await B.db.from('account_lifecycle').select('user_id');
  check('B cannot see that A is pending', !lifecycleB.error && (lifecycleB.data ?? []).length === 0);

  step('4. Edge Functions (service role) respect the state');
  const imgB = await fn('get-collection-item-image-signed-url', { image_ids: [imageId] }, B.token);
  check('B: A\'s image is unavailable', (imgB.json?.results as { status: string }[])?.[0]?.status === 'unavailable', imgB.json);
  // Signed-out callers send the public key, which this function has always
  // answered with invalid_token (no URL) — either way no URL is issued.
  const imgAnon = await fn('get-collection-item-image-signed-url', { image_ids: [imageId] });
  const anonResult = (imgAnon.json?.results as { status: string }[] | undefined)?.[0]?.status;
  check('anon: no signed URL for A\'s image', imgAnon.status === 401 || anonResult === 'unavailable', imgAnon);
  const imgA = await fn('get-collection-item-image-signed-url', { image_ids: [imageId] }, A.token);
  check('A (pending) is refused by a read function', imgA.status === 401, imgA);
  const delA = await fn('delete-post', { post_id: randomUUID() }, A.token);
  check('A (pending) is refused by a write function (delete-post)', delA.status === 401, delA);
  const snapA = await fn('create-snapshot-post', { post_type: 'rate_my_grails', item_ids: [itemId] }, A.token);
  check('A (pending) is refused by create-snapshot-post', snapA.status === 401, snapA);
  const coverA = await fn('get-folder-cover-signed-url', { folder_ids: [folderId] }, A.token);
  check('A (pending) is refused by get-folder-cover-signed-url', coverA.status === 401, coverA);
  const pubHidden = await fn('get-public-registry-card', { cc_id: ccId });
  check('public registry lookup: A\'s card is not found', pubHidden.json?.status === 'not_found', pubHidden.json);

  step('5. The pending collector');
  const relogin = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s2, error: e2 } = await relogin.auth.signInWithPassword({ email: A.email, password: A.password });
  check('A can still sign in (to cancel or export later)', !e2 && !!s2.session);
  const own = await relogin.from('account_lifecycle').select('state, scheduled_for');
  check('A reads their own lifecycle state', (own.data ?? [])[0]?.state === 'pending_deletion', own);
  check('A sees no profiles, not even their own', (await count(relogin, 'profiles', 'id', A.id)) === 0);
  const postA = await relogin.from('posts').insert({ user_id: A.id, content: 'x', post_type: 'text' });
  check('A cannot post (account_inactive)', postA.error?.message === 'account_inactive', postA.error);
  const bioA = await relogin.from('profiles').update({ bio: 'x' }).eq('id', A.id);
  check('A cannot edit the profile', bioA.error?.message === 'account_inactive', bioA.error);
  const upA = await relogin.storage.from('avatars').upload(`${A.id}/new.jpg`, jpeg, { contentType: 'image/jpeg' });
  check('A cannot upload to Storage', !!upA.error, upA.error);

  step('6. Nobody can reach A');
  const followB = await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id });
  check('B cannot follow A', followB.error?.message === 'account_unavailable', followB.error);
  const dmB = await B.db.rpc('get_or_create_conversation', { other_user_id: A.id });
  check('B cannot start a DM with A', dmB.error?.message === 'account_unavailable', dmB.error);

  step('7. Known limits (documented, not hidden)');
  const avatarRes = await fetch(avatarUrl);
  check('PUBLIC bucket: A\'s avatar URL still serves (public URLs bypass policies)', avatarRes.status === 200, avatarRes.status);
  if (earlyUrl?.signed_url) {
    const early = await fetch(reachable(earlyUrl.signed_url));
    check('a signed URL issued BEFORE scheduling still works until it expires (300 s)', early.status === 200, early.status);
  }

  step('8. Cancel restores everything');
  const cancel = await admin.rpc('cancel_account_deletion', { p_user_id: A.id });
  check('service role cancels', cancel.data === true, cancel.error);
  check('B sees A\'s profile, collection and item again', (await count(B.db, 'profiles', 'id', A.id)) === 1 &&
    (await count(B.db, 'folders', 'id', folderId)) === 1 && (await count(B.db, 'collection_items', 'id', itemId)) === 1);
  const img2 = await fn('get-collection-item-image-signed-url', { image_ids: [imageId] }, B.token);
  const url2 = (img2.json?.results as { status: string; signed_url?: string }[])?.[0];
  check('B gets a signed URL for the same image again', url2?.status === 'ok', img2.json);
  if (url2?.signed_url) check('…and it serves the original object', (await fetch(reachable(url2.signed_url))).status === 200);
  const pub2 = await fn('get-public-registry-card', { cc_id: ccId });
  check('the registry card is found again', pub2.json?.status === 'ok', pub2.json);
  const { data: s3 } = await relogin.auth.refreshSession();
  const postAgain = await relogin.from('posts').insert({ user_id: A.id, content: 'back', post_type: 'text' });
  check('A can post again', !postAgain.error && !!s3, postAgain.error);
  check('A\'s Grail is visible to B again', (await count(B.db, 'profile_grail_slots', 'user_id', A.id)) === 1);
}

console.log(`Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${section}": ${(e as Error).message}`);
} finally {
  const removed = await sweep();
  console.log(`\nCleanup: ${removed} accounts removed with their storage objects and registry rows.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

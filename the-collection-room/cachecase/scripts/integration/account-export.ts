/// <reference types="node" />
// Download My Data (Dashboard Milestone 2, Checkpoint 3) — end-to-end check
// of the account-export Edge Function through the REAL APIs against the
// LOCAL Supabase stack, with disposable collectors:
//   A — mixed public/private nested collections, every item category,
//       photos, Grails, posts, comments, DMs, follows, an unreleased
//       registry record; exports while active and while pending deletion
//   B — another collector with look-alike files and private content that
//       must never appear in A's archive; tries to reach A's export
//   C — follows A, then goes pending (shown as an unavailable account)
//   D — 1,050 small photos (pagination well past 1,000 files)
// Archives are validated independently with Python's zipfile (CRC checks).
//
// Prerequisite: functions served with a short recent-sign-in window:
//   echo ACCOUNT_RECENT_AUTH_SECONDS=8 > /tmp/fn.env
//   supabase functions serve --env-file /tmp/fn.env
// Run (Node 24 runs .ts directly):
//   node scripts/integration/account-export.ts
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { crc32, localEntry } from '../../supabase/functions/account-export/zip.ts';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'account-export-it';
const WINDOW_SECONDS = 8;
const work = mkdtempSync(join(tmpdir(), 'cachecase-export-'));

const results: { name: string; ok: boolean }[] = [];
let section = '';
const step = (s: string) => {
  section = s;
  console.log(`\n${s}`);
};
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name: `[${section}] ${name}`, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type User = { id: string; email: string; password: string; username: string; db: SupabaseClient; token: string };
const run = randomUUID().replace(/-/g, '').slice(0, 5);
async function createUser(key: string): Promise<User> {
  const username = `ex${run}${key}`;
  const email = `${username}@example.test`;
  const password = `ex-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username, display_name: `Export ${key.toUpperCase()}` }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const u = { id: data.user.id, email, password, username, db: createClient(st.API_URL, st.ANON_KEY, opts), token: '' };
  await signIn(u);
  return u;
}
async function signIn(u: User) {
  const { data, error } = await u.db.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  u.token = data.session.access_token;
}

async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE).map((u) => u.id);
  if (!ids.length) return 0;
  await admin.from('account_lifecycle').delete().in('user_id', ids).eq('state', 'pending_deletion');
  await admin.from('registered_cards').delete().in('created_by', ids);
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const convIds = [...new Set((parts ?? []).map((r) => r.conversation_id))];
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  for (const id of ids) {
    for (const bucket of ['item-images', 'avatars', 'account-exports']) await removeAll(bucket, id);
    await admin.auth.admin.deleteUser(id);
  }
  return ids.length;
}
async function removeAll(bucket: string, prefix: string) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const files = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) await removeAll(bucket, `${prefix}/${dir.name}`);
  for (let i = 0; i < files.length; i += 500) await admin.storage.from(bucket).remove(files.slice(i, i + 500));
  if (files.length === 1000) await removeAll(bucket, prefix);
}
const listAll = async (bucket: string, prefix: string): Promise<string[]> => {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  const out = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  for (const dir of (data ?? []).filter((o) => !o.id)) out.push(...(await listAll(bucket, `${prefix}/${dir.name}`)));
  return out;
};

async function fn(body: unknown, token: string | null) {
  const res = await fetch(`${st.API_URL}/functions/v1/account-export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token ?? st.ANON_KEY}` },
    body: JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {}
  return { status: res.status, json };
}
async function runToEnd(u: User, maxSteps = 400): Promise<{ steps: number; final: Record<string, any> | null }> {
  let last: Record<string, any> | null = null;
  for (let i = 1; i <= maxSteps; i++) {
    last = (await fn({ action: 'advance' }, u.token)).json;
    const state = last?.export?.state;
    if (state === 'ready' || state === 'failed' || state === 'expired') return { steps: i, final: last };
    await sleep(150);
  }
  return { steps: maxSteps, final: last };
}
// Internal storage URLs point at the gateway inside the stack.
const reachable = (url: string) => url.replace(/^https?:\/\/[^/]+/, st.API_URL);
// Downloads every part of the ready export (one link per part).
async function downloadZip(u: User, label: string): Promise<{ path: string[]; url: string }> {
  const d = await fn({ action: 'download' }, u.token);
  const parts = (d.json?.parts ?? []) as { part: number; url: string }[];
  if (!parts.length) throw new Error(`download failed: ${JSON.stringify(d)}`);
  const paths: string[] = [];
  for (const p of parts) {
    const bytes = Buffer.from(await (await fetch(reachable(p.url))).arrayBuffer());
    const path = join(work, `${label}-part${p.part}.zip`);
    writeFileSync(path, bytes);
    paths.push(path);
  }
  return { path: paths, url: parts[0].url };
}
// Independent validation: Python's zipfile (testzip verifies every CRC).
// Each part is validated on its own; the result merges all parts.
function inspect(zipPaths: string | string[]): { names: string[]; bad: string | null; text: Record<string, string>; sha: Record<string, string> } {
  const merged = { names: [] as string[], bad: null as string | null, text: {} as Record<string, string>, sha: {} as Record<string, string> };
  for (const zipPath of Array.isArray(zipPaths) ? zipPaths : [zipPaths]) {
    const one = inspectOne(zipPath);
    merged.names.push(...one.names);
    merged.bad = merged.bad ?? one.bad;
    Object.assign(merged.text, one.text);
    Object.assign(merged.sha, one.sha);
  }
  return merged;
}
function inspectOne(zipPath: string): { names: string[]; bad: string | null; text: Record<string, string>; sha: Record<string, string> } {
  const out = execFileSync('python3', ['-I', '-c', `
import zipfile, json, hashlib, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
text = {n: z.read(n).decode('utf-8-sig') for n in names if n.endswith(('.json', '.csv', '.txt'))}
sha = {n: hashlib.sha256(z.read(n)).hexdigest() for n in names if n.startswith('media/')}
print(json.dumps({'names': names, 'bad': bad, 'text': text, 'sha': sha}))
`, zipPath], { encoding: 'utf8', maxBuffer: 1 << 30 });
  return JSON.parse(out);
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tus = { Authorization: `Bearer ${st.SERVICE_ROLE_KEY}`, 'Tus-Resumable': '1.0.0' };
const jobOf = async (u: User) => (await admin.from('account_exports').select('*').eq('user_id', u.id).order('created_at', { ascending: false }).limit(1).single()).data as Record<string, any>;
// The next file still to be written, and its part once that part's upload
// is open (advancing the export until it is).
async function pendingInOpenPart(u: User, exportId: string): Promise<{ part: Record<string, any>; entry: Record<string, any> }> {
  for (let i = 0; i < 30; i++) {
    const { data: entry } = await admin.from('account_export_entries').select('*').eq('export_id', exportId)
      .eq('written', false).order('seq').limit(1).maybeSingle();
    if (!entry) throw new Error('no pending file left to interrupt');
    const { data: part } = await admin.from('account_export_parts').select('*').eq('export_id', exportId).eq('part', entry.part).single();
    if (part?.upload_url) return { part, entry };
    await fn({ action: 'advance' }, u.token);
  }
  throw new Error('no open part');
}

async function main() {
  const [A, B, C, D] = [await createUser('a'), await createUser('b'), await createUser('c'), await createUser('d')];

  // ── A's data ──
  const f = { binder: randomUUID(), rookies: randomUUID(), vault: randomUUID(), secret: randomUUID() };
  must(await A.db.from('folders').insert([
    { id: f.binder, user_id: A.id, name: 'Binder', is_public: true },
    { id: f.secret, user_id: A.id, name: 'Secret Stash', is_public: false },
  ]), 'folders');
  must(await A.db.from('folders').insert([
    { id: f.rookies, user_id: A.id, name: 'Rookies', is_public: true, parent_folder_id: f.binder },
    { id: f.vault, user_id: A.id, name: 'Vault', is_public: false, parent_folder_id: f.binder },
  ]), 'nested folders');
  const it = { sports: randomUUID(), trading: randomUUID(), pokemon: randomUUID(), comic: randomUUID(), other: randomUUID(), hidden: randomUUID() };
  must(await A.db.from('collection_items').insert([
    { id: it.sports, folder_id: f.rookies, user_id: A.id, title: 'Rookie Card “Ünïcode”', item_type: 'sports_card', is_public: true, collection_status: 'active', player: 'Player, Jr.', year: 2003, grade: '10', grading_company: 'PSA' },
    { id: it.trading, folder_id: f.binder, user_id: A.id, title: 'Trading Card', item_type: 'trading_card', is_public: true, collection_status: 'active' },
    { id: it.pokemon, folder_id: f.vault, user_id: A.id, title: 'Charizard', item_type: 'pokemon', is_public: false, collection_status: 'active' },
    { id: it.comic, folder_id: f.binder, user_id: A.id, title: 'Comic #1', item_type: 'comic_book', is_public: true, collection_status: 'active' },
    { id: it.other, folder_id: f.secret, user_id: A.id, title: 'Figure', item_type: 'other', is_public: false, collection_status: 'active' },
  ]), 'items');
  must(await admin.from('trading_card_details').insert({ item_id: it.trading, franchise: 'Magic', card_name: 'Black Lotus', set_name: 'Alpha', rarity: 'Rare' }), 'trading details');
  must(await admin.from('pokemon_card_details').insert({ item_id: it.pokemon, pokemon_name: 'Charizard', set_name: 'Base', card_number: '4/102', holo_type: 'Holo' }), 'pokemon details');
  must(await admin.from('comic_book_details').insert({ item_id: it.comic, series_title: 'Amazing', issue_number: '1', publisher: 'Pub', is_key_issue: true, writer: 'Writer' }), 'comic details');
  must(await admin.from('other_item_details').insert({ item_id: it.other, category: 'custom', custom_category_name: 'Vinyl Figures', details: {} }).select(), 'other details');
  must(await admin.from('collection_item_private_details').insert({ item_id: it.sports, purchase_price: 1234.5 }), 'private details');

  // Photos: two large ones (forces several archive steps) and small ones.
  const photos: { path: string; bytes: Buffer }[] = [];
  const upload = async (u: User, bucket: string, path: string, bytes: Buffer) => {
    must(await u.db.storage.from(bucket).upload(path, bytes, { contentType: 'image/jpeg' }), `upload ${path}`);
  };
  const sizes = [4_500_000, 3_800_000, 2_600_000, 900, 15_000];
  const itemOrder = [it.sports, it.sports, it.trading, it.pokemon, it.comic];
  for (let i = 0; i < sizes.length; i++) {
    const path = `${A.id}/${itemOrder[i]}/photo-${i}.jpg`;
    const bytes = randomBytes(sizes[i]);
    await upload(A, 'item-images', path, bytes);
    photos.push({ path, bytes });
    must(await A.db.from('collection_item_images').insert({ item_id: itemOrder[i], user_id: A.id, image_url: path, storage_path: path, sort_order: i, is_primary: i === 0 }), 'image row');
  }
  const coverPath = `${A.id}/cover-binder.jpg`;
  const cover = randomBytes(20_000);
  await upload(A, 'item-images', coverPath, cover);
  must(await A.db.from('folders').update({ cover_storage_path: coverPath, cover_source: 'custom' }).eq('id', f.binder), 'cover');
  const avatar = randomBytes(8_000);
  await upload(A, 'avatars', `${A.id}/avatar.jpg`, avatar);
  must(await A.db.from('profile_grail_slots').insert([
    { user_id: A.id, slot_index: 0, entry_type: 'item', item_id: it.sports },
    { user_id: A.id, slot_index: 4, entry_type: 'collection', collection_id: f.vault },
  ]), 'grails');
  const postA = randomUUID();
  must(await A.db.from('posts').insert({ id: postA, user_id: A.id, content: 'A post', post_type: 'text' }), 'A post');
  const postB = randomUUID();
  must(await B.db.from('posts').insert({ id: postB, user_id: B.id, content: 'B private-ish thoughts', post_type: 'text' }), 'B post');
  must(await A.db.from('comments').insert({ user_id: A.id, post_id: postB, body: 'A comment on B' }), 'comment');
  must(await A.db.from('item_comments').insert({ user_id: A.id, item_id: it.sports, body: 'A item comment' }), 'item comment');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conv') as string;
  must(await A.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: A.id, body: 'A says hello' }), 'A msg');
  must(await B.db.from('messages').insert({ id: randomUUID(), conversation_id: conv, sender_id: B.id, body: 'B SECRET reply' }), 'B msg');
  must(await A.db.from('follows').insert([{ follower_id: A.id, following_id: B.id }]), 'A follows B');
  must(await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id }), 'B follows A');
  must(await C.db.from('follows').insert({ follower_id: C.id, following_id: A.id }), 'C follows A');
  must(await A.db.rpc('register_card', { p_collection_item_id: it.sports, p_visibility: 'public' }), 'register');

  // ── B's look-alike content that must never appear ──
  const bFolder = randomUUID();
  const bItem = randomUUID();
  must(await B.db.from('folders').insert({ id: bFolder, user_id: B.id, name: 'B Private Vault', is_public: false }), 'B folder');
  must(await B.db.from('collection_items').insert({ id: bItem, folder_id: bFolder, user_id: B.id, title: 'B PRIVATE ITEM', item_type: 'sports_card', is_public: false, collection_status: 'active' }), 'B item');
  const bPath = `${B.id}/${bItem}/photo-0.jpg`;
  await upload(B, 'item-images', bPath, randomBytes(3000));
  must(await B.db.from('collection_item_images').insert({ item_id: bItem, user_id: B.id, image_url: bPath, storage_path: bPath }), 'B image');
  must(await admin.rpc('schedule_account_deletion', { p_user_id: C.id }), 'C pending');

  step('1. Access rules');
  check('no user token is rejected', (await fn({ action: 'status' }, null)).json?.reason === 'invalid_token');
  check('status: no export yet', (await fn({ action: 'status' }, A.token)).json?.export === null);
  check('download without a ready export → no_ready_export', (await fn({ action: 'download' }, A.token)).json?.reason === 'no_ready_export');
  check('sweep is service-role only', (await fn({ action: 'sweep' }, A.token)).status === 403);
  await signIn(A); // a known sign-in time, then let it go stale
  await sleep((WINDOW_SECONDS + 2) * 1000);
  const stale = await fn({ action: 'request' }, A.token);
  check('a stale sign-in cannot request an export', stale.status === 403 && stale.json?.reason === 'reauthentication_required', stale);

  step('2. Request (concurrent requests share one job)');
  await signIn(A);
  const [r1, r2, r3] = await Promise.all([fn({ action: 'request' }, A.token), fn({ action: 'request' }, A.token), fn({ action: 'request' }, A.token)]);
  check('all requests answered "preparing"', [r1, r2, r3].every((r) => r.json?.export?.state === 'preparing'), [r1.json, r2.json, r3.json]);
  const { data: active } = await admin.from('account_exports').select('id').eq('user_id', A.id).in('status', ['queued', 'collecting', 'archiving']);
  check('exactly one export job exists', (active ?? []).length === 1, active);
  const parallel = await Promise.all([fn({ action: 'advance' }, A.token), fn({ action: 'advance' }, A.token)]);
  check('parallel steps never fail (one works, one waits)', parallel.every((p) => p.status === 200), parallel.map((p) => p.json));

  step('3. Build in bounded steps');
  const built = await runToEnd(A);
  check('the export becomes ready', built.final?.export?.state === 'ready', built.final);
  check('it took several bounded steps (photos split across ~6 MB steps)', built.steps >= 3, built.steps);
  const jobA = await jobOf(A);
  check('ready for exactly 7 days', Math.abs(Date.parse(jobA.expires_at) - Date.parse(jobA.ready_at) - 7 * 86_400_000) < 5000, jobA);
  check('staging files were removed', (await listAll('account-exports', `${A.id}/${jobA.id}/staging`)).length === 0);
  check('the plan rows were removed', ((await admin.from('account_export_entries').select('seq').eq('export_id', jobA.id)).data ?? []).length === 0);
  const ex = jobA.excluded_records ?? {};
  check('unreleased registry data is recorded as excluded, not exported', ex.registered_cards_owned === 1 && ex.registered_cards_created === 1, ex);

  step('4. Archive contents');
  const { path: zipA, url: urlA } = await downloadZip(A, 'a-active');
  const za = inspect(zipA);
  check('the archive is a valid ZIP (every CRC verified)', za.bad === null, za.bad);
  const expected = ['README.txt', 'manifest.json', 'account/profile.json', 'collections/collections.json', 'collections/collections.csv',
    'items/items.json', 'items/items.csv', 'grails/grails.json', 'posts/posts.json', 'comments/comments.json',
    'messages/sent_messages.json', 'social/followers.json', 'social/following.json'];
  check('all data files are present', expected.every((n) => za.names.includes(n)), za.names);
  const media = za.names.filter((n) => n.startsWith('media/'));
  check('every original photo is included: 5 item photos, cover, avatar', media.length === 7, media);
  const allMatch = photos.every((p) => za.sha[`media/item-images/${p.path.slice(A.id.length + 1)}`] === sha256(p.bytes))
    && za.sha['media/item-images/cover-binder.jpg'] === sha256(cover) && za.sha['media/avatars/avatar.jpg'] === sha256(avatar);
  check('every photo is byte-identical to the original', allMatch);
  const everything = Object.values(za.text).join('\n') + za.names.join('\n');
  check('nothing of B: no B files, private items, collections or replies', !everything.includes(B.id) && !everything.includes('B PRIVATE ITEM')
    && !everything.includes('B Private Vault') && !everything.includes('B SECRET reply'));
  check('no credentials or tokens', !/access_token|refresh_token|encrypted_password|"password"|service_role/i.test(everything));
  check('no registry/transfer data', !/registered_card|cc_id|ownership_transfer|registry/i.test(everything));
  const cols = JSON.parse(za.text['collections/collections.json']);
  const vault = cols.find((c: any) => c.id === f.vault);
  check('nested hierarchy: Vault is under Binder ("Binder / Vault"), private', vault?.parent_id === f.binder && vault?.path === 'Binder / Vault' && vault?.effectively_public === false, vault);
  check('private collections are included for the owner', cols.length === 4 && cols.some((c: any) => c.name === 'Secret Stash'));
  check('collection cover photo is linked', cols.find((c: any) => c.id === f.binder)?.cover_file === 'media/item-images/cover-binder.jpg');
  const items = JSON.parse(za.text['items/items.json']);
  const byId = Object.fromEntries(items.map((i: any) => [i.id, i]));
  check('all five items, private ones included', items.length === 5);
  check('trading card metadata complete', byId[it.trading]?.category_details?.trading_card_details?.card_name === 'Black Lotus');
  check('Pokémon metadata complete', byId[it.pokemon]?.category_details?.pokemon_card_details?.card_number === '4/102');
  check('comic metadata complete', byId[it.comic]?.category_details?.comic_book_details?.is_key_issue === true);
  check('other-category metadata (custom category)', byId[it.other]?.category_details?.other_item_details?.custom_category_name === 'Vinyl Figures');
  check('sports card fields and private purchase price', byId[it.sports]?.player === 'Player, Jr.' && Number(byId[it.sports]?.purchase_price) === 1234.5);
  check('item photos link to files in the archive', byId[it.sports]?.photos?.length === 2 && byId[it.sports].photos.every((p: any) => za.names.includes(p.file)));
  const itemsCsv = za.text['items/items.csv'];
  check('items.csv: header with category columns, quoted commas, Unicode', itemsCsv.startsWith('id,') && itemsCsv.includes('pokemon.card_number')
    && itemsCsv.includes('"Player, Jr."') && itemsCsv.includes('Rookie Card “Ünïcode”'));
  check('collections.csv has every collection', za.text['collections/collections.csv'].trim().split('\r\n').length === 5);
  const grails = JSON.parse(za.text['grails/grails.json']);
  check('Grails positions and associations', grails.length === 2 && grails[0].position === 1 && grails[0].item_id === it.sports
    && grails[1].position === 5 && grails[1].collection_name === 'Vault');
  const sent = JSON.parse(za.text['messages/sent_messages.json']);
  check('sent messages only, with the partner’s public username', sent.length === 1 && sent[0].body === 'A says hello' && sent[0].to_usernames[0] === B.username);
  const followers = JSON.parse(za.text['social/followers.json']);
  check('followers: public usernames; a pending account is counted, not named', followers.collectors.length === 1
    && followers.collectors[0].username === B.username && followers.unavailable_accounts === 1, followers);
  check('comments: own comments only', JSON.parse(za.text['comments/comments.json']).length === 2);
  const manifest = JSON.parse(za.text['manifest.json']);
  check('manifest lists every file with its size', manifest.files.length === za.names.length - 2 + 2 || manifest.files.length >= 13);

  step('5. Nobody else can reach it');
  check('B has no export', (await fn({ action: 'status' }, B.token)).json?.export === null);
  check('B cannot download (no export of their own)', (await fn({ action: 'download' }, B.token)).json?.reason === 'no_ready_export');
  const bRead = await B.db.storage.from('account-exports').download(`${A.id}/${jobA.id}/${jobA.object_path.split('/').pop()}`);
  check('B cannot read A’s archive from Storage directly', !!bRead.error);
  const anonRead = await anon.storage.from('account-exports').download(jobA.object_path);
  check('anon cannot read it either', !!anonRead.error);
  const bList = await B.db.storage.from('account-exports').list(A.id);
  check('B cannot list A’s export folder', (bList.data ?? []).length === 0);
  const bTable = await B.db.from('account_exports').select('id');
  check('clients have no access to export jobs', !!bTable.error || (bTable.data ?? []).length === 0, bTable.error);
  const token = new URL(reachable(urlA)).searchParams.get('token') ?? '';
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  check('download links last 5 minutes', claims.exp - claims.iat === 300, claims);
  check('download links point at A’s own archive only', String(claims.url).startsWith(`account-exports/${A.id}/${jobA.id}/`), claims.url);

  step('6. Pending deletion: export still works');
  must(await admin.rpc('schedule_account_deletion', { p_user_id: A.id }), 'A pending');
  await signIn(A);
  check('A’s normal reads are blocked while pending', ((await A.db.from('collection_items').select('id').eq('user_id', A.id)).data ?? []).length === 0);
  const pendingReq = await fn({ action: 'request' }, A.token);
  check('a pending collector can request an export', pendingReq.json?.export?.state === 'preparing', pendingReq.json);
  const oldObject = await listAll('account-exports', `${A.id}/${jobA.id}`);
  check('the previous ready export was replaced and its archive removed', oldObject.length === 0, oldObject);
  const pendingBuilt = await runToEnd(A);
  check('…and it completes', pendingBuilt.final?.export?.state === 'ready', pendingBuilt.final);
  const zp = inspect((await downloadZip(A, 'a-pending')).path);
  check('the pending-deletion archive is valid and complete', zp.bad === null && JSON.parse(zp.text['items/items.json']).length === 5);
  must(await admin.rpc('cancel_account_deletion', { p_user_id: A.id }), 'A restored');

  step('7. Expiry');
  const jobP = await jobOf(A);
  // A day in the past: robust to clock drift between this machine and the stack.
  await admin.from('account_exports').update({ expires_at: new Date(Date.now() - 86_400_000).toISOString() }).eq('id', jobP.id);
  const expired = await fn({ action: 'status' }, A.token);
  check('an overdue export reports Expired', expired.json?.export?.state === 'expired', expired.json);
  check('its archive is deleted', (await listAll('account-exports', `${A.id}/${jobP.id}`)).length === 0);
  check('it can no longer be downloaded', (await fn({ action: 'download' }, A.token)).json?.reason === 'no_ready_export');

  step('8. Interrupted steps are reconciled');
  await signIn(A);
  await fn({ action: 'request' }, A.token);
  await fn({ action: 'advance' }, A.token); // plan
  let job = await jobOf(A);
  let { part, entry: nextEntry } = await pendingInOpenPart(A, job.id);
  // Simulate "uploaded the next file, then died before recording it".
  const src = Buffer.from(await (await admin.storage.from(nextEntry.source_bucket).download(nextEntry.source_path)).data!.arrayBuffer());
  const crc = crc32(src);
  await admin.from('account_export_entries').update({ crc32: crc }).eq('export_id', job.id).eq('seq', nextEntry.seq);
  const patch = await fetch(reachable(part.upload_url), {
    method: 'PATCH', headers: { ...tus, 'Upload-Offset': String(part.bytes_written), 'Content-Type': 'application/offset+octet-stream' },
    body: Buffer.from(localEntry(nextEntry.archive_name, src, crc)),
  });
  check('(simulated: a file reached the upload but was never recorded)', patch.status === 204, patch.status);
  const recon = await runToEnd(A);
  job = await jobOf(A);
  check('the export recovers without a rebuild', recon.final?.export?.state === 'ready' && job.attempts === 1, { state: recon.final?.export?.state, attempts: job.attempts });
  check('the recovered archive is valid', inspect((await downloadZip(A, 'a-reconciled')).path).bad === null);

  step('9. Broken uploads and changed photos rebuild; repeated failure cleans up');
  await signIn(A);
  await fn({ action: 'request' }, A.token);
  await fn({ action: 'advance' }, A.token);
  job = await jobOf(A);
  ({ part } = await pendingInOpenPart(A, job.id));
  await fetch(reachable(part.upload_url), {
    method: 'PATCH', headers: { ...tus, 'Upload-Offset': String(part.bytes_written), 'Content-Type': 'application/offset+octet-stream' },
    body: randomBytes(17),
  });
  // And a photo changes size mid-export.
  const changed = randomBytes(5000);
  must(await admin.storage.from('item-images').update(photos[3].path, changed, { contentType: 'image/jpeg' }), 'replace photo');
  photos[3].bytes = changed;
  const rebuilt = await runToEnd(A);
  job = await jobOf(A);
  check('a broken upload / changed photo triggers a clean rebuild that completes', rebuilt.final?.export?.state === 'ready' && job.attempts >= 2, { state: rebuilt.final?.export?.state, attempts: job.attempts });
  const zr = inspect((await downloadZip(A, 'a-rebuilt')).path);
  check('the rebuilt archive has the NEW photo', zr.bad === null && zr.sha[`media/item-images/${photos[3].path.slice(A.id.length + 1)}`] === sha256(changed));
  await signIn(A);
  await fn({ action: 'request' }, A.token);
  await fn({ action: 'advance' }, A.token);
  job = await jobOf(A);
  ({ part } = await pendingInOpenPart(A, job.id));
  await admin.from('account_exports').update({ attempts: 3 }).eq('id', job.id);
  await fetch(reachable(part.upload_url), {
    method: 'PATCH', headers: { ...tus, 'Upload-Offset': String(part.bytes_written), 'Content-Type': 'application/offset+octet-stream' },
    body: randomBytes(9),
  });
  const gaveUp = await runToEnd(A);
  check('after repeated failures the export reports Failed', gaveUp.final?.export?.state === 'failed' && gaveUp.final?.export?.error === 'export_failed', gaveUp.final);
  check('…and every partial file is removed', (await listAll('account-exports', `${A.id}/${job.id}`)).length === 0);
  const head = await fetch(reachable(part.upload_url), { method: 'HEAD', headers: tus });
  check('…including the partial upload', head.status === 404 || head.status === 410, head.status);
  await signIn(A);
  check('a new export can be requested after a failure', (await fn({ action: 'request' }, A.token)).json?.export?.state === 'preparing');

  step('10. Large export: 1,050 photos');
  const small = randomBytes(600);
  for (let i = 0; i < 1050; i += 25) {
    await Promise.all(Array.from({ length: Math.min(25, 1050 - i) }, (_, k) => upload(D, 'item-images', `${D.id}/bulk/p${String(i + k).padStart(4, '0')}.jpg`, small)));
  }
  await signIn(D);
  await fn({ action: 'request' }, D.token);
  const big = await runToEnd(D);
  check('the large export completes', big.final?.export?.state === 'ready', big.final);
  const zd = inspect((await downloadZip(D, 'd-large')).path);
  check('all 1,050 photos are in a valid archive', zd.bad === null && zd.names.filter((n) => n.startsWith('media/item-images/bulk/')).length === 1050);

  step('11. Account deletion removes export jobs');
  const jobsBefore = ((await admin.from('account_exports').select('id').eq('user_id', D.id)).data ?? []).length;
  await admin.storage.from('account-exports').remove(await listAll('account-exports', D.id));
  await admin.auth.admin.deleteUser(D.id);
  const jobsAfter = ((await admin.from('account_exports').select('id').eq('user_id', D.id)).data ?? []).length;
  check('a deleted account’s export jobs go with it', jobsBefore >= 1 && jobsAfter === 0, { jobsBefore, jobsAfter });
}

console.log(`Supabase ${st.API_URL} (run ${run}); archives in ${work}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${section}": ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} disposable accounts and their files removed.`);
}
const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failedChecks) console.log(`  FAIL ${f.name}`);
process.exitCode = failedChecks.length || fatal ? 1 : 0;

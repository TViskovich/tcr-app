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
// Every file the manifest records is in the archive (and vice versa), and
// every media/ path any data file refers to is a real ZIP entry.
function checkManifestFiles(who: string, manifest: any, z: { names: string[]; text: Record<string, string> }) {
  const listed = (manifest?.files ?? []).map((f: any) => f.name).concat(['manifest.json']).sort();
  check(`${who}: the manifest records exactly the files in the archive`, JSON.stringify(listed) === JSON.stringify([...z.names].sort()),
    { onlyInManifest: listed.filter((n: string) => !z.names.includes(n)), onlyInZip: z.names.filter((n) => !listed.includes(n)) });
  check(`${who}: every file has a size and a valid part`, (manifest?.files ?? []).every((f: any) => Number.isInteger(f.bytes) && f.bytes >= 0
    && f.part >= 1 && f.part <= manifest.parts.length));
  const refs = new Set<string>();
  for (const [n, t] of Object.entries(z.text)) {
    if (!n.endsWith('.json') && !n.endsWith('.csv')) continue;
    for (const m of t.matchAll(/(media\/[^"\n,;|]+?\.[A-Za-z0-9]+)(?=["\n,;|])/g)) refs.add(m[1]);
  }
  const missing = [...refs].filter((r) => !z.names.includes(r));
  check(`${who}: every media/ reference in the data files resolves to a ZIP entry (${refs.size} references)`, missing.length === 0, missing);
}
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
  // Fixture waitlist signups (all @example.test; cleared even if a run stopped early).
  await admin.from('waitlist_signups').delete().like('email', '%@example.test');
  await admin.from('waitlist_signups').delete().like('email', '%@EXAMPLE.TEST');
  if (!ids.length) return 0;
  await admin.from('account_lifecycle').delete().in('user_id', ids).eq('state', 'pending_deletion');
  await admin.from('registered_cards').delete().in('created_by', ids);
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const convIds = [...new Set((parts ?? []).map((r) => r.conversation_id))];
  for (const c of convIds) await removeAll('dm-attachments', c); // fixture DM photos live per conversation
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  for (const id of ids) {
    for (const bucket of ['item-images', 'avatars', 'account-exports', 'share-snapshots']) await removeAll(bucket, id);
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
  // ── Sent DM photos (Export 6), through the real clients: Storage upload
  // policy, then the message (whose trigger checks path, object and owner).
  const dmSend = async (u: User, conversation: string, label: string) => {
    const id = randomUUID();
    const path = `${conversation}/${id}/image.jpg`;
    const bytes = randomBytes(20_000 + Math.floor(Math.random() * 5000));
    must(await u.db.storage.from('dm-attachments').upload(path, bytes, { contentType: 'image/jpeg', upsert: false }), `${label} upload`);
    must(await u.db.from('messages').insert({ id, conversation_id: conversation, sender_id: u.id, attachment_type: 'image', attachment_storage_path: path, attachment_width: 4, attachment_height: 3 }), label);
    return { id, path, bytes };
  };
  const convAC = must(await A.db.rpc('get_or_create_conversation', { other_user_id: C.id }), 'conv A–C') as string;
  const dmA1 = await dmSend(A, conv, 'A sends B a photo');
  const dmB1 = await dmSend(B, conv, 'B sends A a photo');
  const dmA2 = await dmSend(A, convAC, 'A sends C a photo (C goes pending)');
  const dmA3 = await dmSend(A, conv, 'A sends B a photo whose file is later lost');
  const dmOrphan = `${conv}/${randomUUID()}/image.jpg`; // an upload that never became a message
  must(await A.db.storage.from('dm-attachments').upload(dmOrphan, randomBytes(3000), { contentType: 'image/jpeg' }), 'A orphan upload');
  must(await admin.storage.from('dm-attachments').remove([dmA3.path]), 'A3 file lost');
  must(await A.db.from('follows').insert([{ follower_id: A.id, following_id: B.id }]), 'A follows B');
  must(await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id }), 'B follows A');
  must(await C.db.from('follows').insert({ follower_id: C.id, following_id: A.id }), 'C follows A');
  must(await A.db.rpc('register_card', { p_collection_item_id: it.sports, p_visibility: 'public' }), 'register');

  // ── B's look-alike content that must never appear ──
  const bFolder = randomUUID();
  const bItem = randomUUID();
  must(await B.db.from('folders').insert({ id: bFolder, user_id: B.id, name: 'B Private Vault', is_public: false }), 'B folder');
  must(await B.db.from('collection_items').insert({ id: bItem, folder_id: bFolder, user_id: B.id, title: 'B PRIVATE ITEM', item_type: 'sports_card', is_public: false, collection_status: 'active' }), 'B item');

  // ── A's posts of every kind (Export 1: complete post data) ──
  // Share snapshots live in A's own share-snapshots folder (written by the
  // service role in production, so the fixture does too). Some referenced
  // files are deliberately never uploaded (→ "unavailable"), one reference
  // is an outside address and one is another collector's private file
  // (→ "not_included", and B's private path must never be copied).
  const snapUrl = (path: string) => admin.storage.from('share-snapshots').getPublicUrl(path).data.publicUrl;
  const snapFiles: Record<string, Buffer> = {};
  const putSnap = async (rel: string) => {
    const bytes = randomBytes(1500 + Object.keys(snapFiles).length);
    must(await admin.storage.from('share-snapshots').upload(`${A.id}/${rel}`, bytes, { contentType: 'image/jpeg' }), `snap ${rel}`);
    snapFiles[rel] = bytes;
    return snapUrl(`${A.id}/${rel}`);
  };
  const p = {
    photo: randomUUID(), item: randomUUID(), itemGone: randomUUID(), card: randomUUID(), folder: randomUUID(),
    rmg: randomUUID(), repost: randomUUID(), quote: randomUUID(), outside: randomUUID(),
  };
  const ts = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 60_000).toISOString();
  const urls = {
    upload0: await putSnap(`post-upload/${p.photo}-0.jpg`),
    upload1: await putSnap(`post-upload/${p.photo}-1.jpg`),
    itemCopy: await putSnap(`post/${it.sports}/${it.sports}-copy.jpg`),
    cardTrading: await putSnap(`card_share/${p.card}/${it.trading}.jpg`),
    cardComicMissing: snapUrl(`${A.id}/card_share/${p.card}/${it.comic}.jpg`), // never uploaded
    folderCover: await putSnap(`folder_share/${p.folder}/cover.jpg`),
    folderTrading: await putSnap(`folder_share/${p.folder}/${it.trading}.jpg`),
    rmgSports: await putSnap(`rate_my_grails/${p.rmg}/${it.sports}.jpg`),
    outside: 'https://images.example.org/outside.jpg',
    bPrivate: `${st.API_URL}/storage/v1/object/sign/item-images/${B.id}/${bItem}/photo-0.jpg?token=SECRET-SIGNED-TOKEN`,
  };
  must(await admin.from('posts').insert([
    { id: p.photo, user_id: A.id, post_type: 'text', content: 'Photo post', created_at: ts(1) },
    { id: p.item, user_id: A.id, post_type: 'item', item_id: it.sports, image_url: urls.itemCopy, caption: 'My rookie', created_at: ts(2) },
    { id: p.itemGone, user_id: A.id, post_type: 'item', item_id: null, image_url: null, caption: 'Its item was deleted', created_at: ts(3) },
    { id: p.card, user_id: A.id, post_type: 'card_share', content: 'Three cards', created_at: ts(4) },
    { id: p.folder, user_id: A.id, post_type: 'folder_share', folder_id: f.binder, folder_name: 'Binder', folder_item_count: 3, folder_cover_snapshot_url: urls.folderCover, created_at: ts(5) },
    { id: p.rmg, user_id: A.id, post_type: 'rate_my_grails', content: 'Rate it', created_at: ts(6) },
    { id: p.repost, user_id: A.id, post_type: 'repost', repost_of_post_id: postB, created_at: ts(7) },
    { id: p.quote, user_id: A.id, post_type: 'quote', quote_of_post_id: postB, content: 'Quoting B', created_at: ts(8) },
    { id: p.outside, user_id: A.id, post_type: 'text', content: 'Outside and foreign references', created_at: ts(9) },
  ]), 'A posts of every kind');
  must(await admin.from('post_images').insert([
    { post_id: p.photo, image_url: urls.upload1, source_type: 'item', item_id: it.sports, sort_order: 1 },
    { post_id: p.photo, image_url: urls.upload0, source_type: 'library', sort_order: 0 },
    { post_id: p.outside, image_url: urls.outside, source_type: 'library', sort_order: 0 },
    { post_id: p.outside, image_url: urls.bPrivate, source_type: 'library', sort_order: 1 },
  ]), 'post images');
  must(await admin.from('card_share_items').insert([
    { post_id: p.card, item_id: it.comic, snapshot_image_url: urls.cardComicMissing, snapshot_title: 'Comic #1', snapshot_subtitle: 'Pub', display_order: 1 },
    { post_id: p.card, item_id: it.trading, snapshot_image_url: urls.cardTrading, snapshot_title: 'Black Lotus', snapshot_subtitle: 'Alpha', display_order: 0 },
    { post_id: p.card, item_id: null, snapshot_image_url: null, snapshot_title: 'A card since deleted', snapshot_subtitle: null, display_order: 2 },
  ]), 'card share items');
  must(await admin.from('folder_share_items').insert([
    { post_id: p.folder, item_id: it.trading, snapshot_image_url: urls.folderTrading, snapshot_title: 'Trading Card', snapshot_subtitle: 'Binder', display_order: 0 },
    { post_id: p.folder, item_id: bItem, snapshot_image_url: urls.bPrivate, snapshot_title: 'Shared public card', snapshot_subtitle: null, display_order: 1 },
  ]), 'folder share items');
  must(await admin.from('rate_my_grail_cards').insert(
    { post_id: p.rmg, item_id: it.sports, snapshot_image_url: urls.rmgSports, snapshot_title: 'Rookie Card', snapshot_subtitle: 'PSA 10', display_order: 0 },
  ), 'rate my grails cards');
  const bPath = `${B.id}/${bItem}/photo-0.jpg`;
  await upload(B, 'item-images', bPath, randomBytes(3000));
  must(await B.db.from('collection_item_images').insert({ item_id: bItem, user_id: B.id, image_url: bPath, storage_path: bPath }), 'B image');
  // ── Activity (Export 2): A's likes, saves and ratings ──
  // Targets: A's own content, B's public content (visible), C's content (C
  // goes pending below → hidden), and one of B's posts that is then deleted.
  // B's activity on A's content must never appear in A's archive.
  const bPub = randomUUID();
  const bPubItem = randomUUID();
  const bRmg = randomUUID();
  const bDoomed = randomUUID();
  must(await admin.from('folders').insert({ id: bPub, user_id: B.id, name: 'B Public Shelf', is_public: true }), 'B public folder');
  must(await admin.from('collection_items').insert({ id: bPubItem, folder_id: bPub, user_id: B.id, title: 'B public card', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'B public item');
  must(await admin.from('posts').insert([
    { id: bRmg, user_id: B.id, post_type: 'rate_my_grails', content: 'Rate B' },
    { id: bDoomed, user_id: B.id, post_type: 'text', content: 'B post that gets deleted' },
  ]), 'B posts');
  const cFolder = randomUUID();
  const cItem = randomUUID();
  const cPost = randomUUID();
  must(await admin.from('folders').insert({ id: cFolder, user_id: C.id, name: 'C HIDDEN SHELF', is_public: true }), 'C folder');
  must(await admin.from('collection_items').insert({ id: cItem, folder_id: cFolder, user_id: C.id, title: 'C HIDDEN CARD', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'C item');
  must(await admin.from('posts').insert({ id: cPost, user_id: C.id, post_type: 'rate_my_grails', content: 'C HIDDEN POST' }), 'C post');
  const at = (n: number) => new Date(Date.parse('2026-02-01T00:00:00Z') + n * 60_000).toISOString();
  must(await admin.from('likes').insert([
    { user_id: A.id, post_id: postA, created_at: at(1) },
    { user_id: A.id, post_id: postB, created_at: at(2) },
    { user_id: A.id, post_id: cPost, created_at: at(3) },
    { user_id: A.id, post_id: bDoomed, created_at: at(4) },
    { user_id: B.id, post_id: postA, created_at: at(5) }, // B's activity
  ]), 'post likes');
  must(await admin.from('item_likes').insert([
    { user_id: A.id, item_id: it.trading, created_at: at(6) },
    { user_id: A.id, item_id: bPubItem, created_at: at(7) },
    { user_id: A.id, item_id: cItem, created_at: null }, // no timestamp recorded
    { user_id: B.id, item_id: it.trading, created_at: at(8) }, // B's activity
  ]), 'item likes');
  must(await admin.from('folder_likes').insert([
    { user_id: A.id, folder_id: bPub, created_at: at(9) },
    { user_id: B.id, folder_id: f.binder, created_at: at(10) }, // B's activity
  ]), 'collection likes');
  must(await admin.from('saved_cards').insert([
    { user_id: A.id, item_id: bPubItem, created_at: at(11) },
    { user_id: A.id, item_id: cItem, created_at: at(12) },
    { user_id: B.id, item_id: it.trading, created_at: at(13) }, // B's activity
  ]), 'saved items');
  must(await admin.from('saved_folders').insert([
    { user_id: A.id, folder_id: bPub, created_at: at(14) },
    { user_id: A.id, folder_id: f.binder, created_at: at(15) },
  ]), 'saved collections');
  must(await admin.from('saved_grails').insert([
    { user_id: A.id, owner_id: B.id, created_at: at(16) },
    { user_id: A.id, owner_id: C.id, created_at: at(17) },
    { user_id: B.id, owner_id: A.id, created_at: at(18) }, // B's activity
  ]), 'saved Grails showcases');
  must(await admin.from('grail_ratings').insert([
    { post_id: bRmg, rater_user_id: A.id, score: 8, created_at: at(19), updated_at: at(20) },
    { post_id: cPost, rater_user_id: A.id, score: 3, created_at: at(21), updated_at: at(21) },
    { post_id: p.rmg, rater_user_id: B.id, score: 9, created_at: at(22), updated_at: at(22) }, // B rates A
  ]), 'grail ratings');
  // ── Collector tagging (Export 3) ──
  // Through each collector's own signed-in client, so the real ownership,
  // self-tag and hidden-account guards run. Inserted one at a time: the
  // server stamps created_at, which fixes the expected order.
  const E = await createUser('e'); // tagged by A, then deleted
  // Export 7: a conversation with E, who is deleted below → read-only for A.
  const convAE = must(await A.db.rpc('get_or_create_conversation', { other_user_id: E.id }), 'conv A–E') as string;
  must(await A.db.from('messages').insert({ conversation_id: convAE, sender_id: A.id, body: 'A to E before E leaves' }), 'A→E msg');
  const aTagDoomed = randomUUID();
  must(await A.db.from('collection_items').insert({ id: aTagDoomed, folder_id: f.binder, user_id: A.id, title: 'A item that gets deleted', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'A doomed item');
  const tag = async (u: User, kind: 'item' | 'collection', id: string, who: User, label: string) =>
    must(await u.db.from(kind === 'item' ? 'collection_item_tags' : 'folder_tags').insert({ [kind === 'item' ? 'item_id' : 'folder_id']: id, tagged_user_id: who.id }), label);
  await tag(A, 'item', it.trading, B, 'A tags B in an item');
  await tag(A, 'collection', f.binder, C, 'A tags C in a collection (C goes pending)');
  await tag(A, 'collection', f.secret, B, 'A tags B in a private collection');
  await tag(A, 'item', it.sports, E, 'A tags E (E is deleted)');
  await tag(A, 'item', aTagDoomed, B, 'A tags B in an item that is deleted');
  await tag(B, 'item', bPubItem, A, 'B tags A in a public item');
  await tag(B, 'collection', bPub, A, 'B tags A in a public collection');
  await tag(B, 'item', bItem, A, 'B tags A in a PRIVATE item');
  await tag(B, 'collection', bFolder, A, 'B tags A in a PRIVATE collection');
  await tag(C, 'item', cItem, A, 'C tags A in an item (C goes pending)');
  await tag(C, 'collection', cFolder, A, 'C tags A in a collection (C goes pending)');
  await tag(B, 'item', bPubItem, C, 'unrelated: B tags C');
  await tag(C, 'collection', cFolder, B, 'unrelated: C tags B');
  const selfTag = await A.db.from('collection_item_tags').insert({ item_id: it.trading, tagged_user_id: A.id });
  const forged = await B.db.from('collection_item_tags').insert({ item_id: it.sports, tagged_user_id: B.id, tagged_by: A.id });
  must(await admin.from('collection_items').delete().eq('id', aTagDoomed), 'A deletes a tagged item');
  { const { error } = await admin.auth.admin.deleteUser(E.id); if (error) throw new Error(`E deleted: ${error.message}`); }

  // ── Waitlist signups (Export 4), written as join-waitlist / the invite
  // RPCs would (service role is the table's only writer). Codes are
  // digests in production; these stand-ins must never reach an archive.
  const W = await createUser('w'); // joined the waitlist, signed up without redeeming
  const code = (k: string) => createHash('sha256').update(`${run}-${k}`).digest('hex');
  must(await admin.from('waitlist_signups').insert([
    // A redeemed this invite, then changed email: linked by account id.
    { name: 'Alex Waitlist', email: `old-${A.email}`, reserved_username: A.username, status: 'onboarded', created_at: at(29),
      access_granted_at: at(30), onboarded_at: at(31), access_code: code('a'), access_code_expires_at: at(40), onboarded_user_id: A.id },
    // A's CURRENT email, but redeemed by another account: never A's.
    { name: 'REUSED EMAIL PERSON', email: A.email, status: 'onboarded', created_at: at(32), access_granted_at: at(33), onboarded_at: at(34),
      access_code: code('reused'), onboarded_user_id: B.id },
    // W: unclaimed signup under W's confirmed email (stored in another case).
    { name: 'Wren Waitlist', email: W.email.toUpperCase(), reserved_username: W.username, status: 'access_granted', created_at: at(35),
      access_granted_at: at(36), access_code: code('w'), access_code_expires_at: at(50) },
    // D's email, consumed by an account since deleted (link cleared): never D's.
    { name: 'DELETED ACCOUNT PERSON', email: D.email, status: 'onboarded', created_at: at(37), onboarded_at: at(38), access_code: code('gone') },
    // Nobody's.
    { name: 'UNRELATED STRANGER', email: `${run}-stranger@example.test`, status: 'waitlisted', created_at: at(39) },
  ]), 'waitlist signups');

  must(await admin.from('posts').delete().eq('id', bDoomed), 'B deletes a post A liked');
  // ── Notifications and conversation metadata (Export 7) ──
  // Message and tag notifications come from database triggers (above);
  // follow, like and rating notifications are created the way the app does
  // it — the actor calls the RPC after acting. Also: a conversation with no
  // messages, a tag on content B later makes private, a like on a post A
  // then deletes, an unreleased-feature notification, read/hidden states.
  must(await B.db.rpc('create_or_refresh_follow_notification', { p_followed_user_id: A.id }), 'B follow → notification');
  must(await C.db.rpc('create_or_refresh_follow_notification', { p_followed_user_id: A.id }), 'C follow → notification');
  must(await B.db.rpc('create_or_refresh_like_notification', { p_post_id: postA }), 'B like → notification');
  must(await B.db.rpc('create_or_refresh_grail_rating_notification', { p_post_id: p.rmg, p_score: 9 }), 'B rating → notification');
  const convAW = must(await A.db.rpc('get_or_create_conversation', { other_user_id: W.id }), 'conv A–W (no messages)') as string;
  const bLater = randomUUID();
  must(await admin.from('collection_items').insert({ id: bLater, folder_id: bPub, user_id: B.id, title: 'B LATER PRIVATE', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'B item, public for now');
  must(await B.db.from('collection_item_tags').insert({ item_id: bLater, tagged_user_id: A.id }), 'B tags A (notified)');
  must(await admin.from('collection_items').update({ is_public: false }).eq('id', bLater), 'B makes it private');
  const postGone = randomUUID();
  must(await A.db.from('posts').insert({ id: postGone, user_id: A.id, content: 'A post that gets deleted', post_type: 'text' }), 'A doomed post');
  must(await B.db.from('likes').insert({ user_id: B.id, post_id: postGone }), 'B likes it');
  must(await B.db.rpc('create_or_refresh_like_notification', { p_post_id: postGone }), '…notified');
  check('fixture: the like on the soon-deleted post produced a notification', ((await admin.from('notifications').select('id').eq('post_id', postGone)).data ?? []).length === 1);
  must(await admin.from('posts').delete().eq('id', postGone), 'A deletes the post');
  must(await admin.from('notifications').insert({ user_id: A.id, actor_id: B.id, type: 'ownership_transfer_requested' }), 'unreleased-feature notification');
  const { data: bFollowN } = await admin.from('notifications').select('id').eq('user_id', A.id).eq('actor_id', B.id).eq('type', 'follow').single();
  must(await A.db.from('notifications').update({ read: true }).eq('id', bFollowN!.id), 'A reads B’s follow notification');
  const bNotificationIds = ((await admin.from('notifications').select('id').eq('user_id', B.id)).data ?? []).map((r) => r.id as string);
  must(await A.db.from('conversation_participants').update({ last_read_at: at(60), hidden_at: at(62) }).eq('conversation_id', conv).eq('user_id', A.id), 'A read, then hid A–B');
  must(await B.db.from('conversation_participants').update({ last_read_at: at(70), hidden_at: at(71) }).eq('conversation_id', conv).eq('user_id', B.id), 'B’s own (private) state');

  must(await admin.rpc('schedule_account_deletion', { p_user_id: C.id }), 'C pending');

  step('1. Access rules');
  check('no user token is rejected', (await fn({ action: 'status' }, null)).json?.reason === 'invalid_token');
  check('status: no export yet', (await fn({ action: 'status' }, A.token)).json?.export === null);
  check('download without a ready export → no_ready_export', (await fn({ action: 'download' }, A.token)).json?.reason === 'no_ready_export');
  check('there is no sweep action any more (cleanup runs inside the maintenance worker)', (await fn({ action: 'sweep' }, A.token)).json?.reason === 'invalid_action');
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
  const snapCount = Object.keys(snapFiles).length;
  check(`every original photo is included: 5 item photos, cover, avatar, ${snapCount} post snapshots, 2 sent DM photos`, media.length === 7 + snapCount + 2, media);
  check('every post snapshot file is byte-identical in media/share-snapshots/',
    Object.entries(snapFiles).every(([rel, bytes]) => za.sha[`media/share-snapshots/${rel}`] === sha256(bytes)));
  const allMatch = photos.every((p) => za.sha[`media/item-images/${p.path.slice(A.id.length + 1)}`] === sha256(p.bytes))
    && za.sha['media/item-images/cover-binder.jpg'] === sha256(cover) && za.sha['media/avatars/avatar.jpg'] === sha256(avatar);
  check('every photo is byte-identical to the original', allMatch);
  const everything = Object.values(za.text).join('\n') + za.names.join('\n');
  check('nothing of B: no B files, private items, collections or replies', !everything.includes(B.id) && !everything.includes('B PRIVATE ITEM')
    && !everything.includes('B Private Vault') && !everything.includes('B SECRET reply'));
  check('no credentials or tokens', !/access_token|refresh_token|encrypted_password|"password"|service_role/i.test(everything));
  // README/manifest name the unreleased features only to say they're excluded (counts only; checked in 4f).
  const dataOnly = Object.entries(za.text).filter(([n]) => n !== 'README.txt' && n !== 'manifest.json').map(([, t]) => t).join('\n') + za.names.join('\n');
  check('no registry/transfer data in any data file', !/registered_card|cc_id|ownership_transfer|registry/i.test(dataOnly));
  const mText = JSON.parse(za.text['manifest.json']);
  const { excluded_records: _ex, not_included: _ni, ...mRest } = mText;
  check('the manifest mentions Registry/Transfers only as excluded counts and a description', !/registered_card|ownership_transfer|registry|transfer/i.test(JSON.stringify(mRest))
    && Object.values(_ex.unreleased_registry_and_transfers.counts).every((v) => typeof v === 'number'));
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
  const hello = sent.filter((m: any) => m.body === 'A says hello');
  check('sent messages only, with the partner’s public username (2 text + 3 photo messages)', sent.length === 5 && hello.length === 1
    && hello[0].to_usernames[0] === B.username && sent.find((m: any) => m.body === 'A to E before E leaves')?.to_usernames?.length === 0
    && sent.find((m: any) => m.id === dmA2.id)?.to_usernames?.[0] === null, sent);
  const followers = JSON.parse(za.text['social/followers.json']);
  check('followers: public usernames; a pending account is counted, not named', followers.collectors.length === 1
    && followers.collectors[0].username === B.username && followers.unavailable_accounts === 1, followers);
  check('comments: own comments only', JSON.parse(za.text['comments/comments.json']).length === 2);

  step('4b. Complete post data (Export 1)');
  const postsOut = JSON.parse(za.text['posts/posts.json']);
  const post = Object.fromEntries(postsOut.map((x: any) => [x.id, x]));
  check('all of A’s posts are exported (1 text + 9 of every kind), none of B’s', postsOut.length === 10 && !post[postB], postsOut.map((x: any) => x.type));
  const legacyKeys = ['id', 'type', 'content', 'caption', 'item_id', 'collection_id', 'reposted_post_id', 'quoted_post_id', 'images', 'created_at'];
  check('compatible: every existing post field is still present', postsOut.every((x: any) => legacyKeys.every((k) => k in x)));
  check('compatible: images still carry url and item_id', postsOut.flatMap((x: any) => x.images).every((i: any) => 'url' in i && 'item_id' in i));
  const media1 = (rel: string) => `media/share-snapshots/${rel}`;
  const ph = post[p.photo];
  check('photo post: images in sort order, with source type and item link',
    ph?.images?.length === 2 && ph.images[0].sort_order === 0 && ph.images[0].source_type === 'library' && ph.images[0].item_id === null
    && ph.images[1].sort_order === 1 && ph.images[1].source_type === 'item' && ph.images[1].item_id === it.sports, ph?.images);
  check('photo post: both photos "included" and linked to their archive files',
    ph?.images?.[0]?.status === 'included' && ph.images[0].file === media1(`post-upload/${p.photo}-0.jpg`)
    && ph.images[1].file === media1(`post-upload/${p.photo}-1.jpg`) && ph.images.every((i: any) => za.names.includes(i.file)), ph?.images);
  check('item post: the copied photo is included and linked; the item is the collector’s own',
    post[p.item]?.image?.status === 'included' && post[p.item].image.file === media1(`post/${it.sports}/${it.sports}-copy.jpg`)
    && post[p.item].item_status === 'yours' && post[p.item].caption === 'My rookie', post[p.item]);
  check('item post whose item was deleted: image "unavailable", item "deleted", caption kept',
    post[p.itemGone]?.image?.status === 'unavailable' && post[p.itemGone].image.file === null && post[p.itemGone].item_status === 'deleted'
    && post[p.itemGone].caption === 'Its item was deleted', post[p.itemGone]);
  const cards = post[p.card]?.attached_items ?? [];
  check('card share: three attached cards in display order with titles and subtitles',
    cards.length === 3 && cards.every((c: any) => c.kind === 'card_share') && cards.map((c: any) => c.display_order).join() === '0,1,2'
    && cards[0].title === 'Black Lotus' && cards[0].subtitle === 'Alpha' && cards[1].title === 'Comic #1', cards);
  check('card share: snapshot included / own file missing → "unavailable" / deleted source keeps its title',
    cards[0]?.image?.status === 'included' && cards[0].image.file === media1(`card_share/${p.card}/${it.trading}.jpg`) && cards[0].item_status === 'yours'
    && cards[1]?.image?.status === 'unavailable' && cards[1].image.file === null && cards[1].item_status === 'yours'
    && cards[2]?.item_id === null && cards[2].item_status === 'deleted' && cards[2].image.status === 'unavailable' && cards[2].title === 'A card since deleted', cards);
  const fp = post[p.folder];
  check('collection share: name, item count, own collection and included cover',
    fp?.collection_id === f.binder && fp.collection_status === 'yours' && fp.collection_name === 'Binder' && fp.collection_item_count === 3
    && fp.collection_cover?.status === 'included' && fp.collection_cover.file === media1(`folder_share/${p.folder}/cover.jpg`), fp);
  const shared = fp?.attached_items ?? [];
  check('collection share: attached items, own one included',
    shared.length === 2 && shared[0].kind === 'collection_share' && shared[0].item_status === 'yours' && shared[0].image.status === 'included'
    && shared[0].image.file === media1(`folder_share/${p.folder}/${it.trading}.jpg`), shared);
  check('another collector’s item: "other_collector", file not included, private path NOT copied',
    shared[1]?.item_id === bItem && shared[1].item_status === 'other_collector' && shared[1].image.status === 'not_included'
    && shared[1].image.url === null && shared[1].image.file === null, shared[1]);
  const rmg = post[p.rmg]?.attached_items ?? [];
  check('Rate-My-Grails: attached card with snapshot included',
    rmg.length === 1 && rmg[0].kind === 'rate_my_grails' && rmg[0].item_id === it.sports && rmg[0].title === 'Rookie Card'
    && rmg[0].subtitle === 'PSA 10' && rmg[0].image.status === 'included' && rmg[0].image.file === media1(`rate_my_grails/${p.rmg}/${it.sports}.jpg`), rmg);
  check('repost and quote references intact (only the reference, not B’s post)',
    post[p.repost]?.type === 'repost' && post[p.repost].reposted_post_id === postB
    && post[p.quote]?.type === 'quote' && post[p.quote].quoted_post_id === postB && post[p.quote].content === 'Quoting B'
    && !Object.values(za.text).join('\n').includes('B private-ish thoughts'));
  const out = post[p.outside]?.images ?? [];
  check('outside address: "not_included", public url kept, no file',
    out[0]?.status === 'not_included' && out[0].url === urls.outside && out[0].file === null, out[0]);
  check('another collector’s private storage link: "not_included", url dropped', out[1]?.status === 'not_included' && out[1].url === null, out[1]);
  const allRefs = postsOut.flatMap((x: any) => [x.image, x.collection_cover, ...x.images, ...x.attached_items.map((a: any) => a.image)]).filter(Boolean);
  check('every "included" reference names an archive entry that exists', allRefs.filter((r: any) => r.status === 'included').every((r: any) => za.names.includes(r.file)));
  check('no reference claims a file that is not in the archive', allRefs.every((r: any) => (r.status === 'included') === (r.file !== null)));
  check('no signed-URL tokens copied into the archive', !Object.values(za.text).join('\n').includes('SECRET-SIGNED-TOKEN') && !/[?&]token=/.test(za.text['posts/posts.json']));
  check('README explains image statuses', za.text['README.txt'].includes('"not_included"') && za.text['README.txt'].includes('"unavailable"'));

  step('4c. Collector activity (Export 2)');
  check('activity files are in the archive', ['activity/likes.json', 'activity/saved.json', 'activity/ratings.json'].every((n) => za.names.includes(n)), za.names);
  const likesOut = JSON.parse(za.text['activity/likes.json']);
  const savedOut = JSON.parse(za.text['activity/saved.json']);
  const ratingsOut = JSON.parse(za.text['activity/ratings.json']);
  const sameTime = (a: unknown, b: string) => typeof a === 'string' && Date.parse(a) === Date.parse(b);
  const shape = (e: any, type: string, id: string, owner: string, status: string) =>
    e?.target_type === type && e.target_id === id && e.target_owner === owner && e.target_status === status;
  check('post likes: own, visible and hidden targets, oldest first, with timestamps',
    likesOut.posts?.length === 3 && shape(likesOut.posts[0], 'post', postA, 'you', 'available') && sameTime(likesOut.posts[0].liked_at, at(1))
    && shape(likesOut.posts[1], 'post', postB, 'other_collector', 'available') && sameTime(likesOut.posts[1].liked_at, at(2))
    && shape(likesOut.posts[2], 'post', cPost, 'other_collector', 'unavailable') && sameTime(likesOut.posts[2].liked_at, at(3)), likesOut.posts);
  check('like on a deleted post is gone with the post (no orphan entry)', !likesOut.posts.some((e: any) => e.target_id === bDoomed));
  check('item likes: own, visible, hidden; a missing timestamp is null (not invented)',
    likesOut.items?.length === 3 && shape(likesOut.items[0], 'item', it.trading, 'you', 'available')
    && shape(likesOut.items[1], 'item', bPubItem, 'other_collector', 'available')
    && shape(likesOut.items[2], 'item', cItem, 'other_collector', 'unavailable') && likesOut.items[2].liked_at === null, likesOut.items);
  check('collection likes', likesOut.collections?.length === 1 && shape(likesOut.collections[0], 'collection', bPub, 'other_collector', 'available')
    && sameTime(likesOut.collections[0].liked_at, at(9)), likesOut.collections);
  check('saved items: visible and hidden targets with saved_at',
    savedOut.items?.length === 2 && shape(savedOut.items[0], 'item', bPubItem, 'other_collector', 'available') && sameTime(savedOut.items[0].saved_at, at(11))
    && shape(savedOut.items[1], 'item', cItem, 'other_collector', 'unavailable'), savedOut.items);
  check('saved collections: another collector’s and the collector’s own',
    savedOut.collections?.length === 2 && shape(savedOut.collections[0], 'collection', bPub, 'other_collector', 'available')
    && shape(savedOut.collections[1], 'collection', f.binder, 'you', 'available'), savedOut.collections);
  const sg = savedOut.grails_showcases ?? [];
  check('saved Grails showcases: visible collector by public username, no account id',
    sg.length === 2 && sg[0].target_type === 'grails_showcase' && sg[0].target_username === B.username && sg[0].target_owner === 'other_collector'
    && sg[0].target_status === 'available' && !('target_id' in sg[0]) && sameTime(sg[0].saved_at, at(16)), sg);
  check('saved Grails showcase of a hidden collector: "unavailable", no username', sg[1]?.target_status === 'unavailable' && sg[1].target_username === null, sg[1]);
  const gr = ratingsOut.grail_ratings ?? [];
  check('grail ratings: score, target post, rated_at and updated_at',
    gr.length === 2 && shape(gr[0], 'post', bRmg, 'other_collector', 'available') && gr[0].score === 8
    && sameTime(gr[0].rated_at, at(19)) && sameTime(gr[0].updated_at, at(20)), gr);
  check('rating on a hidden collector’s post: kept, "unavailable"', shape(gr[1], 'post', cPost, 'other_collector', 'unavailable') && gr[1].score === 3, gr[1]);
  check('only A’s activity: none of B’s likes, saves or ratings',
    !gr.some((r: any) => r.score === 9) && likesOut.collections.every((e: any) => e.target_id !== f.binder)
    && sg.every((e: any) => e.target_owner !== 'you') && savedOut.items.every((e: any) => e.target_id !== it.trading));
  const everything2 = Object.values(za.text).join('\n');
  check('nothing about the hidden collector C (no id, username, titles or names)',
    !everything2.includes(C.id) && !everything2.includes(C.username) && !everything2.includes('C HIDDEN'));
  check('no content of B’s targets is copied (titles, collection names)', !everything2.includes('B public card') && !everything2.includes('B Public Shelf'));
  const mcounts = JSON.parse(za.text['manifest.json']).counts ?? {};
  check('manifest counts include activity',
    mcounts.liked_posts === 3 && mcounts.liked_items === 3 && mcounts.liked_collections === 1 && mcounts.saved_items === 2
    && mcounts.saved_collections === 2 && mcounts.saved_grails_showcases === 2 && mcounts.grail_ratings === 2, mcounts);
  check('README describes the activity files', za.text['README.txt'].includes('activity/likes.json') && za.text['README.txt'].includes('activity/ratings.json'));

  step('4d. Collector tagging (Export 3)');
  check('self-tagging is refused by the database', !!selfTag.error, selfTag.error?.message);
  check('nobody can tag on another collector’s behalf', !!forged.error, forged.error?.message);
  check('activity/tags.json is in the archive', za.names.includes('activity/tags.json'), za.names);
  const tagsOut = JSON.parse(za.text['activity/tags.json']);
  const tc = tagsOut.tags_created ?? [];
  const tr = tagsOut.tags_received ?? [];
  const tagged = (e: any, type: string, id: string | null) => e?.target_type === type && e.target_id === id && typeof e.tagged_at === 'string';
  check('tags created: exactly the surviving ones, oldest first, all marked "created"', tc.length === 3 && tc.every((e: any) => e.direction === 'created'), tc);
  check('created item tag: visible collector by public username', tagged(tc[0], 'item', it.trading) && tc[0].target_owner === 'you'
    && tc[0].target_status === 'available' && tc[0].tagged_collector_username === B.username && tc[0].tagged_collector_status === 'available', tc[0]);
  check('created collection tag of a hidden collector: no username, "unavailable"', tagged(tc[1], 'collection', f.binder)
    && tc[1].tagged_collector_username === null && tc[1].tagged_collector_status === 'unavailable' && tc[1].target_owner === 'you', tc[1]);
  check('created tag in the collector’s own private collection is kept', tagged(tc[2], 'collection', f.secret) && tc[2].tagged_collector_username === B.username, tc[2]);
  check('tags on a deleted item and with a deleted account are gone (no orphans)',
    ![...tc, ...tr].some((e: any) => e.target_id === aTagDoomed || e.target_id === it.sports) && !za.text['activity/tags.json'].includes(E.username));
  check('tags received: the four A can see, oldest first, all marked "received"', tr.length === 4 && tr.every((e: any) => e.direction === 'received'), tr);
  check('received item and collection tags from a visible collector: public username',
    tagged(tr[0], 'item', bPubItem) && tr[0].tagged_by_username === B.username && tr[0].tagged_by_status === 'available'
    && tr[0].target_owner === 'other_collector' && tr[0].target_status === 'available'
    && tagged(tr[1], 'collection', bPub) && tr[1].tagged_by_username === B.username && tr[1].target_status === 'available', tr.slice(0, 2));
  check('received tags on content A can’t see (private item and collection): no record at all — no target, tagger or time',
    !tr.some((e: any) => e.target_id === null || e.target_id === bItem || e.target_id === bFolder)
    && !za.text['activity/tags.json'].includes('not_visible') && !za.text['activity/tags.json'].includes(bFolder), tr);
  const exA = JSON.parse(za.text['manifest.json']).excluded_records ?? {};
  // 3: B's private item and collection, and the item B made private after tagging A (Export 7 fixture).
  check('…they are only counted, in manifest excluded_records (not in counts)', exA.tags_received_not_visible_omitted?.count === 3
    && !('tags_received_not_visible_omitted' in mcounts) && typeof exA.tags_received_not_visible_omitted?.meaning === 'string', exA);
  check('received tags from a hidden collector: "unavailable", no username',
    tagged(tr[2], 'item', cItem) && tagged(tr[3], 'collection', cFolder)
    && [tr[2], tr[3]].every((e: any) => e.target_status === 'unavailable' && e.tagged_by_username === null && e.tagged_by_status === 'unavailable'), tr.slice(2));
  check('no tag is both created and received', !tc.some((c: any) => tr.some((r: any) => r.target_id && r.target_type === c.target_type && r.target_id === c.target_id)));
  check('unrelated collectors’ tags are excluded',
    tr.filter((e: any) => e.target_id === bPubItem).length === 1 && tr.filter((e: any) => e.target_id === cFolder).length === 1 && tc.every((e: any) => e.tagged_collector_username !== C.username));
  const tagsText = za.text['activity/tags.json'];
  check('tags.json leaks no account ids, private item ids, emails or storage paths',
    ![B.id, C.id, E.id, A.id, bItem, B.email, C.email].some((s) => tagsText.includes(s)) && !tagsText.includes('/storage/') && !tagsText.includes('B PRIVATE'));
  check('manifest counts include tags', mcounts.tags_created === 3 && mcounts.tags_received === 4, mcounts);
  check('README describes tags', za.text['README.txt'].includes('activity/tags.json') && za.text['README.txt'].includes('tags_received_not_visible_omitted'));

  step('4e. Waitlist record and account metadata (Export 4)');
  const codes = ['a', 'reused', 'w', 'gone'].map(code);
  const noSecrets = (text: string) => !codes.some((c) => text.includes(c))
    && !['access_code', 'encrypted_password', 'identities', 'refresh_token', 'access_token', 'recovery_token', 'confirmation_token',
      'raw_app_meta_data', 'app_metadata', 'user_metadata', 'banned_until', 'reauthentication', 'email_change_token'].some((k) => text.includes(k));
  check('account/waitlist.json is in the archive', za.names.includes('account/waitlist.json'), za.names);
  const wlA = JSON.parse(za.text['account/waitlist.json']);
  check('A: exactly the invite A redeemed, linked by account even after an email change', Array.isArray(wlA) && wlA.length === 1
    && wlA[0].name === 'Alex Waitlist' && wlA[0].email === `old-${A.email}`
    && wlA[0].reserved_username === A.username && wlA[0].status === 'onboarded' && sameTime(wlA[0].signed_up_at, at(29))
    && sameTime(wlA[0].access_granted_at, at(30)) && sameTime(wlA[0].onboarded_at, at(31)), wlA);
  check('A: exactly the exported waitlist fields (no row id, code or code expiry)', wlA.length === 1
    && JSON.stringify(Object.keys(wlA[0]).sort()) === JSON.stringify(['access_granted_at', 'email', 'name', 'onboarded_at', 'reserved_username', 'signed_up_at', 'status']), wlA[0]);
  check('A: a signup under A’s CURRENT email, redeemed by another account, is excluded (a reused email grants nothing)', !everything2.includes('REUSED EMAIL PERSON'));
  check('A: no other person’s signup appears', !everything2.includes('UNRELATED STRANGER') && !everything2.includes('DELETED ACCOUNT PERSON') && !everything2.includes('Wren Waitlist'));
  check('A: no invite codes or authentication secrets anywhere in the archive', noSecrets(everything2));
  const accA = JSON.parse(za.text['account/profile.json']).account;
  const authA = (await admin.auth.admin.getUserById(A.id)).data.user!;
  check('A: profile.json "account" keeps its fields and adds only safe sign-in facts',
    JSON.stringify(Object.keys(accA).sort()) === JSON.stringify(['created_at', 'email', 'email_confirmed_at', 'id', 'last_sign_in_at', 'phone',
      'phone_confirmed_at', 'sign_in_methods', 'two_step_verification']) && accA.id === A.id && accA.email === A.email, accA);
  check('A: account dates match Supabase Auth', sameTime(accA.created_at, authA.created_at) && sameTime(accA.email_confirmed_at, authA.email_confirmed_at!)
    && typeof accA.last_sign_in_at === 'string' && Date.parse(accA.last_sign_in_at) <= Date.parse(authA.last_sign_in_at!), { accA, auth: { c: authA.created_at, e: authA.email_confirmed_at, l: authA.last_sign_in_at } });
  check('A: sign-in method and empty states (no phone, no two-step methods)', JSON.stringify(accA.sign_in_methods) === '["email"]'
    && accA.phone === null && accA.phone_confirmed_at === null && Array.isArray(accA.two_step_verification) && accA.two_step_verification.length === 0, accA);
  check('manifest counts the waitlist record', mcounts.waitlist_records === 1, mcounts);
  check('README describes the waitlist file and sign-in facts', za.text['README.txt'].includes('account/waitlist.json') && za.text['README.txt'].includes('sign_in_methods')
    && za.text['README.txt'].includes('An email address alone never links'));

  await signIn(W);
  check('W: export requested', (await fn({ action: 'request' }, W.token)).json?.export?.state === 'preparing');
  const builtW = await runToEnd(W);
  check('W: export completes', builtW.final?.export?.state === 'ready', builtW.final);
  const zw = inspect((await downloadZip(W, 'w')).path);
  const wlW = JSON.parse(zw.text['account/waitlist.json'] ?? 'null');
  check('W: a matching email alone never links a signup (W’s unredeemed signup is not exported)', zw.bad === null && Array.isArray(wlW) && wlW.length === 0, wlW);
  const everythingW = Object.values(zw.text).join('\n');
  check('W: no signup at all and no codes or secrets', noSecrets(everythingW) && !['Wren Waitlist', 'Alex Waitlist', 'REUSED EMAIL PERSON', 'UNRELATED STRANGER', 'DELETED ACCOUNT PERSON'].some((n) => everythingW.includes(n)));
  check('W: the unredeemed signup is not counted as W’s', JSON.parse(zw.text['manifest.json']).counts?.waitlist_records === 0
    && !JSON.stringify(JSON.parse(zw.text['manifest.json']).excluded_records).includes('waitlist'));

  step('4f. Manifest and README transparency (Export 5)');
  const manifest = JSON.parse(za.text['manifest.json']);
  check('manifest keeps every earlier field and adds the transparency sections', manifest.format_version === 3
    && ['export_id', 'generated_at', 'parts', 'counts', 'files', 'how_to_use', 'not_included', 'excluded_records', 'completeness'].every((k) => k in manifest)
    && manifest.export_id === jobA.id, Object.keys(manifest));
  checkManifestFiles('A', manifest, za);
  const arr = (n: string) => JSON.parse(za.text[n]);
  const fol = arr('social/followers.json');
  const fow = arr('social/following.json');
  const expectCounts: Record<string, number> = {
    collections: arr('collections/collections.json').length, items: arr('items/items.json').length, grails: arr('grails/grails.json').length,
    posts: arr('posts/posts.json').length, comments: arr('comments/comments.json').length, sent_messages: arr('messages/sent_messages.json').length,
    followers: fol.collectors.length + fol.unavailable_accounts, following: fow.collectors.length + fow.unavailable_accounts,
    liked_posts: likesOut.posts.length, liked_items: likesOut.items.length, liked_collections: likesOut.collections.length,
    saved_items: savedOut.items.length, saved_collections: savedOut.collections.length, saved_grails_showcases: savedOut.grails_showcases.length,
    grail_ratings: ratingsOut.grail_ratings.length, tags_created: tc.length, tags_received: tr.length, waitlist_records: wlA.length,
    sent_message_photos: arr('messages/sent_messages.json').filter((m: any) => m.attachment?.status === 'included').length,
    conversations: arr('messages/conversations.json').length, notifications: arr('notifications/notifications.json').length,
    notifications_unread: arr('notifications/notifications.json').filter((n: any) => !n.read).length,
    sent_message_photos_unavailable: arr('messages/sent_messages.json').filter((m: any) => m.attachment?.status === 'unavailable').length,
    media_files: za.names.filter((n) => n.startsWith('media/')).length,
  };
  const wrong = Object.entries(expectCounts).filter(([k, v]) => manifest.counts[k] !== v);
  check('every count matches the records actually in the archive', wrong.length === 0, wrong.map(([k, v]) => `${k}: manifest ${manifest.counts[k]} vs archive ${v}`));
  const imgPhotos = arr('items/items.json').reduce((n: number, i: any) => n + (i.photos?.length ?? 0), 0);
  check('item_photos count matches the photos listed in items.json', manifest.counts.item_photos === imgPhotos && imgPhotos === 5, { count: manifest.counts.item_photos, imgPhotos });
  check('excluded registry/transfer counts are exactly the server’s counts for this export (not exported)',
    JSON.stringify(manifest.excluded_records.unreleased_registry_and_transfers?.counts) === JSON.stringify(jobA.excluded_records)
    && manifest.excluded_records.unreleased_registry_and_transfers.counts.registered_cards_created === 1, manifest.excluded_records);
  const expectedNotIncluded = ['other_collectors_messages', 'other_collectors_content',
    'registry_and_transfers', 'unlinked_waitlist_signups', 'derived_and_internal'];
  check('not_included names every excluded category, each with a reason and description',
    JSON.stringify(manifest.not_included.map((n: any) => n.category)) === JSON.stringify(expectedNotIncluded)
    && manifest.not_included.every((n: any) => ['other_collector', 'not_yet_included', 'unreleased', 'not_linked', 'internal'].includes(n.reason) && n.description.length > 20),
    manifest.not_included);
  check('nothing is listed as "not yet included" any more (notifications and conversation details are in the archive)',
    !manifest.not_included.some((n: any) => n.reason === 'not_yet_included') && za.names.includes('notifications/notifications.json') && za.names.includes('messages/conversations.json'));
  check('no archive file claims an excluded category (no registry or transfer files)',
    !za.names.some((n) => /registry|transfer/i.test(n)), za.names.filter((n) => !n.startsWith('media/')));
  const readme = za.text['README.txt'];
  check('README documents every section from Exports 1–4', ['posts/posts.json', 'activity/likes.json', 'activity/saved.json', 'activity/ratings.json',
    'activity/tags.json', 'account/waitlist.json', 'sign_in_methods', 'two-step verification', 'snapshots'].every((t) => readme.includes(t)));
  check('README explains included / not_included / unavailable', /included +the file is in this archive/.test(readme)
    && /not_included +it exists outside this archive/.test(readme) && /unavailable +nothing is there any more/.test(readme));
  check('README explains null dates and hidden/deleted accounts', readme.includes('Missing values are never filled in')
    && readme.includes('HIDDEN AND DELETED ACCOUNTS') && readme.includes('"unavailable_accounts"'));
  check('README says the archive is not a copy of every record, lists every exclusion, and promises nothing more',
    readme.includes('not a copy of every record') && manifest.not_included.every((n: any) => readme.includes(n.description))
    && !/all (of )?your (personal )?(data|information)|complete copy|everything we (hold|have)|GDPR|CCPA|guarantee/i.test(readme));
  check('no other collector’s private storage links or signed tokens anywhere', !everything2.includes(`/sign/item-images/${B.id}`)
    && !/[?&]token=/.test(everything2) && !everything2.includes('SECRET-SIGNED-TOKEN'));

  step('4g. Sent DM photos (Export 6)');
  const dmFile = (id: string) => `media/dm-attachments/${id}.jpg`;
  check('A’s sent photos are in the archive, byte-identical', za.sha[dmFile(dmA1.id)] === sha256(dmA1.bytes) && za.sha[dmFile(dmA2.id)] === sha256(dmA2.bytes));
  check('…including the one sent to a recipient who is now pending deletion (C)', !!za.sha[dmFile(dmA2.id)]);
  const shas = new Set(Object.values(za.sha));
  check('B’s photo sent to A is absent (by name and by content)', !za.names.includes(dmFile(dmB1.id)) && !shas.has(sha256(dmB1.bytes)));
  check('the lost file and the orphaned upload are absent', !za.names.includes(dmFile(dmA3.id)) && za.names.filter((n) => n.startsWith('media/dm-attachments/')).length === 2);
  const sentOut = arr('messages/sent_messages.json');
  const sentById = new Map(sentOut.map((m: any) => [m.id, m]));
  check('each sent photo message references its exact archive file', JSON.stringify((sentById.get(dmA1.id) as any)?.attachment)
    === JSON.stringify({ type: 'image', item_id: null, status: 'included', file: dmFile(dmA1.id) })
    && (sentById.get(dmA2.id) as any)?.attachment?.file === dmFile(dmA2.id), [sentById.get(dmA1.id), sentById.get(dmA2.id)]);
  check('a sent photo whose file no longer exists is "unavailable" with no file', JSON.stringify((sentById.get(dmA3.id) as any)?.attachment)
    === JSON.stringify({ type: 'image', item_id: null, status: 'unavailable', file: null }), sentById.get(dmA3.id));
  check('text messages keep a null attachment; received messages are not listed', sentOut.filter((m: any) => m.attachment === null).length >= 1
    && !sentById.has(dmB1.id) && !everything2.includes('B SECRET reply'));
  check('no storage paths, conversation folders or signed URLs leak', ![conv, convAC].some((c) => za.names.some((n) => n.includes(c)))
    && !everything2.includes(dmA1.path) && !everything2.includes(dmOrphan) && !everything2.includes('dm-attachments/' + conv) && !/\/sign\/dm-attachments/.test(everything2));
  check('every DM photo is listed in the manifest with its size', [dmA1, dmA2].every((d) => manifest.files.some((f: any) => f.name === dmFile(d.id) && f.bytes === d.bytes.length)));
  check('manifest counts the photos', manifest.counts.sent_message_photos === 2 && manifest.counts.sent_message_photos_unavailable === 1, manifest.counts);
  check('README describes sent DM photos; not_included no longer claims they are missing',
    za.text['README.txt'].includes('media/dm-attachments/') && !manifest.not_included.some((n: any) => n.category === 'sent_message_photos'));

  step('4h. Notifications and conversations (Export 7)');
  const notes = arr('notifications/notifications.json');
  const exN = manifest.excluded_records.notifications_omitted ?? {};
  const { data: aRows } = await admin.from('notifications').select('id, type, actor_id, read, item_id').eq('user_id', A.id);
  check('notifications: only A’s own, none of B’s', notes.length > 0 && notes.every((n: any) => (aRows ?? []).some((r) => r.id === n.id))
    && !notes.some((n: any) => bNotificationIds.includes(n.id)), { n: notes.length });
  check('every one of A’s notifications is listed or counted as omitted', notes.length + exN.unreleased_features + exN.other_types + exN.not_visible_content === (aRows ?? []).length,
    { listed: notes.length, exN, total: (aRows ?? []).length });
  const nb = (type: string, actor: string | null) => notes.filter((n: any) => n.type === type && n.actor_username === actor);
  check('only released notification types are exported', notes.every((n: any) => ['follow', 'like', 'comment', 'message', 'grail_rating', 'item_tag', 'folder_tag'].includes(n.type)),
    [...new Set(notes.map((n: any) => n.type))]);
  check('a visible actor appears by public username only', nb('follow', B.username).length === 1 && nb('like', B.username).length >= 1
    && notes.every((n: any) => !('actor_id' in n) && !('user_id' in n)), notes.filter((n: any) => n.actor_username === B.username).map((n: any) => n.type));
  check('a hidden actor (C, pending) is "unavailable" with nothing identifying', nb('follow', null).length === 1
    && notes.filter((n: any) => n.actor_username === null).every((n: any) => n.actor_status === 'unavailable'), notes.filter((n: any) => n.actor_username === null));
  check('read and unread states', nb('follow', B.username)[0]?.read === true && notes.some((n: any) => n.read === false));
  const rating = notes.find((n: any) => n.type === 'grail_rating');
  check('a Grails rating notification carries the post and the score shown in the app', rating?.post_id === p.rmg && rating?.rating_score === 9, rating);
  const msgN = notes.filter((n: any) => n.type === 'message');
  check('message notifications reference the conversation only (no message text)', msgN.length >= 1 && msgN.every((n: any) => n.conversation_id === conv)
    && !za.text['notifications/notifications.json'].includes('B SECRET reply'), msgN);
  check('tag notifications reference the visible item/collection', notes.some((n: any) => n.type === 'item_tag' && n.item_id === bPubItem)
    && notes.some((n: any) => n.type === 'folder_tag' && n.collection_id === bPub));
  check('a deleted post takes its notifications with it', !notes.some((n: any) => n.post_id === postGone) && !za.text['notifications/notifications.json'].includes(postGone));
  check('omitted, only counted: the unreleased-feature notification and the tag on content B made private', exN.unreleased_features === 1 && exN.other_types === 0 && exN.not_visible_content === 1
    && !notes.some((n: any) => /ownership_transfer/.test(n.type) || n.item_id === bLater) && !everything2.includes('B LATER PRIVATE'), exN);
  const convs = arr('messages/conversations.json');
  const cv = (id: string) => convs.find((c: any) => c.conversation_id === id);
  check('conversations: exactly the four A is in (B, C, E-deleted, W-no-messages)', convs.length === 4 && [conv, convAC, convAE, convAW].every((id) => !!cv(id)), convs.map((c: any) => c.conversation_id));
  check('both participants: B by username; A’s own last-read and hidden state; messages A sent', cv(conv)?.other_participants?.[0]?.username === B.username
    && cv(conv).read_only === false && sameTime(cv(conv).your_last_read_at, at(60)) && cv(conv).hidden_by_you === true && sameTime(cv(conv).hidden_at, at(62))
    && cv(conv).messages_you_sent === 3 && typeof cv(conv).last_activity_at === 'string', cv(conv));
  check('B’s own read/hidden state is never included', !za.text['messages/conversations.json'].includes(new Date(at(70)).toISOString().slice(0, 19))
    && !za.text['messages/conversations.json'].includes(new Date(at(71)).toISOString().slice(0, 19)) && Object.keys(cv(conv).other_participants[0]).sort().join() === 'status,username');
  check('a hidden participant (C, pending) is "unavailable", conversation still listed', cv(convAC)?.other_participants?.[0]?.username === null
    && cv(convAC).other_participants[0].status === 'unavailable' && cv(convAC).read_only === false && cv(convAC).messages_you_sent === 1, cv(convAC));
  check('a deleted participant (E): read-only, nobody named', cv(convAE)?.read_only === true && cv(convAE).other_participants.length === 0
    && cv(convAE).messages_you_sent === 1 && !za.text['messages/conversations.json'].includes(E.username), cv(convAE));
  check('a conversation with no messages: listed, nothing sent, never read', cv(convAW)?.messages_you_sent === 0 && cv(convAW).your_last_read_at === null
    && cv(convAW).hidden_by_you === false && cv(convAW).other_participants[0]?.username === W.username, cv(convAW));
  const ncText = za.text['notifications/notifications.json'] + za.text['messages/conversations.json'];
  check('no other collector’s ids, emails or private paths in notifications or conversations', ![B.id, C.id, E.id, W.id, B.email, C.email, E.email].some((x) => ncText.includes(x))
    && !/storage|token=|dm-attachments/.test(ncText));
  check('manifest counts and README', manifest.counts.notifications === notes.length && manifest.counts.conversations === 4
    && manifest.counts.notifications_unread === notes.filter((n: any) => !n.read).length
    && za.text['README.txt'].includes('notifications/notifications.json') && za.text['README.txt'].includes('messages/conversations.json'), manifest.counts);

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
  // …and a sent DM photo disappears mid-export.
  must(await admin.storage.from('dm-attachments').remove([dmA2.path]), 'A2 file lost mid-export');
  const rebuilt = await runToEnd(A);
  job = await jobOf(A);
  check('a broken upload / changed photo triggers a clean rebuild that completes', rebuilt.final?.export?.state === 'ready' && job.attempts >= 2, { state: rebuilt.final?.export?.state, attempts: job.attempts });
  const zr = inspect((await downloadZip(A, 'a-rebuilt')).path);
  check('the rebuilt archive has the NEW photo', zr.bad === null && zr.sha[`media/item-images/${photos[3].path.slice(A.id.length + 1)}`] === sha256(changed));
  const sentR = JSON.parse(zr.text['messages/sent_messages.json']).find((m: any) => m.id === dmA2.id);
  check('a DM photo lost mid-export: the rebuild drops the file and marks the message "unavailable"', !zr.names.includes(`media/dm-attachments/${dmA2.id}.jpg`)
    && sentR?.attachment?.status === 'unavailable' && JSON.parse(zr.text['manifest.json']).counts.sent_message_photos === 1, sentR);
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
  const emptyActivity = {
    'activity/likes.json': { posts: [], items: [], collections: [] },
    'activity/saved.json': { items: [], collections: [], grails_showcases: [] },
    'activity/ratings.json': { grail_ratings: [] },
    'activity/tags.json': { tags_created: [], tags_received: [] },
    'account/waitlist.json': [], // D's email has only a signup consumed by a deleted account
    'messages/conversations.json': [],
    'notifications/notifications.json': [],
  };
  check('no activity and no waitlist signup: every such file is present with empty arrays',
    Object.entries(emptyActivity).every(([n, v]) => zd.text[n] !== undefined && JSON.stringify(JSON.parse(zd.text[n])) === JSON.stringify(v)),
    Object.keys(emptyActivity).map((n) => zd.text[n]));

  const md = JSON.parse(zd.text['manifest.json']);
  checkManifestFiles('D', md, zd);
  check('D: nothing withheld and nothing unreleased, counted as zero (not missing)', md.excluded_records?.tags_received_not_visible_omitted?.count === 0
    && Object.values(md.excluded_records?.unreleased_registry_and_transfers?.counts ?? { x: 1 }).every((v) => v === 0)
    && md.counts.media_files === 1050 && md.counts.tags_created === 0 && md.counts.waitlist_records === 0 && md.counts.sent_message_photos === 0 && md.counts.notifications === 0 && md.counts.conversations === 0
    && md.excluded_records?.notifications_omitted?.unreleased_features === 0 && md.excluded_records?.notifications_omitted?.other_types === 0, { ex: md.excluded_records, counts: md.counts });

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

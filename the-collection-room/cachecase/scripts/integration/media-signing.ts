/// <reference types="node" />
// Media signing and snapshot-copy security (Phase 2B M2.3a,
// 20261118120000_media_signing_moderation.sql) — end-to-end against the LOCAL
// Supabase stack: the signing and snapshot Edge Functions, Storage and
// PostgREST, called the way the app or a hostile client would call them.
//
// Cleanup: moderation rows are append-only for every API role, so this script
// removes ITS OWN fixture reports/restrictions through a local superuser psql
// session (session_replication_role = replica), scoped to this script's marker;
// Storage objects are removed only under the fixture accounts' own prefixes.
//
// Prerequisites: local Supabase with the migration applied, and
// `supabase functions serve` running.
// Run:  node scripts/integration/media-signing.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'media-signing-it';
const MARK = 'ms-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const UUID = /^[0-9a-f-]{36}$/;
const q = (v: string) => { if (!UUID.test(v)) throw new Error(`not a uuid: ${v}`); return `'${v}'`; };

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};

type U = { id: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `ms${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Ms-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, token: s.session!.access_token, db };
}

// Every object under a prefix (Storage list() is one level deep).
async function listDeep(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data } = await service.storage.from(bucket).list(prefix, { limit: 1000 });
  for (const e of data ?? []) {
    const p = `${prefix}/${e.name}`;
    if (e.id === null) out.push(...await listDeep(bucket, p)); else out.push(p);
  }
  return out;
}
const exists = (bucket: string, path: string) =>
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${bucket}' AND name = '${path.replace(/'/g, "''")}'`) === '1';

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        -- M2.3b: this fixture's quarantine jobs (queued by its restrictions).
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  for (const id of ids) {
    for (const b of ['item-images', 'avatars', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
    await service.auth.admin.deleteUser(id);
  }
  return ids.length;
}

type R = { data: any; error: { message?: string } | null; status: number };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const report = async (u: U, type: string, id: string, evidenceOk = true) => {
  must(await u.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: 'hate', p_details: `${MARK} ${run}` }), `report ${type}`);
  const rows = must(await service.from('content_reports').select('id').eq('target_type', type).eq('target_id', id).eq('reporter_id', u.id).eq('status', 'open'), 'report id') as { id: string }[];
  if (!evidenceOk || rows.length !== 1) throw new Error('report lookup');
  return rows[0].id;
};
const fn = async (name: string, token: string | null, body: unknown, rawBody?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: rawBody ?? JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
// The object path a signed URL points at (…/object/sign/<bucket>/<path>?token=…).
const signedPath = (url: string | undefined) => (url ? decodeURIComponent(new URL(url).pathname.split('/object/sign/item-images/')[1] ?? '') : null);
const cover = async (token: string | null, folderId: string) => {
  const r = (await fn('get-folder-cover-signed-url', token, { folder_ids: [folderId] })).body?.results?.[0];
  return r?.status === 'ok' ? signedPath(r.signed_url) : (r?.status ?? 'error');
};
const imageStatus = async (token: string | null, imageId: string) =>
  (await fn('get-collection-item-image-signed-url', token, { image_ids: [imageId] })).body?.results?.[0]?.status as string | undefined;
const copyItem = (u: U | null, itemId: string, type = 'post', target = randomUUID()) =>
  fn('copy-share-snapshot-image', u?.token ?? null, { item_id: itemId, snapshot_type: type, target_id: target });
// Edge Functions build public URLs from their own SUPABASE_URL, which locally is
// the internal gateway host; re-point the origin at the local API (same path).
const publicGet = async (url: string) => (await fetch(url.replace(/^https?:\/\/[^/]+/, st.API_URL))).status;
const ledger = (caller: string, since: string) =>
  psql(`SELECT coalesce(string_agg(status || '|' || coalesce(dest_path, dest_base), ',' ORDER BY created_at), '')
        FROM private.share_snapshot_copies WHERE caller_id = ${q(caller)} AND created_at >= '${since}'`)
    .split(',').filter(Boolean).map((r) => { const [status, path] = r.split('|'); return { status, path }; });
const dbNow = () => psql('SELECT clock_timestamp()');
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);

async function main() {
  const A = await createUser('a');   // owns the folders
  const O = await createUser('o');   // another collector
  const K = await createUser('k');   // blocked by A
  const Z = await createUser('z');   // owns a private item
  const M = await createUser('m');   // admin
  must(await service.from('admin_users').insert({ user_id: M.id }), 'admin');
  must(await service.from('user_blocks').insert({ blocker_id: A.id, blocked_id: K.id }), 'block');
  const up = (await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status;
  if (up >= 500) throw new Error(`Edge Functions not served (status ${up}) — run supabase functions serve`);

  step('0. Fixtures');
  const [F, G, H3, FM, ZF] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  must(await A.db.from('folders').insert([
    { id: F, user_id: A.id, name: `ms public ${run}`, is_public: true, cover_source: 'first_card' },
    { id: G, user_id: A.id, name: `ms grail ${run}`, is_public: false, cover_source: 'first_card' },
    { id: FM, user_id: A.id, name: `ms misc ${run}`, is_public: true, cover_source: 'first_card' },
  ]), 'folders');
  must(await Z.db.from('folders').insert({ id: ZF, user_id: Z.id, name: `ms z ${run}`, is_public: false }), 'z folder');
  const item = async (u: U, folder: string, key: string, ageMin: number, isPublic = true, upload = true) => {
    const id = randomUUID(), img = randomUUID(), path = `${u.id}/ms-it/${key}.jpg`;
    must(await u.db.from('collection_items').insert({ id, folder_id: folder, user_id: u.id, title: `ms ${key} ${run}`, is_public: isPublic,
      collection_status: 'active', item_type: 'sports_card', created_at: new Date(Date.now() - ageMin * 60_000).toISOString() }), `item ${key}`);
    if (upload) must(await u.db.storage.from('item-images').upload(path, jpeg(key), { contentType: 'image/jpeg' }), `upload ${key}`);
    must(await u.db.from('collection_item_images').insert({ id: img, item_id: id, user_id: u.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), `image ${key}`);
    return { id, img, path };
  };
  const I1 = await item(A, F, 'i1', 30), I2 = await item(A, F, 'i2', 20), I3 = await item(A, F, 'i3', 10);
  const IG = await item(A, G, 'ig', 5), I5 = await item(A, FM, 'i5', 5), IM = await item(A, FM, 'missing', 4, true, false);
  const ZI = await item(Z, ZF, 'zi', 5, false);
  must(await A.db.from('folders').insert({ id: H3, user_id: A.id, name: `ms foreign cover ${run}`, is_public: true, cover_source: 'item', cover_item_id: ZI.id }), 'foreign cover folder');
  must(await A.db.from('profile_grail_slots').insert({ user_id: A.id, slot_index: 0, entry_type: 'collection', collection_id: G }), 'grail slot');

  step('1. Input validation and unauthorized calls');
  check('cover: malformed folder ids → 400', (await fn('get-folder-cover-signed-url', null, { folder_ids: ['nope'] })).status === 400);
  check('cover: 51 ids → 400', (await fn('get-folder-cover-signed-url', null, { folder_ids: Array.from({ length: 51 }, () => randomUUID()) })).status === 400);
  check('cover: invalid token → 401', (await fn('get-folder-cover-signed-url', 'not.a.jwt', { folder_ids: [F] })).status === 401);
  check('item image: invalid token → 401', (await fn('get-collection-item-image-signed-url', 'not.a.jwt', { image_ids: [I1.img] })).status === 401);
  check('cover: unknown folder → unavailable', (await cover(null, randomUUID())) === 'unavailable');
  check('copy-share-snapshot-image: signed out → 401', (await copyItem(null, I1.id)).status === 401);
  check('copy-share-snapshot-image: malformed ids → 400', (await fn('copy-share-snapshot-image', O.token, { item_id: 'x', snapshot_type: 'post', target_id: 'y' })).status === 400);
  check('copy-share-snapshot-image: unknown snapshot type → 400', (await copyItem(O, I1.id, 'registry')).status === 400);
  check('copy-post-photo: signed out → 401', (await fn('copy-post-photo-to-share-snapshots', null, { source_url: 'x' })).status === 401);
  check('copy-post-photo: malformed URL → unavailable', (await fn('copy-post-photo-to-share-snapshots', A.token, { source_url: 'https://evil.invalid/x.jpg' })).body?.status === 'unavailable');
  check('create-snapshot-post: signed out → 401', (await fn('create-snapshot-post', null, { post_type: 'card_share', item_ids: [I1.id, I5.id] })).status === 401);

  step('2. Folder covers: baseline, signed-out and owner access');
  check('before: O gets the newest item as cover', (await cover(O.token, F)) === I3.path);
  check('before: signed-out visitors get it too', (await cover(null, F)) === I3.path);
  check('before: Grail-slot private folder signs for O', (await cover(O.token, G)) === IG.path);

  step('3. Moderated cover items and images');
  const rI3 = await report(O, 'collection_item', I3.id), rI2 = await report(O, 'collection_item', I2.id);
  check('admin hides I3', (await rpc(M, 'admin_hide_content', { p_report_id: rI3, p_reason_code: 'pending_review' })).data?.state === 'hidden');
  check('O: newest-item fallback skips the moderated item → I2', (await cover(O.token, F)) === I2.path);
  check('signed out: same fallback → I2', (await cover(null, F)) === I2.path);
  check('owner: still gets their own moderated item as cover', (await cover(A.token, F)) === I3.path);
  check('admin hides only I2\'s image', (await rpc(M, 'admin_hide_content', { p_report_id: rI2, p_reason_code: 'pending_review', p_image_index: 0 })).data?.state === 'hidden');
  check('O: an item whose image is moderated is skipped too → I1', (await cover(O.token, F)) === I1.path);
  check('item signing agrees: O cannot sign I2\'s or I3\'s image, can sign I1\'s',
    (await imageStatus(O.token, I2.img)) === 'unavailable' && (await imageStatus(O.token, I3.img)) === 'unavailable' && (await imageStatus(O.token, I1.img)) === 'ok');
  check('picked cover that is another collector\'s private item: unavailable for O', (await cover(O.token, H3)) === 'unavailable');
  check('…and for the folder owner (previously signed for them)', (await cover(A.token, H3)) === 'unavailable');

  step('4. Moderated folder in a Grail slot');
  const rG = await report(O, 'folder', G);
  check('admin hides the Grail folder', (await rpc(M, 'admin_hide_content', { p_report_id: rG, p_reason_code: 'pending_review' })).data?.state === 'hidden');
  check('O: the Grail exception no longer exposes it', (await cover(O.token, G)) === 'unavailable');
  check('signed out: unavailable', (await cover(null, G)) === 'unavailable');
  check('owner: still signed', (await cover(A.token, G)) === IG.path);

  step('5. Blocked collectors');
  check('K (blocked by A): folder cover unavailable', (await cover(K.token, F)) === 'unavailable');
  check('K: A\'s public item image unavailable', (await imageStatus(K.token, I1.img)) === 'unavailable');
  check('the same image still signs for O and signed-out visitors', (await imageStatus(O.token, I1.img)) === 'ok' && (await imageStatus(null, I1.img)) === 'ok');
  check('the block error is indistinguishable from any other unavailable result',
    JSON.stringify((await fn('get-collection-item-image-signed-url', K.token, { image_ids: [I1.img] })).body)
      === JSON.stringify({ results: [{ id: I1.img, status: 'unavailable' }] }));

  step('6. Snapshot copies');
  let t0 = dbNow();
  check('owner: own moderated item → unavailable', (await copyItem(A, I3.id, 'card_share')).body?.status === 'unavailable');
  check('owner: own item with a moderated image → unavailable', (await copyItem(A, I2.id, 'card_share')).body?.status === 'unavailable');
  check('owner: own item inside a moderated folder → unavailable', (await copyItem(A, IG.id, 'card_share')).body?.status === 'unavailable');
  check('O: reposting the moderated item → unavailable', (await copyItem(O, I3.id)).body?.status === 'unavailable');
  check('K (blocked): reposting a clean public item → unavailable', (await copyItem(K, I1.id)).body?.status === 'unavailable');
  check('refusals created no objects and no ledger rows',
    (await listDeep('share-snapshots', A.id)).length === 0 && (await listDeep('share-snapshots', O.id)).length === 0
      && (await listDeep('share-snapshots', K.id)).length === 0 && ledger(A.id, t0).length + ledger(O.id, t0).length + ledger(K.id, t0).length === 0);
  const ok = await copyItem(O, I1.id);
  check('O: reposting a clean public item still works', ok.body?.status === 'ok' && typeof ok.body?.public_url === 'string', ok.body);
  check('its public URL resolves for anyone', ok.body?.public_url && (await publicGet(ok.body.public_url)) === 200);
  const okRow = ledger(O.id, t0);
  check('the ledger recorded exactly that published object', okRow.length === 1 && okRow[0].status === 'published' && okRow[0].path === ok.body?.storage_path, okRow);

  step('7. Staging uploads (copy-post-photo-to-share-snapshots)');
  // The function only accepts URLs under its OWN project URL (locally the
  // internal gateway host), exactly as getPublicUrl() produces them in the app;
  // take that origin from a URL the functions just returned.
  const fnOrigin = new URL(ok.body.public_url).origin;
  const url = (p: string) => `${fnOrigin}/storage/v1/object/public/item-images/${p}`;
  const stagingCopy = (src: string) => fn('copy-post-photo-to-share-snapshots', A.token, { source_url: url(src) });
  // 'unauthorized' = refused by the database check (not a URL-shape failure).
  const refusedByLedger = (r: { body: any }) => r.body?.status === 'unavailable' && r.body?.reason === 'unauthorized';
  const r1 = await stagingCopy(I1.path);
  check('an existing item image path is refused by the reference check…', refusedByLedger(r1), r1.body);
  check('…and the image is NOT deleted', exists('item-images', I1.path));
  const r2 = await stagingCopy(I2.path);
  check('a moderated image path is refused and kept', refusedByLedger(r2) && exists('item-images', I2.path), r2.body);
  const ostage = `${O.id}/${Date.now()}.jpg`;
  must(await O.db.storage.from('item-images').upload(ostage, jpeg('ostage'), { contentType: 'image/jpeg' }), 'o staging');
  const r3 = await stagingCopy(ostage);
  check('another collector\'s staging upload is refused and kept', r3.body?.status === 'unavailable' && exists('item-images', ostage), r3.body);
  const stage = `${A.id}/${Date.now()}.jpg`;
  must(await A.db.storage.from('item-images').upload(stage, jpeg('stage'), { contentType: 'image/jpeg' }), 'staging');
  const sp = await stagingCopy(stage);
  check('a genuine staging upload is copied', sp.body?.status === 'ok', sp.body);
  check('…its public URL resolves', sp.body?.public_url && (await publicGet(sp.body.public_url)) === 200);
  check('…and the staging object is deleted', !exists('item-images', stage));

  step('8. Snapshot posts: failures leave nothing public behind');
  t0 = dbNow();
  const before = new Set(await listDeep('share-snapshots', A.id));
  const fail1 = await fn('create-snapshot-post', A.token, { post_type: 'card_share', item_ids: [I5.id, IM.id] });
  check('card share where one copy fails after another succeeded → failed', fail1.body?.status === 'failed', fail1.body);
  const rows1 = ledger(A.id, t0);
  check('the copy that DID succeed was removed (ledger: published → removed)',
    rows1.length === 2 && rows1.every((r) => r.status === 'removed'), rows1);
  check('no new public object remains', (await listDeep('share-snapshots', A.id)).every((p) => before.has(p)));
  t0 = dbNow();
  const fail2 = await fn('create-snapshot-post', A.token, { post_type: 'card_share', item_ids: [I5.id, I3.id] });
  check('card share including a moderated item → failed', fail2.body?.status === 'failed', fail2.body);
  check('…its clean copy was removed, the refused one never existed',
    ledger(A.id, t0).every((r) => r.status === 'removed') && (await listDeep('share-snapshots', A.id)).every((p) => before.has(p)), ledger(A.id, t0));
  check('a refused operation did not touch O\'s earlier repost', exists('share-snapshots', ok.body.storage_path));
  const good = await fn('create-snapshot-post', A.token, { post_type: 'card_share', item_ids: [I5.id, I1.id] });
  check('a clean card share still works', good.body?.status === 'ok', good.body);
  const fs = await fn('create-snapshot-post', O.token, { post_type: 'folder_share', folder_id: F, caption: null });
  check('O: folder share of a folder with moderated items works', fs.body?.status === 'ok', fs.body);
  const fsItems = fs.body?.post_id ? (must(await service.from('folder_share_items').select('item_id').eq('post_id', fs.body.post_id), 'fs items') as { item_id: string }[]) : [];
  check('…and includes only the eligible item', fsItems.length === 1 && fsItems[0].item_id === I1.id, fsItems);
  check('K (blocked): folder share of A\'s folder → failed', (await fn('create-snapshot-post', K.token, { post_type: 'folder_share', folder_id: F, caption: null })).body?.status === 'failed');
  check('folder share of the moderated Grail folder → failed', (await fn('create-snapshot-post', O.token, { post_type: 'folder_share', folder_id: G, caption: null })).body?.status === 'failed');
  for (const [u, id] of [[A, good.body?.post_id], [O, fs.body?.post_id]] as const) {
    if (id) check('the post\'s owner can still delete it', (await fn('delete-post', u.token, { post_id: id })).body?.status === 'ok');
  }

  step('9. Concurrent copy and moderation');
  const I6 = await item(A, FM, 'i6', 3);
  const rI6 = await report(O, 'collection_item', I6.id);
  t0 = dbNow();
  const [copies] = await Promise.all([
    Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((r) => setTimeout(r, i * 40)).then(() => copyItem(O, I6.id)))),
    new Promise((r) => setTimeout(r, 120)).then(() => rpc(M, 'admin_hide_content', { p_report_id: rI6, p_reason_code: 'pending_review' })),
  ]);
  const rows = ledger(O.id, t0);
  const okCount = copies.filter((c) => c.body?.status === 'ok').length;
  console.log(`  INFO  ${okCount}/8 copies published before the restriction, ${8 - okCount} refused`);
  check('every response is ok or unavailable', copies.every((c) => ['ok', 'unavailable'].includes(c.body?.status)));
  check('published copies == ok responses; every other row was rejected/refused and removed',
    rows.filter((r) => r.status === 'published').length === okCount && rows.every((r) => r.status === 'published' || r.status === 'removed'), rows);
  check('an object exists exactly for each published copy',
    rows.every((r) => exists('share-snapshots', r.path) === (r.status === 'published')));
  check('every destination is distinct', new Set(rows.map((r) => r.path)).size === rows.length);
  check('after the restriction, copying is refused', (await copyItem(O, I6.id)).body?.status === 'unavailable');

  step('10. Public buckets');
  const av = `${A.id}/ms-${Date.now()}.jpg`;
  must(await A.db.storage.from('avatars').upload(av, jpeg('avatar'), { contentType: 'image/jpeg' }), 'avatar upload');
  const anonList = await anon.storage.from('avatars').list(A.id);
  check('signed out: listing avatars returns nothing', !anonList.error && (anonList.data ?? []).length === 0, anonList);
  check('signed out: listing share-snapshots returns nothing', ((await anon.storage.from('share-snapshots').list(O.id)).data ?? []).length === 0);
  check('another collector: cannot list A\'s avatars', ((await O.db.storage.from('avatars').list(A.id)).data ?? []).length === 0);
  check('the avatar\'s public URL still resolves for anyone', (await publicGet(anon.storage.from('avatars').getPublicUrl(av).data.publicUrl)) === 200);
  check('an unmoderated snapshot\'s public URL still resolves', (await publicGet(ok.body.public_url)) === 200);
  check('the owner can still list their own avatars', ((await A.db.storage.from('avatars').list(A.id)).data ?? []).some((f) => av.endsWith(f.name)));
  const rm = await A.db.storage.from('avatars').remove([av]);
  check('the owner can still remove their own avatar', !rm.error && (rm.data ?? []).length === 1 && !exists('avatars', av), rm);
  check('a stranger cannot remove someone else\'s snapshot', ((await K.db.storage.from('share-snapshots').remove([ok.body.storage_path])).data ?? []).length === 0
    && exists('share-snapshots', ok.body.storage_path));
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
  console.log(`Fixture rows left: ${psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%') || ' reports, '
    || (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'fixture' = '${FIXTURE}') || ' users, '
    || (SELECT count(*) FROM private.share_snapshot_copies) || ' ledger rows'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

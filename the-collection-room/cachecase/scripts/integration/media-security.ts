/// <reference types="node" />
// Media security integration and release-readiness (Phase 2B M2.3d) —
// M2.3a signing/snapshots + M2.3b queue/holds + M2.3c workers +
// 20261121120000_media_security_hardening.sql, end-to-end against the LOCAL
// Supabase stack with disposable collectors, objects and reports.
//
// Covers: the backfill bypass, snapshot reconciliation, folder-cover
// ownership, the full report → restriction → queue → worker → removal →
// audit → restoration path for every media kind, concurrency with account
// deletion / cleanup / export, privilege separation, and worker performance
// at representative sizes (PERF=0 skips the large files).
//
// Prerequisites: local Supabase with migrations applied, and
//   supabase functions serve --env-file <file with CACHECASE_TEST_MQ_FAULTS=1
//                                         and a local-only BACKFILL_ADMIN_SECRET>
//   BACKFILL_SECRET_FILE=<file holding that secret> FUNCTIONS_LOG=<serve log>
//   node scripts/integration/media-security.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'media-security-it';
const MARK = 'msec-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const backfillSecret = readFileSync(process.env.BACKFILL_SECRET_FILE ?? '', 'utf8').trim();
const functionsLog = process.env.FUNCTIONS_LOG ?? '';
const PERF = process.env.PERF !== '0';
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const info = (s: string) => console.log(`  INFO  ${s}`);
const step = (s: string) => console.log(`\n${s}`);
const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};

type U = { id: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `msec${run}${key}`;
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
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';
const jobFor = (bucket: string, path: string) =>
  psql(`SELECT id FROM private.media_quarantine WHERE source_bucket = ${lit(bucket)} AND source_path = ${lit(path)} ORDER BY created_at DESC LIMIT 1`);
const jobState = (id: string) => psql(`SELECT state || '|' || desired || '|' || needs_attention FROM private.media_quarantine WHERE id = ${lit(id)}`);
const qpath = (id: string) => psql(`SELECT quarantine_path FROM private.media_quarantine WHERE id = ${lit(id)}`);
const deletedPrefixes: string[] = [];
const conversations = new Set<string>();

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const owners = [...ids, ...deletedPrefixes];
  const qPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine
                        WHERE owner_id::text IN (${owners.length ? owners.map(lit).join(',') : "''"})`).split(',').filter(Boolean);
  if (qPaths.length) removeQuarantineFixtures(qPaths);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_profile_fields WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  if (ids.length) {
    for (const p of (await service.from('conversation_participants').select('conversation_id').in('user_id', ids)).data ?? []) conversations.add(p.conversation_id);
  }
  for (const id of [...ids, ...deletedPrefixes.splice(0)]) {
    for (const b of ['item-images', 'avatars', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
  }
  for (const c of conversations) {
    const files = await listDeep('dm-attachments', c);
    if (files.length) await service.storage.from('dm-attachments').remove(files);
    await service.from('conversations').delete().eq('id', c);
  }
  conversations.clear();
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string } | null };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const fn = async (name: string, token: string | null, body: unknown, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY, ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = performance.now();
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, ms: Math.round(performance.now() - t0), body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const sized = (bytes: number, tag: string) => Buffer.concat([jpeg(tag), randomBytes(Math.max(0, bytes - jpeg(tag).length))]);
const publicStatus = async (bucket: string, path: string) => {
  const r = await fetch(`${st.API_URL}/storage/v1/object/public/${bucket}/${path}`, { headers: { 'cache-control': 'no-cache' } });
  await r.body?.cancel();
  return r.status;
};
const downloadSha = async (bucket: string, path: string) => {
  const d = await service.storage.from(bucket).download(path);
  return d.data ? sha(new Uint8Array(await d.data.arrayBuffer())) : null;
};

async function main() {
  const A = await createUser('a');   // reported collector
  const B = await createUser('b');   // reposts A's items
  const R1 = await createUser('r');  // DM partner
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  const pool = await Promise.all(Array.from({ length: 8 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const report = async (type: string, id: string, reason = 'hate', by?: U) => {
    must(await (by ?? pool[turn++ % pool.length]).db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), `report ${type}`);
    return psql(`SELECT id FROM public.content_reports WHERE target_id = ${lit(id)} AND status = 'open' AND details LIKE '${MARK}%' ORDER BY created_at DESC LIMIT 1`);
  };
  const runQ = async (who: U = M1) => fn('admin-media-quarantine', who.token, { limit: 10 });
  const drain = async () => { for (let k = 0; k < 6; k++) if (!((await runQ()).body?.results ?? []).length) break; };
  const restoreQ = async (ids: string[], who: U = M2, confirm?: boolean) =>
    fn('admin-media-restore', who.token, confirm === undefined ? { job_ids: ids } : { job_ids: ids, confirm_child_safety: confirm });
  const outcome = (r: { body: any }, id: string) => (r.body?.results ?? []).find((x: any) => x.id === id);
  const up = (await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status;
  if (up >= 500) throw new Error('Edge Functions not served');

  const F = randomUUID();
  must(await A.db.from('folders').insert({ id: F, user_id: A.id, name: `msec ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const newItem = async (key: string, bytes: Buffer = jpeg(key), isPublic = true) => {
    const id = randomUUID(), img = randomUUID(), path = `${A.id}/msec/${key}.jpg`;
    must(await A.db.from('collection_items').insert({ id, folder_id: F, user_id: A.id, title: `msec ${key}`, is_public: isPublic, collection_status: 'active', item_type: 'sports_card' }), 'item');
    must(await service.storage.from('item-images').upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
    must(await A.db.from('collection_item_images').insert({ id: img, item_id: id, user_id: A.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), 'image');
    return { id, img, path, bytes };
  };
  // A public snapshot of the given size, owned by `u`, on a post of theirs.
  const snapPost = async (u: U, key: string, bytes: Buffer) => {
    const path = `${u.id}/msec-snap/${key}.jpg`;
    must(await service.storage.from('share-snapshots').upload(path, bytes, { contentType: 'image/jpeg' }), 'snapshot upload');
    const url = anon.storage.from('share-snapshots').getPublicUrl(path).data.publicUrl;
    const id = randomUUID();
    must(await u.db.from('posts').insert({ id, user_id: u.id, post_type: 'text', content: `msec ${key}`, image_url: url }), 'post');
    return { id, path, url, bytes };
  };
  // The functions' own origin (the local gateway), for URLs a function parses.
  const probe = await newItem('probe');
  const rep = await fn('copy-share-snapshot-image', B.token, { item_id: probe.id, snapshot_type: 'post', target_id: randomUUID() });
  if (rep.body?.status !== 'ok') throw new Error(`probe copy: ${rep.text}`);
  const fnOrigin = new URL(rep.body.public_url).origin;

  // ── P1. Backfill ────────────────────────────────────────────────────────
  step('P1. backfill-share-snapshots cannot republish or recreate restricted media');
  const legacyUrl = (p: string) => `${fnOrigin}/storage/v1/object/public/item-images/${p}`;
  const leg1 = `${A.id}/legacy-1.jpg`, leg2 = `${A.id}/legacy-2.jpg`, leg3 = `${A.id}/legacy-3.jpg`;
  for (const p of [leg1, leg2, leg3]) must(await service.storage.from('item-images').upload(p, jpeg(p), { contentType: 'image/jpeg' }), 'legacy');
  const [Pb1, Pb2, Pb3] = [randomUUID(), randomUUID(), randomUUID()];
  must(await A.db.from('posts').insert([
    { id: Pb1, user_id: A.id, post_type: 'text', content: 'legacy ok', image_url: legacyUrl(leg1) },
    { id: Pb2, user_id: A.id, post_type: 'text', content: 'legacy moderated', image_url: legacyUrl(leg2) },
    { id: Pb3, user_id: A.id, post_type: 'text', content: 'legacy, destination held', image_url: legacyUrl(leg3) },
  ]), 'legacy posts');
  check('admin hides the moderated legacy post', (await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', Pb2), p_reason_code: 'pending_review' })).data?.state === 'hidden');
  // Pb3's deterministic destination was published once and is now quarantined.
  const dest3 = `${A.id}/historical-post/${Pb3}.jpg`;
  must(await service.storage.from('share-snapshots').upload(dest3, jpeg('old copy'), { contentType: 'image/jpeg' }), 'old dest');
  const Px = randomUUID();
  must(await A.db.from('posts').insert({ id: Px, user_id: A.id, post_type: 'text', content: 'links the old copy', image_url: anon.storage.from('share-snapshots').getPublicUrl(dest3).data.publicUrl }), 'px');
  must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', Px), p_reason_code: 'pending_review' }) as any, 'hide px');
  await drain();
  check('fixture: the old destination is quarantined', jobState(jobFor('share-snapshots', dest3)).startsWith('quarantined') && !exists('share-snapshots', dest3));
  check('backfill: a wrong operator secret → 403', (await fn('backfill-share-snapshots', null, {}, { 'x-backfill-secret': 'nope' })).status === 403);
  const bf = await fn('backfill-share-snapshots', null, {}, { 'x-backfill-secret': backfillSecret });
  const skipped = (bf.body?.skipped_rows ?? []) as { id: string; reason: string }[];
  check('backfill: the unaffected legacy row is still migrated', bf.body?.posts?.migrated === 1, bf.body);
  const pb1 = must(await service.from('posts').select('image_url').eq('id', Pb1).single(), 'pb1') as { image_url: string };
  check('…to its share-snapshots copy, with identical bytes',
    pb1.image_url.includes('/share-snapshots/') && (await downloadSha('share-snapshots', `${A.id}/historical-post/${Pb1}.jpg`)) === sha(jpeg(leg1)));
  check('backfill: the moderated post is skipped as restricted', skipped.some((s) => s.id === Pb2 && s.reason === 'restricted'), skipped);
  check('…and never republished', !exists('share-snapshots', `${A.id}/historical-post/${Pb2}.jpg`));
  check('backfill: the quarantined destination is skipped as held', skipped.some((s) => s.id === Pb3 && s.reason === 'destination_held'), skipped);
  check('…and the quarantined file is NOT recreated', !exists('share-snapshots', dest3) && (await publicStatus('share-snapshots', dest3)) !== 200);
  check('even a direct service-role upload to the quarantined path is refused',
    !!(await service.storage.from('share-snapshots').upload(dest3, jpeg('again'), { contentType: 'image/jpeg', upsert: true })).error && !exists('share-snapshots', dest3));

  // ── P2. Reconciliation ──────────────────────────────────────────────────
  step('P2. Snapshot reconciliation');
  const copyOf = async (u: U, itemId: string) => {
    const c = await fn('copy-share-snapshot-image', u.token, { item_id: itemId, snapshot_type: 'post', target_id: randomUUID() });
    if (c.body?.status !== 'ok') throw new Error(`copy: ${c.text}`);
    return { path: c.body.storage_path as string, url: c.body.public_url as string };
  };
  const itemR = await newItem('recon');
  const orphan = await copyOf(B, itemR.id);                       // the client never created its post
  const kept = await copyOf(B, itemR.id);                         // referenced by a post
  must(await B.db.from('posts').insert({ user_id: B.id, post_type: 'item', item_id: itemR.id, image_url: anon.storage.from('share-snapshots').getPublicUrl(kept.path).data.publicUrl }), 'kept post');
  const racy = await copyOf(B, itemR.id);                         // a post races the reconciler
  const itemH = await newItem('held');
  const heldCopy = await copyOf(B, itemH.id);
  must(await rpc(M1, 'admin_remove_content', { p_report_id: await report('collection_item', itemH.id), p_reason_code: 'hate', p_include_related: false }) as any, 'hold copy');
  const fresh = await copyOf(B, itemR.id);                        // inside the grace period
  psql(`UPDATE private.share_snapshot_copies SET created_at = now() - interval '9 days', updated_at = now() - interval '9 days'
         WHERE dest_path IN (${[orphan.path, kept.path, racy.path, heldCopy.path].map(lit).join(',')})`);
  check('reconcile: an ordinary collector → 403', (await fn('admin-snapshot-reconcile', B.token, {})).status === 403);
  check('reconcile: a grace period under 24 hours → 400', (await fn('admin-snapshot-reconcile', M1.token, { grace_hours: 1 })).status === 400);
  const dry = await fn('admin-snapshot-reconcile', M1.token, {});
  check('a dry run (the default) reports the two unreferenced copies and removes nothing',
    dry.body?.dry_run === true && dry.body?.candidates?.unreferenced === 2 && exists('share-snapshots', orphan.path) && exists('share-snapshots', racy.path), dry.body);
  check('…without exposing any path', !dry.text.includes(B.id));
  const [recon, racePost] = await Promise.all([
    fn('admin-snapshot-reconcile', M1.token, { dry_run: false }),
    B.db.from('posts').insert({ user_id: B.id, post_type: 'item', item_id: itemR.id, image_url: anon.storage.from('share-snapshots').getPublicUrl(racy.path).data.publicUrl }),
  ]);
  check('the abandoned copy is removed', !exists('share-snapshots', orphan.path)
    && psql(`SELECT status FROM private.share_snapshot_copies WHERE dest_path = ${lit(orphan.path)}`) === 'removed', recon.body);
  const racyKept = exists('share-snapshots', racy.path);
  info(`race: post insert ${racePost.error ? 'refused' : 'committed'}, copy ${racyKept ? 'kept' : 'removed'}`);
  check('race with a new post: never a post linking a removed file', racePost.error ? true : racyKept);
  check('referenced, held and fresh copies are untouched',
    exists('share-snapshots', kept.path) && exists('share-snapshots', heldCopy.path) && exists('share-snapshots', fresh.path));
  const again = await fn('admin-snapshot-reconcile', M1.token, { dry_run: false });
  check('a repeated run finds nothing more to do', (again.body?.results ?? []).filter((x: any) => x.outcome === 'removed').length === 0, again.body);

  // ── P3. Folder covers ───────────────────────────────────────────────────
  step('P3. Folder cover ownership');
  const bItem = randomUUID(), bFolder = randomUUID();
  must(await B.db.from('folders').insert({ id: bFolder, user_id: B.id, name: `msec b ${run}`, is_public: false }), 'b folder');
  must(await B.db.from('collection_items').insert({ id: bItem, folder_id: bFolder, user_id: B.id, title: 'b private', is_public: false, collection_status: 'active', item_type: 'sports_card' }), 'b item');
  const foreign = await A.db.from('folders').update({ cover_source: 'item', cover_item_id: bItem }).eq('id', F);
  check('direct API: another collector\'s private item as cover → refused', !!foreign.error && (foreign.error.message ?? '').includes('invalid_cover_item'));
  check('direct API: one\'s own item → fine', !(await A.db.from('folders').update({ cover_source: 'item', cover_item_id: itemR.id }).eq('id', F)).error);
  const [c1, c2] = await Promise.all([
    A.db.from('folders').update({ cover_item_id: bItem }).eq('id', F),
    A.db.from('folders').update({ cover_item_id: probe.id }).eq('id', F),
  ]);
  const finalCover = psql(`SELECT cover_item_id FROM public.folders WHERE id = ${lit(F)}`);
  check('concurrent cover changes: the foreign one fails, the cover is always A\'s own', !!c1.error && !c2.error && finalCover === probe.id, finalCover);

  // ── P4. Full media path ─────────────────────────────────────────────────
  step('P4. Report → restriction → queue → worker → removal → audit → restoration');
  const imgs = { avatar_url: `${A.id}/av-${run}.jpg`, hero_image_url: `${A.id}/hero/h-${run}.jpg`, showcase_badge_url: `${A.id}/badge/b-${run}.jpg` };
  const bytesOf: Record<string, Buffer> = {};
  for (const [f, p] of Object.entries(imgs)) {
    bytesOf[f] = jpeg(`${f}-${run}`);
    must(await A.db.storage.from('avatars').upload(p, bytesOf[f], { contentType: 'image/jpeg' }), `upload ${f}`);
  }
  must(await A.db.from('profiles').update(Object.fromEntries(Object.entries(imgs).map(([f, p]) => [f, anon.storage.from('avatars').getPublicUrl(p).data.publicUrl]))).eq('id', A.id), 'profile images');
  must(await A.db.from('profiles').update({ bio: `msec bio ${run}` }).eq('id', A.id), 'bio');
  const rProf = await report('profile', A.id);
  const clear = await rpc(M1, 'admin_clear_profile_fields', { p_report_id: rProf, p_fields: ['avatar_url', 'hero_image_url', 'showcase_badge_url', 'bio'], p_reason_code: 'hate' });
  check('admin clears avatar, hero, badge and bio', !clear.error, clear.error);
  const profJobs = Object.fromEntries(Object.entries(imgs).map(([f, p]) => [f, jobFor('avatars', p)]));
  check('one queued job per image field', Object.values(profJobs).every((id) => !!id && jobState(id).startsWith('pending')));
  const sp = await snapPost(A, `card-${run}`, jpeg(`card-${run}`));
  must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', sp.id), p_reason_code: 'pending_review' }) as any, 'hide snap post');
  const spJob = jobFor('share-snapshots', sp.path);
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: R1.id }), 'conv') as string;
  conversations.add(conv);
  const msg = randomUUID(), dmPath = `${conv}/${msg}/image.jpg`, dmBytes = jpeg(`dm-${run}`);
  must(await A.db.storage.from('dm-attachments').upload(dmPath, dmBytes, { contentType: 'image/jpeg' }), 'dm');
  must(await A.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: A.id, body: null, attachment_type: 'image', attachment_storage_path: dmPath, attachment_width: 1, attachment_height: 1 }), 'msg');
  must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('message', msg, 'child_safety', R1), p_reason_code: 'urgent_risk' }) as any, 'hide dm');
  const dmJob = jobFor('dm-attachments', dmPath);
  const csItem = await newItem('cs');
  must(await rpc(M2, 'admin_remove_content', { p_report_id: await report('collection_item', csItem.id, 'child_safety'), p_reason_code: 'child_safety', p_include_related: false }) as any, 'cs item');
  const csJob = jobFor('item-images', csItem.path);
  const allPublic = [...Object.entries(imgs).map(([, p]) => ['avatars', p]), ['share-snapshots', sp.path]] as [string, string][];
  check('before the worker: every public original still resolves', (await Promise.all(allPublic.map(([b, p]) => publicStatus(b, p)))).every((s) => s === 200));
  await drain();
  const states = [...Object.values(profJobs), spJob, dmJob, csJob].map((id) => jobState(id).split('|')[0]);
  check('the worker quarantines avatar, hero, badge, snapshot, DM photo and private item image', states.every((s) => s === 'quarantined'), states);
  const statuses = await Promise.all(allPublic.map(([b, p]) => publicStatus(b, p)));
  check('every affected public URL stops resolving at the local Storage origin', statuses.every((s) => s !== 200), statuses);
  check('the private DM and item originals are gone from their buckets', !exists('dm-attachments', dmPath) && !exists('item-images', csItem.path));
  check('every private copy matches its original byte for byte',
    (await downloadSha('moderation-quarantine', qpath(profJobs.avatar_url))) === sha(bytesOf.avatar_url)
      && (await downloadSha('moderation-quarantine', qpath(dmJob))) === sha(dmBytes)
      && (await downloadSha('moderation-quarantine', qpath(csJob))) === sha(csItem.bytes));
  const qp = qpath(profJobs.avatar_url);
  const tries = await Promise.all([
    A.db.storage.from('moderation-quarantine').download(qp), anon.storage.from('moderation-quarantine').download(qp),
    A.db.storage.from('moderation-quarantine').createSignedUrl(qp, 60), A.db.storage.from('moderation-quarantine').list('q'),
  ]);
  check('collectors cannot download, sign or list quarantine objects (signed in or out)',
    !!tries[0].error && !!tries[1].error && !!tries[2].error && ((tries[3].data ?? []).length === 0));
  check('nor reach them by direct public path', (await publicStatus('moderation-quarantine', qp)) !== 200);
  const audit = psql(`SELECT count(*) FROM public.moderation_actions WHERE report_id = ${lit(rProf)}`);
  const evs = psql(`SELECT count(*) FILTER (WHERE actor_id IS NULL) || '/' || count(*) FROM private.media_quarantine_events WHERE quarantine_id = ${lit(profJobs.avatar_url)}`);
  check('audit: the decision is in moderation_actions and every quarantine event names an admin', Number(audit) >= 1 && evs.startsWith('0/'), { audit, evs });
  check('a repeated worker run does nothing more', ((await runQ()).body?.results ?? []).length === 0);

  // Restoration and release, and the restrictions that remain.
  check('admin restores the avatar and hero fields', !(await rpc(M2, 'admin_restore_profile_fields', { p_user_id: A.id, p_fields: ['avatar_url', 'hero_image_url'], p_reason_code: 'resolved_in_error' })).error);
  check('admin releases the badge', !(await rpc(M2, 'admin_release_profile_fields', { p_user_id: A.id, p_fields: ['showcase_badge_url'], p_reason_code: 'owner_may_edit' })).error);
  const rs = await restoreQ([profJobs.avatar_url, profJobs.hero_image_url, profJobs.showcase_badge_url]);
  check('the restore worker restores avatar and hero', outcome(rs, profJobs.avatar_url)?.outcome === 'restored' && outcome(rs, profJobs.hero_image_url)?.outcome === 'restored', rs.body);
  check('…and refuses the released badge (the removal stands)', outcome(rs, profJobs.showcase_badge_url)?.reason === 'not_released');
  check('restored originals resolve again with their exact bytes',
    (await publicStatus('avatars', imgs.avatar_url)) === 200 && (await downloadSha('avatars', imgs.hero_image_url)) === sha(bytesOf.hero_image_url));
  const mine = await rpc(A, 'my_profile_moderation');
  check('M2.2 still restricts the bio after the media restore', (mine.data?.locked_fields ?? []).some((f: any) => f.field === 'bio'), mine.data);
  check('the released badge stays out, and cannot be re-linked',
    (await publicStatus('avatars', imgs.showcase_badge_url)) !== 200
      && !!(await A.db.from('profiles').update({ showcase_badge_url: anon.storage.from('avatars').getPublicUrl(imgs.showcase_badge_url).data.publicUrl }).eq('id', A.id)).error);
  check('M2.1 still hides the snapshot post', ((await R1.db.from('posts').select('id').eq('id', sp.id)).data ?? []).length === 0);

  // ── Concurrency with deletion, cleanup and export ─────────────────────
  step('P4b. Concurrent account deletion, cleanup, export and moderation');
  const C = await createUser('c');
  const cSnap = await snapPost(C, `del-${run}`, jpeg(`del-${run}`));
  must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', cSnap.id), p_reason_code: 'pending_review' }) as any, 'hide c');
  const cJob = jobFor('share-snapshots', cSnap.path);
  deletedPrefixes.push(C.id);
  const [w, d] = await Promise.all([runQ(), service.auth.admin.deleteUser(C.id)]);
  check('account deletion racing the worker: no error, evidence kept',
    !d.error && w.status === 200 && (jobState(cJob).startsWith('quarantined') ? exists('moderation-quarantine', qpath(cJob)) : exists('share-snapshots', cSnap.path)), jobState(cJob));
  await drain();
  check('…and the job finishes after the account is gone', jobState(cJob).startsWith('quarantined') && exists('moderation-quarantine', qpath(cJob)));
  const dp = await snapPost(A, `dp-${run}`, jpeg(`dp-${run}`));
  const [hideR, delR] = await Promise.all([
    report('post', dp.id).then((r) => rpc(M1, 'admin_hide_content', { p_report_id: r, p_reason_code: 'pending_review' })),
    fn('delete-post', A.token, { post_id: dp.id }),
  ]);
  const dpJob = jobFor('share-snapshots', dp.path);
  info(`race: hide ${hideR.error ? 'failed' : 'ok'}, delete ${delR.body?.status}`);
  check('moderation racing the owner\'s post deletion: a held file is never lost',
    dpJob ? exists('share-snapshots', dp.path) : true);
  const exportBefore = psql(`SELECT count(*) FROM public.export_owned_storage_objects(${lit(A.id)}) WHERE name = ${lit(imgs.showcase_badge_url)}`);
  check('Download My Data excludes the quarantined badge', exportBefore === '0');

  // ── Privilege separation ──────────────────────────────────────────────
  step('P4c. Privilege separation');
  check('the service role cannot use admin moderation functions', !!(await service.rpc('admin_media_quarantine_overview')).error
    && !!(await service.rpc('admin_hide_content', { p_report_id: randomUUID(), p_reason_code: 'pending_review' })).error);
  check('collectors cannot use worker or admin functions', (await fn('admin-media-quarantine', A.token, {})).status === 403
    && (await fn('admin-media-restore', A.token, { job_ids: [dmJob] })).status === 403 && (await fn('admin-snapshot-reconcile', A.token, {})).status === 403);
  const lift = await rpc(M2, 'admin_restore_content', { p_moderation_id: psql(`SELECT moderation_id FROM private.media_quarantine_holds WHERE quarantine_id = ${lit(dmJob)} LIMIT 1`),
    p_reason_code: 'child_safety_review_cleared', p_note: 'second review', p_disposition: 'overturn', p_confirm_child_safety: true });
  check('child safety: the restriction is cleared by a second admin', !lift.error, lift.error);
  check('child safety: the admin who imposed it cannot restore the file', outcome(await restoreQ([dmJob], M1, true), dmJob)?.reason === 'second_admin_required');
  check('child safety: the second admin can, with confirmation', outcome(await restoreQ([dmJob], M2, true), dmJob)?.outcome === 'restored');

  // ── P5. Performance ───────────────────────────────────────────────────
  step('P5. Worker performance at representative sizes');
  const sizes: [string, number, 'snap' | 'item'][] = [['avatar 200 KB', 200 * 1024, 'snap'], ['snapshot 5 MB', 5 * 1048576, 'snap'],
    ['snapshot 10 MB', 10 * 1048576, 'snap'], ...(PERF ? [['item image 25 MB', 25 * 1048576, 'item']] as [string, number, 'snap' | 'item'][] : [])];
  for (const [label, bytes, kind] of sizes) {
    const data = sized(bytes, `${label}-${run}`);
    let id: string, bucket: string, path: string;
    if (kind === 'snap') {
      const p = await snapPost(A, `perf-${bytes}-${run}`, data);
      must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', p.id), p_reason_code: 'pending_review' }) as any, 'hide perf');
      [id, bucket, path] = [jobFor('share-snapshots', p.path), 'share-snapshots', p.path];
    } else {
      const it = await newItem(`perf-${bytes}`, data);
      must(await rpc(M2, 'admin_remove_content', { p_report_id: await report('collection_item', it.id, 'child_safety'), p_reason_code: 'child_safety', p_include_related: false }) as any, 'perf cs');
      [id, bucket, path] = [jobFor('item-images', it.path), 'item-images', it.path];
    }
    const r = await runQ();
    const o = outcome(r, id)?.outcome;
    const line = functionsLog ? readFileSync(functionsLog, 'utf8').split('\n').reverse().find((l) => l.includes(id) && l.includes('size_bytes')) : undefined;
    const m = line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
    info(`${label}: outcome=${o} request=${r.ms} ms job=${m?.ms ?? '?'} ms`);
    check(`${label}: quarantined intact`, o === 'quarantined' && !exists(bucket, path)
      && (await downloadSha('moderation-quarantine', qpath(id))) === sha(data), { o, state: jobState(id) });
  }
  if (PERF) {
    // The supported maximum. Before M2.3e this exceeded the worker's 256 MB
    // memory; it must complete, and in any case never lose the file or stall
    // the queue.
    const big = sized(50 * 1048576 - 4096, `big-${run}`);
    const it = await newItem('perf-50mb', big);
    must(await rpc(M2, 'admin_remove_content', { p_report_id: await report('collection_item', it.id, 'child_safety'), p_reason_code: 'child_safety', p_include_related: false }) as any, 'big cs');
    const bigJob = jobFor('item-images', it.path);
    const small = await snapPost(A, `behind-${run}`, jpeg(`behind-${run}`));
    must(await rpc(M1, 'admin_hide_content', { p_report_id: await report('post', small.id), p_reason_code: 'pending_review' }) as any, 'hide small');
    const smallJob = jobFor('share-snapshots', small.path);
    const seen: string[] = [];
    for (let k = 0; k < 8 && !jobState(smallJob).startsWith('quarantined'); k++) {
      const r = await runQ();
      seen.push(`${r.status}:${outcome(r, bigJob)?.outcome ?? (r.body ? 'none' : 'killed')}`);
      psql(`UPDATE private.media_quarantine SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lit(bigJob)} AND lease_token IS NOT NULL`);
    }
    const killed = seen.filter((x) => x.startsWith('546')).length;
    const final = jobState(bigJob);
    info(`item image 50 MB: runs ${seen.join(', ')}; worker killed ${killed}x by the 256 MB limit; final ${final}`);
    // M2.3e (streaming worker): a 50 MB file is now quarantined in a single
    // run without the runtime killing the worker.
    check('item image 50 MB: quarantined in one run, the worker never killed', killed === 0 && seen[0] === '200:quarantined', seen);
    const quarantinedIntact = final.startsWith('quarantined') && !exists('item-images', it.path)
      && (await downloadSha('moderation-quarantine', qpath(bigJob))) === sha(big);
    const flaggedIntact = final.endsWith('|true') && exists('item-images', it.path);
    check('…and still never loses the file: quarantined with a verified copy, or flagged with the source intact', quarantinedIntact || flaggedIntact, final);
    check('…and the job queued behind it is still processed', jobState(smallJob).startsWith('quarantined'));
    if (flaggedIntact) {
      const ov = await rpc(M1, 'admin_media_quarantine_overview');
      check('…and a flagged job is visible in the admin overview', (ov.data?.needs_attention ?? []).some((j: any) => j.id === bigJob));
    }
  }
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
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, ' || (SELECT count(*) FROM private.media_quarantine_events) || ' events, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') || ' quarantine objects, '
    || (SELECT count(*) FROM private.share_snapshot_copies) || ' ledger rows'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

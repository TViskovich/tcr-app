/// <reference types="node" />
// Media quarantine foundation (Phase 2B M2.3b,
// 20261119120000_media_quarantine_foundation.sql) — end-to-end against the
// LOCAL Supabase stack with real uploads, snapshot copies and admin decisions:
// what gets queued, what collectors can still do to held files, and that
// queueing itself never moves, copies or deletes a file. No job is executed.
//
// Cleanup: restrictions, quarantine jobs and audit rows are append-only for
// every API role, so this script removes ITS OWN fixture rows through a local
// superuser psql session (session_replication_role = replica), scoped to its
// marker; Storage objects only under the fixture accounts' own prefixes.
//
// Prerequisites: local Supabase with the migration applied, and
// `supabase functions serve` running.
// Run:  node scripts/integration/media-quarantine.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'media-quarantine-it';
const MARK = 'mq-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

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
  const username = `mq${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Mq-${randomBytes(9).toString('base64url')}`;
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
const job = (bucket: string, path: string) => {
  const r = psql(`SELECT state || '|' || desired || '|' || owner_id || '|' || child_safety || '|' ||
      (SELECT count(*) FROM private.media_quarantine_holds h WHERE h.quarantine_id = q.id AND h.ended_at IS NULL)
    FROM private.media_quarantine q WHERE source_bucket = ${lit(bucket)} AND source_path = ${lit(path)} ORDER BY created_at DESC LIMIT 1`);
  if (!r) return null;
  const [state, desired, owner, cs, holds] = r.split('|');
  return { state, desired, owner, childSafety: cs === 'true', holds: Number(holds) };
};
const pathOf = (url: string, bucket: string) => decodeURIComponent(url.split(`/object/public/${bucket}/`)[1] ?? '');

// Fixture accounts deleted mid-run (their held files outlive them by design).
const deletedPrefixes: string[] = [];
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
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
  const conversations = ids.length
    ? ((await service.from('conversation_participants').select('conversation_id').in('user_id', ids)).data ?? []).map((p) => p.conversation_id as string)
    : [];
  for (const id of [...ids, ...deletedPrefixes.splice(0)]) {
    for (const b of ['item-images', 'avatars', 'share-snapshots']) {
      const files = await listDeep(b, id);
      if (files.length) await service.storage.from(b).remove(files);
    }
  }
  for (const c of new Set(conversations)) {
    const files = await listDeep('dm-attachments', c);
    if (files.length) await service.storage.from('dm-attachments').remove(files);
    await service.from('conversations').delete().eq('id', c);
  }
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string; code?: string } | null; status: number };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const report = async (u: U, type: string, id: string, reason = 'hate') => {
  must(await u.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), `report ${type}`);
  const rows = must(await service.from('content_reports').select('id').eq('target_type', type).eq('target_id', id).eq('reporter_id', u.id).eq('status', 'open'), 'report id') as { id: string }[];
  return rows[0].id;
};
const fn = async (name: string, token: string | null, body: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);

async function main() {
  const A = await createUser('a');   // the reported collector
  const B = await createUser('b');   // reposts A's items
  const C = await createUser('c');   // unrelated; A's rows point at C's file
  const R = await createUser('r');   // reporter / DM partner
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  const up = (await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status;
  if (up >= 500) throw new Error(`Edge Functions not served (status ${up}) — run supabase functions serve`);

  step('0. Fixtures (real uploads and snapshot copies)');
  const avatarPath = `${A.id}/${Date.now()}.jpg`;
  must(await A.db.storage.from('avatars').upload(avatarPath, jpeg('av'), { contentType: 'image/jpeg' }), 'avatar');
  const cAvatar = `${C.id}/${Date.now()}.jpg`;
  must(await C.db.storage.from('avatars').upload(cAvatar, jpeg('cav'), { contentType: 'image/jpeg' }), 'c avatar');
  const avatarUrl = anon.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl;
  const cAvatarUrl = anon.storage.from('avatars').getPublicUrl(cAvatar).data.publicUrl;
  must(await A.db.from('profiles').update({ avatar_url: avatarUrl, hero_image_url: cAvatarUrl }).eq('id', A.id), 'profile');
  const F = randomUUID();
  must(await A.db.from('folders').insert({ id: F, user_id: A.id, name: `mq ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const item = async (key: string) => {
    const id = randomUUID(), img = randomUUID(), path = `${A.id}/mq-it/${key}.jpg`;
    must(await A.db.from('collection_items').insert({ id, folder_id: F, user_id: A.id, title: `mq ${key} ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), `item ${key}`);
    must(await A.db.storage.from('item-images').upload(path, jpeg(key), { contentType: 'image/jpeg' }), `upload ${key}`);
    must(await A.db.from('collection_item_images').insert({ id: img, item_id: id, user_id: A.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), `image ${key}`);
    return { id, img, path };
  };
  const I1 = await item('i1'), I2 = await item('i2'), I3 = await item('i3');
  const share = await fn('create-snapshot-post', A.token, { post_type: 'card_share', item_ids: [I1.id, I2.id], caption: null });
  if (share.body?.status !== 'ok') throw new Error(`card share: ${JSON.stringify(share.body)}`);
  const P = share.body.post_id as string;
  const pRows = must(await service.from('card_share_items').select('item_id, snapshot_image_url').eq('post_id', P), 'p rows') as { item_id: string; snapshot_image_url: string }[];
  const pSnap = (itemId: string) => pathOf(pRows.find((r) => r.item_id === itemId)!.snapshot_image_url, 'share-snapshots');
  const repost = await fn('copy-share-snapshot-image', B.token, { item_id: I1.id, snapshot_type: 'post', target_id: randomUUID() });
  if (repost.body?.status !== 'ok') throw new Error(`repost: ${JSON.stringify(repost.body)}`);
  const bCopy = repost.body.storage_path as string;
  // C reposts A's third item (C's own snapshot), and A writes a post whose image
  // URL points at C's snapshot — an arbitrary URL A controls, naming C's file.
  const cRepost = await fn('copy-share-snapshot-image', C.token, { item_id: I3.id, snapshot_type: 'post', target_id: randomUUID() });
  if (cRepost.body?.status !== 'ok') throw new Error(`c repost: ${JSON.stringify(cRepost.body)}`);
  const cSnap = cRepost.body.storage_path as string;
  const cSnapUrl = anon.storage.from('share-snapshots').getPublicUrl(cSnap).data.publicUrl;
  const Pc = randomUUID();
  must(await A.db.from('posts').insert({ id: Pc, user_id: A.id, post_type: 'text', content: `mq c ${run}`, image_url: cSnapUrl }), 'post with C url');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: R.id }), 'conversation') as string;
  const msg = randomUUID(), dmPath = `${conv}/${msg}/image.jpg`;
  must(await A.db.storage.from('dm-attachments').upload(dmPath, jpeg('dm'), { contentType: 'image/jpeg' }), 'dm upload');
  must(await A.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: A.id, body: null, attachment_type: 'image', attachment_storage_path: dmPath, attachment_width: 1, attachment_height: 1 }), 'dm');
  const quarantineObjects = () => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine'`);
  const qBefore = quarantineObjects();
  const allFixturePaths = [['avatars', avatarPath], ['avatars', cAvatar], ['share-snapshots', pSnap(I1.id)], ['share-snapshots', pSnap(I2.id)],
    ['share-snapshots', bCopy], ['item-images', I1.path], ['item-images', I2.path], ['dm-attachments', dmPath]] as const;

  step('1. The quarantine bucket and job records are closed to collectors');
  check('signed out: listing the bucket returns nothing', ((await anon.storage.from('moderation-quarantine').list('')).data ?? []).length === 0);
  check('a collector cannot upload into it', !!(await A.db.storage.from('moderation-quarantine').upload(`q/${run}/x`, jpeg('x'), { contentType: 'image/jpeg' })).error);
  check('a collector cannot download from it', !!(await A.db.storage.from('moderation-quarantine').download('q/none/original')).error);
  check('job tables are not reachable through the API', !!(await A.db.from('media_quarantine').select('*')).error);
  for (const [name, args] of [['media_quarantine_claim', { p_limit: 1, p_lease_seconds: 60 }],
                              ['media_quarantine_advance', { p_id: randomUUID(), p_lease: randomUUID(), p_to_state: 'copied' }],
                              ['storage_paths_held', { p_bucket: 'avatars', p_paths: [avatarPath] }]] as const) {
    check(`collector: ${name} → refused`, !!(await rpc(A, name, args)).error);
  }
  check('non-admin: admin_media_quarantine_status → refused', !!(await rpc(A, 'admin_media_quarantine_status', { p_moderation_id: randomUUID() })).error);

  step('2. Queueing derives files from trusted records');
  const rP = await report(R, 'post', P), rI1 = await report(R, 'collection_item', I1.id), rI1b = await report(C, 'collection_item', I1.id);
  const rPc = await report(R, 'post', Pc), rProf = await report(R, 'profile', A.id);
  // Concurrent decisions on overlapping content: the post and the item both hold A's I1 snapshot.
  const [hP, hI] = await Promise.all([
    rpc(M1, 'admin_hide_content', { p_report_id: rP, p_reason_code: 'pending_review' }),
    rpc(M2, 'admin_remove_content', { p_report_id: rI1, p_reason_code: 'hate', p_include_related: false }),
  ]);
  check('concurrent post hide and item removal both succeed', hP.data?.state === 'hidden' && hI.data?.state === 'removed', [hP.error, hI.error]);
  const shared = job('share-snapshots', pSnap(I1.id));
  check('the shared snapshot has ONE job with TWO holds', !!shared && shared.holds === 2 && shared.state === 'pending', shared);
  check('the post\'s other snapshot is held once', job('share-snapshots', pSnap(I2.id))?.holds === 1);
  check('B\'s ledgered repost of the item is queued, owned by B', job('share-snapshots', bCopy)?.owner === B.id);
  check('private item images are not queued without child safety', job('item-images', I1.path) === null);
  const again = await Promise.all([
    rpc(M1, 'admin_remove_content', { p_report_id: rI1b, p_reason_code: 'hate', p_include_related: false }),
    rpc(M2, 'admin_hide_content', { p_report_id: rI1b, p_reason_code: 'pending_review' }),
  ]);
  check('a racing second decision on the same item creates no duplicate job or hold',
    job('share-snapshots', pSnap(I1.id))?.holds === 2 && job('share-snapshots', bCopy)?.holds === 1, again.map((r) => r.error?.message));
  check('admin: hides the post with C\'s URL', (await rpc(M1, 'admin_hide_content', { p_report_id: rPc, p_reason_code: 'pending_review' })).data?.state === 'hidden');
  check('C\'s snapshot, linked from A\'s post, is NOT queued', job('share-snapshots', cSnap) === null);
  const st1 = await rpc(M1, 'admin_media_quarantine_status', { p_moderation_id: psql(`SELECT moderation_id FROM public.content_reports WHERE id = ${lit(rPc)}`) });
  check('…and the admin sees why it was skipped', (st1.data?.skipped ?? []).some((s: any) => s.reason === 'not_owned'), st1.data);
  check('admin: clears A\'s avatar and hero', !(await rpc(M1, 'admin_clear_profile_fields', { p_report_id: rProf, p_fields: ['avatar_url', 'hero_image_url'], p_reason_code: 'hate' })).error);
  check('A\'s avatar is queued; C\'s file used as A\'s hero is not', job('avatars', avatarPath)?.state === 'pending' && job('avatars', cAvatar) === null);

  step('3. Child safety');
  const rDm = await report(R, 'message', msg, 'child_safety');
  check('admin: hides a DM photo reported for child safety', (await rpc(M2, 'admin_hide_content', { p_report_id: rDm, p_reason_code: 'urgent_risk' })).data?.state === 'hidden');
  check('the DM photo is queued with child safety', job('dm-attachments', dmPath)?.childSafety === true);
  check('the recipient can no longer sign it', !!(await R.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);
  check('…nor can the sender', !!(await A.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);
  const rI2cs = await report(B, 'collection_item', I2.id, 'child_safety');
  check('admin: removes I2 for child safety', (await rpc(M2, 'admin_remove_content', { p_report_id: rI2cs, p_reason_code: 'child_safety', p_include_related: false })).data?.state === 'removed');
  check('I2\'s private image is queued with child safety', job('item-images', I2.path)?.childSafety === true);
  check('the owner can no longer get a signed URL for it',
    (await fn('get-collection-item-image-signed-url', A.token, { image_ids: [I2.img] })).body?.results?.[0]?.status === 'unavailable');

  step('4. Collectors cannot destroy, replace or republish held files');
  const rm = await A.db.storage.from('avatars').remove([avatarPath]);
  check('the owner\'s remove() leaves a held avatar in place', !rm.error && (rm.data ?? []).length === 0 && exists('avatars', avatarPath), rm);
  check('upsert over a held avatar → refused', !!(await A.db.storage.from('avatars').upload(avatarPath, jpeg('evil'), { contentType: 'image/jpeg', upsert: true })).error);
  check('moving a held item image → refused', !!(await A.db.storage.from('item-images').move(I1.path, `${A.id}/mq-it/moved.jpg`)).error && exists('item-images', I1.path));
  check('copying a child-safety-held item image to a new path → refused',
    !!(await A.db.storage.from('item-images').copy(I2.path, `${A.id}/mq-it/copy.jpg`)).error);
  const fresh = `${A.id}/${Date.now()}-fresh.jpg`;
  check('an ordinary new upload works', !(await A.db.storage.from('avatars').upload(fresh, jpeg('fresh'), { contentType: 'image/jpeg' })).error);
  check('…and its ordinary removal works', ((await A.db.storage.from('avatars').remove([fresh])).data ?? []).length === 1 && !exists('avatars', fresh));
  check('no other collector may link a held avatar', !!(await C.db.from('profiles').update({ avatar_url: avatarUrl }).eq('id', C.id)).error);
  const snapUrl = pRows.find((r) => r.item_id === I1.id)!.snapshot_image_url;
  check('cleanup-share-snapshots will not delete a held snapshot',
    (await fn('cleanup-share-snapshots', A.token, { urls: [snapUrl] })).body?.deleted === 0 && exists('share-snapshots', pSnap(I1.id)));
  const del = await fn('delete-post', A.token, { post_id: P });
  check('the owner may still delete the moderated post', del.body?.status === 'ok', del.body);
  check('…but its held snapshots stay in place as evidence', exists('share-snapshots', pSnap(I1.id)) && exists('share-snapshots', pSnap(I2.id)));

  step('5. Staging uploads');
  const stage = `${A.id}/${Date.now()}-stage.jpg`;
  must(await A.db.storage.from('item-images').upload(stage, jpeg('stage'), { contentType: 'image/jpeg' }), 'stage');
  const fnOrigin = new URL(repost.body.public_url).origin;
  const sp = await fn('copy-post-photo-to-share-snapshots', A.token, { source_url: `${fnOrigin}/storage/v1/object/public/item-images/${stage}` });
  check('a staging copy still works', sp.body?.status === 'ok', sp.body);
  check('…its source is deleted and the reservation released',
    !exists('item-images', stage) && psql(`SELECT source_state FROM private.share_snapshot_copies WHERE source_path = ${lit(stage)}`) === 'removed');

  step('6. Restoration bookkeeping moves no file');
  check('admin: restores A\'s avatar (its file was never moved)',
    !(await rpc(M2, 'admin_restore_profile_fields', { p_user_id: A.id, p_fields: ['avatar_url'], p_reason_code: 'resolved_in_error' })).error);
  check('the pending job is cancelled — nothing to move', job('avatars', avatarPath)?.state === 'cancelled');
  check('and the avatar never left its path', exists('avatars', avatarPath));

  step('7. Account deletion keeps evidence');
  const jobsBefore = psql(`SELECT count(*) FROM private.media_quarantine WHERE owner_id = ${lit(B.id)}`);
  deletedPrefixes.push(B.id);
  must(await service.auth.admin.deleteUser(B.id) as { data: unknown; error: unknown }, 'delete B');
  check('deleting the reposting collector keeps the job on their copy',
    psql(`SELECT count(*) FROM private.media_quarantine WHERE owner_id = ${lit(B.id)}`) === jobsBefore && job('share-snapshots', bCopy)?.holds === 1);

  step('8. Queueing never moved, copied or deleted a file');
  check('the quarantine bucket gained nothing', quarantineObjects() === qBefore);
  check('every held fixture object is still at its original path',
    allFixturePaths.filter(([b, p]) => !(b === 'avatars' && p === avatarPath)).every(([b, p]) => exists(b, p)));
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
    || (SELECT count(*) FROM private.media_quarantine) || ' jobs, ' || (SELECT count(*) FROM private.media_quarantine_holds) || ' holds, '
    || (SELECT count(*) FROM private.media_quarantine_events) || ' events, ' || (SELECT count(*) FROM private.share_snapshot_copies) || ' ledger rows'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

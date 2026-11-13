/// <reference types="node" />
// Account suspension (Phase 2B M3, 20261122120000_account_suspension.sql) —
// end-to-end against the LOCAL Supabase stack: an existing session, direct
// PostgREST and Storage calls, the beta Edge Functions, concurrent admins,
// automatic expiry, media quarantine, and Delete Account / Download My Data
// for a suspended collector. Disposable accounts and objects only.
//
// Cleanup: suspensions, restrictions, reports, jobs and audit rows are
// append-only for every API role, so this script removes ITS OWN fixture rows
// through a local superuser psql session (session_replication_role = replica),
// scoped to its accounts and marker.
//
// Prerequisites: local Supabase with migrations applied, and
// `supabase functions serve` with the account functions' env (short recent
// sign-in window, maintenance secret).
// Run:  node scripts/integration/account-suspension.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { removeQuarantineFixtures } from './quarantine-fixture-cleanup.ts';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'account-suspension-it';
const MARK = 'su-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type U = { id: string; email: string; password: string; token: string; db: SupabaseClient };
async function signIn(email: string, password: string) {
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { db, token: s.session!.access_token };
}
async function createUser(key: string): Promise<U> {
  const username = `su${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Su-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  return { id: data.user.id, email, password, ...(await signIn(email, password)) };
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
const conversations = new Set<string>();
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const idList = ids.length ? ids.map(lit).join(',') : "''";
  const qPaths = psql(`SELECT coalesce(string_agg(quarantine_path, ','), '') FROM private.media_quarantine WHERE owner_id::text IN (${idList})`).split(',').filter(Boolean);
  if (qPaths.length) removeQuarantineFixtures(qPaths);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx) OR target_id::text IN (${idList});
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.account_suspensions WHERE user_id::text IN (${idList}) OR report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  if (ids.length) {
    for (const p of (await service.from('conversation_participants').select('conversation_id').in('user_id', ids)).data ?? []) conversations.add(p.conversation_id);
  }
  for (const id of ids) {
    for (const b of ['item-images', 'avatars', 'share-snapshots', 'account-exports']) {
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

type R = { data: any; error: { message?: string; code?: string } | null };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const fn = async (name: string, token: string | null, body: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const imageStatus = async (token: string | null, id: string) => (await fn('get-collection-item-image-signed-url', token, { image_ids: [id] }));
const coverStatus = async (token: string | null, id: string) => (await fn('get-folder-cover-signed-url', token, { folder_ids: [id] })).body?.results?.[0]?.status as string | undefined;
const errMsg = (r: { error: { message?: string } | null }) => r.error?.message ?? '';

async function main() {
  const S = await createUser('s');   // suspended
  const O = await createUser('o');   // another collector
  const T = await createUser('t');   // temporary suspension
  const C = await createUser('c');   // concurrency target
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  if ((await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status >= 500) throw new Error('Edge Functions not served');

  step('0. Fixtures (S: folder, item with image, post, avatar; a DM with a photo to O)');
  const F = randomUUID(), I = randomUUID(), IMG = randomUUID(), P = randomUUID();
  const imgPath = `${S.id}/su/${run}.jpg`, avPath = `${S.id}/av-${run}.jpg`;
  must(await S.db.from('folders').insert({ id: F, user_id: S.id, name: `su ${run}`, is_public: true }), 'folder');
  must(await S.db.from('collection_items').insert({ id: I, folder_id: F, user_id: S.id, title: `su ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
  must(await S.db.storage.from('item-images').upload(imgPath, jpeg('img'), { contentType: 'image/jpeg' }), 'img');
  must(await S.db.from('collection_item_images').insert({ id: IMG, item_id: I, user_id: S.id, image_url: 'https://x.invalid', storage_path: imgPath, sort_order: 0, is_primary: true }), 'image row');
  must(await S.db.from('posts').insert({ id: P, user_id: S.id, post_type: 'text', content: `su post ${run}` }), 'post');
  must(await S.db.storage.from('avatars').upload(avPath, jpeg('av'), { contentType: 'image/jpeg' }), 'avatar');
  const conv = must(await S.db.rpc('get_or_create_conversation', { other_user_id: O.id }), 'conv') as string;
  conversations.add(conv);
  const msg = randomUUID(), dmPath = `${conv}/${msg}/image.jpg`;
  must(await S.db.storage.from('dm-attachments').upload(dmPath, jpeg('dm'), { contentType: 'image/jpeg' }), 'dm photo');
  must(await S.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: S.id, body: null, attachment_type: 'image', attachment_storage_path: dmPath, attachment_width: 1, attachment_height: 1 }), 'dm');
  check('before: O sees S\'s post and can sign S\'s image and cover',
    ((await O.db.from('posts').select('id').eq('id', P)).data ?? []).length === 1
      && (await imageStatus(O.token, IMG)).body?.results?.[0]?.status === 'ok' && (await coverStatus(O.token, F)) === 'ok');

  step('1. Admin authorization');
  check('a collector cannot suspend', errMsg(await rpc(O, 'admin_suspend_account', { p_user_id: S.id, p_reason_code: 'spam' })).includes('forbidden'));
  check('the service role cannot use admin functions', !!(await service.rpc('admin_suspend_account', { p_user_id: S.id, p_reason_code: 'spam' })).error);
  check('an admin cannot suspend themselves', errMsg(await rpc(M1, 'admin_suspend_account', { p_user_id: M1.id, p_reason_code: 'spam' })).includes('cannot_suspend_self'));
  check('…or another admin', errMsg(await rpc(M1, 'admin_suspend_account', { p_user_id: M2.id, p_reason_code: 'spam' })).includes('cannot_suspend_admin'));

  step('2. Indefinite suspension — S keeps the session token issued before it');
  const sus = await rpc(M1, 'admin_suspend_account', { p_user_id: S.id, p_reason_code: 'harassment', p_note: `${MARK} internal note` });
  check('M1 suspends S indefinitely', sus.data?.state === 'active' && sus.data?.expires_at === null, sus.error);
  const mine = await rpc(S, 'my_account_suspension');
  check('S\'s own status: a category and dates only', mine.data?.suspended === true && mine.data?.category === 'community_guidelines'
    && mine.data?.indefinite === true && !('note' in mine.data) && !('reason_code' in mine.data) && !JSON.stringify(mine.data).includes(M1.id), mine.data);
  check('existing session: S reads nothing (not even their own posts)', ((await S.db.from('posts').select('id').eq('user_id', S.id)).data ?? []).length === 0);
  check('existing session: posting → account_suspended', errMsg(await S.db.from('posts').insert({ user_id: S.id, post_type: 'text', content: 'x' }) as R) === 'account_suspended');
  check('…editing the profile → account_suspended', errMsg(await S.db.from('profiles').update({ bio: 'x' }).eq('id', S.id) as R) === 'account_suspended');
  check('…messaging → account_suspended', errMsg(await S.db.from('messages').insert({ conversation_id: conv, sender_id: S.id, body: 'x' }) as R) === 'account_suspended');
  check('…following → refused', !!(await S.db.from('follows').insert({ follower_id: S.id, following_id: O.id })).error);
  check('Storage: S cannot upload', !!(await S.db.storage.from('avatars').upload(`${S.id}/new-${run}.jpg`, jpeg('n'), { contentType: 'image/jpeg' })).error);
  check('Storage: S cannot sign their DM photo', !!(await S.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);
  check('Storage: S cannot remove their files', ((await S.db.storage.from('avatars').remove([avPath])).data ?? []).length === 0
    && psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars' AND name = ${lit(avPath)}`) === '1');
  const sign = await imageStatus(S.token, IMG);
  check('Edge: the image signer refuses the suspended caller', sign.status === 401, sign.status);
  check('Edge: snapshot copies refuse the suspended caller', (await fn('copy-share-snapshot-image', S.token, { item_id: I, snapshot_type: 'post', target_id: randomUUID() })).status === 401);
  check('Edge: post deletion refuses the suspended caller', (await fn('delete-post', S.token, { post_id: P })).status === 401
    && psql(`SELECT count(*) FROM public.posts WHERE id = ${lit(P)}`) === '1');
  const adm = (await fn('admin-media-quarantine', S.token, {})).status;
  check('Edge: admin functions refuse the suspended collector (rejected at caller verification)', adm === 401 || adm === 403, adm);

  step('3. Everyone else');
  check('O cannot see S\'s profile, posts or items', ((await O.db.from('profiles').select('id').eq('id', S.id)).data ?? []).length === 0
    && ((await O.db.from('posts').select('id').eq('user_id', S.id)).data ?? []).length === 0
    && ((await O.db.from('collection_items').select('id').eq('user_id', S.id)).data ?? []).length === 0);
  check('…or their conversation', ((await O.db.from('messages').select('id').eq('conversation_id', conv)).data ?? []).length === 0);
  check('signing S\'s image for O or signed-out visitors → unavailable',
    (await imageStatus(O.token, IMG)).body?.results?.[0]?.status === 'unavailable' && (await imageStatus(null, IMG)).body?.results?.[0]?.status === 'unavailable');
  check('S\'s folder cover → unavailable', (await coverStatus(O.token, F)) === 'unavailable' && (await coverStatus(null, F)) === 'unavailable');
  check('O cannot follow S', !!(await O.db.from('follows').insert({ follower_id: O.id, following_id: S.id })).error);
  check('O cannot open a conversation with S', !!(await rpc(O, 'get_or_create_conversation', { other_user_id: S.id })).error);
  check('S\'s DM photo cannot be signed by O', !!(await O.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);
  check('nothing about deletion was started', psql(`SELECT count(*) FROM public.account_lifecycle WHERE user_id = ${lit(S.id)}`) === '0'
    && psql(`SELECT count(*) FROM public.account_deletion_jobs WHERE user_id = ${lit(S.id)}`) === '0');

  step('4. Download My Data and Delete Account still work');
  const fresh = await signIn(S.email, S.password); // a recent sign-in, as the app requires
  const req = await fn('account-export', fresh.token, { action: 'request' });
  check('S can request an export', req.status === 200 && !!req.body?.export, req.body);
  let state = '';
  for (let k = 0; k < 200 && !['ready', 'failed', 'expired'].includes(state); k++) {
    state = (await fn('account-export', fresh.token, { action: 'advance' })).body?.export?.state ?? '';
    await sleep(150);
  }
  const dl = await fn('account-export', fresh.token, { action: 'download' });
  check('…which completes and can be downloaded', state === 'ready' && (dl.body?.parts ?? []).length >= 1, { state, dl: dl.body?.reason });
  const sched = await fn('account-deletion', fresh.token, { action: 'schedule', confirmation: 'DELETE' });
  check('S can schedule deletion, with the normal grace period', sched.status === 200 && !!sched.body?.scheduled_for
    && psql(`SELECT state FROM public.account_lifecycle WHERE user_id = ${lit(S.id)}`) === 'pending_deletion', sched.body);
  const cancel = await fn('account-deletion', fresh.token, { action: 'cancel' });
  check('…and cancel it: the suspension is untouched', cancel.status === 200 && (await rpc(S, 'my_account_suspension')).data?.suspended === true
    && psql(`SELECT count(*) FROM public.account_lifecycle WHERE user_id = ${lit(S.id)}`) === '0', cancel.body);

  step('5. Concurrent admins');
  const [c1, c2] = await Promise.all([
    rpc(M1, 'admin_suspend_account', { p_user_id: C.id, p_reason_code: 'spam' }),
    rpc(M2, 'admin_suspend_account', { p_user_id: C.id, p_reason_code: 'scam_fraud' }),
  ]);
  check('two admins suspend at once: exactly one succeeds, the other is told it\'s already suspended',
    [c1, c2].filter((r) => !r.error).length === 1 && [c1, c2].some((r) => errMsg(r).includes('already_suspended')), [errMsg(c1), errMsg(c2)]);
  const [l1, l2] = await Promise.all([
    rpc(M1, 'admin_lift_suspension', { p_user_id: C.id, p_reason_code: 'resolved_in_error' }),
    rpc(M2, 'admin_lift_suspension', { p_user_id: C.id, p_reason_code: 'appeal_granted' }),
  ]);
  check('two admins lift at once: exactly one succeeds', [l1, l2].filter((r) => !r.error).length === 1 && [l1, l2].some((r) => errMsg(r).includes('not_suspended')));
  check('both decisions are audited once each', psql(`SELECT count(*) FILTER (WHERE action = 'suspend') || '/' || count(*) FILTER (WHERE action = 'lift_suspension')
    FROM public.moderation_actions WHERE target_id = ${lit(C.id)}`) === '1/1');

  step('6. Media quarantine while suspended');
  const snapPath = `${S.id}/su-snap-${run}.jpg`;
  must(await service.storage.from('share-snapshots').upload(snapPath, jpeg('snap'), { contentType: 'image/jpeg' }), 'snapshot');
  const SP = randomUUID();
  psql(`INSERT INTO public.posts (id, user_id, post_type, content, image_url) VALUES (${lit(SP)}, ${lit(S.id)}, 'text', 'su snap',
        ${lit(anon.storage.from('share-snapshots').getPublicUrl(snapPath).data.publicUrl)})`);
  check('O cannot see (or report) a suspended collector\'s post', !!(await rpc(O, 'submit_report', { p_target_type: 'post', p_target_id: SP, p_reason: 'spam', p_details: `${MARK} ${run}` })).error);
  // S is hidden, so O cannot even see (or report) the post: an admin acts on an existing report instead.
  const rep = psql(`INSERT INTO public.content_reports (reporter_id, target_type, target_id, target_owner_id, reason, details, evidence)
                    VALUES (${lit(O.id)}, 'post', ${lit(SP)}, ${lit(S.id)}, 'spam', '${MARK} ${run}', '{"v":1}') RETURNING id`).split('\n')[0];
  const hide = await rpc(M1, 'admin_hide_content', { p_report_id: rep, p_reason_code: 'pending_review' });
  const job = psql(`SELECT id FROM private.media_quarantine WHERE source_path = ${lit(snapPath)}`);
  check('restricting a suspended collector\'s post still queues its public snapshot', !hide.error && !!job, hide.error);
  const q = await fn('admin-media-quarantine', M1.token, { limit: 10 });
  check('…and the worker quarantines it', (q.body?.results ?? []).some((r: any) => r.id === job && r.outcome === 'quarantined'), q.body);
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: hide.data.moderation_id, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }) as any, 'lift post');
  const r1 = await fn('admin-media-restore', M2.token, { job_ids: [job] });
  check('restoring media into a suspended account is refused', r1.body?.results?.[0]?.reason === 'owner_unavailable', r1.body);

  step('7. Lifting the suspension');
  check('M2 lifts S\'s suspension', (await rpc(M2, 'admin_lift_suspension', { p_user_id: S.id, p_reason_code: 'appeal_granted', p_note: 'appeal ok' })).data?.state === 'lifted');
  check('S\'s existing session works again', !(await S.db.from('posts').insert({ user_id: S.id, post_type: 'text', content: `back ${run}` })).error);
  check('O sees S\'s content and images again', ((await O.db.from('posts').select('id').eq('id', P)).data ?? []).length === 1
    && (await imageStatus(O.token, IMG)).body?.results?.[0]?.status === 'ok' && (await coverStatus(null, F)) === 'ok');
  const r2 = await fn('admin-media-restore', M2.token, { job_ids: [job] });
  check('…and the quarantined snapshot can now be restored', r2.body?.results?.[0]?.outcome === 'restored', r2.body);

  step('8. Temporary suspension expires on its own');
  const ts = await rpc(M1, 'admin_suspend_account', { p_user_id: T.id, p_reason_code: 'spam', p_expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() });
  check('T is suspended for two hours', ts.data?.state === 'active' && !!ts.data?.expires_at);
  check('T is refused meanwhile', errMsg(await T.db.from('posts').insert({ user_id: T.id, post_type: 'text', content: 'x' }) as R) === 'account_suspended');
  // Time passes (simulated as an operator would: the row is moved into the past).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE public.account_suspensions SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE user_id = ${lit(T.id)};
        COMMIT;`);
  check('after expiry T\'s existing session works — no job ran', !(await T.db.from('posts').insert({ user_id: T.id, post_type: 'text', content: `free ${run}` })).error
    && (await rpc(T, 'my_account_suspension')).data?.suspended === false);
  check('admins see it as expired', (await rpc(M1, 'admin_account_suspensions', { p_user_id: T.id })).data?.history?.[0]?.state === 'expired');

  step('9. Nothing was deleted');
  check('no lifecycle rows or deletion jobs for any suspended fixture', psql(`SELECT count(*) FROM public.account_lifecycle WHERE user_id IN (${[S, T, C].map((u) => lit(u.id)).join(',')})`) === '0'
    && psql(`SELECT count(*) FROM public.account_deletion_jobs WHERE user_id IN (${[S, T, C].map((u) => lit(u.id)).join(',')})`) === '0');
  check('S\'s content is all still there', psql(`SELECT (SELECT count(*) FROM public.collection_items WHERE id = ${lit(I)}) + (SELECT count(*) FROM public.messages WHERE id = ${lit(msg)})`) === '2');
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
    || (SELECT count(*) FROM public.account_suspensions) || ' suspensions, ' || (SELECT count(*) FROM private.media_quarantine) || ' jobs, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'moderation-quarantine') || ' quarantine objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

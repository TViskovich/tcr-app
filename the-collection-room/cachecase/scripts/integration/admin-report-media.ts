/// <reference types="node" />
// Report-scoped media inspection, media restoration, legal holds and
// profile-field release (Phase 2B M5.3: 20261203120000_admin_report_media.sql,
// supabase/functions/admin-report-media, admin-media-restore report scope,
// components/admin/report-media.tsx). The API exactly as the app calls it —
// RPCs and Edge Functions with real user sessions, real Storage uploads made
// by the owning collector — on an ISOLATED disposable local stack with
// synthetic accounts only. Quarantine runs only when an administrator runs
// the worker by hand; no scheduler is switched on; nothing is purged.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/admin-report-media.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'admin-report-media-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
const must = <T,>(r: { data: T; error: { message?: string } | null }, what: string): NonNullable<T> => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as NonNullable<T>;
};

type U = { id: string; db: SupabaseClient; username: string; token: string };
async function createUser(key: string): Promise<U> {
  const username = `rmd${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rmd-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw new Error(`create ${key}: ${error.message}`);
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const s = await db.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { id: data.user.id, db, username, token: s.data.session!.access_token };
}
const fn = async (name: string, token: string | null, body: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, cache: r.headers.get('cache-control'), body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const media = (u: U | null, report: string, ref: number, confirm = false, extra: Record<string, unknown> = {}) =>
  fn('admin-report-media', u?.token ?? null, { report_id: report, ref, confirm_child_safety: confirm, ...extra });
const restore = (u: U, report: string | undefined, jobIds: string[], confirm: boolean) =>
  fn('admin-media-restore', u.token, { job_ids: jobIds, confirm_child_safety: confirm, ...(report ? { report_id: report } : {}) });
const bytesAt = async (signedPath: string) => Buffer.from(await (await fetch(`${st.API_URL}${signedPath}`)).arrayBuffer());
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const objectExists = (bucket: string, path: string) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';
const ev = async (u: U, id: string) => must(await u.db.rpc('admin_report_evidence', { p_report_id: id }), 'evidence') as any;
const ver = async (u: U, id: string) => (must(await u.db.rpc('admin_report_enforcement', { p_report_id: id }), 'enf') as any).version as string;
const claim = async (u: U, id: string) => u.db.rpc('admin_report_case_action', { p_report_id: id, p_action: 'claim', p_expected_version: await ver(u, id) });
const enforce = async (u: U, id: string, action: string, reason: string, options: Record<string, unknown> = {}, note: string | null = null, version?: string) =>
  u.db.rpc('admin_report_enforce', { p_report_id: id, p_action: action, p_expected_version: version ?? await ver(u, id), p_reason_code: reason, p_note: note, p_options: options });
const errMsg = (e: { message?: string } | null) => e?.message ?? null;

async function cleanup(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (!ids.length) return 0;
  const users = ids.map(lit).join(',');
  const objs = psql(`SELECT bucket_id || '|' || name FROM storage.objects
                      WHERE (bucket_id IN ('item-images', 'avatars', 'share-snapshots') AND split_part(name, '/', 1) IN (${ids.map(lit).join(',')}))
                         OR (bucket_id = 'dm-attachments' AND split_part(name, '/', 1)::text IN (SELECT conversation_id::text FROM public.conversation_participants WHERE user_id IN (${users})))
                         OR (bucket_id = 'moderation-quarantine' AND name IN (SELECT quarantine_path FROM private.media_quarantine WHERE owner_id IN (${users})))`).split('\n').filter(Boolean);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM private.report_media_access WHERE admin_id IN (${users}) OR report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${users}) OR target_owner_id IN (${users}));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${users}));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${users}));
        DELETE FROM private.media_quarantine WHERE owner_id IN (${users});
        DELETE FROM private.moderation_legal_holds WHERE subject_owner_id IN (${users}) OR placed_by IN (${users});
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${users}) OR target_owner_id IN (${users}))
                                              OR target_owner_id IN (${users}) OR admin_id IN (${users});
        DELETE FROM public.moderated_profile_fields WHERE user_id IN (${users});
        DELETE FROM public.content_reports WHERE reporter_id IN (${users}) OR target_owner_id IN (${users});
        DELETE FROM public.moderated_content WHERE owner_id IN (${users}) OR created_by IN (${users});
        DELETE FROM public.account_suspensions WHERE user_id IN (${users});
        DELETE FROM public.admin_users WHERE user_id IN (${users});
        COMMIT;`);
  for (const o of objs) {
    const [bucket, ...rest] = o.split('|');
    psql(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(rest.join('|'))}; COMMIT;`);
  }
  const convs = psql(`SELECT string_agg(DISTINCT conversation_id::text, ',') FROM public.conversation_participants WHERE user_id IN (${users})`);
  if (convs) psql(`DELETE FROM public.conversations WHERE id IN (${convs.split(',').map(lit).join(',')})`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const S = await createUser('s');   // suspended admin
  const O = await createUser('o');   // reported collector
  const Q = await createUser('q');   // reported profile
  const N = await createUser('n');   // ordinary collector
  const R = await createUser('r');   // reporter / DM partner
  must(await service.from('admin_users').insert([{ user_id: A.id }, { user_id: B.id }, { user_id: S.id }]), 'admins');
  psql(`INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (${lit(S.id)}, 'spam')`);
  const pool = await Promise.all(Array.from({ length: 4 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const reporter = () => pool[turn++ % pool.length];
  const up = await fn('admin-report-media', null, {});
  if (up.status >= 500) throw new Error(`Edge Functions not served (status ${up.status})`);

  // ── Fixtures, through the collectors' own clients ────────────────────
  const folder = randomUUID();
  must(await O.db.from('folders').insert({ id: folder, user_id: O.id, name: `rmd ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const items: Record<string, { id: string; paths: string[]; bytes: Buffer[] }> = {};
  for (const [key, n] of [['i1', 2], ['i2', 1]] as const) {
    const id = randomUUID();
    must(await O.db.from('collection_items').insert({ id, folder_id: folder, user_id: O.id, title: `rmd ${key} ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
    items[key] = { id, paths: [], bytes: [] };
    for (let k = 0; k < n; k++) {
      const path = `${O.id}/${id}/rmd-${key}-${k}.jpg`;
      const bytes = jpeg(`${key}-${k}-${run}`);
      must(await O.db.storage.from('item-images').upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
      must(await O.db.from('collection_item_images').insert({ item_id: id, user_id: O.id, image_url: 'https://x.invalid', storage_path: path, sort_order: k, is_primary: k === 0 }), 'image');
      items[key].paths.push(path);
      items[key].bytes.push(bytes);
    }
  }
  const conv = must(await R.db.rpc('get_or_create_conversation', { other_user_id: O.id }), 'conversation') as string;
  const dms: { id: string; path: string; bytes: Buffer }[] = [];
  for (const k of [0, 1]) {
    const id = randomUUID();
    const path = `${conv}/${id}/image.jpg`;
    const bytes = jpeg(`dm-${k}-${run}`);
    must(await O.db.storage.from('dm-attachments').upload(path, bytes, { contentType: 'image/jpeg' }), 'dm upload');
    must(await O.db.from('messages').insert({ id, conversation_id: conv, sender_id: O.id, body: `rmd dm ${k} ${run}`, attachment_type: 'image', attachment_storage_path: path }), 'dm');
    dms.push({ id, path, bytes });
  }
  must(await Q.db.from('profiles').update({ display_name: `RMD NAME ${run}`, bio: `RMD BIO ${run}` }).eq('id', Q.id), 'profile');
  const reports: Record<string, string> = {};
  const file = async (key: string, type: string, id: string, reason: string, by = reporter()) => {
    must(await by.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: null }), `report ${key}`);
    reports[key] = psql(`SELECT id FROM public.content_reports WHERE reporter_id = ${lit(by.id)} AND target_id = ${lit(id)} AND status = 'open'`);
  };
  await file('i1', 'collection_item', items.i1.id, 'spam');
  await file('i2', 'collection_item', items.i2.id, 'spam');
  await file('dm0', 'message', dms[0].id, 'child_safety', R);
  await file('dm1', 'message', dms[1].id, 'child_safety', R);
  await file('profile', 'profile', Q.id, 'harassment');
  const snapshot = () => psql(`SELECT md5(string_agg(bucket_id || '/' || name || '/' || COALESCE(metadata ->> 'eTag', ''), ',' ORDER BY bucket_id, name))
                               FROM storage.objects WHERE bucket_id <> 'moderation-quarantine'
                                 AND name NOT LIKE ${lit(`${O.id}/%`)} AND name NOT LIKE ${lit(`${conv}/%`)}`);
  const unrelatedBefore = snapshot();

  step('1. Media inspection: authorization and scope');
  const e1 = await ev(A, reports.i1);
  check('the item report lists its two images (no paths)', e1.media.length === 2 && !JSON.stringify(e1).includes(items.i1.paths[0]) && !JSON.stringify(e1).includes('item-images'));
  const v1 = await media(A, reports.i1, 1);
  check('admin views image 1: a 60-second signed path, not cached', v1.status === 200 && v1.body?.status === 'ok' && v1.body.expires_in === 60
    && /^\/storage\/v1\/object\/sign\/item-images\//.test(v1.body.signed_path) && v1.cache === 'no-store', [v1.status, v1.body?.status, v1.cache]);
  check('the bytes are exactly that image', (await bytesAt(v1.body.signed_path)).equals(items.i1.bytes[0]));
  check('the response carries no permanent/public URL or internal host', !/object\/public|kong|http/.test(JSON.stringify(v1.body)));
  const v2 = await media(A, reports.i1, 2);
  check('image 2 is a different object', v2.body?.status === 'ok' && (await bytesAt(v2.body.signed_path)).equals(items.i1.bytes[1]));
  check('a position the report lacks is refused', (await media(A, reports.i1, 3)).body?.reason === 'not_found');
  const cross = await media(A, reports.i2, 1, false, { path: items.i1.paths[0], bucket: 'item-images' });
  check('another report id only ever yields its own image (extra path/bucket ignored)',
    cross.body?.status === 'ok' && (await bytesAt(cross.body.signed_path)).equals(items.i2.bytes[0]));
  check('an unknown report is refused', (await media(A, randomUUID(), 1)).body?.reason === 'not_found');
  check('ordinary collector → 403', (await media(N, reports.i1, 1)).status === 403);
  const sus = (await media(S, reports.i1, 1)).status;
  check('suspended admin → refused (401/403)', sus === 401 || sus === 403, sus);
  check('signed out → 401', (await media(null, reports.i1, 1)).status === 401);
  check('invalid token → 401', (await fn('admin-report-media', 'not.a.jwt', { report_id: reports.i1, ref: 1 })).status === 401);
  check('a malformed request → 400', (await fn('admin-report-media', A.token, { report_id: reports.i1, ref: '1' })).status === 400);
  const direct = await A.db.rpc('report_media_authorize', { p_admin: A.id, p_report_id: reports.i1, p_ref: 1 });
  check('the authorizer cannot be called from an admin session', !!direct.error);
  const dmNo = await media(A, reports.dm0, 1);
  check('child-safety media: refused without explicit confirmation', dmNo.body?.status === 'refused' && dmNo.body.reason === 'child_safety_confirmation_required');
  const dmYes = await media(A, reports.dm0, 1, true);
  check('…shown with it (and flagged child safety)', dmYes.body?.status === 'ok' && dmYes.body.child_safety === true && (await bytesAt(dmYes.body.signed_path)).equals(dms[0].bytes));
  // 6 requests reached an existing report (4 allowed); an unknown report id is
  // refused before anything can be recorded against it.
  const logged = psql(`SELECT count(*) || ':' || count(*) FILTER (WHERE allowed) FROM private.report_media_access WHERE admin_id = ${lit(A.id)}`);
  check('every media request on a report is logged with its outcome', logged === '6:4', logged);

  step('2. Image-level enforcement after inspection');
  must(await claim(A, reports.i1), 'claim i1');
  const rmImg = await enforce(A, reports.i1, 'remove', 'spam', { image_index: 1 });
  check('remove only image 2 of the item', !rmImg.error && psql(`SELECT string_agg(target_type, ',') FROM public.moderated_content WHERE owner_id = ${lit(O.id)} AND lifted_at IS NULL`) === 'item_image', errMsg(rmImg.error));
  const e1b = await ev(A, reports.i1);
  check('the evidence marks image 2 restricted, image 1 not', e1b.media[0].image_restricted === false && e1b.media[1].image_restricted === true);
  check('both original files are untouched (not child safety: only public copies are quarantined)', objectExists('item-images', items.i1.paths[0]) && objectExists('item-images', items.i1.paths[1]));

  step('3. Child-safety media: quarantine, restore scope, second administrator, legal hold');
  must(await claim(A, reports.dm0), 'claim dm0');
  must(await enforce(A, reports.dm0, 'remove', 'child_safety'), 'remove dm0');
  must(await claim(A, reports.dm1), 'claim dm1');
  must(await enforce(A, reports.dm1, 'remove', 'child_safety'), 'remove dm1');
  must(await A.db.rpc('admin_place_legal_hold', { p_subject_kind: 'report', p_subject_id: reports.dm0, p_basis_code: 'law_enforcement_request',
    p_basis_note: `RMD HOLD NOTE ${run}`, p_expires_at: null }), 'hold'); // child-safety holds have no end date
  const wk = await fn('admin-media-quarantine', A.token, { limit: 10 });
  const d0 = await ev(A, reports.dm0);
  const job0 = d0.jobs[0];
  check('worker run by hand: the DM photo is quarantined and has left its location', wk.status === 200 && job0?.state === 'quarantined' && !objectExists('dm-attachments', dms[0].path), [wk.status, job0?.state]);
  check('the quarantined original is not viewable', (await media(A, reports.dm0, 1, true)).body?.reason === 'quarantined');
  check('legal hold listed with basis code only (never the note)', d0.legal_holds.some((h: any) => h.subject === 'report' && h.basis_code === 'law_enforcement_request')
    && !JSON.stringify(d0).includes('RMD HOLD NOTE'));
  check('while the restriction stands, the media is not restorable', job0.restore_blocked === 'not_released');
  const early = await restore(B, reports.dm0, [job0.id], true);
  check('…and admin-media-restore refuses it', early.body?.results?.[0]?.outcome === 'refused' && early.body.results[0].reason === 'not_released', early.body);
  must(await enforce(B, reports.dm0, 'restore', 'child_safety_review_cleared', { disposition: 'reopen', confirm_child_safety: true }, 'second review'), 'B restores content');
  must(await enforce(B, reports.dm1, 'restore', 'child_safety_review_cleared', { disposition: 'reopen', confirm_child_safety: true }, 'second review'), 'B restores content dm1');
  const d0b = await ev(B, reports.dm0);
  check('content restored ≠ media restored: the photo awaits a separate restore', d0b.jobs[0].state === 'restore_pending' && !objectExists('dm-attachments', dms[0].path));
  check('A (imposed the removal) is shown as unable to restore it', (await ev(A, reports.dm0)).jobs[0].restore_blocked === 'second_admin_required');
  const byA = await restore(A, reports.dm0, [job0.id], true);
  check('A is refused by the server too', byA.body?.results?.[0]?.reason === 'second_admin_required', byA.body);
  const wrong = await restore(B, reports.i1, [job0.id], true);
  check('the job under another report id is refused (not_in_report)', wrong.body?.results?.[0]?.reason === 'not_in_report', wrong.body);
  const unknown = await restore(B, reports.dm0, [randomUUID()], true);
  check('an unrelated job id is refused (not_in_report)', unknown.body?.results?.[0]?.reason === 'not_in_report', unknown.body);
  const noConfirm = await restore(B, reports.dm0, [job0.id], false);
  check('B without confirmation is refused', noConfirm.body?.results?.[0]?.reason === 'child_safety_confirmation_required', noConfirm.body);
  check('still nothing restored', !objectExists('dm-attachments', dms[0].path));
  const [x1, x2] = await Promise.all([restore(B, reports.dm0, [job0.id], true), restore(B, reports.dm0, [job0.id], true)]);
  const outcomes = [x1.body?.results?.[0]?.outcome, x2.body?.results?.[0]?.outcome];
  check('two restore requests at once: exactly one restores', outcomes.filter((o) => o === 'restored').length === 1, outcomes);
  check('the original is back, byte for byte', objectExists('dm-attachments', dms[0].path) && (await bytesAt((await media(B, reports.dm0, 1, true)).body.signed_path)).equals(dms[0].bytes));
  const q0 = psql(`SELECT quarantine_path FROM private.media_quarantine WHERE id = ${lit(job0.id)}`);
  check('the legal-hold evidence copy is preserved in quarantine', objectExists('moderation-quarantine', q0));
  check('the legal hold itself is untouched', (await ev(B, reports.dm0)).legal_holds.length === 1);
  check('evidence shows the job restored', (await ev(B, reports.dm0)).jobs[0].state === 'restored');

  step('4. Restoration failure');
  const job1 = (await ev(B, reports.dm1)).jobs[0];
  const occupy = await service.storage.from('dm-attachments').upload(dms[1].path, jpeg('occupier'), { contentType: 'image/jpeg' });
  check('even the service role cannot write over held media (media_held)', /media_held/.test(occupy.error?.message ?? ''), occupy.error?.message);
  // Simulated loss of the quarantine copy (disposable stack only): the
  // restore cannot verify the bytes and must not claim success.
  const q1 = psql(`SELECT quarantine_path FROM private.media_quarantine WHERE id = ${lit(job1.id)}`);
  psql(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM storage.objects WHERE bucket_id = 'moderation-quarantine' AND name = ${lit(q1)}; COMMIT;`);
  const fail = await restore(B, reports.dm1, [job1.id], true);
  const after = (await ev(B, reports.dm1)).jobs[0];
  check('a restore that cannot complete is not reported as restored', fail.body?.results?.[0]?.outcome !== 'restored', fail.body);
  check('…and the report screen shows it as failed or needing attention', after.state !== 'restored' && (after.needs_attention || after.state === 'failed' || !!after.error), after);
  check('nothing was written to the original location', !objectExists('dm-attachments', dms[1].path));

  step('5. Profile-field release');
  must(await claim(A, reports.profile), 'claim profile');
  must(await enforce(A, reports.profile, 'clear_profile_fields', 'harassment', { fields: ['display_name', 'bio'] }), 'clear');
  const pv = await ver(A, reports.profile);
  const [rel1, rel2] = await Promise.all([
    enforce(A, reports.profile, 'release_profile_fields', 'owner_may_edit', { fields: ['bio'] }, null, pv),
    enforce(B, reports.profile, 'release_profile_fields', 'policy_review', { fields: ['bio'] }, null, pv),
  ]);
  check('two admins releasing from the same screen state: one applies, one report_changed',
    [rel1, rel2].filter((r) => !r.error).length === 1 && [rel1, rel2].some((r) => errMsg(r.error) === 'report_changed'), [errMsg(rel1.error), errMsg(rel2.error)]);
  const qb = await Q.db.from('profiles').update({ bio: `new bio ${run}` }).eq('id', Q.id);
  const qn = await Q.db.from('profiles').update({ display_name: `new name ${run}` }).eq('id', Q.id);
  check('the collector can edit the released field', !qb.error, qb.error);
  check('…but not the field that is still restricted', !!qn.error);
  check('the report decision is unchanged by a release', psql(`SELECT status FROM public.content_reports WHERE id = ${lit(reports.profile)}`) === 'actioned');

  step('6. Expired claims and lost authorization');
  must(await claim(A, reports.i2), 'claim i2');
  psql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.content_reports SET claimed_at = now() - interval '25 hours' WHERE id = ${lit(reports.i2)}; COMMIT;`);
  const take = await claim(B, reports.i2);
  check('a 25-hour-old claim can be taken over', !take.error, errMsg(take.error));
  const aLate = await enforce(A, reports.i2, 'remove', 'spam', { image_index: 0 });
  check('the former claimant can no longer act on it', errMsg(aLate.error) === 'claim_required', errMsg(aLate.error));
  psql(`DELETE FROM public.admin_users WHERE user_id = ${lit(B.id)}`);
  check('a removed admin: media view refused at once', (await media(B, reports.i2, 1)).status === 403);
  check('…and media restore refused', (await restore(B, reports.dm1, [job1.id], true)).status === 403);

  step('7. No unrelated Storage changes');
  check('no Storage object outside the reported collector’s own content changed', snapshot() === unrelatedBefore);
}

const stale = await cleanup();
if (stale) console.log(`(removed ${stale} stale fixture account(s) first)`);
try {
  await main();
} catch (e) {
  check('script ran to completion', false, (e as Error).message);
} finally {
  console.log(`\nCleanup: ${await cleanup()} account(s) removed.`);
  const state = psql(`SELECT (SELECT bool_or(active) FROM cron.job)::text || ',' || (SELECT enabled FROM private.media_quarantine_scheduler_config)::text || ','
                             || (SELECT count(*) FROM public.content_reports) || ',' || (SELECT count(*) FROM private.media_quarantine) || ','
                             || (SELECT count(*) FROM public.moderated_content) || ',' || (SELECT count(*) FROM private.moderation_legal_holds)`);
  check('nothing switched on; no fixture reports, jobs, restrictions or holds left', state === 'false,false,0,0,0,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}

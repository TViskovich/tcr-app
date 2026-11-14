/// <reference types="node" />
// Administrator moderation enforcement from a report (Phase 2B M5.2,
// 20261202120000_admin_report_enforcement.sql, components/admin/
// report-enforcement.tsx, lib/admin-enforcement-view.ts) — the API exactly as
// the app calls it (PostgREST RPCs with real user sessions), on an ISOLATED
// disposable local stack with synthetic accounts and content only. Reports
// are filed through the real submit_report path; every content row and
// upload is made by the owning collector's own client.
//
// Quarantine is exercised by an administrator running the worker by hand
// (admin-media-quarantine); no scheduler is switched on. Nothing is purged.
// It refuses to run against the primary local stack.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/admin-report-enforcement.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { classifyError } from '../../lib/admin-reports-view.ts';
import { requireIsolatedStack } from './local-stack.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'admin-report-enforcement-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const NOTE = `PRIVATE-ENFORCEMENT-NOTE-${run}`;
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
  const username = `rnf${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rnf-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const s = await db.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { id: data.user.id, db, username, token: s.data.session!.access_token };
}

const code = (e: { code?: string; message?: string } | null) => (e ? (classifyError({ code: e.code, message: e.message }) as { kind: string; code?: string }) : null);
const view = async (u: U, id: string) => must(await u.db.rpc('admin_report_enforcement', { p_report_id: id }), 'view') as any;
const claim = async (u: U, id: string) => {
  const v = (await view(u, id)).version;
  return u.db.rpc('admin_report_case_action', { p_report_id: id, p_action: 'claim', p_expected_version: v });
};
const enforce = async (u: U, id: string, action: string, reason: string, options: Record<string, unknown> = {}, note: string | null = null, version?: string) =>
  u.db.rpc('admin_report_enforce', {
    p_report_id: id, p_action: action, p_expected_version: version ?? (await view(u, id)).version,
    p_reason_code: reason, p_note: note, p_options: options,
  });
const modState = (target: string) => psql(`SELECT COALESCE((SELECT state || ':' || child_safety FROM public.moderated_content WHERE target_id = ${lit(target)} AND lifted_at IS NULL), 'none')`);
const status = (id: string) => psql(`SELECT status FROM public.content_reports WHERE id = ${lit(id)}`);
const audits = (id: string, action: string) => Number(psql(`SELECT count(*) FROM public.moderation_actions WHERE report_id = ${lit(id)} AND action = ${lit(action)}`));
const fn = async (name: string, token: string | null, body: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const jpeg = (tag: string) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
const objectExists = (bucket: string, path: string) => psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = ${lit(bucket)} AND name = ${lit(path)}`) === '1';

async function cleanup(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (!ids.length) return 0;
  const users = ids.map(lit).join(',');
  // Storage objects first (through the API, so files are really deleted).
  const objs = psql(`SELECT bucket_id || '|' || name FROM storage.objects WHERE owner_id::uuid IN (${users})
                     OR name LIKE ANY (ARRAY[${ids.map((i) => lit(`${i}/%`)).join(',')}])
                     OR (bucket_id = 'moderation-quarantine' AND name LIKE 'q/%' AND EXISTS (SELECT 1 FROM private.media_quarantine q
                          WHERE q.owner_id IN (${users}) AND q.quarantine_path = storage.objects.name))`).split('\n').filter(Boolean);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${users}));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${users}));
        DELETE FROM private.media_quarantine WHERE owner_id IN (${users});
        DELETE FROM private.moderation_legal_holds WHERE subject_owner_id IN (${users});
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
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const X = await createUser('x');   // admin who owns content
  const O = await createUser('o');   // reported collector
  const Q = await createUser('q');   // reported profile
  const N = await createUser('n');   // ordinary collector
  must(await service.from('admin_users').insert([{ user_id: A.id }, { user_id: B.id }, { user_id: X.id }]), 'admins');
  const pool = await Promise.all(Array.from({ length: 6 }, (_, k) => createUser(`p${k}`)));
  let turn = 0;
  const reporter = () => pool[turn++ % pool.length];
  const up = await fn('admin-media-quarantine', null, {});
  if (up.status >= 500) throw new Error(`Edge Functions not served (status ${up.status})`);

  // O's content, through O's own client.
  const folder = randomUUID();
  must(await O.db.from('folders').insert({ id: folder, user_id: O.id, name: `rnf ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const item = randomUUID();
  must(await O.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: O.id, title: `rnf item ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
  const itemPath = `${O.id}/${item}/rnf-${run}.jpg`;
  must(await O.db.storage.from('item-images').upload(itemPath, jpeg('orig'), { contentType: 'image/jpeg' }), 'upload');
  must(await O.db.from('collection_item_images').insert({ item_id: item, user_id: O.id, image_url: 'https://x.invalid', storage_path: itemPath, sort_order: 0, is_primary: true }), 'image');
  const item2 = randomUUID();
  must(await O.db.from('collection_items').insert({ id: item2, folder_id: folder, user_id: O.id, title: `rnf item2 ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item2');
  const post = must(await O.db.from('posts').insert({ user_id: O.id, content: `rnf post ${run}`, post_type: 'text' }).select('id').single(), 'post').id;
  const post2 = must(await O.db.from('posts').insert({ user_id: O.id, content: `rnf post2 ${run}`, post_type: 'text' }).select('id').single(), 'post2').id;
  const xpost = must(await X.db.from('posts').insert({ user_id: X.id, content: `rnf admin post ${run}`, post_type: 'text' }).select('id').single(), 'xpost').id;
  const comment = must(await O.db.from('comments').insert({ user_id: O.id, post_id: post2, body: `rnf comment ${run}` }).select('id').single(), 'comment').id;
  const icomment = must(await O.db.from('item_comments').insert({ user_id: O.id, item_id: item2, body: `rnf item comment ${run}` }).select('id').single(), 'item comment').id;
  const fcomment = must(await O.db.from('folder_comments').insert({ user_id: O.id, folder_id: folder, body: `rnf folder comment ${run}` }).select('id').single(), 'folder comment').id;
  const gcomment = must(await O.db.from('gallery_comments').insert({ user_id: O.id, folder_id: folder, player_key: 'rnf-player', body: `rnf gallery comment ${run}` }).select('id').single(), 'gallery comment').id;
  const R0 = reporter();
  const conv = must(await R0.db.rpc('get_or_create_conversation', { other_user_id: O.id }), 'conversation') as string;
  const msg = randomUUID();
  const other = randomUUID();
  must(await O.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: O.id, body: `rnf abusive DM ${run}` }), 'msg');
  must(await O.db.from('messages').insert({ id: other, conversation_id: conv, sender_id: O.id, body: `rnf unrelated DM ${run}` }), 'msg2');
  must(await Q.db.from('profiles').update({ display_name: `RNF SECRET NAME ${run}`, bio: `RNF SECRET BIO ${run}` }).eq('id', Q.id), 'profile');

  const reports: Record<string, string> = {};
  const file = async (key: string, type: string, id: string, reason: string, by = reporter()) => {
    must(await by.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: null }), `report ${key}`);
    reports[key] = psql(`SELECT id FROM public.content_reports WHERE reporter_id = ${lit(by.id)} AND target_id = ${lit(id)} AND status = 'open'`);
  };
  await file('message', 'message', msg, 'harassment', R0);
  for (const [key, type, id] of [['post', 'post', post], ['comment', 'comment', comment], ['item_comment', 'item_comment', icomment],
    ['folder_comment', 'folder_comment', fcomment], ['gallery_comment', 'gallery_comment', gcomment], ['folder', 'folder', folder]] as const) {
    await file(key, type, id, 'spam');
  }
  await file('item_cs', 'collection_item', item, 'child_safety');
  await file('profile', 'profile', Q.id, 'harassment');
  await file('xpost', 'post', xpost, 'spam');
  await file('post_related', 'post', post, 'hate');

  step('1. Access');
  const nv = await N.db.rpc('admin_report_enforcement', { p_report_id: reports.post });
  const ne = await N.db.rpc('admin_report_enforce', { p_report_id: reports.post, p_action: 'remove', p_expected_version: 'x', p_reason_code: 'spam', p_note: null, p_options: {} });
  check('ordinary collector: view and enforcement refused', code(nv.error)?.kind === 'forbidden' && code(ne.error)?.kind === 'forbidden');
  const sv = await service.rpc('admin_report_enforcement', { p_report_id: reports.post });
  check('service role: no admin identity, refused', !!sv.error);
  const bogus = createClient(st.API_URL, st.ANON_KEY, { ...opts, global: { headers: { Authorization: 'Bearer not-a-token' } } });
  const bv = await bogus.rpc('admin_report_enforcement', { p_report_id: reports.post });
  check('invalid/expired session: refused', !!bv.error && !bv.data, bv.status);

  step('2. Content types: hide → remove → restore');
  const matrix: [string, string][] = [['post', post], ['comment', comment], ['item_comment', icomment], ['folder_comment', fcomment],
    ['gallery_comment', gcomment], ['message', msg], ['folder', folder]];
  for (const [key, target] of matrix) {
    const id = reports[key];
    const c = await claim(A, id);
    const h = await enforce(A, id, 'hide', 'pending_review');
    const hidden = modState(target);
    const rm = await enforce(A, id, 'remove', key === 'message' ? 'harassment' : 'spam', { include_related: key !== 'post' });
    const removed = modState(target);
    const actioned = status(id);
    const rs = await enforce(A, id, 'restore', 'resolved_in_error', { disposition: 'reopen' });
    check(`${key}: hide → hidden, remove → removed/actioned, restore → lifted/reopened, each audited`,
      !c.error && !h.error && !rm.error && !rs.error && hidden === 'hidden:false' && removed === 'removed:false' && actioned === 'actioned'
      && modState(target) === 'none' && status(id) === 'open' && audits(id, 'hide') === 1 && audits(id, 'remove') === 1 && audits(id, 'restore') === 1,
      [c.error, h.error, rm.error, rs.error, hidden, removed, actioned]);
  }
  check('removing the message touched no other message', psql(`SELECT count(*) FROM public.moderated_content WHERE target_id = ${lit(other)}`) === '0');
  check('restoring left the related open report on the post open (not swept in)', status(reports.post_related) === 'open');

  step('3. Duplicate submissions and stale screens');
  const p = reports.post;
  must(await claim(A, p), 'reclaim');
  const v0 = (await view(A, p)).version;
  const [d1, d2] = await Promise.all([enforce(A, p, 'remove', 'spam', {}, null, v0), enforce(A, p, 'remove', 'spam', {}, null, v0)]);
  check('the same remove sent twice: exactly one applies, the other is report_changed',
    [d1, d2].filter((r) => !r.error).length === 1 && code([d1, d2].find((r) => r.error)!.error)?.code === 'report_changed', [d1.error, d2.error]);
  check('one remove audit row for the duplicate pair', audits(p, 'remove') === 2); // one from section 2 + one now
  check('include_related defaulted on: the related report is actioned with it', status(reports.post_related) === 'actioned');
  const rv = (await view(A, p)).version;
  const [x1, x2] = await Promise.all([
    enforce(A, p, 'restore', 'appeal_granted', { disposition: 'overturn' }, null, rv),
    enforce(B, p, 'restore', 'resolved_in_error', { disposition: 'reopen' }, null, rv),
  ]);
  const winners = [x1, x2].filter((r) => !r.error);
  check('two admins restoring from the same screen state: one restore, one report_changed',
    winners.length === 1 && code([x1, x2].find((r) => r.error)!.error)?.code === 'report_changed', [x1.error, x2.error]);
  check('restore audited once per linked report (2 reports, 1 decision)', audits(p, 'restore') === 2 && audits(reports.post_related, 'restore') === 1);
  const stale = await enforce(A, reports.comment, 'hide', 'pending_review', {}, null, v0);
  check('a version from another report is refused', code(stale.error)?.code === 'report_changed');
  const b1 = await enforce(B, reports.comment, 'hide', 'pending_review');
  check('B cannot enforce on a report A has claimed', code(b1.error)?.code === 'claim_required' || code(b1.error)?.code === 'already_resolved', b1.error);

  step('4. Child safety, quarantine (manual worker run) and second review');
  const cs = reports.item_cs;
  await claim(A, cs);
  const rmcs = await enforce(A, cs, 'remove', 'child_safety', {}, NOTE);
  const after = await view(A, cs);
  check('child-safety removal: restriction is child-safety, report actioned', !rmcs.error && modState(item) === 'removed:true' && status(cs) === 'actioned', rmcs.error);
  check('the item image is queued, not yet processed (automatic quarantine off)', after.media.total >= 1 && after.media.in_progress >= 1 && after.media.automatic === false, after.media);
  check('the enforcement payloads carry no paths, buckets, owner ids or notes',
    ![itemPath, 'item-images', O.id, NOTE].some((s) => JSON.stringify(after).includes(s) || JSON.stringify(rmcs.data).includes(s)));
  const wk = await fn('admin-media-quarantine', A.token, { limit: 10 });
  check('an administrator runs the quarantine worker by hand', wk.status === 200, wk.status);
  const q = await view(A, cs);
  check('the job is quarantined: the original left its public location', (q.media.by_state.quarantined ?? 0) >= 1 && q.media.in_progress === 0 && !objectExists('item-images', itemPath), q.media);
  check('the quarantined child-safety copy is under legal hold', q.media.legal_hold >= 1, q.media);
  check('A sees the reversal as awaiting a second administrator', q.actions.restore.blocked === 'child_safety_second_admin_required');
  const self = await enforce(A, cs, 'restore', 'child_safety_review_cleared', { disposition: 'reopen', confirm_child_safety: true }, 'reviewed');
  check('A cannot approve their own reversal', code(self.error)?.code === 'child_safety_second_admin_required', self.error);
  const bNoNote = await enforce(B, cs, 'restore', 'child_safety_review_cleared', { disposition: 'reopen', confirm_child_safety: true });
  check('B without a review note is refused', code(bNoNote.error)?.code === 'child_safety_confirmation_required', bNoNote.error);
  const bOk = await enforce(B, cs, 'restore', 'child_safety_review_cleared', { disposition: 'reopen', confirm_child_safety: true }, 'second review complete');
  check('B (second administrator) restores after review', !bOk.error && modState(item) === 'none' && status(cs) === 'open', bOk.error);
  const queued = await view(B, cs);
  check('lifting the restriction leaves the media awaiting a separate restore step (reported as such)', queued.media.awaiting_restore >= 1 && queued.media.in_progress === 0, queued.media);
  const wk2 = await fn('admin-media-quarantine', B.token, { limit: 10 });
  check('the quarantine worker does not restore media on its own', wk2.status === 200 && !objectExists('item-images', itemPath) && (await view(B, cs)).media.awaiting_restore >= 1);
  const jobIds = psql(`SELECT string_agg(id::text, ',') FROM private.media_quarantine WHERE owner_id = ${lit(O.id)} AND state = 'restore_pending'`).split(',').filter(Boolean);
  const byA = await fn('admin-media-restore', A.token, { job_ids: jobIds, confirm_child_safety: true });
  check('the admin who imposed the child-safety removal cannot restore its media either',
    byA.status !== 200 || (byA.body?.results ?? []).every((x: any) => x.outcome !== 'restored'), byA);
  const byB = await fn('admin-media-restore', B.token, { job_ids: jobIds, confirm_child_safety: true });
  const back = await view(B, cs);
  check('the second administrator restores the media (existing admin-media-restore): the original is back', byB.status === 200 && objectExists('item-images', itemPath) && (back.media.by_state.restored ?? 0) >= 1, [byB.status, back.media]);
  check('legal-hold evidence copy preserved after the restore', back.media.legal_hold >= 1 || psql(`SELECT count(*) FROM private.media_quarantine WHERE owner_id = ${lit(O.id)} AND legal_hold`) !== '0', back.media);

  step('5. Profile fields');
  const pr = reports.profile;
  await claim(A, pr);
  const pv = await view(A, pr);
  check('profile: only field actions offered for content', pv.actions.hide.blocked === 'unsupported_target' && pv.actions.clear_profile_fields.available);
  const clr = await enforce(A, pr, 'clear_profile_fields', 'harassment', { fields: ['display_name', 'bio'] });
  const prof = must(await N.db.from('profiles').select('display_name, bio').eq('id', Q.id).single(), 'profile read') as any;
  check('fields cleared as others see them; report actioned', !clr.error && prof.display_name === null && prof.bio === null && status(pr) === 'actioned', clr.error);
  check('no original value is returned', !JSON.stringify(await view(A, pr)).includes('RNF SECRET'));
  const own = await Q.db.from('profiles').update({ bio: 'try again' }).eq('id', Q.id);
  check('the collector cannot re-set a cleared field', !!own.error);
  const rp = await enforce(B, pr, 'restore_profile_fields', 'appeal_granted', { fields: ['display_name', 'bio'], disposition: 'overturn' });
  const prof2 = must(await N.db.from('profiles').select('display_name, bio').eq('id', Q.id).single(), 'profile read') as any;
  check('restored exactly; report overturned', !rp.error && prof2.display_name === `RNF SECRET NAME ${run}` && status(pr) === 'dismissed', rp.error);

  step('6. Suspension');
  const m = reports.message;
  const sa = await enforce(A, reports.xpost, 'suspend', 'spam');
  check('an administrator account cannot be suspended', code(sa.error)?.code === 'cannot_suspend_admin', sa.error);
  const bad = await enforce(A, m, 'suspend', 'harassment', { expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
  check('a 5-minute suspension is refused (1 hour minimum)', code(bad.error)?.code === 'invalid_expiry', bad.error);
  const ownPosts = psql(`SELECT count(*) FROM public.posts WHERE user_id = ${lit(O.id)}`);
  const [s1, s2] = await Promise.all([
    enforce(A, m, 'suspend', 'harassment', { expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
    enforce(B, reports.comment, 'suspend', 'spam'),
  ]);
  check('two admins suspending the same collector from two reports: one suspension, one already_suspended',
    [s1, s2].filter((r) => !r.error).length === 1 && code([s1, s2].find((r) => r.error)!.error)?.code === 'already_suspended', [s1.error, s2.error]);
  check('exactly one active suspension', psql(`SELECT count(*) FROM public.account_suspensions WHERE user_id = ${lit(O.id)} AND lifted_at IS NULL`) === '1');
  const sv2 = await view(A, m);
  check('view: suspended, with reason and expiry', sv2.account.suspended && !!sv2.account.suspension.reason_code && sv2.account.suspension.state === 'active');
  const blocked = await O.db.from('posts').insert({ user_id: O.id, content: 'while suspended', post_type: 'text' });
  check('the suspended collector cannot post', !!blocked.error);
  const mine = await O.db.rpc('my_account_suspension');
  check('the suspended collector can still see their own suspension (and keeps deletion/export paths)', !mine.error, mine.error);
  check('suspension deleted no content and started no deletion',
    psql(`SELECT count(*) FROM public.posts WHERE user_id = ${lit(O.id)}`) === ownPosts
    && psql(`SELECT count(*) FROM public.account_lifecycle WHERE user_id = ${lit(O.id)}`) === '0');
  const lift = await enforce(B, m, 'lift_suspension', 'appeal_granted');
  check('lifted', !lift.error && !(await view(A, m)).account.suspended, lift.error);

  step('7. Losing administrator access mid-session');
  psql(`DELETE FROM public.admin_users WHERE user_id = ${lit(B.id)}`);
  const lost = await enforce(B, reports.folder, 'suspend', 'spam', {}, null, (await view(A, reports.folder)).version);
  check('a removed admin is refused on the very next enforcement call', code(lost.error)?.kind === 'forbidden', lost.error);

  step('8. The app offers only these RPCs');
  const client = readFileSync(new URL('../../lib/admin-reports.ts', import.meta.url), 'utf8');
  const ui = ['../../components/admin/report-enforcement.tsx', '../../app/admin/report/[id].tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  const rpcs = [...client.matchAll(/'(admin_[a-z_]+)'/g)].map((x) => x[1]).sort();
  check('client RPCs: the M5.1 three, admin_report_enforcement / admin_report_enforce (M5.2), admin_report_evidence (M5.3)',
    JSON.stringify(rpcs) === JSON.stringify(['admin_report_case', 'admin_report_case_action', 'admin_report_enforce', 'admin_report_enforcement', 'admin_report_evidence', 'admin_report_queue']), rpcs);
  check('no direct enforcement RPCs, deletion, purge or service role in the app code',
    !/admin_(hide|remove|restore)_content|admin_suspend_account|admin_lift_suspension|admin_[a-z]+_profile_fields|retention_|delete_account|SERVICE_ROLE|service_role|console\.(log|warn|error)/.test(client + ui));
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
                             || (SELECT count(*) FROM public.moderated_content)`);
  check('nothing switched on; no fixture reports, jobs or restrictions left', state === 'false,false,0,0,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}

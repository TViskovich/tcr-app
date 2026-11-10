/// <reference types="node" />
// Admin report queue and audit trail (20261115120000_moderation_admin.sql) —
// end-to-end against the LOCAL Supabase stack through PostgREST (and
// GraphQL), exactly as the app, an admin's device or a hostile client would
// call it. Disposable collectors and admins are created with the Auth admin
// API; reports are filed through submit_report like the app does.
//
// Cleanup note: the audit trail is append-only even for the service role,
// so this script removes its own fixture audit rows through a local
// superuser psql session (session_replication_role = replica) — the
// documented superuser limitation, scoped to this run's fixture reports.
//
// Prerequisite: local Supabase with the migration applied.
// Run:  node scripts/integration/admin-moderation.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'admin-moderation-it';
const MARK = 'am-it fixture'; // every report this script files carries it in its details
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

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

type U = { id: string; username: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `am${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Am-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, username, token: s.session!.access_token, db };
}

const conversations = new Set<string>();
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  // Fixture reports and their audit rows (superuser only — see header).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%');
        COMMIT;`);
  await service.from('content_reports').delete().like('details', `${MARK}%`);
  if (ids.length) {
    const { data: parts } = await service.from('conversation_participants').select('conversation_id').in('user_id', ids);
    for (const p of parts ?? []) conversations.add(p.conversation_id);
  }
  if (conversations.size) await service.from('conversations').delete().in('id', [...conversations]);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string; code?: string } | null; status: number };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const refused = (r: R, token: string, status?: number) => !!r.error && (r.error.message ?? '').includes(token) && (status === undefined || r.status === status);
const report = (u: U, type: string, id: string, reason = 'spam') =>
  u.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` });
const reportId = async (type: string, target: string, reporter: string) =>
  (must(await service.from('content_reports').select('id').eq('target_type', type).eq('target_id', target).eq('reporter_id', reporter).single(), 'report id') as { id: string }).id;
// Extra reports for concurrency rounds, inserted as the server would (no client path).
async function seedReports(n: number, owner: string): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({ target_type: 'post', target_id: randomUUID(), target_owner_id: owner, reason: 'spam',
    details: `${MARK} ${run} seed ${i}`, evidence: { v: 1, content: `am seed ${i}` } }));
  return (must(await service.from('content_reports').insert(rows).select('id'), 'seed') as { id: string }[]).map((r) => r.id);
}
const auditRows = async (reportIdV: string) =>
  must(await service.from('moderation_actions').select('*').eq('report_id', reportIdV).order('created_at'), 'audit') as any[];

async function main() {
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  const M3 = await createUser('m3'); // admin, then pending deletion
  const N = await createUser('n');   // ordinary collector
  const A = await createUser('a');   // reporter
  const C = await createUser('c');   // reporter
  const B = await createUser('b');   // reported collector
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }, { user_id: M3.id }]), 'admins');

  step('0. Fixtures: B posts and DMs A; A and C report through submit_report');
  const pB = randomUUID();
  must(await B.db.from('posts').insert({ id: pB, user_id: B.id, content: 'am post by B', post_type: 'text' }), 'post');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conversation') as string;
  conversations.add(conv);
  const mB = randomUUID(), mA = randomUUID(), cB = randomUUID();
  must(await B.db.from('messages').insert({ id: mB, conversation_id: conv, sender_id: B.id, body: 'am abusive DM' }), 'B→A');
  must(await A.db.from('messages').insert({ id: mA, conversation_id: conv, sender_id: A.id, body: 'am private reply from A' }), 'A→B');
  must(await B.db.from('comments').insert({ id: cB, user_id: B.id, post_id: pB, body: 'am comment by B' }), 'comment');
  for (const r of [await report(A, 'post', pB, 'violence'), await report(C, 'post', pB), await report(A, 'message', mB, 'harassment'),
                   await report(A, 'comment', cB, 'hate'), await report(C, 'profile', B.id)]) must(r, 'report');
  const rPostA = await reportId('post', pB, A.id), rPostC = await reportId('post', pB, C.id);
  const rMsg = await reportId('message', mB, A.id), rComment = await reportId('comment', cB, A.id), rProfile = await reportId('profile', B.id, C.id);
  check('fixtures and 5 reports filed', true);

  step('1. Authorization (signed-out, collector, pending admin, admin)');
  const anonList = await (anon.rpc('admin_list_reports') as unknown as Promise<R>);
  check('signed-out: admin_list_reports refused', !!anonList.error && [401, 403].includes(anonList.status), anonList);
  check('signed-out: admin_get_report refused', !!(await (anon.rpc('admin_get_report', { p_report_id: rPostA }) as unknown as Promise<R>)).error);
  for (const [fn, args] of [
    ['admin_list_reports', {}], ['admin_report_counts', {}], ['admin_get_report', { p_report_id: rPostA }],
    ['admin_claim_report', { p_report_id: rPostA }], ['admin_release_report', { p_report_id: rPostA }],
    ['admin_resolve_report', { p_report_id: rPostA, p_outcome: 'no_violation', p_reason_code: 'within_guidelines' }],
    ['admin_reopen_report', { p_report_id: rPostA, p_reason_code: 'new_information' }],
  ] as const) {
    check(`collector: ${fn} → 403 forbidden`, refused(await rpc(N, fn, args), 'forbidden', 403));
  }
  check('the reported collector cannot use the queue either', refused(await rpc(B, 'admin_list_reports'), 'forbidden', 403));
  const s1 = await service.rpc('admin_list_reports');
  check('service role (no admin identity) cannot call admin functions', !!s1.error, s1.error);
  check('admin: admin_list_reports accepted', !(await rpc(M1, 'admin_list_reports')).error);
  psql(`INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for) VALUES ('${M3.id}', 'pending_deletion', 'scheduled', now(), now() + interval '30 days')`);
  check('an admin pending deletion is refused (existing session)', refused(await rpc(M3, 'admin_list_reports'), 'account_inactive', 403));

  step('2. No direct access: PostgREST tables and GraphQL');
  for (const u of [N, M1]) {
    const who = u === N ? 'collector' : 'admin';
    const sel = await u.db.from('content_reports').select('id').limit(1);
    check(`${who}: cannot select content_reports`, !!sel.error || (sel.data ?? []).length === 0, sel.error ?? sel.data);
    const selA = await u.db.from('moderation_actions').select('id').limit(1);
    check(`${who}: cannot select moderation_actions`, !!selA.error || (selA.data ?? []).length === 0, selA.error ?? selA.data);
    const ins = await u.db.from('moderation_actions').insert({ admin_id: u.id, action: 'claim', target_type: 'post', target_id: pB });
    check(`${who}: cannot insert audit rows`, !!ins.error, ins);
    const upd = await u.db.from('content_reports').update({ status: 'dismissed' }).eq('id', rPostA).select('id');
    check(`${who}: cannot change report status directly`, !!upd.error || (upd.data ?? []).length === 0, upd);
  }
  const gql = await (await fetch(`${st.API_URL}/graphql/v1`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${M1.token}` },
    body: JSON.stringify({ query: '{ moderationActionsCollection { edges { node { id note } } } contentReportsCollection { edges { node { id reporterId } } } }' }) })).json();
  check('GraphQL exposes no reports or audit rows (even to an admin)',
    !gql?.data?.moderationActionsCollection?.edges?.length && !gql?.data?.contentReportsCollection?.edges?.length, gql?.errors?.[0]?.message ?? gql?.data);

  step('3. Queue, detail, privacy');
  const list = await rpc(M1, 'admin_list_reports', { p_statuses: ['open'], p_limit: 50 });
  const mine = (list.data?.items ?? []).filter((i: any) => [rPostA, rPostC, rMsg, rComment, rProfile].includes(i.id));
  check('the queue lists the 5 reports', mine.length === 5, list.error ?? mine.length);
  check('urgent (violence) report sorts before this run\'s normal ones',
    (list.data.items as any[]).findIndex((i) => i.id === rPostA) < (list.data.items as any[]).findIndex((i) => i.id === rPostC));
  const listText = JSON.stringify(list.data);
  check('queue never contains a reporter id or username', !listText.includes(A.id) && !listText.includes(C.id) && !listText.includes(A.username) && !listText.includes(C.username) && !/reporter/.test(listText));
  const detail = await rpc(M1, 'admin_get_report', { p_report_id: rMsg });
  const dText = JSON.stringify(detail.data);
  check('message detail: the reported message, current and as filed', detail.data?.current?.content?.body === 'am abusive DM' && detail.data?.evidence?.body === 'am abusive DM');
  check('message detail: no other message, no conversation id', !dText.includes('am private reply') && !dText.includes(conv));
  check('detail: reporter is only {present:true}', JSON.stringify(detail.data?.reporter) === '{"present":true}' && !dText.includes(A.id) && !dText.includes(A.username));
  check('detail: the reported account', detail.data?.owner?.username === B.username && detail.data?.owner?.account_state === 'active');
  check('unknown report → 404 not_found', refused(await rpc(M1, 'admin_get_report', { p_report_id: randomUUID() }), 'not_found', 404));
  check('limit 51 → 400 invalid_limit', refused(await rpc(M1, 'admin_list_reports', { p_limit: 51 }), 'invalid_limit', 400));
  check('mixed statuses → 400 invalid_status', refused(await rpc(M1, 'admin_list_reports', { p_statuses: ['open', 'dismissed'] }), 'invalid_status', 400));
  check('malformed cursor → 400 invalid_cursor', refused(await rpc(M1, 'admin_list_reports', { p_cursor: { r: 7, t: 'x', id: 'y' } }), 'invalid_cursor', 400));
  check('malformed uuid → 400', (await rpc(M1, 'admin_get_report', { p_report_id: 'not-a-uuid' })).status === 400);
  // Pagination over the whole pending queue (it may include other local data).
  const seen: string[] = [];
  let cursor: unknown = null, pages = 0;
  do {
    const page = await rpc(M1, 'admin_list_reports', { p_limit: 2, p_cursor: cursor });
    if (page.error) { check('pagination page', false, page.error); break; }
    seen.push(...page.data.items.map((i: any) => i.id));
    cursor = page.data.next_cursor; pages++;
  } while (cursor && pages < 500);
  const counts = (await rpc(M1, 'admin_report_counts')).data;
  check('2-row pages walk the pending queue with no repeats and match the counts',
    new Set(seen).size === seen.length && seen.length === counts.open + counts.reviewing, { seen: seen.length, counts });
  must(await B.db.from('comments').delete().eq('id', cB), 'B deletes comment');
  const gone = await rpc(M1, 'admin_get_report', { p_report_id: rComment });
  check('deleted content: current gone, evidence kept', gone.data?.current?.exists === false && gone.data?.evidence?.body === 'am comment by B');

  step('4. Concurrency: two admins, same report, same instant');
  const seeds = await seedReports(12, B.id);
  let exactlyOne = 0;
  for (const id of seeds.slice(0, 10)) {
    const [x, y] = await Promise.all([rpc(M1, 'admin_claim_report', { p_report_id: id }), rpc(M2, 'admin_claim_report', { p_report_id: id })]);
    const wins = [x, y].filter((r) => !r.error && r.data?.changed === true).length;
    const loses = [x, y].filter((r) => refused(r, 'claimed_by_other', 409)).length;
    if (wins === 1 && loses === 1 && (await auditRows(id)).length === 1) exactlyOne++;
  }
  check('10 simultaneous claim races: exactly one winner, one 409, one audit row each', exactlyOne === 10, exactlyOne);
  const rRace = seeds[10];
  const both = await Promise.all([
    rpc(M1, 'admin_resolve_report', { p_report_id: rRace, p_outcome: 'no_violation', p_reason_code: 'within_guidelines' }),
    rpc(M2, 'admin_resolve_report', { p_report_id: rRace, p_outcome: 'duplicate', p_reason_code: 'duplicate_report' })]);
  check('two admins resolving an open report at once: one wins, the other gets already_resolved',
    both.filter((r) => !r.error).length === 1 && both.filter((r) => refused(r, 'already_resolved', 409)).length === 1
    && (await auditRows(rRace)).length === 1, both.map((r) => r.error?.message ?? r.data));
  const rRetry = seeds[11];
  const retries = await Promise.all(Array.from({ length: 5 }, () =>
    rpc(M1, 'admin_resolve_report', { p_report_id: rRetry, p_outcome: 'no_violation', p_reason_code: 'insufficient_evidence', p_note: 'am retry' })));
  check('5 identical concurrent retries: all succeed, one change, one audit row',
    retries.every((r) => !r.error) && retries.filter((r) => r.data.changed).length === 1 && (await auditRows(rRetry)).length === 1,
    retries.map((r) => r.error?.message ?? r.data?.changed));

  step('5. Transitions, outcomes, reopen');
  check('content_hidden is not an available outcome yet',
    refused(await rpc(M1, 'admin_resolve_report', { p_report_id: rPostA, p_outcome: 'content_hidden', p_reason_code: 'within_guidelines' }), 'invalid_outcome', 400));
  check('account_suspended is not an available outcome yet',
    refused(await rpc(M1, 'admin_resolve_report', { p_report_id: rPostA, p_outcome: 'account_suspended', p_reason_code: 'within_guidelines' }), 'invalid_outcome', 400));
  check('M1 claims the post report', (await rpc(M1, 'admin_claim_report', { p_report_id: rPostA })).data?.changed === true);
  check('M2 cannot resolve it (409)',
    refused(await rpc(M2, 'admin_resolve_report', { p_report_id: rPostA, p_outcome: 'no_violation', p_reason_code: 'within_guidelines' }), 'claimed_by_other', 409));
  const res = await rpc(M1, 'admin_resolve_report', { p_report_id: rPostA, p_outcome: 'no_violation', p_reason_code: 'within_guidelines',
    p_note: 'am reviewed', p_include_related: true });
  check('M1 resolves it with the related report', res.data?.status === 'dismissed' && res.data?.related_resolved === 1, res.error ?? res.data);
  const row = must(await service.from('content_reports').select('status, resolution, reviewed_by, evidence_purge_after, reviewed_at').eq('id', rPostA).single(), 'row') as any;
  const days = (Date.parse(row.evidence_purge_after) - Date.parse(row.reviewed_at)) / 86_400_000;
  check('stored: dismissed / no_violation, reviewer, purge date = resolution + 90 days', row.status === 'dismissed' && row.resolution === 'no_violation'
    && row.reviewed_by === M1.id && Math.abs(days - 90) < 1e-6, row);
  check('the related report is dismissed too', (must(await service.from('content_reports').select('status').eq('id', rPostC).single(), 'c') as any).status === 'dismissed');
  check('target_deleted closes the deleted-comment report',
    (await rpc(M1, 'admin_resolve_report', { p_report_id: rComment, p_outcome: 'administrative_closure', p_reason_code: 'target_deleted' })).data?.status === 'dismissed');
  check('reopen an open report → 409 not_resolved', refused(await rpc(M1, 'admin_reopen_report', { p_report_id: rMsg, p_reason_code: 'new_information' }), 'not_resolved', 409));
  check('reopen the dismissed comment report', (await rpc(M2, 'admin_reopen_report', { p_report_id: rComment, p_reason_code: 'resolved_in_error' })).data?.status === 'open');
  const hist = (await rpc(M1, 'admin_get_report', { p_report_id: rPostA })).data?.history ?? [];
  check('history: claim then resolve, by M1, with the note', hist.length === 2 && hist[0].action === 'claim' && hist[1].action === 'resolve'
    && hist[1].note === 'am reviewed' && hist[1].admin?.is_me === true, hist);

  step('6. Audit trail is append-only');
  const sIns = await service.from('moderation_actions').insert({ admin_id: M1.id, action: 'claim', target_type: 'post', target_id: pB });
  check('service role cannot insert audit rows', !!sIns.error, sIns);
  const sUpd = await service.from('moderation_actions').update({ note: 'rewritten' }).eq('report_id', rPostA).select('id');
  check('service role cannot update audit rows', !!sUpd.error, sUpd);
  const sDel = await service.from('moderation_actions').delete().eq('report_id', rPostA).select('id');
  check('service role cannot delete audit rows', !!sDel.error, sDel);
  check('audit rows unchanged', (await auditRows(rPostA)).length === 2 && (await auditRows(rPostA))[1].note === 'am reviewed');
  const rDel = await service.from('content_reports').delete().eq('id', rPostA).select('id');
  check('a report with audit history cannot be deleted (even by the service role)', !!rDel.error, rDel);

  step('7. No writes to collector content');
  const post = must(await service.from('posts').select('content').eq('id', pB).single(), 'post') as any;
  const msgs = must(await service.from('messages').select('id, body').eq('conversation_id', conv).order('created_at'), 'msgs') as any[];
  check('the reported post and the DMs are untouched', post.content === 'am post by B' && msgs.length === 2 && msgs.some((m) => m.body === 'am abusive DM'));

  step('8. Account deletion keeps history, anonymised');
  must(await service.auth.admin.deleteUser(M2.id) as { data: unknown; error: unknown }, 'delete M2');
  const m2Rows = must(await service.from('moderation_actions').select('admin_id').in('report_id', [rComment, rRace, ...seeds.slice(0, 10)]).is('admin_id', null), 'm2 rows') as any[];
  check('deleting an admin keeps their audit rows with the actor nulled', m2Rows.length >= 1, m2Rows.length);
  must(await service.auth.admin.deleteUser(B.id) as { data: unknown; error: unknown }, 'delete B');
  const after = await rpc(M1, 'admin_get_report', { p_report_id: rProfile });
  check('deleting the reported account: report and evidence stay, owner shown as deleted',
    after.data?.owner?.account_state === 'deleted' && after.data?.evidence?.username === B.username, after.error ?? after.data?.owner);
  const ownerAudit = must(await service.from('moderation_actions').select('target_owner_id').eq('report_id', rPostA), 'owner audit') as any[];
  check('audit rows for the deleted owner are anonymised', ownerAudit.length === 2 && ownerAudit.every((r) => r.target_owner_id === null));
  check('account_deleted closes the profile report',
    (await rpc(M1, 'admin_resolve_report', { p_report_id: rProfile, p_outcome: 'administrative_closure', p_reason_code: 'account_deleted' })).data?.status === 'dismissed');
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
  const left = psql(`SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%'`);
  console.log(`Fixture reports left: ${left}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

/// <reference types="node" />
// Administrator report review (Phase 2B M5.1,
// 20261201120000_admin_report_review.sql, app/admin/reports.tsx,
// app/admin/report/[id].tsx, lib/admin-reports*.ts) — the API exactly as the
// app calls it (PostgREST RPCs with real user sessions), on an ISOLATED
// disposable local stack with synthetic fixtures: three admins, a reporter,
// a reported collector, an ordinary collector and anonymous callers.
// Reports are filed through the real submit_report path.
//
// Nothing here hides, removes, restores or suspends content, sends alerts or
// touches a scheduler. It refuses to run against the primary local stack.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/admin-report-review.ts
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
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'admin-report-review-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const SECRET_TEXT = `PRIVATE-REPORTED-TEXT-${run}`;
const SECRET_DETAILS = `PRIVATE-REPORTER-DETAILS-${run}`;
const SECRET_URL = `https://example.invalid/private-${run}.jpg`;
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; db: SupabaseClient; username: string };
async function createUser(key: string): Promise<U> {
  const username = `rrv${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Rrv-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE } });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db, username };
}

const fail = (e: { code?: string; message?: string } | null, status?: number) => (e ? classifyError({ code: e.code, message: e.message, status }) : null);
const queue = (db: SupabaseClient, args: Record<string, unknown> = {}) =>
  db.rpc('admin_report_queue', { p_view: 'open', p_target_type: null, p_reason: null, p_priority: null, p_age: null, p_sort: null, p_limit: 20, p_cursor: null, ...args });
const caseOf = (db: SupabaseClient, id: string) => db.rpc('admin_report_case', { p_report_id: id });
const act = (db: SupabaseClient, id: string, action: string, version: string, extra: Record<string, unknown> = {}) =>
  db.rpc('admin_report_case_action', { p_report_id: id, p_action: action, p_expected_version: version, p_outcome: null, p_reason_code: null, p_note: null, ...extra });
const audits = (id: string, action: string) => Number(psql(`SELECT count(*) FROM public.moderation_actions WHERE report_id = ${lit(id)} AND action = ${lit(action)}`));

async function cleanup(): Promise<number> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  const users = ids.map(lit).join(',') || 'NULL';
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${users}) OR target_owner_id IN (${users}));
        DELETE FROM public.content_reports WHERE reporter_id IN (${users}) OR target_owner_id IN (${users});
        DELETE FROM public.account_suspensions WHERE user_id IN (${users});
        DELETE FROM public.admin_users WHERE user_id IN (${users});
        COMMIT;`);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const S = await createUser('s');
  const X = await createUser('x');
  const N = await createUser('n');
  const R = await createUser('r');
  const O = await createUser('o');
  const ins = await service.from('admin_users').insert([{ user_id: A.id }, { user_id: B.id }, { user_id: S.id }, { user_id: X.id }]);
  if (ins.error) throw new Error('admins');
  psql(`INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (${lit(S.id)}, 'spam')`);
  const before = psql(`SELECT (SELECT count(*) FROM public.moderated_content) || ',' || (SELECT count(*) FROM public.account_suspensions)`);

  // O's content; R reports it through the real submit_report path.
  const posts: string[] = [];
  for (const [n, content, image] of [[1, SECRET_TEXT, SECRET_URL], [2, 'second post', null], [3, 'third post', null]] as const) {
    const { data, error } = await O.db.from('posts').insert({ user_id: O.id, content, post_type: 'text', image_url: image }).select('id').single();
    if (error) throw new Error(`post ${n}: ${error.message}`);
    posts.push(data.id);
  }
  for (const [type, id, reason, details] of [
    ['post', posts[0], 'harassment', SECRET_DETAILS], ['post', posts[1], 'spam', null], ['post', posts[2], 'hate', null], ['profile', O.id, 'child_safety', null],
  ] as const) {
    const { error } = await R.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: details });
    if (error) throw new Error(`submit_report ${type}: ${error.message}`);
  }
  const rid = (reason: string) => psql(`SELECT id FROM public.content_reports WHERE reporter_id = ${lit(R.id)} AND reason = ${lit(reason)}`);
  const [rHar, rSpam, rHate, rChild] = ['harassment', 'spam', 'hate', 'child_safety'].map(rid);

  step('1. Who can reach reports');
  const qa = await queue(A.db);
  check('admin: queue loads', !qa.error && Array.isArray(qa.data?.items), qa.error);
  for (const [who, db] of [['collector', N.db], ['reporter', R.db], ['reported collector', O.db]] as const) {
    const q = await queue(db);
    const c = await caseOf(db, rHar);
    check(`${who}: queue and case refused (forbidden)`, fail(q.error)?.kind === 'forbidden' && fail(c.error)?.kind === 'forbidden' && !q.data && !c.data, [q.error, c.error]);
  }
  const an = await queue(anon);
  check('anonymous: refused, no data', !!an.error && !an.data, an.status);
  const sv = await service.rpc('admin_report_queue', {});
  check('service role: no admin identity, refused', !!sv.error && !sv.data);
  const sq = await queue(S.db);
  const sc = await caseOf(S.db, rHar);
  check('suspended admin: queue and evidence refused (inactive)', fail(sq.error)?.kind === 'inactive' && fail(sc.error)?.kind === 'inactive', [sq.error, sc.error]);
  const xq = await queue(X.db);
  check('admin X can read before removal', !xq.error);
  psql(`DELETE FROM public.admin_users WHERE user_id = ${lit(X.id)}`);
  const xq2 = await queue(X.db);
  const xc = await caseOf(X.db, rHar);
  check('removed admin: refused on the very next call, same session (forbidden)', fail(xq2.error)?.kind === 'forbidden' && fail(xc.error)?.kind === 'forbidden', [xq2.error, xc.error]);
  const bogus = createClient(st.API_URL, st.ANON_KEY, { ...opts, global: { headers: { Authorization: 'Bearer not-a-valid-token' } } });
  const bq = await bogus.rpc('admin_report_queue', {});
  check('invalid or expired session token: refused and classified as session expired', fail(bq.error, bq.status)?.kind === 'session_expired' && !bq.data, [bq.status, bq.error?.code]);
  const gone = await createUser('g');
  await service.from('admin_users').insert({ user_id: gone.id });
  await gone.db.auth.signOut();
  const gq = await queue(gone.db);
  check('signed-out admin client: refused', !!gq.error && !gq.data, gq.status);

  step('2. Queue');
  const items = qa.data.items as any[];
  const mine = items.filter((i) => [rHar, rSpam, rHate, rChild].includes(i.id));
  check('the four filed reports are open', mine.length === 4);
  const first = items.findIndex((i) => i.id === rChild);
  check('child-safety report is urgent, flagged and ahead of every normal report',
    mine.find((i) => i.id === rChild)?.child_safety === true && items[first]?.priority === 'urgent' && items.slice(0, first).every((i) => i.priority === 'urgent'));
  const qtext = JSON.stringify(qa.data);
  check('queue payload has no report text, details, URLs, usernames or account ids',
    ![SECRET_TEXT, SECRET_DETAILS, SECRET_URL, R.id, O.id, R.username, O.username].some((s) => qtext.includes(s)));
  const fr = await queue(A.db, { p_reason: 'hate' });
  check('reason filter', fr.data?.items.length >= 1 && fr.data.items.every((i: any) => i.reason === 'hate'), fr.data);
  const fp = await queue(A.db, { p_priority: 'urgent', p_age: 'under_24h' });
  check('priority + age filter', fp.data?.items.some((i: any) => i.id === rChild) && fp.data.items.every((i: any) => i.priority === 'urgent'));
  let cursor: unknown = null;
  const walked: string[] = [];
  for (let i = 0; i < 50; i++) {
    const p = await queue(A.db, { p_limit: 1, p_cursor: cursor });
    walked.push(...p.data.items.map((x: any) => x.id));
    cursor = p.data.next_cursor;
    if (!cursor) break;
  }
  check('incremental loading (1 per page) returns the whole queue once, in order', JSON.stringify(walked) === JSON.stringify(items.map((i) => i.id)), walked.length);

  step('3. Case and restricted evidence');
  const c1 = await caseOf(A.db, rHar);
  const ctext = JSON.stringify(c1.data);
  check('case loads with evidence, current state and history', !c1.error && c1.data?.evidence?.content === SECRET_TEXT && c1.data?.current?.exists === true, c1.error);
  check('reporter identity withheld (only "present")', JSON.stringify(c1.data?.reporter) === '{"present":true}' && !ctext.includes(R.id) && !ctext.includes(R.username));
  check('reporter’s permitted details are shown to the admin', c1.data?.report?.details === SECRET_DETAILS);
  check('media URLs withheld from evidence and current content', !ctext.includes(SECRET_URL) && c1.data?.current?.content?.withheld_media?.[0] === 'image_url');
  check('only the reported post is returned (no other posts of the account)', !ctext.includes('second post') && !ctext.includes('third post'));
  const nf = await caseOf(A.db, randomUUID());
  check('unknown report → not found', fail(nf.error)?.kind === 'not_found');

  step('4. Two admins claim the same report at once');
  const v0 = c1.data.case.version as string;
  const [ca, cb] = await Promise.all([act(A.db, rHar, 'claim', v0), act(B.db, rHar, 'claim', v0)]);
  const winners = [ca, cb].filter((r) => !r.error);
  const loser = [ca, cb].find((r) => r.error);
  check('exactly one claim succeeds', winners.length === 1, [ca.error, cb.error]);
  check('the other gets a conflict (report_changed or claimed_by_other), not an overwrite',
    ['report_changed', 'claimed_by_other'].includes((fail(loser?.error ?? null) as any)?.code), loser?.error);
  check('one claim audit row', audits(rHar, 'claim') === 1);
  const holder = ca.error ? B : A;
  const other = ca.error ? A : B;
  const hv = (await caseOf(holder.db, rHar)).data.case.version as string;
  const steal = await act(other.db, rHar, 'dismiss', hv, { p_outcome: 'no_violation', p_reason_code: 'within_guidelines' });
  check('the other admin cannot dismiss the claimed report', (fail(steal.error) as any)?.code === 'claimed_by_other', steal.error);

  step('5. Conflicting decisions by the claimant');
  const [d1, d2] = await Promise.all([
    act(holder.db, rHar, 'dismiss', hv, { p_outcome: 'no_violation', p_reason_code: 'within_guidelines', p_note: 'it note' }),
    act(holder.db, rHar, 'release', hv),
  ]);
  const ok = [d1, d2].filter((r) => !r.error);
  check('dismiss vs release from the same view: exactly one applies, the other is report_changed',
    ok.length === 1 && (fail([d1, d2].find((r) => r.error)!.error) as any)?.code === 'report_changed', [d1.error, d2.error]);
  const afterDecision = await caseOf(A.db, rHar);
  const status1 = afterDecision.data.report.status;
  check('the report reflects the winner only', (d1.error ? status1 === 'open' : status1 === 'dismissed'));
  if (status1 === 'open') {
    // release won; claim and dismiss so the reopen race below has a dismissed report.
    const c = await act(A.db, rHar, 'claim', afterDecision.data.case.version);
    const v = (await caseOf(A.db, rHar)).data.case.version;
    const d = await act(A.db, rHar, 'dismiss', v, { p_outcome: 'no_violation', p_reason_code: 'within_guidelines' });
    if (c.error || d.error) throw new Error('setup dismiss');
  }
  const dv = (await caseOf(A.db, rHar)).data.case.version as string;
  const [r1, r2] = await Promise.all([
    act(A.db, rHar, 'reopen', dv, { p_reason_code: 'new_information' }),
    act(B.db, rHar, 'reopen', dv, { p_reason_code: 'quality_review' }),
  ]);
  check('two admins reopening at once: one reopen, one conflict', [r1, r2].filter((r) => !r.error).length === 1
    && ['report_changed', 'not_resolved'].includes((fail([r1, r2].find((r) => r.error)!.error) as any)?.code), [r1.error, r2.error]);
  check('one reopen audit row', audits(rHar, 'reopen') === 1);
  const retry = await act(A.db, rHar, 'dismiss', dv, { p_outcome: 'duplicate', p_reason_code: 'duplicate_report' });
  check('a stale screen cannot overwrite the reopen (report_changed)', (fail(retry.error) as any)?.code === 'report_changed', retry.error);
  const enf = await act(A.db, rHar, 'remove', dv);
  check('no enforcement action through the case endpoint', fail(enf.error)?.kind === 'invalid');

  step('6. Losing admin standing mid-case');
  const sv0 = (await caseOf(A.db, rSpam)).data.case.version as string;
  const cl = await act(A.db, rSpam, 'claim', sv0);
  check('A claims a report', !cl.error, cl.error);
  psql(`INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (${lit(A.id)}, 'spam')`);
  const sus = await act(A.db, rSpam, 'dismiss', cl.data?.version ?? '', { p_outcome: 'no_violation', p_reason_code: 'within_guidelines' });
  const susRead = await caseOf(A.db, rSpam);
  check('suspended mid-case: A can no longer decide or read (inactive)', fail(sus.error)?.kind === 'inactive' && fail(susRead.error)?.kind === 'inactive');
  const bView = await caseOf(B.db, rSpam);
  check('B sees A’s claim as stale and may take it over', bView.data?.case?.claim === 'stale' && bView.data?.case?.can?.claim === true);
  const take = await act(B.db, rSpam, 'claim', bView.data.case.version);
  check('B takes over; audited as a stale takeover', !take.error && Number(psql(`SELECT count(*) FROM public.moderation_actions WHERE report_id = ${lit(rSpam)} AND action = 'claim' AND metadata ? 'took_over_stale_claim'`)) === 1);
  psql(`UPDATE public.account_suspensions SET lifted_at = now(), lift_reason = 'resolved_in_error' WHERE user_id = ${lit(A.id)} AND lifted_at IS NULL`);
  const back = await queue(A.db);
  check('A regains access once the suspension is lifted (server-side standing, not a cached flag)', !back.error);

  step('7. Purged evidence');
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE public.content_reports SET status = 'dismissed', resolution = 'no_violation', resolution_reason = 'within_guidelines', reviewed_at = now() - interval '100 days',
               reviewed_by = ${lit(B.id)}, evidence_purge_after = now() - interval '10 days', evidence = NULL, evidence_purged_at = now() - interval '9 days'
         WHERE id = ${lit(rHate)}; COMMIT;`);
  const pc = await caseOf(A.db, rHate);
  check('purged evidence: case loads with evidence "purged" and no content', !pc.error && pc.data.case.evidence === 'purged' && pc.data.evidence === null);
  const pr = await act(A.db, rHate, 'reopen', pc.data.case.version, { p_reason_code: 'new_information' });
  check('purged report cannot be reopened (evidence is never restored)', (fail(pr.error) as any)?.code === 'evidence_unavailable');
  check('evidence stays purged', psql(`SELECT evidence IS NULL AND evidence_purged_at IS NOT NULL FROM public.content_reports WHERE id = ${lit(rHate)}`) === 't');

  step('8. Nothing was enforced; the app offers no enforcement');
  const after = psql(`SELECT (SELECT count(*) FROM public.moderated_content) || ',' || (SELECT count(*) FROM public.account_suspensions)`);
  check('no content restricted; suspensions only the test’s own', after.split(',')[0] === before.split(',')[0] && Number(after.split(',')[1]) === Number(before.split(',')[1]) + 1, [before, after]);
  const visible = await N.db.from('posts').select('id').in('id', posts);
  check('reported posts are still visible to other collectors', visible.data?.length === 3);
  const client = readFileSync(new URL('../../lib/admin-reports.ts', import.meta.url), 'utf8');
  const screens = ['../../app/admin/reports.tsx', '../../app/admin/report/[id].tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  const rpcs = [...client.matchAll(/'(admin_[a-z_]+)'/g)].map((m) => m[1]).sort();
  // M5.2 adds the version-checked enforcement entry point and its read model;
  // M5.3 the report-scoped evidence/restoration/hold read model.
  check('the report client calls only the review RPCs (M5.1), the enforcement wrapper (M5.2) and the evidence view (M5.3)',
    JSON.stringify(rpcs) === JSON.stringify(['admin_report_case', 'admin_report_case_action', 'admin_report_enforce', 'admin_report_enforcement', 'admin_report_evidence', 'admin_report_queue']), rpcs);
  check('no enforcement, legal-hold, purge or service-role RPCs (and no logging) in the screens or client in the screens or client',
    !/admin_(hide|remove|restore)_content|admin_(suspend_account|lift_suspension)|admin_(clear|restore|release)_profile_fields|legal_hold'|retention_|SERVICE_ROLE|service_role|console\.(log|info|warn|error)/.test(client + screens));
}

const stale = await cleanup();
if (stale) console.log(`(removed ${stale} stale fixture account(s) first)`);
try {
  await main();
} catch (e) {
  check('script ran to completion', false, (e as Error).message);
} finally {
  console.log(`\nCleanup: ${await cleanup()} account(s) removed.`);
  const state = psql(`SELECT (SELECT bool_or(active) FROM cron.job)::text || ',' || (SELECT delivery_enabled FROM private.moderation_monitoring_state)::text || ','
                             || (SELECT enabled FROM private.media_quarantine_scheduler_config)::text || ',' || (SELECT count(*) FROM public.content_reports)`);
  check('nothing switched on; no fixture reports left', state === 'false,false,false,0', state);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}

// Administrator report review (Phase 2B M5.1) — UI test of the real Reports
// screens (web build) against an ISOLATED disposable local Supabase stack.
// Two admins (A, B) in separate browser contexts, plus a collector N. The
// reports are filed by a reporter R through the real submit_report path; the
// service role only creates/deletes accounts and grants or removes admin rows.
//
// Prerequisites: an isolated stack (CACHECASE_STACK_WORKDIR), a local-only
// Metro on :8090 whose EXPO_PUBLIC_SUPABASE_URL is that stack, and
// shell-proxy.mjs on :8091.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/ui/admin-reports-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from '../local-stack.ts';
import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'admin-reports-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-admin-reports-ui`;
mkdirSync(OUT, { recursive: true });

const stack = requireIsolatedStack();
const st = stack.st;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
{
  const html = await (await fetch(APP)).text();
  const src = html.match(/src="([^"]+entry\.bundle[^"]*)"/)?.[1];
  const bundle = await (await fetch(new URL(src, APP))).text();
  if (!bundle.includes(`"EXPO_PUBLIC_SUPABASE_URL": { enumerable: true, value: "${st.API_URL}"`)) {
    throw new Error('Refusing: the web build is not pointed at the isolated stack.');
  }
}

// ── Check harness ──────────────────────────────────────────────────────────
const results = [];
let current = '';
const step = (name) => {
  current = name;
  console.log(`\n${name}`);
};
function check(name, ok, detail) {
  results.push({ step: current, name, ok: !!ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
async function eventually(name, page, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last === true) return check(name, true);
    } catch (e) {
      last = e.message;
    }
    await sleep(300);
  }
  await page.screenshot(`${OUT}/fail-${results.length}.png`);
  check(name, false, `${last ?? 'timed out'} (screenshot fail-${results.length}.png)`);
}
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// ── Fixtures ───────────────────────────────────────────────────────────────
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const SECRET = `PRIVATE-REPORTED-TEXT-${run}`;
const SECRET_URL = `https://example.invalid/private-${run}.jpg`;
const users = {};
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  if (!ids.length) return 0;
  // Reports and their append-only audit rows can only be removed by operator
  // SQL on this disposable stack.
  const list = ids.map((i) => `'${i}'`).join(',');
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc',
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list}));
     DELETE FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list});
     DELETE FROM public.admin_users WHERE user_id IN (${list});
     COMMIT;`]);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key) {
  const username = `ar${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `ar-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { key, id: data.user.id, username, email, password, db };
}

// ── Page helpers (as user-blocking-ui) ────────────────────────────────────
async function installAlertShim(page) {
  await page.waitFor('typeof __r === "function"', 30000);
  const ok = await page.eval(`(() => {
    const mods = __r.getModules();
    const entries = mods instanceof Map ? [...mods.entries()] : Object.entries(mods);
    const hit = entries.find(([, m]) => /react-native-web\\/dist\\/(cjs\\/)?exports\\/Alert\\/index\\.js$/.test(m.verboseName ?? ''));
    if (!hit) return false;
    const Alert = __r(Number(hit[0])).default ?? __r(Number(hit[0]));
    window.__alerts = window.__alerts ?? [];
    window.__alertChoices = window.__alertChoices ?? [];
    Alert.alert = (title, message, buttons) => {
      window.__alerts.push({ title, message: message ?? '', buttons: (buttons ?? []).map((b) => b.text) });
      const choice = window.__alertChoices.shift();
      const button = (buttons ?? []).find((b) => b.text === choice);
      if (button?.onPress) setTimeout(() => button.onPress(), 0);
    };
    return true;
  })()`);
  if (!ok) throw new Error('Alert shim: react-native-web Alert module not found');
}
async function open(page, path) {
  await page.goto(`${APP}${path}`);
  await installAlertShim(page);
}
async function login(page, u) {
  await open(page, '/login');
  await page.waitForEl('testid', 'login-email-input', 60000);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', u.password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
const path = (page) => page.eval('location.pathname');
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const htmlHas = (page, text) => page.eval(`document.documentElement.innerHTML.includes(${JSON.stringify(text)})`);
const trace = (...a) => process.env.UI_TRACE && console.log('    ·', ...a);
async function tapText(page, text) {
  trace(page.label, 'tap', text);
  const sel = `[...document.querySelectorAll('div,span,a,button')].filter(e => e.textContent.trim() === ${JSON.stringify(text)}).pop()`;
  await page.waitFor(`!!(${sel})`, 20000, text);
  await page.eval(`${sel}?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await page.tap('text', text);
}
// Scrolls a labelled element into view first (sections below may push it
// off-screen).
async function tapLabel(page, label) {
  const sel = `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
  await page.waitFor(`!!(${sel})`, 20000, label);
  await page.eval(`${sel}?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await page.tap('label', label);
}
const alerts = (page) => page.eval('JSON.stringify(window.__alerts ?? [])').then((s) => JSON.parse(s));
const choose = (page, ...choices) => {
  trace(page.label, 'choose', ...choices);
  return page.eval(`(window.__alertChoices = ${JSON.stringify(choices)}, true)`);
};
const lastAlert = async (page) => (await alerts(page)).pop();
const rowLabels = (page) => page.eval(`JSON.stringify([...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => / · /.test(l) && /Submitted/.test(l)))`).then(JSON.parse);

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B, N, R, O } = users;
  const post1 = must(await O.db.from('posts').insert({ user_id: O.id, content: SECRET, post_type: 'text', image_url: SECRET_URL }).select('id').single(), 'post 1').id;
  const post2 = must(await O.db.from('posts').insert({ user_id: O.id, content: `spam post ${run}`, post_type: 'text' }).select('id').single(), 'post 2').id;
  must(await R.db.rpc('submit_report', { p_target_type: 'post', p_target_id: post1, p_reason: 'harassment', p_details: null }), 'report 1');
  must(await R.db.rpc('submit_report', { p_target_type: 'post', p_target_id: post2, p_reason: 'spam', p_details: null }), 'report 2');
  must(await R.db.rpc('submit_report', { p_target_type: 'profile', p_target_id: O.id, p_reason: 'child_safety', p_details: null }), 'report 3');

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  await login(p.N, N);
  check('three accounts signed in', true);

  step('1. Navigation: Admin Tools shows Reports to admins only');
  await open(p.A, '/dashboard');
  await eventually('admin sees the Reports entry under Admin Tools', p.A, () => bodyHas(p.A, 'Review, claim and resolve reported content.'));
  await tapText(p.A, 'Reports');
  await eventually('Reports opens /admin/reports', p.A, async () => (await path(p.A)) === '/admin/reports');
  await open(p.N, '/dashboard');
  await sleep(3000);
  check('collector sees no Admin Tools / Reports entry', !(await bodyHas(p.N, 'Review, claim and resolve reported content.')));
  await open(p.N, '/admin/reports');
  await eventually('collector opening /admin/reports directly is sent away', p.N, async () => (await path(p.N)) !== '/admin/reports');
  check('…and saw no report data', !(await bodyHas(p.N, 'Harassment · Post')));

  step('2. Queue');
  await eventually('rows load', p.A, async () => (await rowLabels(p.A)).length >= 3);
  const labels = await rowLabels(p.A);
  check('child-safety report is first and labelled as such', /^Child safety\. Child safety · Profile\. Open\./.test(labels[0] ?? ''), labels[0]);
  check('rows show type, reason, status and age', labels.some((l) => /^Harassment · Post\. Open\. Submitted .* ago/.test(l)), labels);
  check('no reported text or media URL on the queue', !(await bodyHas(p.A, SECRET)) && !(await htmlHas(p.A, SECRET_URL)));
  check('pending summary shows urgent and child-safety counts', await bodyHas(p.A, '1 urgent · 1 child safety'));
  await tapText(p.A, 'Filters');
  await tapText(p.A, 'Spam');
  await eventually('reason filter: only the spam report', p.A, async () => {
    const l = await rowLabels(p.A);
    return l.length === 1 && l[0].startsWith('Spam · Post');
  });
  await tapText(p.A, 'Clear');
  await eventually('clearing filters restores the queue', p.A, async () => (await rowLabels(p.A)).length >= 3);
  await tapText(p.A, 'Mine 0');
  await eventually('empty state: "You have no claimed reports."', p.A, () => bodyHas(p.A, 'You have no claimed reports.'));
  await tapText(p.A, 'Open 3');
  await eventually('back to Open', p.A, async () => (await rowLabels(p.A)).length >= 3);

  step('3. Error and retry');
  await p.A.send('Network.enable');
  await p.A.send('Network.setBlockedURLs', { urls: ['*rpc/admin_report_queue*'] });
  await tapText(p.A, 'Refresh');
  await tapText(p.A, 'Claimed 0');
  await eventually('a failed load shows an error with Try again', p.A, () => bodyHas(p.A, 'Couldn’t load reports.'));
  await p.A.send('Network.setBlockedURLs', { urls: [] });
  await tapText(p.A, 'Try again');
  await eventually('retry loads the (empty) Claimed view', p.A, () => bodyHas(p.A, 'No reports are being reviewed.'));
  await tapText(p.A, 'Open 3');
  await eventually('Open again', p.A, async () => (await rowLabels(p.A)).length >= 3);

  step('4. Report detail and restricted preview');
  const harLabel = (await rowLabels(p.A)).find((l) => l.startsWith('Harassment · Post'));
  await tapLabel(p.A, harLabel);
  await eventually('detail opens', p.A, async () => (await path(p.A)).startsWith('/admin/report/'));
  const reportPath = await path(p.A);
  await eventually('reason, type, status and claim are shown', p.A, async () =>
    (await bodyHas(p.A, 'Content type')) && (await bodyHas(p.A, 'Not claimed')) && (await bodyHas(p.A, 'Account exists (identity withheld)')));
  check('reported content is hidden until requested', !(await bodyHas(p.A, SECRET)));
  await tapLabel(p.A, 'Show reported content');
  await eventually('content shown on request', p.A, () => bodyHas(p.A, SECRET));
  check('media is described, never loaded (URL absent from the page)', !(await htmlHas(p.A, SECRET_URL)) && (await bodyHas(p.A, 'not displayed here')));
  check('reporter is never identified', !(await bodyHas(p.A, R.username)));
  // B opens the same report now, before A claims.
  await open(p.B, reportPath);
  await eventually('B has the report open (unclaimed)', p.B, () => bodyHas(p.B, 'Not claimed'));

  step('5. Claim, conflicting claim');
  await choose(p.A, 'Cancel');
  await tapText(p.A, 'Claim');
  await eventually('claim asks for confirmation; Cancel changes nothing', p.A, async () => (await lastAlert(p.A))?.title === 'Claim report' && (await bodyHas(p.A, 'Not claimed')));
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed after confirming', p.A, () => bodyHas(p.A, 'Claimed. You are reviewing this report.'));
  await choose(p.B, 'Claim');
  await tapText(p.B, 'Claim');
  await eventually('B (stale screen) is refused, told why, and shown the current owner', p.B, async () =>
    (await bodyHas(p.B, 'changed since you opened it')) && (await bodyHas(p.B, 'Claimed by another admin')));
  const bCase = JSON.parse(await p.B.eval(`(() => {
    const note = [...document.querySelectorAll('div')].filter(e => e.textContent.trim().startsWith('Every action is re-checked by the server') && !e.children.length).pop();
    return JSON.stringify(note ? [...note.parentElement.querySelectorAll('[role=button]')].map(e => e.textContent.trim()) : null);
  })()`));
  check('B is not offered Claim (or any decision) on A’s live claim', Array.isArray(bCase) && bCase.length === 0, bCase);

  step('6. Dismiss and reopen');
  await tapText(p.A, 'Dismiss…');
  await tapText(p.A, 'Within guidelines');
  await choose(p.A, 'Dismiss');
  await tapText(p.A, 'Confirm dismissal…');
  await eventually('dismissed after confirmation', p.A, () => bodyHas(p.A, 'Report dismissed.'));
  const d = await lastAlert(p.A);
  check('dismissal confirmation states that nothing is enforced', /No content or account is changed/.test(d?.message ?? ''), d);
  check('history shows the decision', (await bodyHas(p.A, 'Resolved by you')) && (await bodyHas(p.A, 'Claimed by you')));
  await tapText(p.A, 'Reopen…');
  await tapText(p.A, 'New information');
  await choose(p.A, 'Reopen');
  await tapText(p.A, 'Confirm reopen…');
  await eventually('reopened', p.A, () => bodyHas(p.A, 'Report reopened.'));
  // The Case card's own buttons (other stacked screens stay mounted on web).
  const caseButtons = JSON.parse(await p.A.eval(`(() => {
    const note = [...document.querySelectorAll('div')].filter(e => e.textContent.trim().startsWith('Every action is re-checked by the server') && !e.children.length).pop();
    const card = note?.parentElement;
    return JSON.stringify(card ? [...card.querySelectorAll('[role=button]')].map(e => e.textContent.trim()) : null);
  })()`));
  check('the case actions are only the existing case-management ones (no hide/remove/restore/suspend)',
    Array.isArray(caseButtons) && caseButtons.length > 0 && caseButtons.every((b) => ['Claim', 'Release', 'Dismiss…', 'Reopen…', 'Take over claim', 'Release stale claim'].includes(b)), caseButtons);

  step('7. Child-safety report');
  await open(p.A, '/admin/reports');
  await eventually('queue', p.A, async () => (await rowLabels(p.A)).length >= 3);
  await p.A.tap('label', (await rowLabels(p.A)).find((l) => l.startsWith('Child safety.')));
  await eventually('child-safety detail shows its flag', p.A, () => bodyHas(p.A, 'Child-safety content is hidden. Tap to review the text.'));
  await choose(p.A, 'Cancel');
  await tapLabel(p.A, 'Show reported content');
  await eventually('revealing asks for an extra confirmation; Cancel keeps it hidden', p.A, async () =>
    (await lastAlert(p.A))?.title === 'Show child-safety content' && (await bodyHas(p.A, 'Child-safety content is hidden.')));
  check('child-safety evidence is described as preserved', await bodyHas(p.A, 'preserved and excluded from routine purging'));

  step('8. Losing administrator access');
  await open(p.A, '/admin/reports');
  await eventually('queue', p.A, async () => (await rowLabels(p.A)).length >= 3);
  must(await admin.from('admin_users').delete().eq('user_id', A.id), 'remove A');
  await tapText(p.A, 'Refresh');
  await eventually('removed admin: the list is replaced by an access message', p.A, async () =>
    (await bodyHas(p.A, 'You no longer have administrator access.')) && (await rowLabels(p.A)).length === 0);
  await open(p.B, reportPath);
  await eventually('B still has access', p.B, () => bodyHas(p.B, 'Content type'));
  await p.B.eval('localStorage.clear(), sessionStorage.clear(), true');
  await open(p.B, reportPath);
  await eventually('signed-out session: no report data shown', p.B, async () => !(await bodyHas(p.B, 'Content type')) && !(await bodyHas(p.B, SECRET)));

  for (const [k, pg] of Object.entries(p)) await pg.screenshot(`${OUT}/${k}-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL} (isolated ${stack.project}, run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const k of ['A', 'B', 'N', 'R', 'O']) users[k] = await createUser(k);
must(await admin.from('admin_users').insert([{ user_id: users.A.id }, { user_id: users.B.id }]), 'admins');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const hardStop = setTimeout(async () => {
  console.error(`\nHard timeout in "${current}" — taking screenshots and exiting.`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/hang-${key}.png`).catch(() => {});
  process.exit(2);
}, 480_000);
hardStop.unref();
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'B', 'N']) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, pg]) => pg.errors.map((e) => `${k}: ${String(e).replace(/\s+/g, ' ').slice(0, 260)}`));
  await browser.close();
  const removed = await sweep();
  console.log(`\nCleanup: ${removed} accounts removed.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 20).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

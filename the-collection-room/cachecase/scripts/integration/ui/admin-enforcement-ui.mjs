// Administrator moderation enforcement (Phase 2B M5.2) — UI test of the
// Enforcement section of the real report screen (web build) against an
// ISOLATED disposable local Supabase stack. Two admins (A, B) in separate
// browser contexts. Content is made by the owner O's own client; reports are
// filed by R through the real submit_report path; the service role only
// creates/deletes accounts and grants admin rows. Synthetic data only.
//
// Prerequisites: an isolated stack (CACHECASE_STACK_WORKDIR), a local-only
// Metro on :8090 whose EXPO_PUBLIC_SUPABASE_URL is that stack, and
// shell-proxy.mjs on :8091.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/ui/admin-enforcement-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from '../local-stack.ts';
import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'admin-enforcement-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-admin-enforcement-ui`;
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
     DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${list}));
     DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${list}));
     DELETE FROM private.media_quarantine WHERE owner_id IN (${list});
     DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list}))
                                           OR target_owner_id IN (${list}) OR admin_id IN (${list});
     DELETE FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list});
     DELETE FROM public.moderated_content WHERE owner_id IN (${list}) OR created_by IN (${list});
     DELETE FROM public.account_suspensions WHERE user_id IN (${list});
     DELETE FROM public.admin_users WHERE user_id IN (${list});
     COMMIT;`]);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key) {
  const username = `ae${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `ae-${randomUUID()}`;
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
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const trace = (...a) => process.env.UI_TRACE && console.log('    ·', ...a);
async function tapText(page, text) {
  trace(page.label, 'tap', text);
  const sel = `[...document.querySelectorAll('div,span,a,button')].filter(e => e.textContent.trim() === ${JSON.stringify(text)}).pop()`;
  await page.waitFor(`!!(${sel})`, 20000, text);
  await page.eval(`${sel}?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await page.tap('text', text);
}
const alerts = (page) => page.eval('JSON.stringify(window.__alerts ?? [])').then((s) => JSON.parse(s));
const choose = (page, ...choices) => {
  trace(page.label, 'choose', ...choices);
  return page.eval(`(window.__alertChoices = ${JSON.stringify(choices)}, true)`);
};
const lastAlert = async (page) => (await alerts(page)).pop();

// ── Scenario ───────────────────────────────────────────────────────────────
const sql = (q) => execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', q], { encoding: 'utf8' }).trim();
const modState = (id) => sql(`SELECT COALESCE((SELECT state FROM public.moderated_content WHERE target_id = '${id}' AND lifted_at IS NULL), 'none')`);
const suspended = (id) => sql(`SELECT private.account_is_suspended('${id}')`) === 't';
async function act(page, label, reasonChip, extra = async () => {}) {
  await tapText(page, `${label}…`);
  await tapText(page, reasonChip);
  await extra();
}
async function tapLabel(page, label) {
  const sel = `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
  await page.waitFor(`!!(${sel})`, 20000, label);
  await page.eval(`${sel}?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await page.tap('label', label);
}
async function review(page, label, confirmWord) {
  await choose(page, confirmWord);
  await tapLabel(page, `Review ${label}`);
}

async function scenario(p) {
  const { A, B, R, O } = users;
  const post = must(await O.db.from('posts').insert({ user_id: O.id, content: `enforce post ${run}`, post_type: 'text' }).select('id').single(), 'post').id;
  const post2 = must(await O.db.from('posts').insert({ user_id: O.id, content: `cs host post ${run}`, post_type: 'text' }).select('id').single(), 'post2').id;
  const comment = must(await O.db.from('comments').insert({ user_id: O.id, post_id: post2, body: `cs comment ${run}` }).select('id').single(), 'comment').id;
  must(await R.db.rpc('submit_report', { p_target_type: 'post', p_target_id: post, p_reason: 'harassment', p_details: null }), 'report post');
  must(await R.db.rpc('submit_report', { p_target_type: 'comment', p_target_id: comment, p_reason: 'child_safety', p_details: null }), 'report comment');
  const rPost = sql(`SELECT id FROM public.content_reports WHERE reporter_id = '${R.id}' AND target_id = '${post}'`);
  const rCs = sql(`SELECT id FROM public.content_reports WHERE reporter_id = '${R.id}' AND target_id = '${comment}'`);

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  check('two admins signed in', true);

  step('1. Enforcement section before a claim');
  await open(p.A, `/admin/report/${rPost}`);
  await eventually('the Enforcement section shows the current state', p.A, async () =>
    (await bodyHas(p.A, 'No restriction on this content.')) && (await bodyHas(p.A, 'Account: Not suspended; no suspension history.')));
  check('hide/remove are explained, not offered, until the report is claimed',
    (await bodyHas(p.A, 'Hide content: Claim the report first.')) && (await bodyHas(p.A, 'Remove content: Claim the report first.')) && !(await p.A.exists('text', 'Hide content…')));
  check('profile-only and restore actions are not shown for a post', !(await bodyHas(p.A, 'Clear profile fields')) && !(await bodyHas(p.A, 'Restore content')));
  // B opens the same report now (stale later).
  await open(p.B, `/admin/report/${rPost}`);
  await eventually('B has the report open', p.B, () => bodyHas(p.B, 'Suspend account…'));

  step('2. Hide, then remove');
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed', p.A, () => bodyHas(p.A, 'Hide content…'));
  await act(p.A, 'Hide content', 'Pending review');
  await review(p.A, 'Hide content', 'Hide');
  await eventually('hidden; the screen reports it', p.A, async () => (await bodyHas(p.A, 'Content hidden. The report stays claimed by you.')) && modState(post) === 'hidden');
  const hideAlert = await lastAlert(p.A);
  check('hide confirmation names the action, target and reason, and says it is reversible',
    hideAlert?.title === 'Hide content' && /Post · reason: Pending review/.test(hideAlert.message) && /Reversible: Restore content/.test(hideAlert.message), hideAlert);
  await eventually('the restriction line updates', p.A, () => bodyHas(p.A, 'by you · Pending review'));
  await act(p.A, 'Remove content', 'Harassment');
  await review(p.A, 'Remove content', 'Remove');
  await eventually('removed; report actioned', p.A, async () => (await bodyHas(p.A, 'Content removed; report actioned')) && modState(post) === 'removed');
  await eventually('status badge and history follow the server', p.A, async () => (await bodyHas(p.A, 'Actioned')) && (await bodyHas(p.A, 'Content removed by you')));

  step('3. A stale screen cannot act');
  await tapText(p.B, 'Suspend account…');
  await tapText(p.B, 'Spam');
  await review(p.B, 'Suspend account', 'Suspend');
  await eventually('B (opened before the hide) is told the report changed; nothing suspended', p.B, async () =>
    (await bodyHas(p.B, 'changed since you opened it')) && !suspended(O.id));
  await eventually('…and B now sees the removal', p.B, () => bodyHas(p.B, 'Removed'));

  step('4. Restore');
  await act(p.A, 'Restore content', 'Resolved in error', async () => tapText(p.A, 'Reopen the reports'));
  await review(p.A, 'Restore content', 'Restore');
  await eventually('restored and reopened', p.A, async () => (await bodyHas(p.A, 'Restriction lifted.')) && modState(post) === 'none');

  step('5. Suspension and lifting');
  await act(p.A, 'Suspend account', 'Spam', async () => tapText(p.A, '24 hours'));
  await review(p.A, 'Suspend account', 'Suspend');
  await eventually('suspended for 24 hours', p.A, async () => (await bodyHas(p.A, 'Account suspended.')) && suspended(O.id) && (await bodyHas(p.A, 'Account: Suspended until')));
  const sAlert = await lastAlert(p.A);
  check('suspension confirmation: duration, effects, deletion/export kept, reversible',
    /for 24 hours/.test(sAlert?.message ?? '') && /keep account deletion and Download My Data/.test(sAlert?.message ?? '') && /Reversible: Lift suspension/.test(sAlert?.message ?? ''), sAlert);
  await act(p.A, 'Lift suspension', 'Appeal granted');
  await review(p.A, 'Lift suspension', 'Lift');
  await eventually('lifted', p.A, async () => (await bodyHas(p.A, 'Suspension lifted.')) && !suspended(O.id));

  step('6. Child safety: second administrator');
  await open(p.A, `/admin/report/${rCs}`);
  await eventually('child-safety report open', p.A, () => bodyHas(p.A, 'Claim'));
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed', p.A, () => bodyHas(p.A, 'Remove content…'));
  await act(p.A, 'Remove content', 'Child safety');
  await review(p.A, 'Remove content', 'Remove');
  await eventually('removed', p.A, async () => modState(comment) === 'removed');
  await eventually('A sees the reversal awaiting a second administrator, with no Restore button', p.A, async () =>
    (await bodyHas(p.A, 'Awaiting a second administrator')) && !(await p.A.exists('text', 'Restore content…')));
  await open(p.B, `/admin/report/${rCs}`);
  await tapText(p.B, 'Restore content…');
  await eventually('only the dedicated child-safety reason is offered', p.B, async () =>
    (await p.B.exists('text', 'Child-safety review cleared')) && !(await p.B.exists('text', 'Appeal granted')) && !(await p.B.exists('text', 'Resolved in error')));
  await tapText(p.B, 'Child-safety review cleared');
  await tapText(p.B, 'Reopen the reports');
  await eventually('Review stays disabled until a note and the confirmation are given', p.B, () => bodyHas(p.B, 'A child-safety reversal needs a note'));
  await tapLabel(p.B, 'Restore content note');
  await p.B.type('label', 'Restore content note', 'Second review: no violation found.');
  await tapLabel(p.B, 'I completed the child-safety review and confirm this reversal.');
  await review(p.B, 'Restore content', 'Restore');
  await eventually('B restores after the second review', p.B, async () => (await bodyHas(p.B, 'Restriction lifted.')) && modState(comment) === 'none');
  const csAlert = await lastAlert(p.B);
  check('the confirmation states the second-administrator rule', /other than the one who imposed it/.test(csAlert?.message ?? ''), csAlert);

  for (const [k, pg] of Object.entries(p)) await pg.screenshot(`${OUT}/${k}-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL} (isolated ${stack.project}, run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const k of ['A', 'B', 'R', 'O']) users[k] = await createUser(k);
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
  for (const key of ['A', 'B']) pages[key] = await browser.newPage(key);
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

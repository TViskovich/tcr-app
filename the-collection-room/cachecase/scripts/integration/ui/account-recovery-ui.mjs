// Password recovery and Change Password — UI test of the real app screens
// (web build) against the LOCAL Supabase stack, reading the emailed codes
// from Mailpit. One browser page; app storage is cleared between scenarios
// (web AsyncStorage = localStorage). Codes and passwords are never printed.
//
// Prerequisites: same as the other UI suites (local Supabase with the
// recovery template, local-only Metro on :8090, shell-proxy.mjs on :8091).
// Run:  node scripts/integration/ui/account-recovery-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'account-recovery-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-recovery-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const MAIL = st.MAILPIT_URL ?? st.INBUCKET_URL;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = () => createClient(st.API_URL, st.ANON_KEY, opts);
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const pw = () => `Ui-${randomBytes(9).toString('base64url')}`;

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
async function eventually(name, page, fn, timeout = 15000) {
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

// ── Fixtures and mail ──────────────────────────────────────────────────────
async function createUser(key) {
  const email = `ru${run}${key}@example.test`;
  const password = pw();
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username: `ru${run}${key}`, display_name: `Recovery ${key}` }, app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  return { id: data.user.id, email, password };
}
async function sweep() {
  const ids = [];
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE_TAG) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (ids.length) await admin.from('account_lifecycle').delete().in('user_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
const mailsTo = async (email) => (await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=50`)).json()).messages ?? [];
async function codeFor(email, seen) {
  for (let i = 0; i < 40; i++) {
    const list = await mailsTo(email);
    if (list.length > seen) {
      const m = await (await fetch(`${MAIL}/api/v1/message/${list[0].ID}`)).json();
      return (`${m.Text} ${m.HTML}`.match(/\b(\d{6,10})\b/) ?? [])[1] ?? null;
    }
    await sleep(300);
  }
  return null;
}

// ── Page helpers ───────────────────────────────────────────────────────────
const path = (page) => page.eval('location.pathname');
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const hasLabel = (page, label) => page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)`);
const tapLabel = (page, label) => page.tap('label', label);
async function fill(page, testid, value) {
  await page.waitForEl('testid', testid, 15000);
  await page.eval(`(() => { const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]'); el.focus(); el.select && el.select(); })()`);
  await page.eval(`(() => { const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.type('testid', testid, value);
}
async function freshApp(page) {
  await page.goto(`${APP}/login`);
  await page.eval('localStorage.clear(); sessionStorage.clear();');
  await page.goto(`${APP}/login`);
  await page.waitForEl('testid', 'login-email-input', 60000);
}
async function login(page, u, password = u.password) {
  await freshApp(page);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
const tabBarShown = (page) => page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => ['Feed', 'Dashboard'].includes(e.getAttribute('aria-label')) && e.getBoundingClientRect().width > 0)`);
const canSignIn = async (email, password) => !(await anon().auth.signInWithPassword({ email, password })).error;

async function scenario(page, users) {
  const { A, C, D, E } = users;

  step('1. Login → Forgot password; unknown and known addresses look the same');
  await freshApp(page);
  await page.type('testid', 'login-email-input', `nobody${run}@example.test`);
  check('the login screen offers “Forgot password?”', await hasLabel(page, 'Forgot password?'));
  await tapLabel(page, 'Forgot password?');
  await eventually('Forgot Password opens with the typed email', page, async () => (await path(page)) === '/forgot-password'
    && (await page.eval(`document.querySelector('[data-testid="forgot-email-input"]').value`)) === `nobody${run}@example.test`);
  await page.screenshot(`${OUT}/01-forgot.png`);
  await tapLabel(page, 'Send code');
  await eventually('an unknown address goes on to Reset Password with the neutral message', page, async () => (await path(page)) === '/reset-password'
    && (await bodyHas(page, `If an account uses nobody${run}@example.test, we’ve sent it a code.`)));
  const unknownText = (await page.eval('document.body.innerText')).replace(`nobody${run}@example.test`, '<email>');
  await eventually('the resend link is on its 60-second cooldown', page, () => bodyHas(page, 'Send a new code in'));
  check('no email was sent to the unknown address', (await mailsTo(`nobody${run}@example.test`)).length === 0);

  await freshApp(page);
  await tapLabel(page, 'Forgot password?');
  await fill(page, 'forgot-email-input', A.email);
  const seenA = (await mailsTo(A.email)).length;
  await tapLabel(page, 'Send code');
  await eventually('a real address goes on to the same Reset Password screen', page, async () => (await path(page)) === '/reset-password');
  const knownText = (await page.eval('document.body.innerText')).replace(A.email, '<email>');
  check('the screen is identical for a real and an unknown address', knownText === unknownText, { knownText: knownText.slice(0, 160), unknownText: unknownText.slice(0, 160) });
  await page.screenshot(`${OUT}/02-reset.png`);
  const codeA = await codeFor(A.email, seenA);
  check('the real address receives its code by email', /^\d{8}$/.test(codeA ?? ''));
  // Going back (in-app navigation, no reload) shows the cooldown on Forgot
  // Password too; "I have a code" returns to Reset Password.
  await page.eval('history.back()');
  await eventually('Forgot Password shows “Send again in …s” during the cooldown', page, async () => (await path(page)) === '/forgot-password'
    && (await bodyHas(page, 'Send again in')));
  await tapLabel(page, 'I have a code');

  step('2. Reset Password validation and wrong codes');
  const newA = pw();
  await eventually('Reset Password is shown', page, () => bodyHas(page, 'Reset password'));
  await fill(page, 'reset-code-input', codeA);
  await fill(page, 'reset-password-input', 'short7');
  await fill(page, 'reset-confirm-input', 'short7');
  await tapLabel(page, 'Reset password');
  await eventually('a short password is refused before anything is sent', page, () => bodyHas(page, 'Use at least 8 characters.'));
  await fill(page, 'reset-password-input', newA);
  await fill(page, 'reset-confirm-input', `${newA}x`);
  await tapLabel(page, 'Reset password');
  await eventually('mismatched passwords are refused', page, () => bodyHas(page, 'The passwords don’t match.'));
  const wrongCode = String((Number(codeA) + 1) % 100000000).padStart(8, '0');
  await fill(page, 'reset-code-input', wrongCode);
  await fill(page, 'reset-confirm-input', newA);
  await tapLabel(page, 'Reset password');
  await eventually('a wrong code is refused with the neutral message', page, () => bodyHas(page, 'That code is invalid or has expired.'));
  check('…and the wrong code signs nobody in', (await path(page)) === '/reset-password' && !(await tabBarShown(page)));

  step('3. Code accepted but the password update fails → held on Reset Password');
  await fill(page, 'reset-code-input', codeA);
  await fill(page, 'reset-password-input', A.password); // the current password: Supabase refuses it (same_password)
  await fill(page, 'reset-confirm-input', A.password);
  await tapLabel(page, 'Reset password');
  await eventually('the failed update is explained and the screen asks only for a new password', page, async () =>
    (await bodyHas(page, 'Choose a password different from your current one.')) && (await bodyHas(page, 'Code confirmed.'))
    && !(await page.exists('testid', 'reset-code-input')));
  check('the held session shows no tab bar', !(await tabBarShown(page)));
  for (const target of ['/dashboard', '/account/delete', '/account/export', '/account/pending']) {
    await page.goto(`${APP}${target}`);
    await eventually(`navigating to ${target} is sent back to Reset Password`, page, async () => (await path(page)) === '/reset-password' && (await bodyHas(page, 'Code confirmed.')));
  }
  await page.goto(`${APP}/reset-password`);
  await page.eval('location.reload()');
  await eventually('after a relaunch the session is still held on Reset Password (code already confirmed)', page, async () =>
    (await path(page)) === '/reset-password' && (await bodyHas(page, 'Code confirmed.')) && !(await tabBarShown(page)), 30000);
  check('the code is in no URL and no stored value', !(await page.eval(`location.href.includes(${JSON.stringify(codeA)}) || Object.keys(localStorage).some(k => (localStorage.getItem(k) ?? '').includes(${JSON.stringify(codeA)}))`)));
  await page.screenshot(`${OUT}/03-held.png`);

  step('4. Finishing the reset');
  await fill(page, 'reset-password-input', newA);
  await fill(page, 'reset-confirm-input', newA);
  await tapLabel(page, 'Reset password');
  await eventually('saving the new password leaves recovery for the app', page, async () => !(await path(page)).includes('reset-password')
    && (await tabBarShown(page)), 30000);
  check('the new password signs in; the old one doesn’t', (await canSignIn(A.email, newA)) && !(await canSignIn(A.email, A.password)));
  await page.eval('location.reload()');
  await eventually('a relaunch afterwards opens the app normally (hold cleared)', page, async () => !(await path(page)).includes('reset-password') && (await tabBarShown(page)), 30000);

  step('5. Cancel clears the hold and signs out');
  await freshApp(page);
  await tapLabel(page, 'Forgot password?');
  await fill(page, 'forgot-email-input', C.email);
  const seenC = (await mailsTo(C.email)).length;
  await tapLabel(page, 'Send code');
  const codeC = await codeFor(C.email, seenC);
  await eventually('Reset Password for C', page, async () => (await path(page)) === '/reset-password');
  await fill(page, 'reset-code-input', codeC);
  await fill(page, 'reset-password-input', C.password);
  await fill(page, 'reset-confirm-input', C.password);
  await tapLabel(page, 'Reset password');
  await eventually('C is held with the code confirmed', page, () => bodyHas(page, 'Code confirmed.'));
  await tapLabel(page, 'Cancel password reset');
  await eventually('Cancel signs out and returns to Log In', page, async () => (await path(page)) === '/login');
  await page.eval('location.reload()');
  await eventually('after a relaunch it stays signed out (no held session left)', page, async () => (await path(page)) === '/login', 30000);
  check('C’s password is unchanged', await canSignIn(C.email, C.password));

  step('6. A pending-deletion account lands on Pending Deletion after resetting');
  await admin.rpc('schedule_account_deletion', { p_user_id: E.id });
  await freshApp(page);
  await tapLabel(page, 'Forgot password?');
  await fill(page, 'forgot-email-input', E.email);
  const seenE = (await mailsTo(E.email)).length;
  await tapLabel(page, 'Send code');
  const codeE = await codeFor(E.email, seenE);
  await eventually('Reset Password for E', page, async () => (await path(page)) === '/reset-password');
  const newE = pw();
  await fill(page, 'reset-code-input', codeE);
  await fill(page, 'reset-password-input', newE);
  await fill(page, 'reset-confirm-input', newE);
  await tapLabel(page, 'Reset password');
  await eventually('after the reset a pending account sees Pending Deletion (where it can cancel)', page, async () => (await path(page)) === '/account/pending', 30000);
  const { data: lc } = await admin.from('account_lifecycle').select('state').eq('user_id', E.id).single();
  check('the account is still pending deletion', lc?.state === 'pending_deletion');

  step('7. Change Password (signed in)');
  await login(page, D);
  await page.goto(`${APP}/dashboard`);
  await eventually('Account & Security offers Change Password', page, () => hasLabel(page, 'Change Password'), 30000);
  await page.eval(`[...document.querySelectorAll('[aria-label="Change Password"]')].pop().scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await tapLabel(page, 'Change Password');
  await eventually('the Change Password screen opens', page, async () => (await path(page)) === '/account/password');
  const newD = pw();
  await fill(page, 'change-current-input', 'Not-the-password-1');
  await fill(page, 'change-new-input', newD);
  await fill(page, 'change-confirm-input', newD);
  await tapLabel(page, 'Change password');
  await eventually('a wrong current password is refused', page, () => bodyHas(page, 'Your current password isn’t right.'));
  await fill(page, 'change-current-input', D.password);
  await fill(page, 'change-new-input', newD);
  await fill(page, 'change-confirm-input', `${newD}x`);
  await tapLabel(page, 'Change password');
  await eventually('mismatched new passwords are refused', page, () => bodyHas(page, 'The passwords don’t match.'));
  await fill(page, 'change-current-input', D.password);
  await fill(page, 'change-confirm-input', newD);
  await tapLabel(page, 'Change password');
  await eventually('the change succeeds and says other devices were signed out', page, async () =>
    (await bodyHas(page, 'Password changed')) && (await bodyHas(page, 'Your other devices have been signed out.')), 30000);
  await page.screenshot(`${OUT}/04-changed.png`);
  check('the new password signs in; the old one doesn’t', (await canSignIn(D.email, newD)) && !(await canSignIn(D.email, D.password)));
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}, Mailpit ${MAIL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
const users = { A: await createUser('a'), C: await createUser('c'), D: await createUser('d'), E: await createUser('e') };
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
let page = null;
let fatal = null;
try {
  page = await browser.newPage('R');
  await scenario(page, users);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  if (page) await page.screenshot(`${OUT}/abort.png`).catch(() => {});
} finally {
  await browser.close();
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

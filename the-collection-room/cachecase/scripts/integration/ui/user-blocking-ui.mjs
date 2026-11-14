// Collector blocking UI (App Store moderation Phase 1C) — UI test of the real
// screens (web build) against the LOCAL Supabase stack, in isolated browser
// contexts:
//   A — blocks B (profile, then a conversation), manages Blocked Collectors,
//       tries a Registry transfer to B
//   B — the blocked collector: sees the neutral read-only/unavailable states
// Fixture rows are written through each collector's own signed-in client;
// the service role only creates/deletes the disposable accounts and A's
// disposable registered card.
//
// Prerequisites: supabase start (with 20261112120000 and 20261113120000),
// local-only Metro on :8090 and shell-proxy.mjs on :8091 (as the other UI
// suites). No Edge Functions needed.
// Run:  node scripts/integration/ui/user-blocking-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'user-blocking-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-user-blocking-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
{
  const html = await (await fetch(APP)).text();
  const src = html.match(/src="([^"]+entry\.bundle[^"]*)"/)?.[1];
  const bundle = await (await fetch(new URL(src, APP))).text();
  if (!bundle.includes(`"EXPO_PUBLIC_SUPABASE_URL": { enumerable: true, value: "${st.API_URL}"`)) {
    throw new Error('Refusing: the web build is not pointed at the local Supabase URL.');
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
const cards = [];
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  if (!ids.length) return 0;
  const { data: owned } = await admin.from('registered_cards').select('id').in('current_owner_id', ids);
  const allCards = [...new Set([...cards, ...(owned ?? []).map((c) => c.id)])];
  if (allCards.length) {
    await admin.from('notifications').delete().in('registered_card_id', allCards);
    await admin.from('ownership_transfers').delete().in('registered_card_id', allCards);
    await admin.from('registry_events').delete().in('registered_card_id', allCards);
    await admin.from('registered_cards').delete().in('id', allCards);
  }
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const convIds = [...new Set((parts ?? []).map((r) => r.conversation_id))];
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key, displayName) {
  const username = `ub${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `ub-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { key, id: data.user.id, username, email, password, name: displayName, db };
}

// ── Page helpers (as account-deletion-ui) ─────────────────────────────────
// react-native-web's Alert.alert is a no-op; record alerts and press the
// next queued button instead.
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
const labelEl = (label) => `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
const hasLabel = (page, label) => page.eval(`!!(${labelEl(label)})`);
const showsLabel = (page, label) => page.eval(`(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && el.contains(hit); })()`);
async function tapLabel(page, label) {
  await page.waitFor(`!!(${labelEl(label)})`, 20000, label);
  const unobstructed = `(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })()`;
  for (let i = 0; i < 10 && !(await page.eval(unobstructed)); i++) {
    await page.eval(`${labelEl(label)}?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await page.tap('label', label);
}
const alerts = (page) => page.eval('JSON.stringify(window.__alerts ?? [])').then((s) => JSON.parse(s));
const choose = (page, ...choices) => page.eval(`(window.__alertChoices = ${JSON.stringify(choices)}, true)`);
const lastAlert = async (page) => (await alerts(page)).pop();
const hasComposer = (page) => page.eval(`!!document.querySelector('[placeholder="Message..."]')`);
const blockRow = async (blocker, blocked) =>
  (await admin.from('user_blocks').select('blocker_id').eq('blocker_id', blocker.id).eq('blocked_id', blocked.id)).data?.length === 1;

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ccId = () => `CC-${Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')}-${Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')}`;

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B } = users;
  const postB = `Post by B ${run}`;
  must(await B.db.from('posts').insert({ user_id: B.id, content: postB, post_type: 'text' }), 'B post');
  must(await A.db.from('posts').insert({ user_id: A.id, content: `Post by A ${run}`, post_type: 'text' }), 'A post');
  must(await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id }), 'B follows A');
  const convId = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conversation');
  must(await A.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: A.id, body: `Hello from A ${run}` }), 'A message');
  must(await B.db.from('messages').insert({ id: randomUUID(), conversation_id: convId, sender_id: B.id, body: `Hello from B ${run}` }), 'B message');
  const card = must(await admin.from('registered_cards').insert({ cc_id: ccId(), current_owner_id: A.id, status: 'active' }).select('id').single(), 'card');
  cards.push(card.id);

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  check('both signed in', true);

  step('1. Profile menu: never on your own profile');
  await open(p.A, `/user/${A.username}`);
  await sleep(2500);
  check('your own profile has no "More options" / Block', !(await hasLabel(p.A, 'More options')));

  step('2. Block from another collector\'s profile — cancel, then confirm');
  // B opens A's profile first, in-app, so its memory caches hold A.
  await open(p.B, `/conversation/${convId}`);
  await eventually('B sees the conversation history', p.B, () => bodyHas(p.B, `Hello from A ${run}`));
  await open(p.A, `/user/${B.username}`);
  await eventually('A sees B\'s profile and post', p.A, async () => (await bodyHas(p.A, `@${B.username}`)) && (await bodyHas(p.A, postB)));
  await eventually('"More options" is offered with an accessibility hint', p.A, async () => (await showsLabel(p.A, 'More options'))
    && (await p.A.eval(`${labelEl('More options')}?.getAttribute('role') === 'button'`)));
  await choose(p.A, 'Cancel');
  await tapLabel(p.A, 'More options');
  await tapLabel(p.A, `Block @${B.username}`);
  await eventually('a confirmation appears', p.A, async () => (await lastAlert(p.A))?.title === `Block @${B.username}?`);
  const confirm = await lastAlert(p.A);
  check('…it explains messaging/following/interaction, kept history and no notification', /message you, follow you, or interact/.test(confirm.message)
    && /existing messages stay/.test(confirm.message) && /won’t be notified/.test(confirm.message), confirm.message);
  check('…it doesn\'t overpromise: public content stays visible to signed-out visitors', /people who aren’t signed in/.test(confirm.message));
  check('…with Cancel and a Block button', JSON.stringify(confirm.buttons) === JSON.stringify(['Cancel', 'Block']), confirm.buttons);
  await sleep(1200);
  check('Cancel blocks nothing', !(await blockRow(A, B)));
  await choose(p.A, 'Block');
  await tapLabel(p.A, 'More options');
  await tapLabel(p.A, `Block @${B.username}`);
  await eventually('Block creates the block on the server', p.A, () => blockRow(A, B));
  await eventually('the profile shows the "You blocked" notice with Unblock', p.A, async () =>
    (await bodyHas(p.A, `You blocked @${B.username}`)) && (await hasLabel(p.A, `Unblock @${B.username}`)));
  check('B\'s post is no longer shown on the profile', !(await bodyHas(p.A, postB)));
  check('Follow and Message actions are removed', !(await hasLabel(p.A, 'Follow')) && !(await hasLabel(p.A, 'Message')));
  check('the server removed B\'s follow of A', (await admin.from('follows').select('follower_id').eq('follower_id', B.id).eq('following_id', A.id)).data?.length === 0);

  step('3. Status survives navigation and a full reload (app restart)');
  await open(p.A, '/dashboard');
  await open(p.A, `/user/${B.username}`);
  await eventually('after navigating away and back, still blocked', p.A, () => bodyHas(p.A, `You blocked @${B.username}`));
  // A real reload (clears all in-memory state, like an app restart).
  // Navigating to the identical URL is a no-op for the page.
  await p.A.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  await p.A.waitFor('document.readyState === "complete"', 30000);
  await installAlertShim(p.A);
  await eventually('after a full reload, still blocked', p.A, () => bodyHas(p.A, `You blocked @${B.username}`));
  await choose(p.A, 'Cancel');
  await tapLabel(p.A, `Unblock @${B.username}`);
  await eventually('Unblock asks for confirmation (cancelled)', p.A, async () => (await lastAlert(p.A))?.title === `Unblock @${B.username}?`);
  await sleep(1000);
  check('cancelling Unblock keeps the block', await blockRow(A, B));

  step('4. Direct messages — both sides read-only, history kept');
  await open(p.A, `/conversation/${convId}`);
  await eventually('A still reads both messages', p.A, async () => (await bodyHas(p.A, `Hello from A ${run}`)) && (await bodyHas(p.A, `Hello from B ${run}`)));
  await eventually('A sees "You blocked this collector" with Unblock, and no composer', p.A, async () =>
    (await bodyHas(p.A, 'You blocked this collector. Unblock them to send messages again.')) && (await hasLabel(p.A, 'Unblock Collector'))
    && !(await hasComposer(p.A)) && !(await hasLabel(p.A, 'Attach')));
  // B's conversation is still the one opened before the block (stale).
  await p.B.type('placeholder', 'Message...', 'still there?');
  await tapLabel(p.B, 'Send message');
  await eventually('B\'s stale thread: send refused → neutral read-only notice, history kept', p.B, async () =>
    (await bodyHas(p.B, 'Messaging isn’t available in this conversation.')) && (await bodyHas(p.B, `Hello from A ${run}`))
    && !(await hasComposer(p.B)) && !(await bodyHas(p.B, 'This conversation isn’t available')));
  check('no message was stored', (await admin.from('messages').select('id').eq('conversation_id', convId)).data?.length === 2);
  await open(p.B, `/conversation/${convId}`);
  await eventually('B reopening: "Unavailable collector", neutral notice, history, no composer', p.B, async () =>
    (await bodyHas(p.B, 'Unavailable collector')) && (await bodyHas(p.B, 'Messaging isn’t available in this conversation.'))
    && (await bodyHas(p.B, `Hello from B ${run}`)) && !(await hasComposer(p.B)) && !(await hasLabel(p.B, 'Attach')));
  check('B is never told it was blocked', !(await bodyHas(p.B, 'blocked')));
  await open(p.B, `/user/${A.username}`);
  await eventually('B opening A\'s profile: "This collector isn’t available."', p.B, () => bodyHas(p.B, 'This collector isn’t available.'));

  step('5. Blocked Collectors');
  await open(p.A, '/dashboard');
  await eventually('Account & Security offers Blocked Collectors', p.A, () => hasLabel(p.A, 'Blocked Collectors'));
  await tapLabel(p.A, 'Blocked Collectors');
  await eventually('it lists only B with Unblock', p.A, async () => (await path(p.A)) === '/account/blocked'
    && (await bodyHas(p.A, `@${B.username}`)) && (await hasLabel(p.A, `Unblock @${B.username}`)));
  check('it explains unblocking doesn\'t restore follows or tags', await bodyHas(p.A, 'Unblocking doesn’t bring back follows, tags'));
  check('it doesn\'t overpromise about public content', await bodyHas(p.A, 'people who aren’t signed in'));
  await open(p.B, '/account/blocked');
  await eventually('B\'s own list is empty (never shows who blocked them)', p.B, () => bodyHas(p.B, 'You haven’t blocked anyone.'));

  step('6. Registry transfers are outside the release scope (R2)');
  // The Registry (and with it transfers) is excluded from the first
  // submission (lib/beta-features.ts): its route is not in the navigator.
  // The block-aware transfer refusal itself is still covered at the API
  // level by scripts/integration/user-blocking-transfers.ts.
  await open(p.A, `/registry/${card.id}`);
  await eventually('a direct link to the Registry does not open it', p.A, async () => (await path(p.A)) !== `/registry/${card.id}`
    && !(await hasLabel(p.A, 'Transfer this card to another user')));
  check('no transfer was created', (await admin.from('ownership_transfers').select('id').eq('registered_card_id', card.id)).data?.length === 0);

  step('7. Unblock from Blocked Collectors');
  await open(p.A, '/account/blocked');
  await choose(p.A, 'Unblock');
  await tapLabel(p.A, `Unblock @${B.username}`);
  await eventually('the row disappears with confirmation feedback', p.A, async () =>
    (await bodyHas(p.A, `Unblocked @${B.username}.`)) && !(await hasLabel(p.A, `Unblock @${B.username}`)));
  check('the block is gone on the server', !(await blockRow(A, B)));
  check('follows were not restored', (await admin.from('follows').select('follower_id').eq('follower_id', B.id).eq('following_id', A.id)).data?.length === 0);
  await open(p.A, `/user/${B.username}`);
  await eventually('B\'s post is visible again and the menu offers Block', p.A, async () => (await bodyHas(p.A, postB)) && !(await bodyHas(p.A, 'You blocked')));

  step('8. Block from a conversation; loading/error states; repeated actions');
  await open(p.A, `/conversation/${convId}`);
  await eventually('the composer is back after unblocking', p.A, () => hasComposer(p.A));
  await p.A.fakeRequests([{ match: /\/rpc\/block_collector/, fail: true }]);
  await choose(p.A, 'Block');
  await tapLabel(p.A, 'Conversation options');
  await tapLabel(p.A, 'Block Collector');
  await eventually('a dropped connection shows a clear error and changes nothing', p.A, async () => {
    const a = await lastAlert(p.A);
    return a?.title === 'Couldn’t block' && /Check your connection/.test(a.message) && !(await blockRow(A, B)) && (await hasComposer(p.A));
  });
  await p.A.fakeRequests([]);
  await choose(p.A, 'Block');
  await tapLabel(p.A, 'Conversation options');
  await tapLabel(p.A, 'Block Collector');
  await eventually('blocking from the conversation works and disables the composer', p.A, async () =>
    (await blockRow(A, B)) && !(await hasComposer(p.A)) && (await bodyHas(p.A, 'You blocked this collector.')));
  check('history is still there', (await bodyHas(p.A, `Hello from A ${run}`)) && (await bodyHas(p.A, `Hello from B ${run}`)));
  // Repeated taps: block again through the API (idempotent), then unblock twice quickly.
  check('a repeated block is harmless (already_blocked)', (await A.db.rpc('block_collector', { p_user_id: B.id })).data?.already_blocked === true);
  await choose(p.A, 'Unblock', 'Unblock');
  console.log('    · tapping Unblock Collector (twice, quickly)');
  await tapLabel(p.A, 'Unblock Collector');
  await p.A.tap('label', 'Unblock Collector', 3000).catch(() => {});
  console.log('    · taps sent');
  await eventually('unblocking from the conversation restores the composer', p.A, async () => !(await blockRow(A, B)) && (await hasComposer(p.A)));
  const errs = (await alerts(p.A)).filter((a) => /Couldn’t/.test(a.title));
  check('a double tap did not produce a second error', errs.length === 1, errs);

  step('9. Signed-out limitation (documented, not hidden)');
  must(await A.db.rpc('block_collector', { p_user_id: B.id }), 'block again');
  const pub = await anon.from('posts').select('id').eq('user_id', A.id);
  check('(limitation) A\'s public post is still readable signed out while B is blocked', (pub.data ?? []).length === 1, pub.error);
  must(await A.db.rpc('unblock_collector', { p_user_id: B.id }), 'unblock');

  await p.A.screenshot(`${OUT}/a-final.png`);
  await p.B.screenshot(`${OUT}/b-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
users.A = await createUser('A', 'Block Ana');
users.B = await createUser('B', 'Block Ben');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
// Hard stop: a hung page (eval never answering) must not hang the suite.
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

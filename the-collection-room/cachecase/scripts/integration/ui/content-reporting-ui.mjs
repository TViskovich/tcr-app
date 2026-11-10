// Content reporting UI (App Store moderation Phase 2A, Gate 2) — UI test of
// the real screens (web build) against the LOCAL Supabase stack:
//   A — reports B's profile, post, comment, DM message (then blocks B)
//   C — reports B's item, item/collection/gallery comments, collection
//   B — the reported collector: never sees a report or a report option on
//       their own content
// Every report is checked on the server for its exact target type and id.
// Fixture rows are written through each collector's own signed-in client;
// the service role only creates/deletes the disposable accounts and reads
// content_reports to verify.
//
// Prerequisites: supabase start (with 20261114120000), local-only Metro on
// :8090 and shell-proxy.mjs on :8091 (as the other UI suites).
// Run:  node scripts/integration/ui/content-reporting-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'content-reporting-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-content-reporting-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
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
const conversations = new Set();
async function sweep() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = data.users.filter((u) => u.app_metadata?.fixture === FIXTURE_TAG).map((u) => u.id);
  if (ids.length) {
    await admin.from('content_reports').delete().in('reporter_id', ids);
    await admin.from('content_reports').delete().in('target_owner_id', ids);
    const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
    for (const r of parts ?? []) conversations.add(r.conversation_id);
  }
  if (conversations.size) await admin.from('conversations').delete().in('id', [...conversations]);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key, displayName) {
  const username = `rp${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `rp-${randomUUID()}`;
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

// ── Page helpers (as the other UI suites) ─────────────────────────────────
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
const labelEl = (label) => `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
const hasLabel = (page, label) => page.eval(`!!(${labelEl(label)})`);
async function tapLabel(page, label, timeout = 20000) {
  await page.waitFor(`!!(${labelEl(label)})`, timeout, label);
  const unobstructed = `(() => { const el = ${labelEl(label)}; if (!el) return false; const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })()`;
  for (let i = 0; i < 10 && !(await page.eval(unobstructed)); i++) {
    await page.eval(`${labelEl(label)}?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await page.tap('label', label, 5000);
}
const choose = (page, ...choices) => page.eval(`(window.__alertChoices = ${JSON.stringify(choices)}, true)`);
const sheetOpen = (page) => page.eval(`!!document.querySelector('[data-testid="report-sheet"]')`);
const reports = async (filter) => (await filter(admin.from('content_reports').select('target_type, target_id, reason, details, reporter_id'))).data ?? [];

// Fills and submits the open sheet; leaves it on the result screen.
async function fillAndSubmit(page, reasonLabel, details) {
  await eventually(`…the report sheet opens`, page, () => sheetOpen(page));
  await tapLabel(page, reasonLabel);
  if (details) {
    await page.eval(`document.querySelector('[data-testid="report-details-input"]').focus()`);
    await page.send('Input.insertText', { text: details });
  }
  await tapLabel(page, 'Submit report');
}
async function finish(page) {
  await tapLabel(page, 'Done');
  await eventually('…Done closes the sheet', page, async () => !(await sheetOpen(page)));
}

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B, C } = users;
  const id = () => randomUUID();
  const fB = id(), iB = id(), pB = id(), pA = id(), pC = id(), cB = id(), cB2 = id(), cA = id(), icB = id(), fcB = id(), gcB = id();
  const mB = id(), mB2 = id(), mA = id();
  const PLAYER = 'Test Player';
  must(await B.db.from('folders').insert({ id: fB, user_id: B.id, name: `B binder ${run}`, is_public: true }), 'folder');
  must(await B.db.from('collection_items').insert({ id: iB, folder_id: fB, user_id: B.id, title: `B card ${run}`, player: PLAYER, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
  must(await B.db.from('posts').insert({ id: pB, user_id: B.id, content: `Post by B ${run}`, post_type: 'text' }), 'B post');
  must(await A.db.from('posts').insert({ id: pA, user_id: A.id, content: `Post by A ${run}`, post_type: 'text' }), 'A post');
  must(await C.db.from('posts').insert({ id: pC, user_id: C.id, content: `Post by C ${run}`, post_type: 'text' }), 'C post');
  must(await B.db.from('comments').insert([{ id: cB, user_id: B.id, post_id: pA, body: `Rude comment by B ${run}` },
    { id: cB2, user_id: B.id, post_id: pA, body: `Second comment by B ${run}` }]), 'B comments');
  must(await A.db.from('comments').insert({ id: cA, user_id: A.id, post_id: pA, body: `Own comment by A ${run}` }), 'A comment');
  must(await B.db.from('item_comments').insert({ id: icB, user_id: B.id, item_id: iB, body: `Item comment by B ${run}` }), 'item comment');
  must(await B.db.from('folder_comments').insert({ id: fcB, user_id: B.id, folder_id: fB, body: `Collection comment by B ${run}` }), 'folder comment');
  must(await B.db.from('gallery_comments').insert({ id: gcB, user_id: B.id, folder_id: fB, player_key: PLAYER, body: `Gallery comment by B ${run}` }), 'gallery comment');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'conversation');
  conversations.add(conv);
  must(await B.db.from('messages').insert([{ id: mB, conversation_id: conv, sender_id: B.id, body: `Abusive DM from B ${run}` }]), 'B message');
  await sleep(20);
  must(await B.db.from('messages').insert([{ id: mB2, conversation_id: conv, sender_id: B.id, body: `Another DM from B ${run}` }]), 'B message 2');
  must(await A.db.from('messages').insert({ id: mA, conversation_id: conv, sender_id: A.id, body: `Reply from A ${run}` }), 'A message');
  const notifB = (await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', B.id)).count;

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  await login(p.C, C);
  check('all signed in', true);

  step('1. Profile → Report @user (sheet contents, accessibility, submit, block offer)');
  await open(p.A, `/user/${B.username}`);
  await tapLabel(p.A, 'More options');
  await tapLabel(p.A, `Report @${B.username}`);
  await eventually('the sheet opens titled "Report collector" for @user', p.A, async () => (await sheetOpen(p.A))
    && (await bodyHas(p.A, 'Report collector')) && (await bodyHas(p.A, `@${B.username}`)));
  const radios = await p.A.eval(`[...document.querySelectorAll('[role="radio"]')].map(e => e.getAttribute('aria-label'))`);
  check('11 reasons, as radio buttons', radios.length === 11 && radios.includes('Child safety') && radios.includes('Scam or fraud'), radios);
  check('Submit is disabled until a reason is chosen', await p.A.eval(`${labelEl('Submit report')}?.getAttribute('aria-disabled') === 'true'`));
  check('the title is a header', await p.A.eval(`[...document.querySelectorAll('[role="heading"]')].some(e => e.textContent === 'Report collector')`));
  await tapLabel(p.A, 'Impersonation');
  check('the chosen reason is marked checked', await p.A.eval(`${labelEl('Impersonation')}?.getAttribute('aria-checked') === 'true'`));
  await p.A.eval(`document.querySelector('[data-testid="report-details-input"]').focus()`);
  await p.A.send('Input.insertText', { text: 'x'.repeat(520) });
  await eventually('details are capped at 500 with a live counter', p.A, () => bodyHas(p.A, '500/500'));
  await p.A.eval(`(() => { const el = document.querySelector('[data-testid="report-details-input"]'); el.focus(); el.select(); })()`);
  await p.A.send('Input.insertText', { text: 'Pretends to be a dealer' });
  await eventually('…counter follows the text', p.A, () => bodyHas(p.A, '23/500'));
  await tapLabel(p.A, 'Submit report');
  await eventually('confirmation uses the neutral wording', p.A, () => bodyHas(p.A, 'Thanks for reporting. We’ll review this against our Community Guidelines.'));
  check('…makes no claim about timing or outcome', !(await bodyHas(p.A, 'hours')) && !(await bodyHas(p.A, 'resolved')) && !(await bodyHas(p.A, 'removed')));
  check('…offers Block (not automatic)', (await hasLabel(p.A, `Block @${B.username}`))
    && (await admin.from('user_blocks').select('blocker_id').eq('blocker_id', A.id)).data?.length === 0);
  let r = await reports((q) => q.eq('reporter_id', A.id).eq('target_type', 'profile'));
  check('server: profile report for B\'s id, reason and details', r.length === 1 && r[0].target_id === B.id && r[0].reason === 'impersonation'
    && r[0].details === 'Pretends to be a dealer', r);
  await finish(p.A);
  check('navigation stays on the profile after Done', (await p.A.eval('location.pathname')) === `/user/${B.username}`);
  await tapLabel(p.A, 'More options');
  await tapLabel(p.A, `Report @${B.username}`);
  await fillAndSubmit(p.A, 'Spam');
  await eventually('reporting again shows the duplicate message', p.A, () => bodyHas(p.A, 'You’ve already reported this.'));
  await finish(p.A);

  step('2. Post: cancel from a feed card, then report from post detail');
  await open(p.A, `/user/${B.username}`);
  await tapLabel(p.A, `Report post by @${B.username}`);
  await eventually('a post card\'s ⋯ opens "Report post"', p.A, async () => (await sheetOpen(p.A)) && (await bodyHas(p.A, 'Report post')));
  await tapLabel(p.A, 'Harassment or bullying');
  await tapLabel(p.A, 'Cancel');
  await eventually('Cancel closes without reporting', p.A, async () => !(await sheetOpen(p.A))
    && (await reports((q) => q.eq('reporter_id', A.id).eq('target_type', 'post'))).length === 0);
  await open(p.A, `/post/${pB}`);
  await tapLabel(p.A, 'Report post');
  await fillAndSubmit(p.A, 'Spam');
  await eventually('post detail → report received', p.A, () => bodyHas(p.A, 'Thanks for reporting.'));
  r = await reports((q) => q.eq('reporter_id', A.id).eq('target_type', 'post'));
  check('server: target is the post id (pB)', r.length === 1 && r[0].target_id === pB, r);
  await finish(p.A);

  step('3. Comments on a post (and none on your own comment)');
  await open(p.A, `/post/${pA}`);
  await eventually('B\'s comments show Report; A\'s own comment does not', p.A, async () =>
    (await bodyHas(p.A, `Rude comment by B ${run}`)) && (await bodyHas(p.A, `Own comment by A ${run}`))
    && (await p.A.eval(`[...document.querySelectorAll('[aria-label="Report comment by @${B.username}"]')].length === 2`))
    && !(await hasLabel(p.A, `Report comment by @${A.username}`)));
  check('A\'s own post has no Report action', !(await hasLabel(p.A, 'Report post')));
  await p.A.eval(`[...document.querySelectorAll('[aria-label="Report comment by @${B.username}"]')][0].scrollIntoView({ block: 'center' })`);
  await p.A.tap('label', `Report comment by @${B.username}`);
  await eventually('the comment sheet names the comment', p.A, async () => (await sheetOpen(p.A)) && (await bodyHas(p.A, `Comment by @${B.username}`)));
  // Repeated taps on Submit send a single report.
  await tapLabel(p.A, 'Harassment or bullying');
  await p.A.tap('label', 'Submit report', 5000);
  await p.A.tap('label', 'Submit report', 2000).catch(() => {});
  await eventually('comment report received', p.A, () => bodyHas(p.A, 'Thanks for reporting.'));
  r = await reports((q) => q.eq('reporter_id', A.id).eq('target_type', 'comment'));
  check('server: exactly one report, for a comment id — never the post id', r.length === 1 && [cB, cB2].includes(r[0].target_id) && r[0].target_id !== pA, r);
  await finish(p.A);

  step('4. Direct message: long-press → Report Message; then Block; history still reportable');
  await open(p.A, `/conversation/${conv}`);
  await eventually('A sees the DM history', p.A, () => bodyHas(p.A, `Abusive DM from B ${run}`));
  await choose(p.A, 'Report Message');
  await p.A.longPress('text', `Abusive DM from B ${run}`);
  await fillAndSubmit(p.A, 'Harassment or bullying', 'Repeated insults');
  await eventually('message report received', p.A, () => bodyHas(p.A, 'Thanks for reporting.'));
  r = await reports((q) => q.eq('reporter_id', A.id).eq('target_type', 'message'));
  check('server: target is the message id (never the conversation id)', r.length === 1 && r[0].target_id === mB && r[0].target_id !== conv, r);
  await tapLabel(p.A, `Block @${B.username}`);
  await eventually('Block after reporting blocks B', p.A, async () => (await bodyHas(p.A, `Blocked @${B.username}.`))
    && (await admin.from('user_blocks').select('blocker_id').eq('blocker_id', A.id).eq('blocked_id', B.id)).data?.length === 1);
  await finish(p.A);
  await choose(p.A, 'Report Message');
  await p.A.longPress('text', `Another DM from B ${run}`);
  await fillAndSubmit(p.A, 'Spam');
  await eventually('a historical message is still reportable after blocking', p.A, () => bodyHas(p.A, 'Thanks for reporting.'));
  check('server: second message reported', (await reports((q) => q.eq('reporter_id', A.id).eq('target_id', mB2))).length === 1);
  check('no Block offer once already blocked', !(await hasLabel(p.A, `Block @${B.username}`)));
  await finish(p.A);
  const before = (await reports((q) => q.eq('reporter_id', A.id))).length;
  await choose(p.A);
  await p.A.longPress('text', `Reply from A ${run}`);
  await sleep(800);
  check('long-pressing your own message offers nothing', !(await sheetOpen(p.A)) && JSON.parse(await p.A.eval('JSON.stringify(window.__alerts)')).filter((a) => a.title === 'Message').length === 2);
  await tapLabel(p.A, 'Conversation options');
  await tapLabel(p.A, 'Report Collector');
  await fillAndSubmit(p.A, 'Harassment or bullying');
  await eventually('Report Collector from the conversation menu (already reported → duplicate)', p.A, () => bodyHas(p.A, 'You’ve already reported this.'));
  await finish(p.A);
  check('no extra report stored by the duplicate', (await reports((q) => q.eq('reporter_id', A.id))).length === before);

  step('5. Rate limit (A has 5 reports in 10 minutes) keeps the form intact');
  await open(p.A, `/post/${pC}`);
  await tapLabel(p.A, 'Report post');
  await fillAndSubmit(p.A, 'Something else', 'keep this text');
  await eventually('rate-limited → clear message, still on the form', p.A, async () => (await bodyHas(p.A, 'You’ve sent several reports recently.'))
    && (await sheetOpen(p.A)) && (await p.A.eval(`${labelEl('Something else')}?.getAttribute('aria-checked') === 'true'`))
    && (await p.A.eval(`document.querySelector('[data-testid="report-details-input"]').value === 'keep this text'`)));
  await tapLabel(p.A, 'Cancel');

  step('6. Hidden content after blocking: no Report on content A can no longer see');
  await open(p.A, `/post/${pB}`);
  await sleep(3000);
  check('B\'s post is unavailable to A, with nothing to report', !(await hasLabel(p.A, 'Report post')) && !(await bodyHas(p.A, `Post by B ${run}`)));

  step('7. Item, item comment, collection, collection comment, gallery comment (as C)');
  await open(p.C, `/item/${iB}`);
  await tapLabel(p.C, 'Report item');
  await fillAndSubmit(p.C, 'Scam or fraud');
  await eventually('item report received', p.C, () => bodyHas(p.C, 'Thanks for reporting.'));
  check('server: collection_item report for the item id', (await reports((q) => q.eq('reporter_id', C.id).eq('target_type', 'collection_item').eq('target_id', iB))).length === 1);
  await finish(p.C);
  step('7b. Content deleted while the sheet is open (before C reaches the rate limit)');
  await open(p.C, `/post/${pA}`);
  await eventually('C sees B\'s comments with Report', p.C, () => hasLabel(p.C, `Report comment by @${B.username}`));
  await p.C.eval(`[...document.querySelectorAll('[aria-label="Report comment by @${B.username}"]')].pop().scrollIntoView({ block: 'center' })`);
  await p.C.tap('label', `Report comment by @${B.username}`);
  await eventually('…sheet open', p.C, () => sheetOpen(p.C));
  // Deleted with the service role: after A blocked B (step 4), B can no
  // longer see — and so can't delete — its own comments on A's post.
  must(await admin.from('comments').delete().in('id', [cB, cB2]), 'comments deleted');
  await tapLabel(p.C, 'Spam');
  await tapLabel(p.C, 'Submit report');
  await eventually('a vanished target says it isn\'t available anymore', p.C, () => bodyHas(p.C, 'This isn’t available to report anymore.'));
  await tapLabel(p.C, 'Cancel');

  await open(p.C, `/item/${iB}`);
  await tapLabel(p.C, 'Comment');
  await tapLabel(p.C, `Report comment by @${B.username}`);
  // Network failure, then retry with the same choices.
  await p.C.fakeRequests([{ match: /\/rpc\/submit_report/, fail: true }]);
  await fillAndSubmit(p.C, 'Hate', 'slur in comment');
  await eventually('a dropped connection keeps the sheet, reason and details', p.C, async () => (await bodyHas(p.C, 'Couldn’t send your report. Check your connection'))
    && (await p.C.eval(`${labelEl('Hate')}?.getAttribute('aria-checked') === 'true'`))
    && (await p.C.eval(`document.querySelector('[data-testid="report-details-input"]').value === 'slur in comment'`)));
  await p.C.fakeRequests([]);
  await tapLabel(p.C, 'Submit report');
  await eventually('retry succeeds', p.C, () => bodyHas(p.C, 'Thanks for reporting.'));
  check('server: item_comment report for the comment id', (await reports((q) => q.eq('reporter_id', C.id).eq('target_type', 'item_comment').eq('target_id', icB))).length === 1);
  await finish(p.C);
  await open(p.C, `/collection/${fB}`);
  await tapLabel(p.C, 'Report collection');
  await fillAndSubmit(p.C, 'Intellectual property');
  await eventually('collection report received', p.C, () => bodyHas(p.C, 'Thanks for reporting.'));
  check('server: folder report for the folder id', (await reports((q) => q.eq('reporter_id', C.id).eq('target_type', 'folder').eq('target_id', fB))).length === 1);
  await finish(p.C);
  await tapLabel(p.C, 'Collection comments');
  await tapLabel(p.C, `Report comment by @${B.username}`);
  await fillAndSubmit(p.C, 'Sexual content');
  await eventually('collection comment report received', p.C, () => bodyHas(p.C, 'Thanks for reporting.'));
  check('server: folder_comment report for the comment id', (await reports((q) => q.eq('reporter_id', C.id).eq('target_type', 'folder_comment').eq('target_id', fcB))).length === 1);
  await finish(p.C);
  await open(p.C, `/collection/${fB}?player=${encodeURIComponent(PLAYER)}`);
  await tapLabel(p.C, 'Gallery comments');
  await tapLabel(p.C, `Report comment by @${B.username}`);
  await fillAndSubmit(p.C, 'Violence or threats');
  await eventually('gallery comment report received', p.C, () => bodyHas(p.C, 'Thanks for reporting.'));
  check('server: gallery_comment report for the comment id', (await reports((q) => q.eq('reporter_id', C.id).eq('target_type', 'gallery_comment').eq('target_id', gcB))).length === 1);
  await finish(p.C);

  step('9. The reported collector: no report options on own content, no notifications');
  await open(p.B, `/post/${pB}`);
  await sleep(3000);
  check('B\'s own post has no Report action', !(await hasLabel(p.B, 'Report post')) && !(await hasLabel(p.B, `Report post by @${B.username}`)));
  await open(p.B, `/item/${iB}`);
  await sleep(3000);
  check('B\'s own item has no Report action', !(await hasLabel(p.B, 'Report item')));
  await open(p.B, `/collection/${fB}`);
  await sleep(3000);
  check('B\'s own collection has no Report action', !(await hasLabel(p.B, 'Report collection')));
  const notifAfter = (await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', B.id)).count;
  check('B received no notification from any report', notifAfter === notifB, { notifB, notifAfter });
  const bReads = await B.db.from('content_reports').select('id');
  check('B cannot read the reports about them', !!bReads.error || (bReads.data ?? []).length === 0);

  await p.A.screenshot(`${OUT}/a-final.png`);
  await p.C.screenshot(`${OUT}/c-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
users.A = await createUser('A', 'Report Ana');
users.B = await createUser('B', 'Report Ben');
users.C = await createUser('C', 'Report Cal');
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
const hardStop = setTimeout(async () => {
  console.error(`\nHard timeout in "${current}" — taking screenshots and exiting.`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/hang-${key}.png`).catch(() => {});
  process.exit(2);
}, 540_000);
hardStop.unref();
let fatal = null;
try {
  for (const key of ['A', 'B', 'C']) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, pg]) => pg.errors.map((e) => `${k}: ${String(e).replace(/\s+/g, ' ').slice(0, 220)}`));
  await browser.close();
  const removed = await sweep();
  console.log(`\nCleanup: ${removed} accounts removed.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 15).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

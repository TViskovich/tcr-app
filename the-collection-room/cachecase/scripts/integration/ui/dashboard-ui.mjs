// User Dashboard (Milestone 1) — UI test of the real Dashboard tab (web
// build) against the LOCAL Supabase stack. Three temporary collectors:
//   A — the dashboard owner under test
//   B — engages with A's content (follow, likes, comments, a view, a tag)
//   C — views A's items, trades CC#ID transfers with A, and is an admin
// Every fixture row is written through that collector's OWN signed-in client
// with the app's own tables/functions (register_card,
// initiate_ownership_transfer, record_item_view…); the service role only
// creates/deletes the accounts and grants C's admin row.
//
// Prerequisites: same as group-messaging-ui.mjs (supabase start, local-only
// Metro on :8090, shell-proxy.mjs on :8091).
// Run:  node scripts/integration/ui/dashboard-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'dashboard-it';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-dashboard-ui`;
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
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// ── Fixtures ───────────────────────────────────────────────────────────────
const run = randomUUID().replace(/-/g, '').slice(0, 5);
const users = {};

async function sweep() {
  const ids = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE_TAG) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (!ids.length) return 0;
  // Registry rows outlive their owner (SET NULL by design), so fixture cards
  // are removed explicitly; their events and transfers cascade with them.
  await admin.from('registered_cards').delete().in('created_by', ids);
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  await admin.from('collection_items').delete().in('user_id', ids);
  await admin.from('folders').delete().in('user_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

async function createUser(key, displayName) {
  const username = `db${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `db-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { key, id: data.user.id, username, email, password, name: displayName, db };
}

// ── Page helpers ───────────────────────────────────────────────────────────
// react-native-web's Alert.alert is a no-op; replace it (this page only)
// with a recorder that presses the next queued button (as group-messaging-ui).
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
const queueAlert = (page, choice) => page.eval(`(window.__alertChoices = window.__alertChoices ?? []).push(${JSON.stringify(choice)})`);
const alerts = (page) => page.eval('window.__alerts ?? []');

async function login(page, u) {
  await page.goto(`${APP}/login`);
  await page.waitForEl('testid', 'login-email-input', 60000);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', u.password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
async function openDashboard(page) {
  await page.goto(`${APP}/dashboard`);
  await installAlertShim(page);
  await page.waitFor(`document.body.textContent.includes('How-To & Knowledge Base')`, 30000, 'dashboard');
}
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const hasLabel = (page, label) =>
  page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)`);
const labelsStarting = (page, prefix) =>
  page.eval(`[...document.querySelectorAll('[aria-label]')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.getAttribute('aria-label')).filter(l => l.startsWith(${JSON.stringify(prefix)}))`);
// Clicks the element labelled `label` inside the transfer row for `ccId`.
async function tapInRow(page, ccId, label) {
  const pt = await page.eval(`(() => {
    const card = [...document.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label') === ${JSON.stringify(`Open registry card ${ccId}`)});
    let row = card;
    while (row && !row.querySelector('[aria-label=${JSON.stringify(label)}]')) row = row.parentElement;
    const el = row?.querySelector('[aria-label=${JSON.stringify(label)}]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pt) throw new Error(`[${page.label}] no "${label}" in the row for ${ccId}`);
  await sleep(300);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
}
async function tapLabel(page, label) {
  await page.waitFor(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)})`, 20000, label);
  // Content above can still be loading and move the target, and the
  // floating tab bar covers the bottom of the screen: scroll until the
  // target itself is the topmost element at its centre.
  const unobstructed = `(() => { const el = [...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop();
    if (!el) return false; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit); })()`;
  for (let i = 0; i < 10 && !(await page.eval(unobstructed)); i++) {
    await page.eval(`[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()?.scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await page.tap('label', label);
}

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B, C } = users;

  // A's content: a public and a private collection; five active items across
  // three categories, one graded; one text post; one Grail.
  const pub = randomUUID();
  const priv = randomUUID();
  must(await A.db.from('folders').insert([
    { id: pub, user_id: A.id, name: 'Dash Binder', is_public: true },
    { id: priv, user_id: A.id, name: 'Dash Vault', is_public: false },
  ]), 'folders');
  const [i1, i2, i3, i4, i5] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const item = (id, folder, title, type, extra = {}) => ({ id, folder_id: folder, user_id: A.id, title, item_type: type, is_public: true, collection_status: 'active', ...extra });
  must(await A.db.from('collection_items').insert([
    item(i1, pub, 'Dash Rookie', 'sports_card', { grade: '10', grading_company: 'PSA' }),
    item(i2, pub, 'Dash Auto', 'sports_card'),
    item(i3, priv, 'Dash Hidden', 'sports_card', { is_public: false }),
    item(i4, pub, 'Dash Charizard', 'pokemon'),
    item(i5, pub, 'Dash Comic', 'comic_book'),
  ]), 'items');
  const postId = must(await A.db.rpc('create_text_post', { p_content: 'Dash post', p_attachments: [] }), 'post');
  const post = typeof postId === 'string' ? postId : (postId?.id ?? postId?.[0]?.id);
  if (!post) throw new Error(`create_text_post returned ${JSON.stringify(postId)}`);
  must(await A.db.from('profile_grail_slots').insert({ user_id: A.id, slot_index: 0, entry_type: 'item', item_id: i1 }), 'grail');

  // Engagement by B (and A's own likes, which must NOT count).
  must(await B.db.from('follows').insert({ follower_id: B.id, following_id: A.id }), 'follow');
  must(await B.db.from('likes').insert({ user_id: B.id, post_id: post }), 'post like');
  must(await A.db.from('likes').insert({ user_id: A.id, post_id: post }), 'self post like');
  must(await B.db.from('comments').insert({ user_id: B.id, post_id: post, body: 'nice' }), 'post comment');
  must(await B.db.from('item_likes').insert({ user_id: B.id, item_id: i1 }), 'item like');
  must(await A.db.from('item_likes').insert({ user_id: A.id, item_id: i1 }), 'self item like');
  must(await B.db.from('item_comments').insert({ user_id: B.id, item_id: i1, body: 'clean' }), 'item comment');
  must(await B.db.from('folder_likes').insert({ user_id: B.id, folder_id: pub }), 'folder like');
  must(await B.db.from('folder_comments').insert({ user_id: B.id, folder_id: pub, body: 'great binder' }), 'folder comment');
  // B tags A in B's own item.
  const bFolder = randomUUID();
  const bItem = randomUUID();
  must(await B.db.from('folders').insert({ id: bFolder, user_id: B.id, name: 'Ben Binder', is_public: true }), 'B folder');
  must(await B.db.from('collection_items').insert({ id: bItem, folder_id: bFolder, user_id: B.id, title: 'Ben Card', item_type: 'sports_card', is_public: true, collection_status: 'active' }), 'B item');
  must(await B.db.from('collection_item_tags').insert({ item_id: bItem, tagged_user_id: A.id }), 'tag');

  // Views: B and C open Rookie, C opens Auto → 3 views across 2 items.
  for (const [u, id] of [[B, i1], [C, i1], [C, i2]]) {
    const counted = must(await u.db.rpc('record_item_view', { p_item_id: id }), 'view');
    if (counted !== true) throw new Error(`view by ${u.key} not counted`);
  }

  // Registry: A registers Rookie and Auto; C registers two of C's own cards.
  const register = async (u, itemId) => {
    const r = must(await u.db.rpc('register_card', { p_collection_item_id: itemId, p_visibility: 'public' }), 'register_card');
    const id = typeof r === 'string' ? r : (r?.id ?? r?.[0]?.id);
    const { data } = await admin.from('registered_cards').select('id, cc_id').eq('id', id).single();
    return data;
  };
  const cFolder = randomUUID();
  const [c1, c2] = [randomUUID(), randomUUID()];
  must(await C.db.from('folders').insert({ id: cFolder, user_id: C.id, name: 'Cam Binder', is_public: true }), 'C folder');
  must(await C.db.from('collection_items').insert([
    { id: c1, folder_id: cFolder, user_id: C.id, title: 'Cam Rookie', item_type: 'sports_card', is_public: true, collection_status: 'active' },
    { id: c2, folder_id: cFolder, user_id: C.id, title: 'Cam Auto', item_type: 'sports_card', is_public: true, collection_status: 'active' },
  ]), 'C items');
  const cardA1 = await register(A, i1);
  const cardA2 = await register(A, i2);
  const cardC1 = await register(C, c1);
  const cardC2 = await register(C, c2);
  // Four pending transfers, oldest first: A→C (A2), C→A (C2), A→C (A1), C→A (C1).
  must(await A.db.rpc('initiate_ownership_transfer', { p_registered_card_id: cardA2.id, p_recipient_username: C.username, p_reason: 'trade' }), 'transfer A2');
  await sleep(50);
  must(await C.db.rpc('initiate_ownership_transfer', { p_registered_card_id: cardC2.id, p_recipient_username: A.username, p_reason: 'gift' }), 'transfer C2');
  await sleep(50);
  must(await A.db.rpc('initiate_ownership_transfer', { p_registered_card_id: cardA1.id, p_recipient_username: C.username, p_reason: 'sale' }), 'transfer A1');
  await sleep(50);
  must(await C.db.rpc('initiate_ownership_transfer', { p_registered_card_id: cardC1.id, p_recipient_username: A.username, p_reason: 'trade' }), 'transfer C1');
  must(await admin.from('admin_users').insert({ user_id: C.id }), 'admin row');

  step('0. Sign in');
  await login(p.A, A);
  await login(p.C, C);
  check('A and C signed in', true);

  step('1. Tab and header');
  await openDashboard(p.A);
  check('bottom tab is labelled "Dashboard"', await hasLabel(p.A, 'Dashboard'));
  check('no tab is labelled "Profile"', !(await hasLabel(p.A, 'Profile')));
  check('placeholder copy is gone', !(await bodyHas(p.A, 'Dashboard tools coming soon')) && !(await bodyHas(p.A, 'Professional Dashboard')));
  await eventually('header shows @username', p.A, () => bodyHas(p.A, `@${A.username}`));

  step('2. Analytics: collection totals (real counts)');
  await eventually('Items 5, Collections 2, Graded 1, Posts 1', p.A, async () =>
    (await hasLabel(p.A, 'Items: 5')) && (await hasLabel(p.A, 'Collections: 2')) && (await hasLabel(p.A, 'Graded: 1')) && (await hasLabel(p.A, 'Posts: 1')));
  await eventually('Registered 2 (CC#IDs A currently owns)', p.A, () => hasLabel(p.A, 'Registered: 2'));
  check('Grails 1/9', await hasLabel(p.A, 'Grails: 1/9'));
  check('categories: Sports card 3 (incl. private), Pokémon card 1, Comic book 1; none invented',
    (await hasLabel(p.A, 'Sports card: 3')) && (await hasLabel(p.A, 'Pokémon card: 1')) && (await hasLabel(p.A, 'Comic book: 1')) &&
    !(await hasLabel(p.A, 'Figurine: 0')) && !(await bodyHas(p.A, 'Uncategorized')));
  await p.A.screenshot(`${OUT}/01-analytics.png`);

  step('3. Analytics: item views');
  await eventually('3 views across 2 items', p.A, () => hasLabel(p.A, '3 item views across 2 items'));
  const top = await labelsStarting(p.A, 'Dash ');
  check('most viewed: Rookie (2) then Auto (1)', top.indexOf('Dash Rookie, 2 views') > -1 && top.indexOf('Dash Auto, 1 view') > top.indexOf('Dash Rookie, 2 views'), top);
  check('footnote explains what a view is', await bodyHas(p.A, 'at most once per collector every 30 minutes'));

  step('4. Analytics: engagement (from other collectors only)');
  const expected = { Followers: 1, Following: 0, 'Post likes': 1, 'Post comments': 1, 'Item likes': 1, 'Item comments': 1, 'Collection likes': 1, 'Collection comments': 1, 'Times tagged': 1 };
  for (const [label, n] of Object.entries(expected)) {
    await eventually(`${label}: ${n}`, p.A, () => hasLabel(p.A, `${label}: ${n}`), 8000);
  }
  check('untracked metrics are named as not recorded', await bodyHas(p.A, 'Profile views, Top 9 / Grails impressions and link clicks aren’t recorded yet'));

  step('5. Transfers preview (reused TransactionsList)');
  await eventually('summary: 4 total, 4 pending', p.A, () =>
    p.A.eval(`(() => { const t = document.body.innerText; return /\\b4\\s+Total\\b/i.test(t) && /\\b4\\s+Pending\\b/i.test(t); })()`));
  check('only 3 rows shown, with "Showing 3 of 4"', (await labelsStarting(p.A, 'Open registry card')).length === 3 && (await bodyHas(p.A, 'Showing 3 of 4')));
  check('View All present', await hasLabel(p.A, 'Open full transfer history'));
  await p.A.screenshot(`${OUT}/02-transfers.png`);

  step('6. Accept / Decline / Cancel still work from the Dashboard');
  await queueAlert(p.A, 'Accept');
  await tapInRow(p.A, cardC1.cc_id, 'Accept transfer');
  await eventually('Accept: C1 now owned by A (server)', p.A, async () => {
    const { data } = await admin.from('registered_cards').select('current_owner_id').eq('id', cardC1.id).single();
    return data.current_owner_id === A.id;
  });
  await queueAlert(p.A, 'Cancel Transfer');
  await tapInRow(p.A, cardA1.cc_id, 'Cancel transfer');
  await eventually('Cancel: A1 transfer cancelled (server)', p.A, async () => {
    const { data } = await admin.from('ownership_transfers').select('status').eq('registered_card_id', cardA1.id).single();
    return data.status === 'cancelled';
  });
  await queueAlert(p.A, 'Decline');
  await tapInRow(p.A, cardC2.cc_id, 'Decline transfer');
  await eventually('Decline: C2 transfer declined (server)', p.A, async () => {
    const { data } = await admin.from('ownership_transfers').select('status').eq('registered_card_id', cardC2.id).single();
    return data.status === 'declined';
  });
  const titles = (await alerts(p.A)).map((a) => a.title);
  check('each action asked for confirmation first', ['Accept transfer?', 'Cancel this transfer?', 'Decline transfer?'].every((t) => titles.includes(t)), titles);
  await openDashboard(p.A);
  await eventually('after refresh: Registered 3 (accepted card counted)', p.A, () => hasLabel(p.A, 'Registered: 3'));

  step('7. Registry and history navigation');
  await tapLabel(p.A, `Open registry card ${cardC1.cc_id}`);
  await eventually('row opens that card’s registry page', p.A, async () => (await p.A.eval('location.pathname')) === `/registry/${cardC1.id}`);
  await openDashboard(p.A);
  await tapLabel(p.A, 'Open full transfer history');
  await eventually('View All opens the full transfer history', p.A, async () => (await p.A.eval('location.pathname')) === `/transactions/${A.id}`);
  await eventually('full history lists all 4 transfers', p.A, async () => (await labelsStarting(p.A, 'Open registry card')).length === 4);

  step('8. Most viewed opens the item');
  await openDashboard(p.A);
  await eventually('Most viewed row present', p.A, () => hasLabel(p.A, 'Dash Rookie, 2 views'));
  await tapLabel(p.A, 'Dash Rookie, 2 views');
  await eventually('opens Item Detail for Rookie', p.A, async () => (await p.A.eval('location.pathname')) === `/item/${i1}`);

  step('9. How-To & Knowledge Base');
  await openDashboard(p.A);
  for (const g of ['Collections', 'Top 9 / Grails', 'Cache ID & provenance', 'Transfers']) {
    check(`guide: ${g}`, await hasLabel(p.A, `${g} guide`));
  }
  check('guides start collapsed', !(await bodyHas(p.A, 'Tap an empty slot and choose Single Item or Collection')));
  await tapLabel(p.A, 'Top 9 / Grails guide');
  await eventually('tapping expands the Grails guide', p.A, () => bodyHas(p.A, 'Tap an empty slot and choose Single Item or Collection'));
  check('expanded state is announced', await p.A.eval(`[...document.querySelectorAll('[aria-label="Top 9 / Grails guide"]')].some(e => e.getAttribute('aria-expanded') === 'true')`));
  check('planned features listed separately as "Planned"', (await bodyHas(p.A, 'Coming later')) && (await bodyHas(p.A, 'Account deletion')) && (await bodyHas(p.A, 'Planned')));

  step('10. Support & Contact: no invented destinations');
  for (const s of ['Help Center', 'Contact Support', 'Report a Problem']) {
    check(`${s}: shown as not available yet`, await hasLabel(p.A, `${s}, not available yet`));
  }
  check('no mailto or http link on the page', await p.A.eval(`![...document.querySelectorAll('a[href]')].some(a => /^(mailto:|https?:)/.test(a.getAttribute('href')))`));
  check('placeholder note shown', await bodyHas(p.A, 'Support contact details are being finalized'));

  step('11. Account & Security');
  check('signed-in email shown', await bodyHas(p.A, A.email));
  check('privacy and provenance information', (await bodyHas(p.A, 'Private ones are visible only to you')) && (await bodyHas(p.A, 'A Cache ID is a permanent record')));
  for (const l of ['Delete Account', 'Freeze Account', 'Private Profile']) {
    check(`${l}: not available yet (no control)`, (await hasLabel(p.A, `${l}, not available yet`)) && !(await p.A.eval(`[...document.querySelectorAll('[role="button"],[role="switch"],button')].some(e => e.textContent.trim() === ${JSON.stringify(l)})`)));
  }
  check('non-admin sees no Admin Tools', !(await bodyHas(p.A, 'Waitlist Management')));
  await p.A.screenshot(`${OUT}/03-account.png`);

  step('12. Admin-only Waitlist entry preserved');
  await openDashboard(p.C);
  await eventually('admin C sees Waitlist Management', p.C, () => bodyHas(p.C, 'Waitlist Management'));
  await p.C.eval(`[...document.querySelectorAll('div')].filter(e => e.textContent.trim() === 'Waitlist Management').pop()?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await p.C.tap('text', 'Waitlist Management');
  await eventually('opens /admin/waitlist', p.C, async () => (await p.C.eval('location.pathname')) === '/admin/waitlist');

  step('13. A failed count shows an error, never zero');
  await p.A.fakeRequests([{ match: /\/rest\/v1\/item_likes/, status: 500, body: { code: 'XX000', message: 'test failure', details: null, hint: null } }]);
  await openDashboard(p.A);
  await eventually('Engagement shows "Couldn’t load" with Retry', p.A, async () => (await bodyHas(p.A, 'Couldn’t load this right now.')) && (await hasLabel(p.A, 'Retry')));
  check('no engagement numbers shown for the failed group', !(await hasLabel(p.A, 'Post likes: 1')) && !(await hasLabel(p.A, 'Item likes: 0')));
  check('other groups still load', (await hasLabel(p.A, 'Items: 5')) && (await hasLabel(p.A, '3 item views across 2 items')));
  await p.A.screenshot(`${OUT}/04-failed-group.png`);
  await p.A.fakeRequests([]);

  step('14. Sign Out');
  await openDashboard(p.A);
  await queueAlert(p.A, 'Sign out');
  await tapLabel(p.A, 'Sign out');
  await eventually('signed out to the login screen', p.A, async () => (await p.A.eval('location.pathname')).includes('login'), 20000);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const [key, name] of [['A', 'Dash Ana'], ['B', 'Dash Ben'], ['C', 'Dash Cam']]) users[key] = await createUser(key, name);
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'C']) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, pg]) => pg.errors.map((e) => `${k}: ${String(e).replace(/\s+/g, ' ').slice(0, 260)}`));
  await browser.close();
  const removed = await sweep();
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).like('username', `db${run}%`);
  const { count: cards } = await admin.from('registered_cards').select('id', { count: 'exact', head: true }).is('created_by', null).is('current_owner_id', null);
  console.log(`\nCleanup: ${removed} accounts removed; leftover profiles: ${count}; ownerless registry cards: ${cards}.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 20).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

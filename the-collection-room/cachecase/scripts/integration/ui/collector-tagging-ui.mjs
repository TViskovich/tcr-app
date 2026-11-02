// Collector tagging — Checkpoint 2 UI test of the real app screens (web
// build) against the LOCAL Supabase stack: the Tag action on Item Detail and
// Collection Detail and the shared tagging sheet, driven as the owner, a
// tagged collector and a visitor in isolated browser contexts. All reads and
// writes go through the app's own signed-in client (RLS applies); the
// service role only creates/deletes fixture accounts and checks the
// server-side notification.
//
// Prerequisites: same as group-messaging-ui.mjs (supabase start with the
// tagging migration, local-only Metro on :8090, shell-proxy.mjs on :8091).
// Run:  node scripts/integration/ui/collector-tagging-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'collector-tagging-it';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-tagging-ui`;
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
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  await admin.from('collection_items').delete().in('user_id', ids);
  await admin.from('folders').delete().in('user_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

async function createUser(key, displayName) {
  const username = `tg${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `tg-${randomUUID()}`;
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
async function login(page, u) {
  await page.goto(`${APP}/login`);
  await page.waitForEl('testid', 'login-email-input', 60000);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', u.password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const rect = (page, label) =>
  page.eval(`(() => { const e = [...document.querySelectorAll('[aria-label="${label}"]')].pop(); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
async function tapUntil(page, kind, value, expectText, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if (await page.exists(kind, value)) await page.tap(kind, value);
    try {
      await page.waitFor(`document.body.textContent.includes(${JSON.stringify(expectText)})`, 2500, expectText);
      return;
    } catch {}
  }
  throw new Error(`[${page.label}] tapping ${kind}=${value} never showed "${expectText}"`);
}
async function search(page, text) {
  await page.eval(`(() => { const el = [...document.querySelectorAll('input')].filter(i => i.placeholder === 'Search people').pop(); el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(900); // debounce + request
}
async function openSheet(page) {
  for (let i = 0; i < 6 && !(await page.exists('text', 'Done')); i++) {
    if (await page.exists('label', 'Tag')) await page.tap('label', 'Tag');
    await page.waitForEl('text', 'Done', 2500).catch(() => {});
  }
  await page.waitForEl('text', 'Done', 5000);
  await page.waitFor(`!document.body.textContent.includes('Loading')`, 2000).catch(() => {});
  await sleep(800);
}
async function closeSheet(page) {
  await page.tap('text', 'Done');
  await page.waitFor(`![...document.querySelectorAll('div,span')].some(e => e.textContent.trim() === 'Done' && e.getBoundingClientRect().width > 0)`, 10000, 'sheet closed');
  await sleep(400);
}


// Present anywhere in the page (tiles can sit below the fold).
const hasLabel = (page, label) => page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)`);
async function scrollTo(page, kind, value) {
  await page.eval(`(() => { const sel = ${JSON.stringify(kind)} === 'label' ? [...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(value)}) : [...document.querySelectorAll('div,span')].filter(e => e.textContent.trim() === ${JSON.stringify(value)} && ![...e.children].some(c => c.textContent.trim() === ${JSON.stringify(value)}));
    const el = sel.filter(e => e.getBoundingClientRect().width > 0).pop(); el?.scrollIntoView({ block: 'center' }); })()`);
  await sleep(400);
}
async function tapScrolled(page, kind, value) {
  await scrollTo(page, kind, value);
  await page.tap(kind, value);
}
// Taps the innermost visible element whose text contains `text`.
async function tapContaining(page, text, index = 0) {
  const pt = await page.eval(`(() => { const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('div,span')].filter(e => e.textContent.includes(t) && ![...e.children].some(c => c.textContent.includes(t)) && e.getBoundingClientRect().width > 0);
    const el = els[${index}]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!pt) throw new Error(`[${page.label}] no element containing "${text}" (#${index})`);
  await sleep(300);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
  await sleep(400);
}
async function openTaggedTab(page, path) {
  await page.goto(`${APP}${path}`);
  await page.waitForEl('text', 'Tagged', 30000);
  await tapScrolled(page, 'text', 'Tagged');
  await page.waitFor(`!document.body.textContent.includes('Loading')`, 3000).catch(() => {});
  await sleep(2500);
}

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(p) {
  const { A, B, C, V, X } = users;

  // A's content, created through A's own client: a public collection with a
  // public item and a private item.
  // Ids are made here: returning a just-inserted folder row runs the
  // folder visibility check before the row is visible to it.
  const folder = { id: randomUUID() };
  const item = randomUUID();
  const privateItem = randomUUID();
  const { error: fErr } = await A.db.from('folders').insert({ id: folder.id, user_id: A.id, name: 'Tag Test Binder', is_public: true });
  if (fErr) throw fErr;
  const { error: iErr } = await A.db.from('collection_items').insert([
    { id: item, folder_id: folder.id, user_id: A.id, title: 'Tag Test Rookie', is_public: true, collection_status: 'active' },
    { id: privateItem, folder_id: folder.id, user_id: A.id, title: 'Tag Test Secret', is_public: false, collection_status: 'active' },
  ]);
  if (iErr) throw iErr;

  step('0. Sign in (real login screen)');
  for (const key of ['A', 'B', 'V']) {
    await login(p[key], users[key]);
    check(`${key} signed in`, true);
  }

  step('1. Tag action on Item Detail (owner)');
  await p.A.goto(`${APP}/item/${item}`);
  await p.A.waitForEl('label', 'Share', 30000);
  await eventually('Tag icon appears (tagging available)', p.A, () => p.A.exists('label', 'Tag'));
  const share = await rect(p.A, 'Share');
  const tag = await rect(p.A, 'Tag');
  check('Tag sits at the end of Comment / Like / Share, same row', tag && share && tag.x > share.x && Math.abs(tag.y - share.y) < 1, { share, tag });
  check('Tag button is the same size as Share (36×36)', tag && share && tag.w === share.w && tag.h === share.h, { share, tag });
  await p.A.screenshot(`${OUT}/01-item-action-row.png`);

  step('2. Owner: empty sheet, then tag B and C');
  await openSheet(p.A);
  check('sheet names the item', await bodyHas(p.A, 'Tag Test Rookie'));
  check('empty state with the owner hint', (await bodyHas(p.A, 'No one is tagged yet')) && (await bodyHas(p.A, 'Tag collectors to show this item on their profile.')));
  await tapUntil(p.A, 'label', 'Tag collectors', 'Tag Collectors');
  await search(p.A, A.username);
  check('the owner cannot pick themselves (not offered)', !(await p.A.exists('label', A.name)));
  await search(p.A, B.username);
  await p.A.tap('label', B.name);
  await search(p.A, C.username);
  await p.A.tap('label', C.name);
  check('picks shown as chips, "2 selected"', (await p.A.exists('label', `Remove ${B.name}`)) && (await bodyHas(p.A, '2 selected')));
  await p.A.tap('text', 'Tag');
  await eventually('back on the list: B and C tagged, 2/20', p.A, async () => (await bodyHas(p.A, '2/20 tagged')) && (await p.A.exists('label', `Remove ${B.name}`)) && (await p.A.exists('label', `Remove ${C.name}`)));
  await p.A.screenshot(`${OUT}/02-owner-list.png`);
  const { data: bNotif } = await admin.from('notifications').select('id').eq('user_id', B.id).eq('type', 'item_tag').eq('item_id', item);
  check('server created B’s tag notification (exactly one)', bNotif?.length === 1, bNotif);

  step('3. Duplicates and server errors');
  await tapUntil(p.A, 'label', 'Tag collectors', 'Tag Collectors');
  await search(p.A, B.username);
  check('already-tagged collectors are not offered again', !(await p.A.exists('label', B.name)));
  await search(p.A, X.username);
  await p.A.tap('label', X.name);
  // Meanwhile the owner tags X from another device.
  const race = await A.db.from('collection_item_tags').insert({ item_id: item, tagged_user_id: X.id });
  check('(another device tags X first)', !race.error, race.error);
  await p.A.tap('text', 'Tag');
  await eventually('the server’s duplicate refusal is shown in words', p.A, () => bodyHas(p.A, 'Someone you picked is already tagged.'));
  await p.A.screenshot(`${OUT}/03-duplicate-error.png`);
  await p.A.tap('text', 'Back');
  await eventually('list reloaded with X from the other device', p.A, () => p.A.exists('label', `Remove ${X.name}`));

  step('4. Owner removes a tag');
  await p.A.tap('label', `Remove ${C.name}`);
  await eventually('C removed, 2/20', p.A, async () => !(await p.A.exists('label', `Remove ${C.name}`)) && (await bodyHas(p.A, '2/20 tagged')));
  await closeSheet(p.A);

  step('5. Tagged collector (B): read-only except their own tag');
  await p.B.goto(`${APP}/item/${item}`);
  await p.B.waitForEl('label', 'Share', 30000);
  await eventually('B sees the Tag icon on A’s item', p.B, () => p.B.exists('label', 'Tag'));
  await openSheet(p.B);
  check('B is listed as "You" with "Remove Me"', (await bodyHas(p.B, '· You')) && (await p.B.exists('label', 'Remove my tag')));
  check('B cannot remove X or add anyone', !(await p.B.exists('label', `Remove ${X.name}`)) && !(await p.B.exists('label', 'Tag collectors')));
  await p.B.screenshot(`${OUT}/05-tagged-B.png`);
  await p.B.tap('label', 'Remove my tag');
  await eventually('B’s tag is gone', p.B, async () => !(await bodyHas(p.B, '· You')) && (await bodyHas(p.B, X.name)));
  const { data: bAfter } = await admin.from('notifications').select('id').eq('user_id', B.id).eq('type', 'item_tag').eq('item_id', item);
  check('and so is B’s notification', bAfter?.length === 0, bAfter);

  step('6. Visitor (V): read-only');
  await p.V.goto(`${APP}/item/${item}`);
  await p.V.waitForEl('label', 'Share', 30000);
  await eventually('visitor sees the Tag icon', p.V, () => p.V.exists('label', 'Tag'));
  await openSheet(p.V);
  check('visitor sees who is tagged', await bodyHas(p.V, X.name));
  check('visitor has no Add or Remove controls', !(await p.V.exists('label', 'Tag collectors')) && !(await p.V.exists('labelStarts', 'Remove')));
  await p.V.screenshot(`${OUT}/06-visitor.png`);
  await closeSheet(p.V);

  step('7. Collection Detail: same action and sheet');
  await p.A.goto(`${APP}/collection/${folder.id}`);
  await eventually('Tag icon on the collection’s action group', p.A, () => p.A.exists('label', 'Tag'), 30000);
  const sizes = await p.A.eval(`(() => { const t = [...document.querySelectorAll('[aria-label="Tag"]')].pop(); const prev = t.previousElementSibling; const a = t.getBoundingClientRect(), b = prev.getBoundingClientRect(); return { tag: [a.width, a.height, a.x, a.y], prev: [b.width, b.height, b.x, b.y] }; })()`);
  check('it follows Share at the end of the group, same size and row', sizes.tag[0] === sizes.prev[0] && sizes.tag[1] === sizes.prev[1] && sizes.tag[2] > sizes.prev[2] && Math.abs(sizes.tag[3] - sizes.prev[3]) < 1, sizes);
  await p.A.screenshot(`${OUT}/07-collection-row.png`);
  await openSheet(p.A);
  check('sheet names the collection', await bodyHas(p.A, 'Tag Test Binder'));
  await tapUntil(p.A, 'label', 'Tag collectors', 'Tag Collectors');
  await search(p.A, B.username);
  await p.A.tap('label', B.name);
  await p.A.tap('text', 'Tag');
  await eventually('B tagged in the collection', p.A, () => p.A.exists('label', `Remove ${B.name}`));
  const { data: fNotif } = await admin.from('notifications').select('id').eq('user_id', B.id).eq('type', 'folder_tag').eq('folder_id', folder.id);
  check('server created B’s collection notification', fNotif?.length === 1, fNotif);
  await closeSheet(p.A);
  await p.V.goto(`${APP}/collection/${folder.id}`);
  await eventually('visitor sees Tag on the collection', p.V, () => p.V.exists('label', 'Tag'), 30000);
  await openSheet(p.V);
  check('visitor: read-only collection list', (await bodyHas(p.V, B.name)) && !(await p.V.exists('labelStarts', 'Remove')));
  await closeSheet(p.V);

  step('8. The 20-collector maximum');
  const fillers = [];
  for (let i = 1; i <= 18; i++) fillers.push(await createUser(`f${i}`, `Tag Fill ${i}`));
  const seed = await A.db.from('collection_item_tags').insert(fillers.map((f) => ({ item_id: item, tagged_user_id: f.id })));
  check('(owner seeds 18 more tags → 19)', !seed.error, seed.error);
  await p.A.goto(`${APP}/item/${item}`);
  await p.A.waitForEl('label', 'Tag', 30000);
  await openSheet(p.A);
  await eventually('19/20 tagged', p.A, () => bodyHas(p.A, '19/20 tagged'));
  await tapUntil(p.A, 'label', 'Tag collectors', 'Tag Collectors');
  check('picker says "Up to 1 more"', await bodyHas(p.A, 'Up to 1 more'));
  await search(p.A, C.username);
  await p.A.tap('label', C.name);
  await search(p.A, B.username);
  await p.A.tap('label', B.name);
  check('a second pick is refused: "You can tag 1 more collector."', (await bodyHas(p.A, 'You can tag 1 more collector.')) && !(await p.A.exists('label', `Remove ${B.name}`)));
  await p.A.tap('text', 'Tag');
  await eventually('20/20 with the maximum notice; Add disabled', p.A, async () =>
    (await bodyHas(p.A, '20/20 tagged')) && (await bodyHas(p.A, 'has the maximum of 20 tagged collectors')) &&
    (await p.A.eval(`[...document.querySelectorAll('[aria-label="Tag collectors"]')].pop()?.getAttribute('aria-disabled') === 'true'`)),
  );
  await p.A.screenshot(`${OUT}/08-cap.png`);
  await closeSheet(p.A);
  const over = await A.db.from('collection_item_tags').insert({ item_id: item, tagged_user_id: V.id });
  check('server enforces it too (tag_limit_reached)', over.error?.message === 'tag_limit_reached', over.error);

  step('9. Privacy: a tag never exposes a private item');
  const priv = await A.db.from('collection_item_tags').insert({ item_id: privateItem, tagged_user_id: B.id });
  check('(owner tags B in a private item)', !priv.error, priv.error);
  const bView = await B.db.from('collection_item_tags').select('item_id').eq('item_id', privateItem);
  check('B cannot read that tag', !bView.error && bView.data.length === 0, bView);
  await p.B.goto(`${APP}/item/${privateItem}`);
  await sleep(4000);
  check('B opening the private item gets no item, no Tag action, no title', !(await p.B.exists('label', 'Tag')) && !(await bodyHas(p.B, 'Tag Test Secret')));
  await p.B.screenshot(`${OUT}/09-private-B.png`);


  // ── Checkpoint 3: the Tagged tab and tag notifications ──────────────────
  step('10. Setup: B tagged in more of A’s content; B saves (bookmarks) one item');
  const later = randomUUID(), gone = randomUUID(), saved = randomUUID();
  {
    const { error } = await A.db.from('collection_items').insert([
      { id: later, folder_id: folder.id, user_id: A.id, title: 'Tag Test Later', is_public: true, collection_status: 'active' },
      { id: gone, folder_id: folder.id, user_id: A.id, title: 'Tag Test Gone', is_public: true, collection_status: 'active' },
      { id: saved, folder_id: folder.id, user_id: A.id, title: 'Tag Test Saved', is_public: true, collection_status: 'active' },
    ]);
    if (error) throw error;
  }
  const freeSlot = await A.db.from('collection_item_tags').delete().eq('item_id', item).eq('tagged_user_id', (await admin.from('profiles').select('id').eq('username', `tg${run}f1`).single()).data.id);
  check('(owner frees a slot on the full item)', !freeSlot.error, freeSlot.error);
  for (const id of [item, later, gone]) {
    const r = await A.db.from('collection_item_tags').insert({ item_id: id, tagged_user_id: B.id });
    if (r.error) throw r.error;
  }
  const save = await B.db.from('saved_cards').insert({ user_id: B.id, item_id: saved });
  check('(B bookmarks "Tag Test Saved" — saved content, not a tag)', !save.error, save.error);
  const savedBefore = (await admin.from('saved_cards').select('item_id, created_at').eq('user_id', B.id)).data;

  step('11. B’s own Tagged tab shows A’s content B was tagged in');
  await openTaggedTab(p.B, '/profile');
  await eventually('item tiles: Rookie, Later, Gone', p.B, async () =>
    (await hasLabel(p.B, 'Tag Test Rookie')) && (await hasLabel(p.B, 'Tag Test Later')) && (await hasLabel(p.B, 'Tag Test Gone')));
  check('collection tile: Tag Test Binder', await hasLabel(p.B, 'Collection: Tag Test Binder'));
  check('private item B is tagged in is NOT shown', !(await hasLabel(p.B, 'Tag Test Secret')));
  check('B’s bookmarked item is NOT shown (Tagged ≠ Saved)', !(await hasLabel(p.B, 'Tag Test Saved')));
  await p.B.screenshot(`${OUT}/11-tagged-own.png`);

  step('12. Tapping a tagged tile opens the owner’s original');
  await tapScrolled(p.B, 'label', 'Tag Test Rookie');
  await eventually('Item Detail of A’s item, owned by A', p.B, async () =>
    (await p.B.eval('location.pathname')) === `/item/${item}` && (await bodyHas(p.B, `@${A.username}`)));
  const { data: rookie } = await admin.from('collection_items').select('user_id, folder_id').eq('id', item).single();
  check('content not copied or transferred (still A’s, same collection)', rookie.user_id === A.id && rookie.folder_id === folder.id, rookie);
  await p.B.eval('history.back()');
  await sleep(2000);

  step('13. Visitor V on B’s profile sees the same tagged content');
  await openTaggedTab(p.V, `/user/${B.username}`);
  await eventually('V sees Rookie, Later, Gone and the Binder', p.V, async () =>
    (await hasLabel(p.V, 'Tag Test Rookie')) && (await hasLabel(p.V, 'Tag Test Later')) && (await hasLabel(p.V, 'Tag Test Gone')) && (await hasLabel(p.V, 'Collection: Tag Test Binder')));
  check('V does not see the private item', !(await hasLabel(p.V, 'Tag Test Secret')));
  await p.V.screenshot(`${OUT}/13-tagged-visitor.png`);

  step('14. Visibility change and deletion drop out on refresh');
  const hide = await A.db.from('collection_items').update({ is_public: false }).eq('id', later);
  const del = await A.db.from('collection_items').delete().eq('id', gone);
  check('(A makes "Later" private and deletes "Gone")', !hide.error && !del.error, hide.error ?? del.error);
  await openTaggedTab(p.V, `/user/${B.username}`);
  await eventually('V: Later and Gone gone, Rookie and Binder remain', p.V, async () =>
    !(await hasLabel(p.V, 'Tag Test Later')) && !(await hasLabel(p.V, 'Tag Test Gone')) && (await hasLabel(p.V, 'Tag Test Rookie')) && (await hasLabel(p.V, 'Collection: Tag Test Binder')));
  await openTaggedTab(p.B, '/profile');
  await eventually('B (tagged, not owner) also no longer sees "Later"', p.B, async () => !(await hasLabel(p.B, 'Tag Test Later')) && (await hasLabel(p.B, 'Tag Test Rookie')));
  const { data: goneNotif } = await admin.from('notifications').select('id').eq('item_id', gone);
  check('the deleted item’s notification was removed with it', goneNotif?.length === 0, goneNotif);

  step('15. Long-press Search Tagged Items searches tagged content');
  await scrollTo(p.B, 'text', 'Tagged');
  await p.B.longPress('text', 'Tagged');
  await eventually('search sheet opens', p.B, () => p.B.exists('placeholder', 'Search tagged items'));
  await p.B.type('placeholder', 'Search tagged items', 'Rookie');
  await eventually('finds "Tag Test Rookie", context names A', p.B, async () => (await p.B.exists('text', 'Tag Test Rookie')) && (await bodyHas(p.B, `@${A.username}'s`)));
  await p.B.eval(`(() => { const el = [...document.querySelectorAll('input')].filter(i => i.placeholder === 'Search tagged items').pop(); el.focus(); el.select(); })()`);
  await p.B.send('Input.insertText', { text: 'Saved' });
  await sleep(800);
  check('does not find the bookmarked item', !(await p.B.exists('text', 'Tag Test Saved')));
  await p.B.eval(`(() => { const el = [...document.querySelectorAll('input')].filter(i => i.placeholder === 'Search tagged items').pop(); el.focus(); el.select(); })()`);
  await p.B.send('Input.insertText', { text: 'Rookie' });
  await sleep(800);
  await p.B.screenshot(`${OUT}/15-tagged-search.png`);
  await p.B.tap('text', 'Tag Test Rookie');
  await eventually('result opens the item', p.B, async () => (await p.B.eval('location.pathname')) === `/item/${item}`);

  step('16. Notifications: text and destinations');
  await p.B.goto(`${APP}/notifications`);
  await eventually('rows: "tagged you in a collection." and two "tagged you in an item."', p.B, async () =>
    (await bodyHas(p.B, `${A.name} tagged you in a collection.`)) &&
    (await p.B.eval(`[...document.querySelectorAll('div,span')].filter(e => e.textContent.trim().endsWith('tagged you in an item.') && ![...e.children].some(c => c.textContent.includes('tagged you'))).length`)) === 2, 20000);
  await p.B.screenshot(`${OUT}/16-notifications.png`);
  // Newest first: "Later" (now private), then "Rookie".
  await tapContaining(p.B, 'tagged you in an item.', 0);
  await eventually('newest item notification → /item/<Later>', p.B, async () => (await p.B.eval('location.pathname')) === `/item/${later}`);
  await sleep(3000);
  check('…which is now private: no title, no Tag action shown', !(await bodyHas(p.B, 'Tag Test Later')) && !(await p.B.exists('label', 'Tag')));
  await p.B.goto(`${APP}/notifications`);
  await eventually('notifications reload', p.B, () => bodyHas(p.B, 'tagged you in an item.'));
  await tapContaining(p.B, 'tagged you in an item.', 1);
  await eventually('older item notification → A’s Item Detail', p.B, async () => (await p.B.eval('location.pathname')) === `/item/${item}` && (await bodyHas(p.B, 'Tag Test Rookie')));
  await p.B.goto(`${APP}/notifications`);
  await eventually('notifications reload', p.B, () => bodyHas(p.B, 'tagged you in a collection.'));
  await tapContaining(p.B, 'tagged you in a collection.');
  await eventually('collection notification → A’s Collection Detail', p.B, async () => (await p.B.eval('location.pathname')) === `/collection/${folder.id}` && (await bodyHas(p.B, 'Tag Test Binder')));

  step('17. Removing a tag removes the content from Tagged');
  await openTaggedTab(p.B, '/profile');
  await tapScrolled(p.B, 'label', 'Tag Test Rookie');
  await p.B.waitForEl('label', 'Tag', 30000);
  await openSheet(p.B);
  await eventually('B’s row is in the sheet', p.B, () => hasLabel(p.B, 'Remove my tag'));
  await tapScrolled(p.B, 'label', 'Remove my tag');
  await eventually('tag removed', p.B, async () => !(await bodyHas(p.B, '· You')));
  await closeSheet(p.B);
  await p.B.eval('history.back()');
  await eventually('back on the profile, Rookie has left Tagged (refresh on focus); Binder stays', p.B, async () =>
    (await p.B.eval('location.pathname')) === '/profile' && !(await hasLabel(p.B, 'Tag Test Rookie')) && (await hasLabel(p.B, 'Collection: Tag Test Binder')), 20000);
  await p.B.screenshot(`${OUT}/17-after-remove.png`);

  step('18. Saved content untouched');
  const savedAfter = (await admin.from('saved_cards').select('item_id, created_at').eq('user_id', B.id)).data;
  check('B’s saved_cards rows are identical', JSON.stringify(savedAfter) === JSON.stringify(savedBefore), { savedBefore, savedAfter });
  await p.B.goto(`${APP}/saved`);
  await eventually('the Saved screen still shows the bookmarked item', p.B, () => bodyHas(p.B, 'Tag Test Saved'), 20000);
  await p.B.screenshot(`${OUT}/18-saved.png`);

  step('19. Database without the migration (production today)');
  const errorsBefore = p.V.errors.length;
  await p.V.fakeRequests([
    {
      match: /\/rest\/v1\/(collection_item_tags|folder_tags)/,
      status: 404,
      body: { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.collection_item_tags' in the schema cache" },
    },
  ]);
  await p.V.goto(`${APP}/item/${item}`);
  await p.V.waitForEl('label', 'Share', 30000);
  await sleep(3000);
  check('Item Detail works, Comment / Like / Share present', (await p.V.exists('label', 'Comment')) && (await p.V.exists('label', 'Share')));
  check('no Tag icon', !(await p.V.exists('label', 'Tag')));
  check('exactly one probe request for the session', p.V.fakedUrls.length === 1, p.V.fakedUrls);
  await p.V.tap('labelStarts', 'Tag Ana').catch(() => {});
  await p.V.goto(`${APP}/collection/${folder.id}`);
  await sleep(4000);
  check('Collection Detail: no Tag icon', !(await p.V.exists('label', 'Tag')) && (await bodyHas(p.V, 'Tag Test Binder')));
  await openTaggedTab(p.V, `/user/${B.username}`);
  await eventually('Tagged tab: the plain empty state, no saved items', p.V, async () => (await bodyHas(p.V, 'Nothing tagged yet')) && !(await hasLabel(p.V, 'Collection: Tag Test Binder')));
  await p.V.goto(`${APP}/notifications`);
  await sleep(4000);
  check('Notifications screen loads normally', !(await bodyHas(p.V, 'Couldn’t')) && !(await bodyHas(p.V, 'went wrong')));
  const notifReqs = p.V.requestUrls.filter((u) => u.includes('/rest/v1/notifications'));
  check('notifications are fetched without the new columns', notifReqs.length > 0 && notifReqs.every((u) => !u.includes('item_id') && !u.includes('folder_id')), notifReqs);
  check('no request to the tag tables except the one-per-load check', p.V.fakedUrls.every((u) => u.includes('limit=0')), p.V.fakedUrls);
  const newErrors = p.V.errors.slice(errorsBefore).filter((e) => /tag/i.test(String(e)));
  check('nothing logged as an error about tagging', newErrors.length === 0, newErrors.map((e) => String(e).split('\n')[0]));
  await p.V.screenshot(`${OUT}/10-no-migration.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const [key, name] of [['A', 'Tag Ana'], ['B', 'Tag Ben'], ['C', 'Tag Cam'], ['V', 'Tag Vic'], ['X', 'Tag Xan']]) {
  users[key] = await createUser(key, name);
}
const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const key of ['A', 'B', 'V']) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, pg] of Object.entries(pages)) await pg.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, pg]) => pg.errors.map((e) => `${k}: ${String(e).replace(/\s+/g, ' ').slice(0, 260)}`));
  await browser.close();
  const removed = await sweep();
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).like('username', `tg${run}%`);
  console.log(`\nCleanup: ${removed} accounts and their content/tags/notifications removed; leftover profiles: ${count}.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 20).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

// Top 9 Grails — public-visibility disclosure, UI test of the real picker
// screens (web build) against the LOCAL Supabase stack.
//
// Checks that both pickers (app/grail-slot/pick-item.tsx, pick-collection
// .tsx) show the "Your Grails are public" note before Save, that adding and
// removing Grails still works, and that the note is accurate: with a
// SIGNED-OUT client (the public API key, no session) it verifies exactly
// what a showcased private item / collection exposes — and what stays
// private — before, during and after showcasing.
//
// Prerequisites: same as the other UI suites (local Supabase, local-only
// Metro on :8090, shell-proxy.mjs on :8091).
// Run:  node scripts/integration/ui/grails-visibility-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'grails-visibility-it';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-grails-ui`;
mkdirSync(OUT, { recursive: true });

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts); // signed out: the public API key only

// Must match components/profile-v2/grails-public-note.tsx.
const NOTE = {
  item: 'Your Grails are public. Anyone can see an item you add here, including its photos and main details such as title, grade, serial number and estimated value, even if the item is private. Its purchase price and the rest of your collection stay private.',
  collection: 'Your Grails are public. Anyone can see the name and details of a collection you add here, such as its description, even if it’s private. The items inside keep their own privacy settings.',
};

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
const T = {
  grailItem: `GRAIL PRIVATE ITEM ${run}`,
  siblingItem: `SIBLING PRIVATE ITEM ${run}`,
  grailFolder: `GRAIL PRIVATE SHELF ${run}`,
  hiddenInside: `INSIDE PRIVATE SHELF ${run}`,
};

async function sweep() {
  const ids = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE_TAG) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  for (const id of ids) {
    const { data } = await admin.storage.from('item-images').list(`${id}/grails`, { limit: 100 });
    const files = (data ?? []).map((o) => `${id}/grails/${o.name}`);
    if (files.length) await admin.storage.from('item-images').remove(files);
    await admin.from('profile_grail_slots').delete().eq('user_id', id);
    await admin.from('collection_items').delete().eq('user_id', id);
    await admin.from('folders').delete().eq('user_id', id);
    await admin.auth.admin.deleteUser(id);
  }
  return ids.length;
}

async function createUser() {
  const username = `gv${run}`;
  const email = `${username}@example.test`;
  const password = `gv-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username, display_name: 'Grail Gus' }, app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, username, email, password, db };
}
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function login(page, u) {
  await page.goto(`${APP}/login`);
  await page.waitForEl('testid', 'login-email-input', 60000);
  await page.type('testid', 'login-email-input', u.email);
  await page.type('testid', 'login-password-input', u.password);
  await page.tap('text', 'Log In');
  await page.waitFor('!location.pathname.includes("login")', 20000, 'leave login');
}
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
// The note must sit above the choices: its top is above the first tile's top.
const noteAboveTile = (page, noteText, tileText) => page.eval(`(() => {
  const leaf = (t) => [...document.querySelectorAll('div,span')].filter((e) => e.childElementCount === 0 && e.textContent.includes(t)).pop();
  const n = leaf(${JSON.stringify(noteText.slice(0, 40))}); const t = leaf(${JSON.stringify(tileText)});
  return !!n && !!t && n.getBoundingClientRect().top < t.getBoundingClientRect().top;
})()`);

// What a signed-out visitor can read (RLS), as plain facts.
async function publicView(ids) {
  const item = await anon.from('collection_items').select('id, title, grade, serial_number, estimated_value, description').eq('id', ids.grailItem).maybeSingle();
  const sibling = await anon.from('collection_items').select('id').eq('id', ids.siblingItem).maybeSingle();
  const images = await anon.from('collection_item_images').select('id').eq('item_id', ids.grailItem);
  const trading = await anon.from('trading_card_details').select('item_id').eq('item_id', ids.grailItem);
  const price = await anon.from('collection_item_private_details').select('item_id').eq('item_id', ids.grailItem);
  const folder = await anon.from('folders').select('id, name, description').eq('id', ids.grailFolder).maybeSingle();
  const inside = await anon.from('collection_items').select('id').eq('id', ids.insideItem).maybeSingle();
  return {
    item: item.data, sibling: !!sibling.data, images: (images.data ?? []).length, tradingDetails: (trading.data ?? []).length,
    priceReadable: !price.error && (price.data ?? []).length > 0, folder: folder.data, insideVisible: !!inside.data,
  };
}

async function scenario(page, u, ids) {
  step('0. Before showcasing, a signed-out visitor sees none of the private things');
  let v = await publicView(ids);
  check('private item, its photo, the private collection and its contents are hidden', !v.item && v.images === 0 && !v.folder && !v.insideVisible && !v.sibling, v);
  check('purchase price is never readable by a visitor', !v.priceReadable);

  step('1. Item picker: the note is shown before Save, and adding still works');
  await login(page, u);
  await page.goto(`${APP}/grail-slot/pick-item?slotIndex=0&mode=add`);
  await eventually('the item picker lists the private item', page, () => bodyHas(page, T.grailItem), 30000);
  check('the item picker shows the exact Grails-public note', await bodyHas(page, NOTE.item));
  check('…above the choices', await noteAboveTile(page, NOTE.item, T.grailItem));
  check('the note is announced as one item to screen readers', await page.eval(`!!document.querySelector('[aria-label=${JSON.stringify(NOTE.item)}]')`));
  await page.screenshot(`${OUT}/01-pick-item.png`);
  await page.tap('text', T.grailItem);
  await page.tap('text', 'Save');
  await eventually('Save adds the item to Grails slot 1 (unchanged behaviour)', page, async () => {
    const { data } = await admin.from('profile_grail_slots').select('slot_index, entry_type, item_id').eq('user_id', u.id).eq('slot_index', 0);
    return data?.length === 1 && data[0].entry_type === 'item' && data[0].item_id === ids.grailItem;
  });

  step('2. The item note is accurate');
  v = await publicView(ids);
  check('a visitor now sees the item’s main details (title, grade, serial number, estimated value)', v.item?.title === T.grailItem && v.item?.grade === '9.5'
    && v.item?.serial_number === `SN-${run}` && Number(v.item?.estimated_value) === 1234 && v.item?.description === 'grail notes', v.item);
  check('…and its photo', v.images === 1);
  check('its category-specific details stay private', v.tradingDetails === 0);
  check('its purchase price stays private', !v.priceReadable);
  check('the rest of the collection stays private (sibling item hidden)', !v.sibling);

  step('3. Collection picker: the note is shown before Save, and adding still works');
  await page.goto(`${APP}/grail-slot/pick-collection?slotIndex=1&mode=add`);
  await eventually('the collection picker lists the private collection', page, () => bodyHas(page, T.grailFolder), 30000);
  check('the collection picker shows the exact Grails-public note', await bodyHas(page, NOTE.collection));
  check('…above the choices', await noteAboveTile(page, NOTE.collection, T.grailFolder));
  await page.screenshot(`${OUT}/02-pick-collection.png`);
  await page.tap('text', T.grailFolder);
  await page.tap('text', 'Save');
  await eventually('Save adds the collection to Grails slot 2 (unchanged behaviour)', page, async () => {
    const { data } = await admin.from('profile_grail_slots').select('entry_type, collection_id').eq('user_id', u.id).eq('slot_index', 1);
    return data?.length === 1 && data[0].entry_type === 'collection' && data[0].collection_id === ids.grailFolder;
  });

  step('4. The collection note is accurate');
  v = await publicView(ids);
  check('a visitor now sees the collection’s name and description', v.folder?.name === T.grailFolder && v.folder?.description === 'shelf notes', v.folder);
  check('the items inside keep their own privacy (private item still hidden)', !v.insideVisible);

  step('5. Removing from Grails (the same conditional delete the app uses) restores privacy');
  const slots = must(await u.db.from('profile_grail_slots').select('id, slot_index, entry_type, item_id, collection_id').eq('user_id', u.id), 'slots');
  for (const s of slots) {
    let q = u.db.from('profile_grail_slots').delete().eq('id', s.id).eq('user_id', u.id).eq('slot_index', s.slot_index).eq('entry_type', s.entry_type);
    q = s.entry_type === 'item' ? q.eq('item_id', s.item_id).is('collection_id', null) : q.eq('collection_id', s.collection_id).is('item_id', null);
    const deleted = must(await q.select('id'), 'remove slot');
    check(`slot ${s.slot_index + 1} (${s.entry_type}) removed`, deleted.length === 1);
  }
  v = await publicView(ids);
  check('after removal the private item, photo and collection are hidden again', !v.item && v.images === 0 && !v.folder, v);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
const u = await createUser();
const ids = { folder: randomUUID(), grailFolder: randomUUID(), grailItem: randomUUID(), siblingItem: randomUUID(), insideItem: randomUUID() };
must(await u.db.from('folders').insert([
  { id: ids.folder, user_id: u.id, name: `Private Binder ${run}`, is_public: false },
  { id: ids.grailFolder, user_id: u.id, name: T.grailFolder, is_public: false, description: 'shelf notes' },
]), 'folders');
must(await u.db.from('collection_items').insert([
  { id: ids.grailItem, folder_id: ids.folder, user_id: u.id, title: T.grailItem, item_type: 'trading_card', is_public: false, collection_status: 'active',
    grade: '9.5', serial_number: `SN-${run}`, estimated_value: 1234, description: 'grail notes' },
  { id: ids.siblingItem, folder_id: ids.folder, user_id: u.id, title: T.siblingItem, item_type: 'sports_card', is_public: false, collection_status: 'active' },
  { id: ids.insideItem, folder_id: ids.grailFolder, user_id: u.id, title: T.hiddenInside, item_type: 'sports_card', is_public: false, collection_status: 'active' },
]), 'items');
must(await admin.from('trading_card_details').insert({ item_id: ids.grailItem, franchise: 'Magic', card_name: 'Private details', set_name: 'Alpha' }), 'trading details');
must(await admin.from('collection_item_private_details').insert({ item_id: ids.grailItem, purchase_price: 999 }), 'purchase price');
const photoPath = `${u.id}/grails/${ids.grailItem}.jpg`;
must(await u.db.storage.from('item-images').upload(photoPath, randomBytes(2000), { contentType: 'image/jpeg' }), 'photo upload');
must(await u.db.from('collection_item_images').insert({ item_id: ids.grailItem, user_id: u.id, image_url: photoPath, storage_path: photoPath, sort_order: 0, is_primary: true }), 'photo row');

const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
let page = null;
let fatal = null;
try {
  page = await browser.newPage('G');
  await scenario(page, u, ids);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  if (page) await page.screenshot(`${OUT}/abort.png`).catch(() => {});
} finally {
  await browser.close();
  const removed = await sweep();
  console.log(`\nCleanup: ${removed} account(s) and their items, folders, slots and photos removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

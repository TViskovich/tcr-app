// Group Messaging M1 — UI test of the real app screens (web build) against
// the LOCAL Supabase stack, with five temporary collectors in five isolated
// browser contexts. Every step is a tap / typed text on the actual screens;
// the app's own queries (lib/group-chat.ts, lib/dm-inbox.ts, the
// conversation screen, Group Info) do all the data work.
//
// Prerequisites (see README.md beside this file):
//   1. supabase start (local, with the group migration applied)
//   2. local-only Metro web server on :8090 (env vars point at local Supabase)
//   3. node scripts/integration/ui/shell-proxy.mjs   (:8091)
// Run:  node scripts/integration/ui/group-messaging-ui.mjs
//
// The service role only creates/deletes the fixture accounts and their data.
// One photo message is seeded as collector E through E's OWN signed-in
// client (same storage path + insert the app uses), because the app's photo
// upload reads files with expo-file-system, which has no web implementation.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { renderPlaceholderCard, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from '../../loadtest/synthetic-jpeg.ts';
import { launchChrome } from './cdp.mjs';
import { BETA_FEATURES } from '../../../lib/beta-features.ts';

// Release Readiness R2: group messaging is outside the first submission's
// scope, so its creation controls and Group Info are not in the build. This
// suite drives those controls; it runs again once the flag is switched on.
// The group backend stays covered by scripts/integration/group-messaging.ts.
if (!BETA_FEATURES.groupMessaging) {
  console.log('SKIPPED: group messaging is outside the release scope (lib/beta-features.ts groupMessaging = false).');
  process.exit(0);
}

const FIXTURE_TAG = 'group-messaging-it';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-group-ui`;
mkdirSync(OUT, { recursive: true });

// ── Local-only config ──────────────────────────────────────────────────────
const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{')));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error(`Refusing: ${APP} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);

// The web build must be the local-only one.
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
  results.push({ step: current, name, ok: !!ok, detail: ok ? undefined : detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
async function expectEventually(name, page, fn, timeout = 15000) {
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
const PEOPLE = [
  ['A', 'UI Ana'],
  ['B', 'UI Ben'],
  ['C', 'UI Cam'],
  ['D', 'UI Dee'],
  ['E', 'UI Eli'],
];
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
  const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
  const { data: made } = await admin.from('conversations').select('id').in('created_by', ids);
  const { data: sent } = await admin.from('messages').select('conversation_id').in('sender_id', ids);
  const convIds = [...new Set([...(parts ?? []), ...(sent ?? [])].map((r) => r.conversation_id).concat((made ?? []).map((r) => r.id)))];
  for (const conv of convIds) {
    const { data: objs } = await admin.storage.from('dm-attachments').list(conv);
    for (const dir of objs ?? []) await admin.storage.from('dm-attachments').remove([`${conv}/${dir.name}/image.jpg`]);
  }
  if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  await admin.from('notifications').delete().in('user_id', ids);
  await admin.from('notifications').delete().in('actor_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

async function createUser(key, displayName) {
  const username = `gu${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `gu-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  return { key, id: data.user.id, username, email, password, name: displayName };
}

// ── App helpers ────────────────────────────────────────────────────────────

// react-native-web's Alert.alert is a no-op, so confirmation dialogs never
// appear on web. Replace it (in this page only) with a recorder that presses
// the next queued button — the app's own onPress handlers then run.
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

async function searchAndPick(page, username, displayName) {
  await page.eval(`(() => { const el = [...document.querySelectorAll('input')].filter(i => i.placeholder === 'Search people').pop(); el.focus(); el.select(); })()`);
  await page.send('Input.insertText', { text: username });
  await page.tap('label', displayName, 15000);
}

// Taps (retrying while controls animate in) until `expectText` is on screen.
async function tapUntil(page, kind, value, expectText, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if (await page.exists(kind, value)) await page.tap(kind, value);
    try {
      await page.waitFor(`document.body.innerText.includes(${JSON.stringify(expectText)})`, 2500, expectText);
      return;
    } catch {}
  }
  throw new Error(`[${page.label}] tapping ${kind}=${value} never showed "${expectText}"`);
}

// textContent, not innerText: some labels are styled uppercase.
const bodyHas = (page, text) => page.eval(`document.body.textContent.includes(${JSON.stringify(text)})`);
const findLabel = (page, re) =>
  page.eval(`[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).find(l => new RegExp(${JSON.stringify(re.source)}).test(l)) ?? null`);
// An unnamed group is titled by its other members; members who joined
// together are ordered by user id, so either order is correct.
const either = (x, y) => `(${x}, ${y}|${y}, ${x})`;
const labelsStarting = (page, prefix) =>
  page.eval(`[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => l.startsWith(${JSON.stringify(prefix)}))`);
const alerts = (page) => page.eval('window.__alerts ?? []');
const queueAlert = (page, choice) => page.eval(`(window.__alertChoices = window.__alertChoices ?? []).push(${JSON.stringify(choice)})`);

async function sendMessage(page, text) {
  await page.type('placeholder', 'Message...', text);
  await page.tap('label', 'Send message');
  await page.waitForEl('text', text, 15000);
}

// ── Scenario ───────────────────────────────────────────────────────────────
async function scenario(pages) {
  const { A, B, C, D, E } = users;
  const pa = pages.A, pb = pages.B, pc = pages.C, pd = pages.D, pe = pages.E;

  step('0. Sign in (real login screen) — five collectors, five isolated browsers');
  for (const [key] of PEOPLE) {
    await login(pages[key], users[key]);
    check(`${key} signed in`, true);
  }

  step('1. One-on-one DM baseline: A messages B from New Message');
  await open(pa, '/');
  await pa.tap('text', 'Messages');
  await tapUntil(pa, 'label', 'New message', 'Choose someone');
  await sleep(1500);
  await pa.screenshot(`${OUT}/01-new-message-empty-inbox.png`);
  check('New Group row is offered to a collector with an empty inbox', await pa.exists('label', 'New group'));
  await searchAndPick(pa, B.username, B.name);
  await pa.waitFor('location.pathname.startsWith("/conversation/")', 15000, 'DM opens');
  const dmPath = await pa.eval('location.pathname');
  await sendMessage(pa, 'Hi Ben, DM here');
  check('DM header is a person, not a group', !(await labelsStarting(pa, `${B.name},`)).some((l) => /members/.test(l)), await labelsStarting(pa, `${B.name},`));
  await open(pb, '/messages');
  await expectEventually('B inbox: DM row from A, unread, not a group', pb, async () => {
    const rows = await labelsStarting(pb, `${A.name}, unread.`);
    return rows.length === 1 || `rows: ${JSON.stringify(await labelsStarting(pb, A.name))}`;
  });
  await pb.tap('labelStarts', `${A.name}, unread.`);
  await pb.waitForEl('text', 'Hi Ben, DM here');
  await sendMessage(pb, 'Hi Ana, got it');
  await expectEventually('A sees B’s DM reply (poll)', pa, () => bodyHas(pa, 'Hi Ana, got it'), 15000);

  step('2. A creates a group with B and C (New Message → New Group)');
  await open(pa, '/messages');
  await tapUntil(pa, 'label', 'New message', 'Choose someone');
  await tapUntil(pa, 'label', 'New group', 'Next');
  await pa.waitForEl('text', 'Next');
  await searchAndPick(pa, B.username, B.name);
  await pa.tap('text', 'Next');
  check('Next does nothing with only one person picked', await pa.exists('placeholder', 'Search people'));
  await searchAndPick(pa, C.username, C.name);
  check('both picks shown as chips', (await pa.exists('label', `Remove ${B.name}`)) && (await pa.exists('label', `Remove ${C.name}`)));
  await pa.tap('text', 'Next');
  await pa.waitForEl('label', 'Group name (optional)');
  check('details step: Members · 3, creator shown as Admin', (await bodyHas(pa, 'Members · 3')) && (await pa.exists('text', 'Admin')));
  await pa.tap('text', 'Create');
  await pa.waitFor('location.pathname.startsWith("/conversation/")', 20000, 'group opens');
  const groupPath = await pa.eval('location.pathname');
  const groupId = groupPath.split('/').pop();
  check('opened a new conversation (not the DM)', groupPath !== dmPath, groupPath);
  await expectEventually('group header: titled by B and C · 3 members', pa, async () =>
    !!(await findLabel(pa, new RegExp(`^${either(B.name, C.name)}, 3 members$`))) || JSON.stringify(await labelsStarting(pa, 'UI ')),
  );
  await pa.screenshot(`${OUT}/02-group-created.png`);

  step('3. Messages from different collectors');
  await sendMessage(pa, 'Welcome to the group!');
  check('own message shows no "Read" receipt in a group', !(await bodyHas(pa, 'Read')));
  await open(pb, '/messages');
  await expectEventually('B inbox: group row, unread, titled by the other members', pb, async () => {
    const rows = await labelsStarting(pb, 'Group: ');
    const re = new RegExp(`^Group: ${either(A.name, C.name)}, unread\\. ${A.name}: Welcome to the group!$`);
    return rows.some((l) => re.test(l)) || JSON.stringify(rows);
  });
  check('B inbox still lists the DM separately', (await labelsStarting(pb, `${A.name}`)).length >= 1);
  await pb.screenshot(`${OUT}/03-inbox-B.png`);
  await pb.tap('labelStarts', 'Group: ');
  await pb.waitForEl('text', 'Welcome to the group!');
  check('B sees A’s name above A’s message', await pb.exists('text', A.name));
  await sendMessage(pb, 'Thanks — show us your grails');
  await open(pc, '/messages');
  await expectEventually('C inbox: group unread before opening', pc, async () => (await labelsStarting(pc, 'Group: ')).some((l) => l.includes(', unread.')) || JSON.stringify(await labelsStarting(pc, 'Group: ')));
  await pc.tap('labelStarts', 'Group: ');
  await pc.waitForEl('text', 'Thanks — show us your grails');
  const order = await pc.eval(`(() => { const t = document.body.innerText; return [t.indexOf('Welcome to the group!'), t.indexOf('Thanks — show us your grails')]; })()`);
  check('C sees both messages in order', order[0] >= 0 && order[0] < order[1], order);
  check('C sees both sender names', (await pc.exists('text', A.name)) && (await pc.exists('text', B.name)));
  await pc.screenshot(`${OUT}/03-thread-C.png`);
  await expectEventually('A sees B’s reply arrive (poll)', pa, () => bodyHas(pa, 'Thanks — show us your grails'));
  await open(pc, '/messages');
  await expectEventually('C inbox: no longer unread after reading', pc, async () => {
    const rows = await labelsStarting(pc, 'Group: ');
    return (rows.length === 1 && !rows[0].includes(', unread.')) || JSON.stringify(rows);
  });

  step('4. Group Info (admin vs member)');
  await pa.tap('label', await findLabel(pa, new RegExp(`^${either(B.name, C.name)}, 3 members$`)));
  await pa.waitForEl('text', 'Group Info');
  check('A: 3 members', await bodyHas(pa, '3 members'));
  check('A: listed as admin and "you"', await pa.exists('label', `${A.name}, admin, you`));
  check('A (admin): Rename, Add Members, Remove controls', (await pa.exists('label', 'Rename group')) && (await pa.exists('text', 'Add Members')) && (await pa.exists('label', `Remove ${B.name}`)));
  check('A: no Remove on own row', !(await pa.exists('label', `Remove ${A.name}`)));
  await pa.screenshot(`${OUT}/04-group-info-A.png`);
  await pb.tap('label', await findLabel(pb, new RegExp(`^${either(A.name, C.name)}, 3 members$`)));
  await pb.waitForEl('text', 'Group Info');
  check('B (member): no Rename / Add Members / Remove', !(await pb.exists('label', 'Rename group')) && !(await pb.exists('text', 'Add Members')) && !(await pb.exists('labelStarts', 'Remove ')));
  check('B: sees Leave Group', await pb.exists('text', 'Leave Group'));

  step('5. Rename');
  await pa.tap('label', 'Rename group');
  await pa.type('label', 'Group name', 'Grail Hunters');
  await pa.tap('text', 'Save');
  await expectEventually('A: Group Info shows "Grail Hunters"', pa, () => pa.exists('text', 'Grail Hunters'));
  await open(pb, groupPath);
  await expectEventually('B: conversation header shows the new name', pb, () => pb.exists('label', 'Grail Hunters, 3 members'));
  await open(pc, '/messages');
  await expectEventually('C inbox: row renamed', pc, async () => (await labelsStarting(pc, 'Group: Grail Hunters')).length === 1);

  step('6. Add D and E (Group Info → Add Members)');
  await pa.tap('text', 'Add Members');
  await pa.waitForEl('placeholder', 'Search people');
  await searchAndPick(pa, D.username, D.name);
  await searchAndPick(pa, E.username, E.name);
  check('sheet: 2 selected', await bodyHas(pa, '2 selected'));
  await pa.tap('text', 'Add');
  await expectEventually('A: Group Info now 5 members', pa, async () => (await bodyHas(pa, '5 members')) && !(await pa.exists('text', '2 selected')));
  await open(pd, '/messages');
  await expectEventually('D inbox: group appears', pd, async () => (await labelsStarting(pd, 'Group: Grail Hunters')).length === 1 || JSON.stringify(await labelsStarting(pd, 'Group')));
  await pd.tap('labelStarts', 'Group: Grail Hunters');
  await pd.waitForEl('text', 'Welcome to the group!');
  check('D (new member) sees earlier history', await bodyHas(pd, 'Thanks — show us your grails'));
  await sendMessage(pd, 'Hi all, Dee here');
  await open(pe, groupPath);
  await expectEventually('E sees D’s message with D’s name', pe, async () => (await bodyHas(pe, 'Hi all, Dee here')) && (await pe.exists('text', D.name)));

  step('7. Photo attachments');
  // Seed a photo as E through E's own signed-in client (app's path + insert).
  const eClient = createClient(st.API_URL, st.ANON_KEY, opts);
  await eClient.auth.signInWithPassword({ email: E.email, password: E.password });
  const photoId = randomUUID();
  const path = `${groupId}/${photoId}/image.jpg`;
  const up = await eClient.storage.from('dm-attachments').upload(path, renderPlaceholderCard('GROUP', 1), { contentType: 'image/jpeg', upsert: false });
  check('E uploads a photo to the group’s storage folder (participant policy)', !up.error, up.error);
  const ins = await eClient.from('messages').insert({
    id: photoId,
    conversation_id: groupId,
    sender_id: E.id,
    body: null,
    attachment_type: 'image',
    attachment_storage_path: path,
    attachment_width: PLACEHOLDER_WIDTH,
    attachment_height: PLACEHOLDER_HEIGHT,
  });
  check('E sends the photo message', !ins.error, ins.error);
  await expectEventually(
    'B’s group thread renders E’s photo (signed URL, loaded)',
    pb,
    () => pb.eval(`[...document.querySelectorAll('img')].some(i => i.src.includes('dm-attachments') && i.naturalWidth > 0) || [...document.querySelectorAll('[style*="dm-attachments"]')].length > 0`),
    20000,
  );
  await pb.screenshot(`${OUT}/07-photo-B.png`);
  const outsiderPhoto = await createClient(st.API_URL, st.ANON_KEY, opts);
  await outsiderPhoto.auth.signInWithPassword({ email: C.email, password: C.password });
  // (C is still a member here; the outsider check is after C leaves.)
  // UI photo send from the composer: Attach → Photos → pick a file.
  await pa.goto(`${APP}${groupPath}`);
  await installAlertShim(pa);
  await pa.waitForEl('label', 'Attach');
  await pa.send('Page.setInterceptFileChooserDialog', { enabled: true });
  const chooser = new Promise((resolve) => (pa.fileChooser = resolve));
  await pa.tap('label', 'Attach');
  await pa.tap('text', 'Photos');
  const opened = await Promise.race([chooser, sleep(8000).then(() => null)]);
  if (opened) {
    const file = `${OUT}/pick.jpg`;
    (await import('node:fs')).writeFileSync(file, renderPlaceholderCard('PICK', 2));
    await pa.send('DOM.setFileInputFiles', { files: [file], backendNodeId: opened.backendNodeId });
    await sleep(4000);
    check('A: picking a photo opens the Send Photo confirm sheet', await pa.exists('text', 'Send Photo'));
    await pa.screenshot(`${OUT}/07-photo-pick-A.png`);
    const errorsBefore = pa.errors.length;
    // Not a pass/fail check: the upload reads the file with expo-file-system,
    // which has no web implementation — this records what web does.
    await pa.tap('text', 'Send Photo');
    await sleep(6000);
    const { data: aPhotos } = await admin.from('messages').select('id').eq('conversation_id', groupId).eq('sender_id', A.id).eq('attachment_type', 'image');
    console.log(`  INFO  web "Send Photo" → ${aPhotos?.length ? 'photo message committed' : 'no photo message committed'}; screen: ${JSON.stringify((await pa.text()).slice(0, 160))}; new console errors: ${JSON.stringify(pa.errors.slice(errorsBefore).map((e) => String(e).split('\n')[0])).slice(0, 400)}`);
    await pa.screenshot(`${OUT}/07-photo-send-A.png`);
  } else {
    console.log('  INFO  photo picker on web: no file chooser opened');
  }
  await pa.send('Page.setInterceptFileChooserDialog', { enabled: false });

  step('8. Remove D (admin) — D loses access while viewing');
  await open(pd, groupPath);
  await pd.waitForEl('text', 'Hi all, Dee here');
  await open(pa, `/group-info/${groupId}`);
  await pa.waitForEl('label', `Remove ${D.name}`);
  await queueAlert(pa, 'Remove');
  await pa.tap('label', `Remove ${D.name}`);
  const removeAlert = (await alerts(pa)).at(-1);
  check('confirmation: "Remove UI Dee?" with Cancel / Remove', removeAlert?.title === `Remove ${D.name}?` && removeAlert.buttons.join() === 'Cancel,Remove', removeAlert);
  await expectEventually('A: Group Info now 4 members, D gone', pa, async () => (await bodyHas(pa, '4 members')) && !(await pa.exists('label', `Remove ${D.name}`)));
  await expectEventually('D’s open thread switches to "This conversation isn’t available"', pd, () => pd.exists('text', 'This conversation isn’t available'), 20000);
  await pd.screenshot(`${OUT}/08-removed-D.png`);
  await open(pd, '/messages');
  await sleep(2500);
  check('D inbox: group gone', (await labelsStarting(pd, 'Group:')).length === 0, await labelsStarting(pd, 'Group:'));
  await open(pd, `/group-info/${groupId}`);
  await expectEventually('D: Group Info deep link → "This group isn’t available"', pd, () => pd.exists('text', 'This group isn’t available'));

  step('9. C leaves (Group Info → Leave Group)');
  await open(pc, groupPath);
  await pc.waitForEl('labelStarts', 'Grail Hunters, 4 members');
  await pc.tap('labelStarts', 'Grail Hunters, 4 members');
  await pc.waitForEl('text', 'Leave Group');
  await queueAlert(pc, 'Leave Group');
  await pc.tap('text', 'Leave Group');
  const leaveAlert = (await alerts(pc)).at(-1);
  check('confirmation: "Leave Grail Hunters?" (no succession line for a member)', leaveAlert?.title === 'Leave Grail Hunters?' && !leaveAlert.message.includes('admin'), leaveAlert);
  await expectEventually('C is taken out of the group screens', pc, async () => !(await pc.eval('location.pathname')).includes(groupId));
  await open(pc, '/messages');
  await sleep(2500);
  check('C inbox: group gone', (await labelsStarting(pc, 'Group:')).length === 0, await labelsStarting(pc, 'Group:'));
  await open(pc, groupPath);
  await expectEventually('C: deep link to the thread shows "This conversation isn’t available"', pc, () => pc.exists('text', 'This conversation isn’t available'));
  check('C: no group messages visible', !(await bodyHas(pc, 'Welcome to the group!')));
  await pc.screenshot(`${OUT}/09-left-C.png`);
  const cPhoto = await outsiderPhoto.storage.from('dm-attachments').createSignedUrl(path, 60);
  check('C (left) can no longer sign the group photo', !!cPhoto.error, cPhoto.data);

  step('10. Error state: re-adding someone who left');
  await open(pa, `/group-info/${groupId}`);
  await pa.tap('text', 'Add Members');
  await searchAndPick(pa, C.username, C.name);
  await pa.tap('text', 'Add');
  await expectEventually('sheet shows the server’s refusal copy', pa, () => bodyHas(pa, 'Someone you picked recently left a group and can’t be added right now.'));
  await pa.screenshot(`${OUT}/10-readd-error.png`);
  await pa.tap('text', 'Cancel');
  check('still 3 members', await bodyHas(pa, '3 members'));

  step('11. Admin role change via succession: A (only admin) leaves');
  await open(pb, `/group-info/${groupId}`);
  await pb.waitForEl('text', 'Leave Group');
  check('B before: member view', !(await pb.exists('text', 'Add Members')));
  check('no promote/demote control exists in Group Info (M1 has no role UI)', !(await pb.eval(`/make admin|promote|demote/i.test(document.body.innerText)`)));
  await queueAlert(pa, 'Leave Group');
  await pa.tap('text', 'Leave Group');
  const succession = (await alerts(pa)).at(-1);
  check('A’s leave warning names B as the next admin', succession?.message.includes(`${B.name} will become the group admin.`), succession);
  await expectEventually('A is taken out of the group screens', pa, async () => !(await pa.eval('location.pathname')).includes(groupId));
  await open(pb, `/group-info/${groupId}`);
  await expectEventually('B now: admin controls, 2 members', pb, async () => (await pb.exists('label', `${B.name}, admin, you`)) && (await pb.exists('text', 'Add Members')) && (await bodyHas(pb, '2 members')));
  await pb.screenshot(`${OUT}/11-succession-B.png`);
  await open(pe, groupPath);
  await expectEventually('E header: Grail Hunters · 2 members', pe, () => pe.exists('label', 'Grail Hunters, 2 members'));
  check('E still sees former members’ messages with their names', (await bodyHas(pe, 'Welcome to the group!')) && (await pe.exists('text', A.name)));

  step('12. DM still works independently after all of it');
  await open(pa, '/messages');
  await expectEventually('A inbox: DM with B present, group gone', pa, async () =>
    ((await labelsStarting(pa, `${B.name}`)).length === 1 && (await labelsStarting(pa, 'Group:')).length === 0) || JSON.stringify(await labelsStarting(pa, '')),
  );
  await pa.tap('labelStarts', `${B.name}`);
  await pa.waitForEl('text', 'Hi Ana, got it');
  check('DM history intact, no group messages in it', !(await bodyHas(pa, 'Welcome to the group!')));
  await sendMessage(pa, 'Still here?');
  await open(pb, dmPath);
  await pb.waitForEl('text', 'Still here?');
  await expectEventually('A sees "Read" once B opens the DM (DM read receipts)', pa, () => bodyHas(pa, '· Read'), 15000);
  await pa.screenshot(`${OUT}/12-dm-read-A.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL}  (run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const [key, name] of PEOPLE) users[key] = await createUser(key, name);

const browser = await launchChrome({ profileDir: `${OUT}/chrome-profile-${run}` });
const pages = {};
let fatal = null;
try {
  for (const [key] of PEOPLE) pages[key] = await browser.newPage(key);
  await scenario(pages);
} catch (e) {
  fatal = e;
  console.error(`\nAborted in "${current}": ${e.message}`);
  for (const [key, p] of Object.entries(pages)) await p.screenshot(`${OUT}/abort-${key}.png`).catch(() => {});
} finally {
  const pageErrors = Object.entries(pages).flatMap(([k, p]) => p.errors.map((e) => `${k}: ${String(e).split('\n')[0]}`));
  await browser.close();
  const removed = await sweep();
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).like('username', `gu${run}%`);
  console.log(`\nCleanup: ${removed} accounts and their conversations/messages/photos/notifications removed; leftover profiles: ${count}.`);
  const uniq = [...new Set(pageErrors)];
  if (uniq.length) console.log(`Console errors seen (${uniq.length} distinct):\n  ${uniq.slice(0, 25).join('\n  ')}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

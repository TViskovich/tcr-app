// Report media inspection, media restoration, legal holds and profile-field
// release (Phase 2B M5.3) — UI test of the real report screen (web build)
// against an ISOLATED disposable local Supabase stack with its Edge Functions
// served. Two admins (A, B) in separate browser contexts. Content and
// uploads are made by the owner's own client; reports are filed by R through
// submit_report; the service role only creates/deletes accounts and grants
// admin rows. Synthetic data only.
//
// Prerequisites: an isolated stack (CACHECASE_STACK_WORKDIR), a local-only
// Metro on :8090 whose EXPO_PUBLIC_SUPABASE_URL is that stack, and
// shell-proxy.mjs on :8091.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/ui/admin-media-ui.mjs
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from '../local-stack.ts';
import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'admin-media-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-admin-media-ui`;
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
     DELETE FROM private.report_media_access WHERE admin_id IN (${list});
     DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${list}));
     DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM private.media_quarantine WHERE owner_id IN (${list}));
     DELETE FROM private.media_quarantine WHERE owner_id IN (${list});
     DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list}))
                                           OR target_owner_id IN (${list}) OR admin_id IN (${list});
     DELETE FROM public.content_reports WHERE reporter_id IN (${list}) OR target_owner_id IN (${list});
     DELETE FROM public.moderated_content WHERE owner_id IN (${list}) OR created_by IN (${list});
     DELETE FROM public.account_suspensions WHERE user_id IN (${list});
     DELETE FROM public.moderated_profile_fields WHERE user_id IN (${list});
     DELETE FROM storage.objects WHERE (bucket_id IN ('item-images', 'dm-attachments') AND owner IN (${list}))
        OR (bucket_id = 'moderation-quarantine' AND name LIKE 'q/%' AND NOT EXISTS (SELECT 1 FROM private.media_quarantine q WHERE q.quarantine_path = storage.objects.name));
     DELETE FROM public.admin_users WHERE user_id IN (${list});
     COMMIT;`]);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}
async function createUser(key) {
  const username = `am${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `am-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e } = await db.auth.signInWithPassword({ email, password });
  if (e) throw e;
  return { key, id: data.user.id, username, email, password, db, token: s.session.access_token };
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
async function tapLabel(page, label) {
  const sel = `[...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()`;
  await page.waitFor(`!!(${sel})`, 20000, label);
  await page.eval(`${sel}?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await page.tap('label', label);
}

async function scenario(p) {
  const { A, B, R, O, Q } = users;
  const fnCall = async (name, token, body) => {
    const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const jpeg = (tag) => Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from(tag)]);
  const folder = randomUUID();
  must(await O.db.from('folders').insert({ id: folder, user_id: O.id, name: `am ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const item = randomUUID();
  must(await O.db.from('collection_items').insert({ id: item, folder_id: folder, user_id: O.id, title: `am item ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), 'item');
  for (const k of [0, 1]) {
    const path = `${O.id}/${item}/am-${k}.jpg`;
    must(await O.db.storage.from('item-images').upload(path, jpeg(`img${k}`), { contentType: 'image/jpeg' }), 'upload');
    must(await O.db.from('collection_item_images').insert({ item_id: item, user_id: O.id, image_url: 'https://x.invalid', storage_path: path, sort_order: k, is_primary: k === 0 }), 'image');
  }
  const conv = must(await R.db.rpc('get_or_create_conversation', { other_user_id: O.id }), 'conversation');
  const dm = randomUUID();
  const dmPath = `${conv}/${dm}/image.jpg`;
  must(await O.db.storage.from('dm-attachments').upload(dmPath, jpeg('dm'), { contentType: 'image/jpeg' }), 'dm upload');
  must(await O.db.from('messages').insert({ id: dm, conversation_id: conv, sender_id: O.id, body: `am dm ${run}`, attachment_type: 'image', attachment_storage_path: dmPath }), 'dm');
  must(await Q.db.from('profiles').update({ bio: `am bio ${run}`, tagline: `am tagline ${run}` }).eq('id', Q.id), 'profile');
  must(await R.db.rpc('submit_report', { p_target_type: 'collection_item', p_target_id: item, p_reason: 'spam', p_details: null }), 'report item');
  must(await R.db.rpc('submit_report', { p_target_type: 'message', p_target_id: dm, p_reason: 'child_safety', p_details: null }), 'report dm');
  must(await R.db.rpc('submit_report', { p_target_type: 'profile', p_target_id: Q.id, p_reason: 'harassment', p_details: null }), 'report profile');
  const rid = (t) => sql(`SELECT id FROM public.content_reports WHERE reporter_id = '${R.id}' AND target_id = '${t}'`);
  const rItem = rid(item), rDm = rid(dm), rProf = rid(Q.id);
  // In the DOM at all (scrolled or not) — exists() only sees the viewport.
  const hasLabel = (page, label) => page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)})`);
  const signedImgs = (page) => page.eval(`[...document.querySelectorAll('img')].filter(i => /object\\/sign\\//.test(i.src)).length`);
  const blurred = (page) => page.eval(`[...document.querySelectorAll('img')].filter(i => /object\\/sign\\//.test(i.src)).some(i => /blur/.test(getComputedStyle(i).filter) || /blur/.test(getComputedStyle(i.parentElement).filter))`);

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  check('two admins signed in', true);

  step('1. Inspecting a reported item’s images');
  await open(p.A, `/admin/report/${rItem}`);
  await eventually('the Evidence media card lists both images, not loaded', p.A, async () =>
    (await bodyHas(p.A, 'Item image 1')) && (await bodyHas(p.A, 'Item image 2')) && (await signedImgs(p.A)) === 0);
  await eventually('legal holds: none active', p.A, () => bodyHas(p.A, 'No active legal hold'));
  await tapLabel(p.A, 'View Item image 1');
  await eventually('image 1 loads on request only (signed, one image)', p.A, async () => (await signedImgs(p.A)) === 1);
  check('it is not blurred (not child safety)', !(await blurred(p.A)));
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed; image actions offered for the viewed image only', p.A, async () =>
    (await hasLabel(p.A, 'Remove Item image 1')) && !(await hasLabel(p.A, 'Remove Item image 2')));
  await tapLabel(p.A, 'Remove Item image 1');
  await tapText(p.A, 'Spam');
  await choose(p.A, 'Remove');
  await tapLabel(p.A, 'Review image action');
  await eventually('only that image is removed', p.A, async () => (await bodyHas(p.A, 'Item image 1 removed; the item and its other images are unchanged.'))
    && sql(`SELECT string_agg(target_type, ',') FROM public.moderated_content WHERE owner_id = '${O.id}' AND lifted_at IS NULL`) === 'item_image');
  const imgAlert = await lastAlert(p.A);
  check('the confirmation names the viewed image and says the item is unchanged', /only Item image 1 \(the one you viewed\)/.test(imgAlert?.message ?? '') && /item and its other images are not changed/.test(imgAlert?.message ?? ''), imgAlert);

  step('2. Child-safety media');
  await open(p.A, `/admin/report/${rDm}`);
  await eventually('the DM photo is listed, not loaded', p.A, async () => (await bodyHas(p.A, 'Message photo · child safety')) && (await signedImgs(p.A)) === 0);
  await choose(p.A, 'Cancel');
  await tapLabel(p.A, 'View Message photo');
  await eventually('a warning is shown first; cancelling loads nothing', p.A, async () => (await lastAlert(p.A))?.title === 'Child-safety media' && (await signedImgs(p.A)) === 0);
  await choose(p.A, 'Show blurred');
  await tapLabel(p.A, 'View Message photo');
  await eventually('after confirming, it is shown blurred', p.A, async () => (await signedImgs(p.A)) === 1 && (await blurred(p.A)));
  await tapText(p.A, 'Reveal image');
  await eventually('revealed only on a second tap', p.A, async () => !(await blurred(p.A)));
  await tapLabel(p.A, 'Close Message photo');
  await eventually('closing drops the image', p.A, async () => (await signedImgs(p.A)) === 0);

  step('3. Media restoration (second administrator)');
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed', p.A, () => bodyHas(p.A, 'Remove content…'));
  await tapText(p.A, 'Remove content…');
  await tapText(p.A, 'Child safety');
  await choose(p.A, 'Remove');
  await tapLabel(p.A, 'Review Remove content');
  await eventually('removed', p.A, async () => sql(`SELECT count(*) FROM public.moderated_content WHERE target_id = '${dm}' AND lifted_at IS NULL`) === '1');
  const wk = await fnCall('admin-media-quarantine', A.token, { limit: 10 });
  check('quarantine worker run by hand', wk.status === 200);
  const ver = sql(`SELECT private.report_review_version(c) FROM public.content_reports c WHERE id = '${rDm}'`);
  must(await B.db.rpc('admin_report_enforce', { p_report_id: rDm, p_action: 'restore', p_expected_version: ver, p_reason_code: 'child_safety_review_cleared',
    p_note: 'second review', p_options: { disposition: 'reopen', confirm_child_safety: true } }), 'B restores content');
  await open(p.A, `/admin/report/${rDm}`);
  await eventually('A sees the photo awaiting restoration but may not restore it', p.A, async () =>
    (await bodyHas(p.A, 'Awaiting restoration')) && (await bodyHas(p.A, 'a different administrator must restore it')) && !(await hasLabel(p.A, 'Restore media')));
  await eventually('the quarantined original is not viewable', p.A, async () => (await bodyHas(p.A, 'Quarantined — not viewable in the app')) && !(await hasLabel(p.A, 'View Message photo')));
  await open(p.B, `/admin/report/${rDm}`);
  await eventually('B sees the restore control, disabled until the child-safety confirmation', p.B, async () =>
    (await hasLabel(p.B, 'Restore media')) && (await p.B.eval(`[...document.querySelectorAll('[aria-label="Restore media"]')].pop()?.getAttribute('aria-disabled') === 'true'`)));
  await tapLabel(p.B, 'I completed the child-safety review and confirm restoring this media.');
  await choose(p.B, 'Restore');
  await tapLabel(p.B, 'Restore media');
  await eventually('restored — reported only once the server confirms', p.B, async () =>
    (await bodyHas(p.B, 'Media: 1 restored to the original location.')) && (await bodyHas(p.B, 'Restored')));
  const rAlert = await lastAlert(p.B);
  check('the restore confirmation separates media from content and keeps the evidence copy',
    /separate from restoring the content/.test(rAlert?.message ?? '') && /private evidence copy is kept/.test(rAlert?.message ?? ''), rAlert);
  check('the original is back in place', sql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'dm-attachments' AND name = '${dmPath}'`) === '1');

  step('4. Profile-field release');
  await open(p.A, `/admin/report/${rProf}`);
  await eventually('profile report open', p.A, () => bodyHas(p.A, 'Claim'));
  await choose(p.A, 'Claim');
  await tapText(p.A, 'Claim');
  await eventually('claimed', p.A, () => bodyHas(p.A, 'Clear profile fields…'));
  await tapText(p.A, 'Clear profile fields…');
  await tapText(p.A, 'Harassment');
  await tapText(p.A, 'Bio');
  await tapText(p.A, 'Tagline');
  await choose(p.A, 'Clear');
  await tapLabel(p.A, 'Review Clear profile fields');
  await eventually('fields cleared', p.A, () => bodyHas(p.A, 'Cleared: Bio, Tagline'));
  await tapText(p.A, 'Release profile fields…');
  await tapText(p.A, 'Owner may edit');
  await tapText(p.A, 'Bio');
  await choose(p.A, 'Release');
  await tapLabel(p.A, 'Review Release profile fields');
  await eventually('bio released; the screen says values are not restored', p.A, () => bodyHas(p.A, 'Released: Bio — the collector may edit it again'));
  const relAlert = await lastAlert(p.A);
  check('release confirmation: values NOT restored, other fields stay locked', /NOT restored; other restricted fields stay locked/.test(relAlert?.message ?? ''), relAlert);
  const qb = await Q.db.from('profiles').update({ bio: 'my new bio' }).eq('id', Q.id);
  const qt = await Q.db.from('profiles').update({ tagline: 'my new tagline' }).eq('id', Q.id);
  check('the collector can edit only the released field', !qb.error && !!qt.error, [qb.error?.message, qt.error?.message]);

  for (const [k, pg] of Object.entries(p)) await pg.screenshot(`${OUT}/${k}-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL} (isolated ${stack.project}, run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const k of ['A', 'B', 'R', 'O', 'Q']) users[k] = await createUser(k);
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

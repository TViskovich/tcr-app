// Release scope (Release Readiness R2) — UI test of the real app (web build)
// against an ISOLATED disposable local Supabase stack. Checks that Registry,
// Ownership Transfers, Group Messaging and Figurine creation are not
// reachable (no entry points, no direct links), that nonfunctional
// placeholders are gone, and that the in-scope flows around them still work:
// item detail, collections, individual DMs and existing group threads.
// Registry/transfer/group rows are seeded as pre-existing data and must be
// left exactly as they were. Synthetic accounts only.
//
// Prerequisites: an isolated stack (CACHECASE_STACK_WORKDIR), a local-only
// Metro on :8090 whose EXPO_PUBLIC_SUPABASE_URL is that stack, and
// shell-proxy.mjs on :8091.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/ui/beta-scope-ui.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from '../local-stack.ts';
import { launchChrome } from './cdp.mjs';

const FIXTURE_TAG = 'beta-scope-ui';
const APP = process.env.UI_APP_URL ?? 'http://127.0.0.1:8091';
const OUT = process.env.UI_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/cachecase-beta-scope-ui`;
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
     DELETE FROM public.notifications WHERE user_id IN (${list}) OR actor_id IN (${list});
     DELETE FROM public.ownership_transfers WHERE from_owner_id IN (${list}) OR to_owner_id IN (${list});
     DELETE FROM public.registered_cards WHERE current_owner_id IN (${list}) OR created_by IN (${list});
     DELETE FROM public.conversations WHERE id IN (SELECT conversation_id FROM public.conversation_participants WHERE user_id IN (${list}));
     DELETE FROM public.collection_items WHERE user_id IN (${list});
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
  const username = `bs${run}${key.toLowerCase()}`;
  const email = `${username}@example.test`;
  const password = `bs-${randomUUID()}`;
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
  const { A, B } = users;
  const hasLabel = (page, label) => page.eval(`[...document.querySelectorAll('[aria-label]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(label)})`);
  const path = (page) => page.eval('location.pathname');
  const count = (q) => Number(sql(q));
  // Synthetic content, through the owners' own clients.
  const folder = randomUUID();
  must(await A.db.from('folders').insert({ id: folder, user_id: A.id, name: `bs ${run}`, is_public: true, cover_source: 'first_card' }), 'folder');
  const item = randomUUID(), registeredItem = randomUUID(), outItem = randomUUID();
  for (const [id, title] of [[item, 'plain'], [registeredItem, 'registered'], [outItem, 'transferred']]) {
    must(await A.db.from('collection_items').insert({ id, folder_id: folder, user_id: A.id, title: `bs ${title} ${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' }), `item ${title}`);
  }
  // Pre-existing Registry / transfer data (as if created before R2).
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
  const ccId = `CC-${pick()}-${pick()}`;
  const card = must(await admin.from('registered_cards').insert({ cc_id: ccId, current_owner_id: A.id, status: 'active', collection_item_id: registeredItem }).select('id').single(), 'registered card').id;
  sql(`UPDATE public.collection_items SET collection_status = 'transferred_out', transferred_registered_card_id = '${card}', transferred_out_at = now() WHERE id = '${outItem}'`);
  sql(`INSERT INTO public.notifications (user_id, actor_id, type, registered_card_id, read) VALUES ('${A.id}', '${B.id}', 'ownership_transfer_requested', '${card}', false), ('${A.id}', '${B.id}', 'follow', NULL, false)`);
  // The group-conversation migration the dormant group client targets
  // (20261101130000_add_group_conversations) is not in this repository, so
  // no group data can exist here; groups are checked for absence only.
  const group = randomUUID();
  const before = sql(`SELECT (SELECT count(*) FROM public.registered_cards WHERE id = '${card}') || ',' || (SELECT count(*) FROM public.notifications WHERE user_id = '${A.id}') || ','
                       || (SELECT count(*) FROM public.collection_items WHERE folder_id = '${folder}')`);

  step('0. Sign in');
  await login(p.A, A);
  await login(p.B, B);
  check('two collectors signed in', true);

  step('1. Item detail: no Registry entry points; item still works');
  await open(p.A, `/item/${item}`);
  await eventually('the item loads with its social row', p.A, async () => (await bodyHas(p.A, `bs plain ${run}`)) && (await hasLabel(p.A, 'Comment')) && (await hasLabel(p.A, 'Share')));
  check('no CacheCase ID button', !(await hasLabel(p.A, 'CacheCase ID')));
  check('no "Register with CacheCase" action for the owner', !(await bodyHas(p.A, 'Register with CacheCase')));
  await open(p.A, `/item/${registeredItem}`);
  await eventually('a registered item opens normally', p.A, () => bodyHas(p.A, `bs registered ${run}`));
  check('…still with no CacheCase ID button or Registry link', !(await hasLabel(p.A, 'CacheCase ID')) && !(await bodyHas(p.A, 'View Registry')));
  await open(p.A, `/item/${outItem}`);
  await eventually('a transferred-out item shows its banner', p.A, () => bodyHas(p.A, 'Transferred Out'));
  check('…with no "View Registry" / "View Registry History" links', !(await bodyHas(p.A, 'View Registry')));

  step('2. Direct links to excluded screens');
  for (const [label, url] of [['Registry', `/registry/${card}`], ['Registry history', `/registry-history/${card}`], ['Claim card', `/claim-card/${card}`],
    ['Transactions', `/transactions/${A.id}`], ['Group Info', `/group-info/${group}`]]) {
    await open(p.A, url);
    await sleep(2500);
    const at = await path(p.A);
    check(`${label} link does not open its screen (landed on ${at})`, at !== url && !(await bodyHas(p.A, ccId)) && !(await bodyHas(p.A, 'Transfer this card')), at);
  }

  step('3. Profile: no Transfers section');
  await open(p.A, `/user/${A.username}`);
  await eventually('own profile loads with its tabs', p.A, () => bodyHas(p.A, 'Collections'));
  check('no Transfers / Transactions entry', !(await bodyHas(p.A, 'Transfers')) && !(await bodyHas(p.A, 'Transactions')) && !(await bodyHas(p.A, 'transfer history')));

  step('4. Notifications: transfer notifications hidden, others intact');
  await open(p.A, '/notifications');
  await eventually('the follow notification is listed', p.A, () => bodyHas(p.A, 'started following you.'));
  check('the transfer notification is not', !(await bodyHas(p.A, 'wants to transfer a card to you.')));
  const unread = await A.db.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', A.id).eq('read', false)
    .not('type', 'in', '(ownership_transfer_requested,ownership_transfer_accepted,ownership_transfer_declined,ownership_transfer_cancelled)');
  check('the unread badge query counts only the listed notification', unread.count === 1, unread.count);

  step('5. Messages: no New Group; individual DMs work');
  await open(p.A, '/messages');
  await eventually('inbox loads', p.A, () => hasLabel(p.A, 'New message'));
  await tapLabel(p.A, 'New message');
  await eventually('the New Message sheet opens', p.A, async () => (await bodyHas(p.A, 'New Message')) && (await bodyHas(p.A, 'Choose someone')));
  check('no New Group entry', !(await hasLabel(p.A, 'New group')) && !(await bodyHas(p.A, 'New Group')));
  const dm = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'dm');
  await open(p.A, `/conversation/${dm}`);
  await eventually('the DM composer is shown', p.A, () => p.A.eval(`!!document.querySelector('[placeholder="Message..."]')`));
  await p.A.type('placeholder', 'Message...', `bs dm hello ${run}`);
  await p.A.eval(`(() => { const el = [...document.querySelectorAll('[aria-label]')].find(e => /^Send/.test(e.getAttribute('aria-label'))); el?.click(); return !!el; })()`);
  await eventually('A sends an individual DM', p.A, async () => count(`SELECT count(*) FROM public.messages WHERE conversation_id = '${dm}' AND body = 'bs dm hello ${run}'`) === 1);
  await open(p.B, `/conversation/${dm}`);
  await eventually('B receives it', p.B, () => bodyHas(p.B, `bs dm hello ${run}`));
  await open(p.A, `/conversation/${dm}`);
  await tapLabel(p.A, 'Attach');
  await eventually('the attachment sheet lists working actions only', p.A, async () => (await bodyHas(p.A, 'Share Item')) && (await bodyHas(p.A, 'Photos')));
  check('no "Coming soon" rows', !(await bodyHas(p.A, 'Coming soon')));

  step('6. New item: Figurine not offered; collection flow intact');
  await open(p.A, `/item/new?folderId=${folder}&folderName=${encodeURIComponent(`bs ${run}`)}`);
  await tapLabel(p.A, 'Collectible Type');
  await eventually('the type menu opens', p.A, () => bodyHas(p.A, 'Pokémon Card'));
  check('working types are offered', (await bodyHas(p.A, 'Sports Card')) && (await bodyHas(p.A, 'Comic Book')) && (await bodyHas(p.A, 'Trading Card')));
  check('Figurine is not offered', !(await bodyHas(p.A, 'Figurine')));
  await open(p.A, `/collection/${folder}`);
  // Two active items (the transferred-out one is history, not counted).
  await eventually('the collection still lists its items', p.A, () => bodyHas(p.A, '2 items'));

  step('7. Dashboard: no nonfunctional controls');
  await open(p.A, '/dashboard');
  await eventually('dashboard loads', p.A, () => bodyHas(p.A, 'Support & Contact'));
  for (const t of ['Coming later', 'Planned', 'Freeze Account', 'Private Profile', 'Help Center', 'Not available yet', 'not available yet']) {
    check(`no "${t}"`, !(await bodyHas(p.A, t)));
  }
  check('working support entries remain', (await hasLabel(p.A, 'Contact Support')) && (await hasLabel(p.A, 'Report a Problem')));
  check('account deletion and export entries remain', (await hasLabel(p.A, 'Delete Account')) && (await hasLabel(p.A, 'Download My Data')));

  step('8. Data preserved');
  const after = sql(`SELECT (SELECT count(*) FROM public.registered_cards WHERE id = '${card}') || ',' || (SELECT count(*) FROM public.notifications WHERE user_id = '${A.id}') || ','
                      || (SELECT count(*) FROM public.collection_items WHERE folder_id = '${folder}')`);
  check('registration, notification and item rows unchanged (nothing deleted or rewritten)', after === before, [before, after]);
  check('the registration is still active and owned by A', sql(`SELECT status || ':' || (current_owner_id = '${A.id}') FROM public.registered_cards WHERE id = '${card}'`) === 'active:true');
  check('the transferred-out item keeps its Registry link in the data', sql(`SELECT transferred_registered_card_id FROM public.collection_items WHERE id = '${outItem}'`) === card);

  for (const [k, pg] of Object.entries(p)) await pg.screenshot(`${OUT}/${k}-final.png`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(`App ${APP} → Supabase ${st.API_URL} (isolated ${stack.project}, run ${run}); screenshots: ${OUT}`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
for (const k of ['A', 'B']) users[k] = await createUser(k);
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

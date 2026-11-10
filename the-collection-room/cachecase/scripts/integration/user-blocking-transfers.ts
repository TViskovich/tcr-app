/// <reference types="node" />
// Collector blocking × Registry ownership transfers
// (20261113120000_block_ownership_transfers.sql) — end-to-end against the
// LOCAL Supabase stack through PostgREST, with disposable collectors and
// disposable registered cards (created with the service role, removed
// afterwards). Transfers go through the same RPCs the app calls
// (lib/ownership-transfer.ts).
//
// Prerequisite: local Supabase with the migration applied.
// Run:  node scripts/integration/user-blocking-transfers.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'user-blocking-transfers-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);

type U = { id: string; username: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `ux${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Ux-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, username, db };
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ccId = () => `CC-${Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')}-${Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')}`;
const cards: string[] = [];
async function card(owner: U): Promise<string> {
  const { data, error } = await admin.from('registered_cards').insert({ cc_id: ccId(), current_owner_id: owner.id, status: 'active' }).select('id').single();
  if (error) throw new Error(`card: ${error.message}`);
  cards.push(data.id);
  return data.id;
}

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (ids.length) {
    const { data: owned } = await admin.from('registered_cards').select('id').in('current_owner_id', ids);
    const all = [...new Set([...cards, ...(owned ?? []).map((c) => c.id)])];
    if (all.length) {
      await admin.from('notifications').delete().in('registered_card_id', all);
      await admin.from('registry_events').delete().in('registered_card_id', all);
      await admin.from('ownership_transfers').delete().in('registered_card_id', all);
      await admin.from('registered_cards').delete().in('id', all);
    }
    await admin.from('account_lifecycle').delete().in('user_id', ids);
  }
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

const initiate = (u: U, cardId: string, to: string) => u.db.rpc('initiate_ownership_transfer', { p_registered_card_id: cardId, p_recipient_username: to, p_reason: 'gift' });
const pendingId = async (cardId: string) => (await admin.from('ownership_transfers').select('id').eq('registered_card_id', cardId).eq('status', 'pending').maybeSingle()).data?.id as string | undefined;
const n = async (table: string, f: (q: any) => any) => (await f(admin.from(table).select('*', { count: 'exact', head: true }))).count ?? 0;
const cardState = async (id: string) => (await admin.from('registered_cards').select('current_owner_id, custody_status, collection_item_id, status').eq('id', id).single()).data;

async function main() {
  const A = await createUser('a');
  const B = await createUser('b');
  const C = await createUser('c');
  const D = await createUser('d');
  const K1 = await card(B); // B's card for B → A attempts
  const K2 = await card(A); // A's card for A → B attempts
  const K3 = await card(C); // C → A
  const K4 = await card(B); // pending B → A before the block
  const K5 = await card(A); // pending A → B before the block
  const K6 = await card(A); // A → D (pending deletion)

  step('0. Pre-existing legitimate transfers');
  check('before blocking: B sends K4 to A', !(await initiate(B, K4, A.username)).error);
  check('before blocking: A sends K5 to B', !(await initiate(A, K5, B.username)).error);
  const k4Before = await cardState(K4);
  const k5Before = await cardState(K5);

  step('1. A blocks B — new requests refused both ways, nothing created');
  check('A blocks B', !(await A.db.rpc('block_collector', { p_user_id: B.id })).error);
  const transfersBefore = await n('ownership_transfers', (q) => q.in('registered_card_id', cards));
  const requestsBefore = await n('notifications', (q) => q.eq('type', 'ownership_transfer_requested').in('registered_card_id', cards));
  const bToA = await initiate(B, K1, A.username);
  const aToB = await initiate(A, K2, B.username);
  const unknown = await initiate(A, K2, `ux${run}nobody`);
  check('B (blocked) cannot send a transfer to A', bToA.error?.message === 'Recipient not found', bToA.error);
  check('A (blocker) cannot send a transfer to B', aToB.error?.message === 'Recipient not found', aToB.error);
  check('the refusal is identical (message and code) to an unknown username',
    bToA.error?.message === unknown.error?.message && bToA.error?.code === unknown.error?.code, { blocked: bToA.error?.code, unknown: unknown.error?.code });
  const direct = await B.db.from('ownership_transfers').insert({ registered_card_id: K1, from_owner_id: B.id, to_owner_id: A.id });
  check('a direct API insert is refused', !!direct.error, direct.error?.code);
  check('no transfer was created', (await n('ownership_transfers', (q) => q.in('registered_card_id', cards))) === transfersBefore);
  check('no transfer-request notification was created',
    (await n('notifications', (q) => q.eq('type', 'ownership_transfer_requested').in('registered_card_id', cards))) === requestsBefore);
  const toHidden = await (async () => {
    must(await admin.rpc('schedule_account_deletion', { p_user_id: D.id }), 'schedule D');
    return initiate(A, K6, D.username);
  })();
  check('a pending-deletion recipient is still refused by the lifecycle guard', toHidden.error?.message === 'account_unavailable', toHidden.error);

  step('2. Pre-existing transfers: never completed while blocked, still resolvable');
  const t4 = await pendingId(K4);
  const t5 = await pendingId(K5);
  const eventsBefore = await n('registry_events', (q) => q.in('registered_card_id', [K4, K5]));
  const accA = await A.db.rpc('accept_ownership_transfer', { p_transfer_id: t4 });
  const accB = await B.db.rpc('accept_ownership_transfer', { p_transfer_id: t5 });
  check('A cannot accept B\'s pending transfer while blocked', accA.error?.message === 'account_unavailable', accA.error);
  check('B cannot accept A\'s pending transfer while blocked', accB.error?.message === 'account_unavailable', accB.error);
  check('ownership, custody and item links are unchanged',
    JSON.stringify(await cardState(K4)) === JSON.stringify(k4Before) && JSON.stringify(await cardState(K5)) === JSON.stringify(k5Before));
  check('no registry history was written', (await n('registry_events', (q) => q.in('registered_card_id', [K4, K5]))) === eventsBefore);
  check('both transfers are still pending', (await pendingId(K4)) === t4 && (await pendingId(K5)) === t5);
  check('A can still decline B\'s transfer', !(await A.db.rpc('decline_ownership_transfer', { p_transfer_id: t4 })).error);
  check('A can still cancel its own transfer to B', !(await A.db.rpc('cancel_ownership_transfer', { p_transfer_id: t5 })).error);
  check('…recorded as declined and cancelled, cards still with their owners',
    (await admin.from('ownership_transfers').select('status').eq('id', t4).single()).data?.status === 'declined'
    && (await admin.from('ownership_transfers').select('status').eq('id', t5).single()).data?.status === 'cancelled'
    && (await cardState(K4))?.current_owner_id === B.id && (await cardState(K5))?.current_owner_id === A.id);

  step('3. Bystander C is unaffected');
  check('C can send A a transfer', !(await initiate(C, K3, A.username)).error);
  const t3 = await pendingId(K3);
  check('A can accept it', !(await A.db.rpc('accept_ownership_transfer', { p_transfer_id: t3 })).error);
  check('K3 moved to A with one ownership_transferred event',
    (await cardState(K3))?.current_owner_id === A.id
    && (await n('registry_events', (q) => q.eq('registered_card_id', K3).eq('event_type', 'ownership_transferred'))) === 1);

  step('4. Unblock restores new transfers; the reverse block is enforced');
  check('A unblocks B', (await A.db.rpc('unblock_collector', { p_user_id: B.id })).data?.was_blocked === true);
  check('B can send A a transfer again', !(await initiate(B, K1, A.username)).error);
  check('…and A gets the request notification',
    (await n('notifications', (q) => q.eq('type', 'ownership_transfer_requested').eq('registered_card_id', K1).eq('user_id', A.id).eq('read', false))) === 1);
  check('B cancels it (cleanup)', !(await B.db.rpc('cancel_ownership_transfer', { p_transfer_id: await pendingId(K1) })).error);
  check('B blocks A', !(await B.db.rpc('block_collector', { p_user_id: A.id })).error);
  check('A cannot send B a transfer', (await initiate(A, K2, B.username)).error?.message === 'Recipient not found');
  check('B (blocker) cannot send A one', (await initiate(B, K1, A.username)).error?.message === 'Recipient not found');
  check('B unblocks A', (await B.db.rpc('unblock_collector', { p_user_id: A.id })).data?.was_blocked === true);

  step('5. Concurrency: block vs transfer request (20 races)');
  let late = 0, committedFirst = 0;
  for (let i = 0; i < 20; i++) {
    const jitter = randomInt(6);
    const [br, tr] = await Promise.all([
      (async () => { await sleep(jitter); return A.db.rpc('block_collector', { p_user_id: B.id }); })(),
      (async () => { await sleep(5 - jitter); return initiate(B, K1, A.username); })(),
    ]);
    if (!tr.error) {
      committedFirst++;
      const blockedAt = (await admin.from('user_blocks').select('created_at').eq('blocker_id', A.id).eq('blocked_id', B.id).maybeSingle()).data?.created_at;
      const createdAt = (tr.data as { created_at: string }).created_at;
      if (!br.error && blockedAt && new Date(createdAt) > new Date(blockedAt)) late++;
      await admin.from('ownership_transfers').update({ status: 'cancelled', resolved_at: new Date().toISOString() }).eq('id', (tr.data as { id: string }).id);
    }
    await A.db.rpc('unblock_collector', { p_user_id: B.id });
  }
  check(`no transfer request is accepted after a block commits (${committedFirst}/20 requests committed before their block)`, late === 0, { late });
  check('K1 is still B\'s with no pending transfer left over', (await cardState(K1))?.current_owner_id === B.id && !(await pendingId(K1)));
}

function must<T>(r: { data: T; error: unknown }, what: string): T {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
}

console.log(`Local Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted: ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

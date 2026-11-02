/// <reference types="node" />
// Group Messaging M1 — end-to-end integration test against the LOCAL
// Supabase stack only (supabase start). Five temporary collectors (A–E) sign
// in through Auth and drive the same RPCs and table operations the app uses
// (lib/group-chat.ts, lib/dm-send.ts, app/conversation/[id].tsx,
// hooks/use-unread-messages.ts, app/(tabs)/notifications.tsx), each as their
// own authenticated user. The service role is used only to create and delete
// the fixture accounts and to remove leftover rows afterwards.
//
// Run (Node 24 runs .ts directly):
//   node scripts/integration/group-messaging.ts
//
// Refuses to run unless the API URL is 127.0.0.1/localhost. Every fixture is
// tagged (username prefix gmit_, app_metadata.fixture) and removed at the
// end — and any leftovers from an interrupted earlier run are swept first.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const FIXTURE_TAG = 'group-messaging-it';
const USERNAME_PREFIX = 'gmit_';
const PASSWORD = `gmit-${randomUUID()}`;

// ── Local-only configuration ───────────────────────────────────────────────

function localConfig() {
  const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
  const url = status.API_URL;
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run: API_URL ${url} is not the local stack.`);
  }
  return { url, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY };
}

const config = localConfig();
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.url, config.serviceKey, clientOptions);

// ── Tiny check harness ─────────────────────────────────────────────────────

const results: { step: string; name: string; ok: boolean; detail?: string }[] = [];
let currentStep = '';

function step(name: string) {
  currentStep = name;
  console.log(`\n${name}`);
}

function check(name: string, ok: boolean, detail?: unknown) {
  const text = ok || detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ step: currentStep, name, ok, detail: text });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${text ? `  — ${text}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

type Collector = { label: string; id: string; username: string; db: SupabaseClient };

const runId = randomUUID().replace(/-/g, '').slice(0, 8);
const createdConversations = new Set<string>();

async function sweepLeftovers() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE_TAG) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (ids.length) await deleteFixtures(ids, []);
  return ids.length;
}

async function deleteFixtures(userIds: string[], conversationIds: string[]) {
  // Every conversation any fixture is (or was) in — groups and DMs.
  const { data: rows } = await admin.from('conversation_participants').select('conversation_id').in('user_id', userIds);
  const { data: made } = await admin.from('conversations').select('id').in('created_by', userIds);
  const convIds = [...new Set([...conversationIds, ...(rows ?? []).map((r) => r.conversation_id), ...(made ?? []).map((r) => r.id)])];
  if (convIds.length) {
    const { error } = await admin.from('conversations').delete().in('id', convIds);
    if (error) throw new Error(`deleting conversations failed: ${error.message}`);
  }
  await admin.from('notifications').delete().in('user_id', userIds);
  await admin.from('notifications').delete().in('actor_id', userIds);
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw new Error(`deleting user ${id} failed: ${error.message}`);
  }
}

async function createCollector(label: string): Promise<Collector> {
  const username = `${USERNAME_PREFIX}${runId}_${label.toLowerCase()}`;
  const email = `${username}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { username, display_name: `Collector ${label}` },
    app_metadata: { fixture: FIXTURE_TAG },
  });
  if (error || !data.user) throw new Error(`createUser ${label} failed: ${error?.message}`);
  const db = createClient(config.url, config.anonKey, clientOptions);
  const { error: signInError } = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`sign-in ${label} failed: ${signInError.message}`);
  return { label, id: data.user.id, username, db };
}

// ── App operations (same calls as the mobile app) ──────────────────────────

const MESSAGE_COLUMNS =
  'id, sender_id, body, created_at, attachment_type, attachment_item_id, attachment_storage_path, attachment_width, attachment_height';

type Message = { id: string; sender_id: string; body: string | null; created_at: string };

// lib/dm-send.ts writeDmMessage + stampSenderReadCursor.
async function send(user: Collector, conversationId: string, body: string) {
  const id = randomUUID();
  const { data, error } = await user.db
    .from('messages')
    .insert({ id, conversation_id: conversationId, sender_id: user.id, body })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) return { error, message: null };
  const message = data as Message;
  await user.db
    .from('conversation_participants')
    .update({ last_read_at: message.created_at })
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id);
  return { error: null, message };
}

// app/conversation/[id].tsx fetch.
async function messagesFor(user: Collector, conversationId: string) {
  const { data, error } = await user.db
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`${user.label} messages read failed: ${error.message}`);
  return (data ?? []) as Message[];
}

// Opening the thread: last_read_at = newest message's created_at.
async function markRead(user: Collector, conversationId: string) {
  const list = await messagesFor(user, conversationId);
  const { error } = await user.db
    .from('conversation_participants')
    .update({ last_read_at: list.length ? list[list.length - 1].created_at : new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id);
  if (error) throw new Error(`${user.label} mark read failed: ${error.message}`);
}

// hooks/use-unread-messages.ts rule: last_message_at > my last_read_at.
async function isUnread(user: Collector, conversationId: string) {
  const { data: mine } = await user.db
    .from('conversation_participants')
    .select('last_read_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  const { data: conv } = await user.db.from('conversations').select('last_message_at').eq('id', conversationId).maybeSingle();
  if (!conv?.last_message_at) return false;
  return !mine?.last_read_at || new Date(conv.last_message_at) > new Date(mine.last_read_at);
}

// lib/group-chat.ts loadConversationMeta (group-schema path).
async function meta(user: Collector, conversationId: string) {
  const [conv, parts] = await Promise.all([
    user.db.from('conversations').select('id, kind, name').eq('id', conversationId).maybeSingle(),
    user.db
      .from('conversation_participants')
      .select('user_id, role, joined_at, last_read_at')
      .eq('conversation_id', conversationId)
      .order('joined_at', { ascending: true })
      .order('user_id', { ascending: true }),
  ]);
  if (conv.error) throw new Error(`${user.label} conversation read failed: ${conv.error.message}`);
  if (parts.error) throw new Error(`${user.label} participants read failed: ${parts.error.message}`);
  return conv.data
    ? {
        kind: conv.data.kind as string,
        name: conv.data.name as string | null,
        members: (parts.data ?? []) as { user_id: string; role: string; joined_at: string }[],
      }
    : null;
}

async function rpc(user: Collector, fn: string, args: Record<string, unknown>) {
  return user.db.rpc(fn, args);
}

async function messageNotifications(user: Collector, conversationId: string) {
  const { data, error } = await user.db
    .from('notifications')
    .select('id, actor_id, type, read')
    .eq('user_id', user.id)
    .eq('type', 'message')
    .eq('conversation_id', conversationId);
  if (error) throw new Error(`${user.label} notifications read failed: ${error.message}`);
  return (data ?? []) as { actor_id: string }[];
}

async function expectNoAccess(user: Collector, conversationId: string, label: string) {
  eq(`${label}: conversation row hidden`, await meta(user, conversationId), null);
  eq(`${label}: messages hidden`, (await messagesFor(user, conversationId)).length, 0);
  const { data: member } = await rpc(user, 'is_my_conversation', { p_conversation_id: conversationId });
  eq(`${label}: is_my_conversation is false`, member, false);
  const { error } = await send(user, conversationId, 'should not land');
  check(`${label}: cannot send`, error?.code === '42501', error);
  eq(`${label}: its message notifications were cleared`, (await messageNotifications(user, conversationId)).length, 0);
  const { error: readErr, count } = await user.db
    .from('conversation_participants')
    .update({ last_read_at: new Date().toISOString() }, { count: 'exact' })
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id);
  check(`${label}: cannot touch a read marker`, !readErr && count === 0, readErr ?? { count });
}

// ── The lifecycle ──────────────────────────────────────────────────────────

async function run(A: Collector, B: Collector, C: Collector, D: Collector, E: Collector) {
  const name = (id: string) => [A, B, C, D, E].find((u) => u.id === id)?.label ?? id;

  step('1. A creates a group with B and C');
  const created = await rpc(A, 'create_group_conversation', { p_member_ids: [B.id, C.id], p_name: null });
  check('create_group_conversation succeeds', !created.error && typeof created.data === 'string', created.error);
  const groupId = created.data as string;
  createdConversations.add(groupId);
  const m1 = await meta(B, groupId);
  eq('kind is group, unnamed', [m1?.kind, m1?.name], ['group', null]);
  eq('members in join order with roles', m1?.members.map((m) => `${name(m.user_id)}:${m.role}`).sort(), ['A:admin', 'B:member', 'C:member']);
  for (const u of [A, B, C]) {
    const { data } = await rpc(u, 'is_my_conversation', { p_conversation_id: groupId });
    eq(`${u.label} is a member`, data, true);
  }
  eq('D (outsider) cannot see the group', await meta(D, groupId), null);
  const tooSmall = await rpc(A, 'create_group_conversation', { p_member_ids: [B.id], p_name: null });
  eq('a 2-person group is rejected', tooSmall.error?.message, 'group_invalid_member_count');

  step('2. A sends a message');
  const s1 = await send(A, groupId, 'Welcome to the group!');
  check('A can send', !s1.error, s1.error);
  const spoof = await B.db.from('messages').insert({ id: randomUUID(), conversation_id: groupId, sender_id: A.id, body: 'spoof' });
  check('B cannot send as A', spoof.error?.code === '42501', spoof.error);
  eq('B and C each unread, A not', [await isUnread(A, groupId), await isUnread(B, groupId), await isUnread(C, groupId)], [false, true, true]);

  step('3. B replies and C reads');
  await markRead(B, groupId);
  const s2 = await send(B, groupId, 'Thanks — show us your grails');
  check('B can reply', !s2.error, s2.error);
  await markRead(C, groupId);

  step('4. Ordering, senders, unread markers');
  for (const u of [A, B, C]) {
    const list = await messagesFor(u, groupId);
    eq(`${u.label} sees both messages in order with senders`, list.map((m) => `${name(m.sender_id)}:${m.body}`), [
      'A:Welcome to the group!',
      'B:Thanks — show us your grails',
    ]);
  }
  eq('unread: A yes (B replied), B no, C no', [await isUnread(A, groupId), await isUnread(B, groupId), await isUnread(C, groupId)], [true, false, false]);
  const cRead = await C.db.from('conversation_participants').select('last_read_at').eq('conversation_id', groupId).eq('user_id', C.id).single();
  eq("C's read marker is at B's reply", cRead.data?.last_read_at, s2.message?.created_at);
  eq('A has 1 notification (from B)', (await messageNotifications(A, groupId)).map((n) => name(n.actor_id)), ['B']);
  eq('B has 1 notification (from A)', (await messageNotifications(B, groupId)).map((n) => name(n.actor_id)), ['A']);
  eq('C has 2 notifications (A, B)', (await messageNotifications(C, groupId)).map((n) => name(n.actor_id)).sort(), ['A', 'B']);

  step('5. A adds D and E');
  const added = await rpc(A, 'add_group_members', { p_conversation_id: groupId, p_member_ids: [D.id, E.id] });
  eq('add_group_members returns 2', added.data ?? added.error, 2);
  const again = await rpc(A, 'add_group_members', { p_conversation_id: groupId, p_member_ids: [D.id] });
  eq('re-adding an existing member is rejected', again.error?.message, 'group_duplicate_member');
  const m5 = await meta(A, groupId);
  // D and E joined in one call (same joined_at), so their relative order is by user id.
  eq('D and E listed last (newest joiners), as members', m5?.members.map((m) => `${name(m.user_id)}:${m.role}`).slice(3).sort(), ['D:member', 'E:member']);
  eq('member count is 5', m5?.members.length, 5);
  const { data: addedBy } = await admin.from('conversation_participants').select('user_id, added_by').eq('conversation_id', groupId).in('user_id', [D.id, E.id]);
  check('D and E recorded as added by A', (addedBy ?? []).length === 2 && (addedBy ?? []).every((r) => r.added_by === A.id), addedBy);

  step('6. New members read and participate');
  for (const u of [D, E]) {
    eq(`${u.label} sees the group history`, (await messagesFor(u, groupId)).length, 2);
    eq(`${u.label} sees the conversation as unread`, await isUnread(u, groupId), true);
  }
  const s3 = await send(D, groupId, 'Hi all, D here');
  check('D can send', !s3.error, s3.error);
  await markRead(E, groupId);
  const s4 = await send(E, groupId, 'E checking in');
  check('E can send', !s4.error, s4.error);
  eq('B sees all four messages in order', (await messagesFor(B, groupId)).map((m) => name(m.sender_id)), ['A', 'B', 'D', 'E']);
  eq('D got a notification for E only (none from before joining)', (await messageNotifications(D, groupId)).map((n) => name(n.actor_id)), ['E']);
  eq('E got a notification for D only', (await messageNotifications(E, groupId)).map((n) => name(n.actor_id)), ['D']);

  step('7. B (member) attempts admin-only actions');
  const denied = [
    ['add_group_members', { p_conversation_id: groupId, p_member_ids: [randomUUID()] }],
    ['rename_group', { p_conversation_id: groupId, p_name: 'B was here' }],
    ['remove_group_member', { p_conversation_id: groupId, p_user_id: C.id }],
    ['set_group_member_role', { p_conversation_id: groupId, p_user_id: B.id, p_role: 'admin' }],
  ] as const;
  for (const [fn, args] of denied) {
    const res = await rpc(B, fn, args);
    eq(`B ${fn} → not_group_admin`, res.error?.message, 'not_group_admin');
  }
  const directName = await B.db.from('conversations').update({ name: 'direct write' }).eq('id', groupId).select();
  check('B cannot rename by writing the table', directName.error?.code === '42501' || (directName.data ?? []).length === 0, directName.error ?? directName.data);
  const directRole = await B.db.from('conversation_participants').update({ role: 'admin' }).eq('conversation_id', groupId).eq('user_id', B.id).select();
  check('B cannot promote itself by writing the table', directRole.error?.code === '42501' || (directRole.data ?? []).length === 0, directRole.error ?? directRole.data);
  const directJoin = await B.db.from('conversation_participants').insert({ conversation_id: groupId, user_id: randomUUID() });
  check('B cannot insert a participant row', directJoin.error?.code === '42501', directJoin.error);
  const after7 = await meta(A, groupId);
  eq('nothing changed: name, roles, member count', [after7?.name, after7?.members.filter((m) => m.role === 'admin').map((m) => name(m.user_id)), after7?.members.length], [null, ['A'], 5]);

  step('8. A renames the group');
  const renamed = await rpc(A, 'rename_group', { p_conversation_id: groupId, p_name: '  Grail Hunters  ' });
  check('rename_group succeeds', !renamed.error, renamed.error);
  for (const u of [B, C, D, E]) eq(`${u.label} sees the new name`, (await meta(u, groupId))?.name, 'Grail Hunters');
  const tooLong = await rpc(A, 'rename_group', { p_conversation_id: groupId, p_name: 'x'.repeat(51) });
  eq('a 51-character name is rejected', tooLong.error?.message, 'group_invalid_name');

  step('9. A removes D');
  const removed = await rpc(A, 'remove_group_member', { p_conversation_id: groupId, p_user_id: D.id });
  check('remove_group_member succeeds', !removed.error, removed.error);
  await expectNoAccess(D, groupId, 'D');
  eq('D is no longer listed for others', (await meta(B, groupId))?.members.some((m) => m.user_id === D.id), false);
  eq("D's earlier message stays in the history", (await messagesFor(A, groupId)).some((m) => m.sender_id === D.id), true);
  const removeSelf = await rpc(A, 'remove_group_member', { p_conversation_id: groupId, p_user_id: A.id });
  eq('admin cannot remove self (must leave)', removeSelf.error?.message, 'cannot_remove_self');

  step('10. C leaves');
  const left = await rpc(C, 'leave_group', { p_conversation_id: groupId });
  check('leave_group succeeds', !left.error, left.error);
  await expectNoAccess(C, groupId, 'C');
  const readd = await rpc(A, 'add_group_members', { p_conversation_id: groupId, p_member_ids: [C.id] });
  eq('a member who left cannot be re-added', readd.error?.message, 'group_member_unavailable');
  const leaveAgain = await rpc(C, 'leave_group', { p_conversation_id: groupId });
  eq('leaving again → not_group_member', leaveAgain.error?.message, 'not_group_member');

  step('11. Member counts, admin permissions, notifications');
  const m11 = await meta(E, groupId);
  eq('3 members remain: A admin, B and E members', m11?.members.map((m) => `${name(m.user_id)}:${m.role}`).sort(), ['A:admin', 'B:member', 'E:member']);
  const lastAdmin = await rpc(A, 'set_group_member_role', { p_conversation_id: groupId, p_user_id: A.id, p_role: 'member' });
  eq('the only admin cannot demote itself', lastAdmin.error?.message, 'last_group_admin');
  const promote = await rpc(A, 'set_group_member_role', { p_conversation_id: groupId, p_user_id: B.id, p_role: 'admin' });
  check('A promotes B to admin', !promote.error, promote.error);
  const bRename = await rpc(B, 'rename_group', { p_conversation_id: groupId, p_name: 'Grail Hunters II' });
  check('B can now rename', !bRename.error, bRename.error);
  const demote = await rpc(B, 'set_group_member_role', { p_conversation_id: groupId, p_user_id: B.id, p_role: 'member' });
  check('B steps back down (A is still admin)', !demote.error, demote.error);
  const eDenied = await rpc(E, 'rename_group', { p_conversation_id: groupId, p_name: 'nope' });
  eq('E (member) still denied', eDenied.error?.message, 'not_group_admin');

  const before = new Map<string, number>();
  for (const u of [A, B, C, D, E]) before.set(u.label, (await messageNotifications(u, groupId)).length);
  const s5 = await send(A, groupId, 'Final roll call');
  check('A sends after the membership changes', !s5.error, s5.error);
  const delta = async (u: Collector) => (await messageNotifications(u, groupId)).length - (before.get(u.label) ?? 0);
  eq('new message notifies B and E only', [await delta(A), await delta(B), await delta(C), await delta(D), await delta(E)], [0, 1, 0, 0, 1]);
  eq('C and D have no notifications for the group at all', [(await messageNotifications(C, groupId)).length, (await messageNotifications(D, groupId)).length], [0, 0]);

  // Last-admin succession: A (only admin) leaves → longest-standing member (B) is promoted.
  const aLeaves = await rpc(A, 'leave_group', { p_conversation_id: groupId });
  check('A (sole admin) can leave', !aLeaves.error, aLeaves.error);
  const m11b = await meta(B, groupId);
  eq('B inherits admin; 2 members remain', m11b?.members.map((m) => `${name(m.user_id)}:${m.role}`), ['B:admin', 'E:member']);

  step('12. One-on-one DMs are independent');
  const dm1 = await rpc(A, 'get_or_create_conversation', { other_user_id: B.id });
  check('A opens a DM with B', !dm1.error && typeof dm1.data === 'string', dm1.error);
  const dmId = dm1.data as string;
  createdConversations.add(dmId);
  check('the DM is not the group (both were in it)', dmId !== groupId);
  const dm2 = await rpc(B, 'get_or_create_conversation', { other_user_id: A.id });
  eq('B gets the same DM back', dm2.data, dmId);
  eq('DM is kind direct with 2 members', await meta(A, dmId).then((m) => [m?.kind, m?.name, m?.members.length]), ['direct', null, 2]);
  const dmSend = await send(A, dmId, 'private hello');
  check('A sends in the DM', !dmSend.error, dmSend.error);
  const dmReply = await send(B, dmId, 'private reply');
  check('B replies in the DM', !dmReply.error, dmReply.error);
  eq('DM history is only the DM messages', (await messagesFor(B, dmId)).map((m) => m.body), ['private hello', 'private reply']);
  eq('group history has no DM messages', (await messagesFor(B, groupId)).some((m) => m.body?.startsWith('private')), false);
  eq('E (in the group) cannot see the A–B DM', await meta(E, dmId), null);
  eq('B has one DM notification (from A)', (await messageNotifications(B, dmId)).map((n) => name(n.actor_id)), ['A']);
  const peer = await A.db.from('conversation_participants').select('last_read_at').eq('conversation_id', dmId).neq('user_id', A.id).maybeSingle();
  eq("A sees B's read receipt (DM peer cursor)", peer.data?.last_read_at, dmReply.message?.created_at);
  const removedDm = await rpc(C, 'get_or_create_conversation', { other_user_id: D.id });
  check('C and D (both out of the group) can still DM', !removedDm.error, removedDm.error);
  if (removedDm.data) createdConversations.add(removedDm.data as string);
  const cdSend = removedDm.data ? await send(C, removedDm.data as string, 'hey') : { error: 'no dm' };
  check('C sends to D', !cdSend.error, cdSend.error);
  const forged = await C.db
    .from('messages')
    .insert({ id: randomUUID(), conversation_id: removedDm.data as string, sender_id: C.id, body: 'time travel', created_at: '2000-01-01T00:00:00Z' })
    .select('id, created_at')
    .single();
  check('client-supplied created_at is replaced by server time', !forged.error && !forged.data.created_at.startsWith('2000'), forged.data ?? forged.error);
  const groupRpcOnDm = await rpc(A, 'add_group_members', { p_conversation_id: dmId, p_member_ids: [E.id] });
  eq('group functions refuse a DM', groupRpcOnDm.error?.message, 'not_group_member');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Local Supabase: ${config.url}  (run ${runId})`);
  const swept = await sweepLeftovers();
  if (swept) console.log(`Removed ${swept} leftover fixture account(s) from an earlier run.`);

  const users: Collector[] = [];
  let fatal: unknown = null;
  try {
    for (const label of ['A', 'B', 'C', 'D', 'E']) users.push(await createCollector(label));
    const [A, B, C, D, E] = users;
    await run(A, B, C, D, E);
  } catch (e) {
    fatal = e;
    console.error(`\nAborted in "${currentStep}": ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await Promise.all(users.map((u) => u.db.auth.signOut().catch(() => {})));
    await deleteFixtures(users.map((u) => u.id), [...createdConversations]);
    const leftover = await admin.from('profiles').select('id').like('username', `${USERNAME_PREFIX}${runId}%`);
    const leftoverConvs = createdConversations.size
      ? await admin.from('conversations').select('id').in('id', [...createdConversations])
      : { data: [] };
    console.log(`\nCleanup: ${users.length} accounts deleted; leftover profiles ${leftover.data?.length ?? '?'}, leftover conversations ${leftoverConvs.data?.length ?? '?'}.`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (run aborted early)' : ''}.`);
  for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = failed.length || fatal ? 1 : 0;
}

await main();

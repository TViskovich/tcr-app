import { supabase } from '@/lib/supabase';

// Group conversations — the client half of supabase/migrations/
// 20261101130000_add_group_conversations.sql. Every permission (admin-only
// actions, the 3–32 size, who can be added, last-admin succession) is
// enforced by those server functions; this module only calls them and turns
// their error tokens into words. Groups are ordinary conversations
// (conversations.kind = 'group'), so messages, attachments, unread state and
// notifications all go through the existing DM paths.

// ── Schema compatibility ─────────────────────────────────────────────────
// The app can run against a database that doesn't have the group migration
// yet (e.g. a dev build on production before 20261101130000 is applied).
// The first query that hits one of the group-only columns there fails with
// "column … does not exist" (42703); that is remembered for the rest of the
// session, the query is re-run in the original DM-only shape, and every later
// query starts in that shape — no repeated failing requests. Any other error
// is passed through untouched. Group features (New Group) only show once the
// schema is known to have them. Not persisted: the next launch checks again,
// so applying the migration needs nothing more than an app restart.
let groupSchema: boolean | null = null;

const GROUP_ONLY_COLUMNS = /^column (conversations\.(kind|name|created_by)|conversation_participants\.(role|joined_at|added_by)) does not exist$/;

export function isMissingGroupColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '42703' && GROUP_ONLY_COLUMNS.test(error.message ?? '');
}

// True only once a query has confirmed the database has group messaging.
export function groupMessagingAvailable(): boolean {
  return groupSchema === true;
}

// Runs the group-aware query unless the schema is already known to lack it;
// falls back to the legacy (DM-only) query on a missing group column, and
// records what it learned. Other errors are returned as-is to the caller.
export async function withGroupSchema<R extends { error: { code?: string; message?: string } | null }>(
  groupQuery: () => PromiseLike<R>,
  legacyQuery: () => PromiseLike<R>,
): Promise<{ result: R; groups: boolean }> {
  if (groupSchema !== false) {
    const result = await groupQuery();
    if (!isMissingGroupColumn(result.error)) {
      if (!result.error) groupSchema = true;
      return { result, groups: true };
    }
    groupSchema = false;
    if (__DEV__) console.info('[group-chat] group messaging columns not in this database yet — using the DM-only schema.');
  }
  return { result: await legacyQuery(), groups: false };
}

// Settles groupMessagingAvailable() when nothing has queried a group column
// yet (e.g. an empty inbox never does): one zero-cost probe, same fallback
// rules. False on any other error — group features just stay hidden.
export async function checkGroupMessaging(): Promise<boolean> {
  if (groupSchema !== null) return groupSchema;
  try {
    const { result } = await withGroupSchema<{ error: { code?: string; message?: string } | null }>(
      () => supabase.from('conversations').select('kind').limit(1),
      () => supabase.from('conversations').select('id').limit(1),
    );
    if (result.error && __DEV__) console.warn('[group-chat] group schema check failed:', result.error.message);
  } catch (e) {
    if (__DEV__) console.warn('[group-chat] group schema check threw:', e);
  }
  return groupSchema === true;
}

export const GROUP_MAX_MEMBERS = 32;
export const GROUP_MIN_MEMBERS = 3;
export const GROUP_NAME_MAX = 50;

export type ConversationKind = 'direct' | 'group';

export type ConversationMember = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: 'admin' | 'member';
  joinedAt: string;
  lastReadAt: string | null;
};

export type ConversationMeta = {
  id: string;
  kind: ConversationKind;
  name: string | null;
  // Everyone in it, the signed-in user included, longest-standing first.
  members: ConversationMember[];
};

export function memberName(member: Pick<ConversationMember, 'displayName' | 'username'>): string {
  return member.displayName?.trim() || member.username;
}

// A group's title: its name, else the other members' names ("Ana, Ben" or
// "Ana, Ben +3").
export function groupTitle(
  name: string | null,
  members: Pick<ConversationMember, 'id' | 'displayName' | 'username'>[],
  currentUserId: string | null | undefined,
): string {
  if (name?.trim()) return name.trim();
  const others = members.filter((m) => m.id !== currentUserId);
  if (others.length === 0) return 'Group';
  const shown = others.slice(0, 2).map(memberName);
  const extra = others.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ');
}

// The conversation row plus every member with their profile — null when the
// signed-in user can't see it (not a member, or it no longer exists; RLS
// answers both the same way). Throws on a request failure.
// On a database without the group migration (see withGroupSchema) it loads
// the original DM shape: every conversation is 'direct', members have no
// role/join time.
export async function loadConversationMeta(conversationId: string, signal?: AbortSignal): Promise<ConversationMeta | null> {
  const withSignal = <Q extends { abortSignal: (s: AbortSignal) => Q }>(q: Q): Q => (signal ? q.abortSignal(signal) : q);
  const [{ result: conversationRes }, { result: participantsRes }] = await Promise.all([
    withGroupSchema(
      () => withSignal(supabase.from('conversations').select('id, kind, name').eq('id', conversationId)).maybeSingle(),
      () => withSignal(supabase.from('conversations').select('id').eq('id', conversationId)).maybeSingle(),
    ),
    withGroupSchema(
      () =>
        withSignal(
          supabase
            .from('conversation_participants')
            .select('user_id, role, joined_at, last_read_at')
            .eq('conversation_id', conversationId)
            .order('joined_at', { ascending: true })
            .order('user_id', { ascending: true }),
        ),
      () =>
        withSignal(
          supabase
            .from('conversation_participants')
            .select('user_id, last_read_at')
            .eq('conversation_id', conversationId)
            .order('user_id', { ascending: true }),
        ),
    ),
  ]);
  if (conversationRes.error) throw conversationRes.error;
  if (participantsRes.error) throw participantsRes.error;
  const conversation = conversationRes.data as { id: string; kind?: ConversationKind | null; name?: string | null } | null;
  if (!conversation) return null;

  const participants = (participantsRes.data ?? []) as {
    user_id: string;
    role?: 'admin' | 'member' | null;
    joined_at?: string | null;
    last_read_at: string | null;
  }[];
  const ids = participants.map((p) => p.user_id);
  let profiles: { id: string; username: string; display_name: string | null; avatar_url: string | null }[] = [];
  if (ids.length) {
    let profilesQuery = supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', ids);
    if (signal) profilesQuery = profilesQuery.abortSignal(signal);
    const profilesRes = await profilesQuery;
    if (profilesRes.error) throw profilesRes.error;
    profiles = (profilesRes.data ?? []) as typeof profiles;
  }
  const byId = new Map(profiles.map((p) => [p.id, p]));

  return {
    id: conversation.id,
    // Rows from before the group migration have no kind: they are DMs.
    kind: conversation.kind === 'group' ? 'group' : 'direct',
    name: conversation.name ?? null,
    members: participants.map((p) => {
      const profile = byId.get(p.user_id);
      return {
        id: p.user_id,
        username: profile?.username ?? 'user',
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
        role: p.role === 'admin' ? 'admin' : 'member',
        joinedAt: p.joined_at ?? '',
        lastReadAt: p.last_read_at,
      };
    }),
  };
}

// ── Server functions ──────────────────────────────────────────────────────

export type GroupResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

// The server's error tokens (see the migration's section 7) as user-facing
// copy. Anything unexpected gets a generic retry message.
const ERROR_COPY: Record<string, string> = {
  not_authenticated: 'Please sign in again.',
  group_invalid_name: `Group names can be up to ${GROUP_NAME_MAX} characters.`,
  group_invalid_member_count: `Groups need ${GROUP_MIN_MEMBERS}–${GROUP_MAX_MEMBERS} people, including you.`,
  group_duplicate_member: 'Someone you picked is already in this group.',
  group_member_not_found: 'Someone you picked is no longer available.',
  group_member_unavailable:
    'Someone you picked recently left a group and can’t be added right now.',
  group_rate_limited: 'You’ve started a lot of groups today. Please try again tomorrow.',
  group_full: `Groups can have up to ${GROUP_MAX_MEMBERS} people.`,
  not_group_member: 'You’re no longer in this group.',
  not_group_admin: 'Only group admins can do that.',
  cannot_remove_self: 'To leave the group, use Leave Group.',
  last_group_admin: 'Make someone else an admin first.',
  group_invalid_role: 'That isn’t a valid role.',
};

export function groupErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  // The group functions don't exist on this database yet (see withGroupSchema).
  if (error?.code === 'PGRST202') return 'Group chats aren’t available yet.';
  const token = error?.message?.trim() ?? '';
  return ERROR_COPY[token] ?? 'Something went wrong. Please try again.';
}

async function callGroupFunction<T>(fn: string, args: Record<string, unknown>): Promise<GroupResult<T>> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      if (__DEV__) console.warn(`[group-chat] ${fn} failed:`, error.message);
      return { ok: false, message: groupErrorMessage(error) };
    }
    return { ok: true, value: data as T };
  } catch (e) {
    if (__DEV__) console.warn(`[group-chat] ${fn} threw:`, e);
    return { ok: false, message: groupErrorMessage(null) };
  }
}

// The caller becomes its admin. Returns the new conversation's id.
export function createGroupConversation(memberIds: string[], name: string | null): Promise<GroupResult<string>> {
  return callGroupFunction<string>('create_group_conversation', { p_member_ids: memberIds, p_name: name });
}

export function addGroupMembers(conversationId: string, memberIds: string[]): Promise<GroupResult<number>> {
  return callGroupFunction<number>('add_group_members', { p_conversation_id: conversationId, p_member_ids: memberIds });
}

export function removeGroupMember(conversationId: string, userId: string): Promise<GroupResult> {
  return callGroupFunction<void>('remove_group_member', { p_conversation_id: conversationId, p_user_id: userId });
}

// The last admin leaving hands admin to the longest-standing member
// (server-side). Leaving removes access to the whole conversation.
export function leaveGroup(conversationId: string): Promise<GroupResult> {
  return callGroupFunction<void>('leave_group', { p_conversation_id: conversationId });
}

// Blank clears the name (the group is then titled after its members).
export function renameGroup(conversationId: string, name: string): Promise<GroupResult> {
  return callGroupFunction<void>('rename_group', { p_conversation_id: conversationId, p_name: name });
}

import { ACCOUNT_INACTIVE_MESSAGE, ACCOUNT_UNAVAILABLE_MESSAGE } from '@/lib/account-errors';
import { clearInboxSnapshot } from '@/lib/dm-inbox';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { removeRecentProfile } from '@/lib/recent-profiles';
import { supabase } from '@/lib/supabase';
import { forgetVisitedProfile } from '@/lib/visited-profile-cache';

// Collector blocking — the client half of
// supabase/migrations/20261112120000_add_user_blocks.sql (and
// 20261113120000_block_ownership_transfers.sql). The database enforces every
// rule; this module only calls its functions, turns their error tokens into
// words, and clears local caches that could still show what a block hides.
//
// Privacy: nothing here can tell whether the OTHER collector blocked the
// signed-in one. get_block_status only answers "did I block them?", and a
// blocked interaction is reported with the same neutral wording as any
// unavailable account (ACCOUNT_UNAVAILABLE_MESSAGE).

export type BlockedCollector = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
};

export type BlockFailure = 'session_expired' | 'unavailable' | 'self' | 'limit' | 'inactive' | 'network' | 'unknown';

export const BLOCK_ERROR_COPY: Record<BlockFailure, string> = {
  session_expired: 'Your session has ended. Sign in again to continue.',
  unavailable: ACCOUNT_UNAVAILABLE_MESSAGE,
  self: 'You can’t block yourself.',
  limit: 'You’ve reached the limit of 1,000 blocked collectors. Unblock someone to block another collector.',
  inactive: ACCOUNT_INACTIVE_MESSAGE,
  network: 'Couldn’t reach CacheCase. Check your connection and try again.',
  unknown: 'Something went wrong. Please try again.',
};

export type BlockResult<T> = { ok: true; value: T } | { ok: false; reason: BlockFailure; message: string };

type MaybeError = { message?: string; code?: string; status?: number } | null | undefined;

export function blockFailureOf(error: MaybeError, thrown = false): BlockFailure {
  if (thrown) return 'network';
  const message = error?.message ?? '';
  if (message.includes('not_authenticated') || error?.code === 'PGRST301' || /jwt expired|invalid jwt/i.test(message)) return 'session_expired';
  if (message.includes('account_unavailable')) return 'unavailable';
  if (message.includes('cannot_block_self')) return 'self';
  if (message.includes('block_limit_reached')) return 'limit';
  if (message.includes('account_inactive')) return 'inactive';
  if (/failed to fetch|network request failed|load failed|fetch failed/i.test(message)) return 'network';
  return 'unknown';
}

function failure<T>(reason: BlockFailure): BlockResult<T> {
  return { ok: false, reason, message: BLOCK_ERROR_COPY[reason] };
}

async function call<T>(fn: string, args: Record<string, unknown>, map: (data: unknown) => T): Promise<BlockResult<T>> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return failure(blockFailureOf(error));
    return { ok: true, value: map(data) };
  } catch {
    return failure('network');
  }
}

// ── Change notifications ─────────────────────────────────────────────────
// Screens that show the other collector (profile, conversation, Blocked
// Collectors) refresh when a block changes anywhere in the app.
type BlockChange = { userId: string; blocked: boolean };
const listeners = new Set<(change: BlockChange) => void>();

export function subscribeBlockChanges(listener: (change: BlockChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Local caches that could still show what a block hides (or keep hiding
// what an unblock restores). Supabase stays authoritative: every screen
// still revalidates on focus; this only stops stale snapshots being shown.
function afterBlockChange(viewerId: string, userId: string, blocked: boolean) {
  forgetVisitedProfile(viewerId, userId);
  invalidateOwnProfileCache(viewerId); // follow counts change when a block removes follows
  clearInboxSnapshot();
  if (blocked) removeRecentProfile(viewerId, userId).catch(() => {});
  for (const listener of listeners) listener({ userId, blocked });
}

// ── Functions ────────────────────────────────────────────────────────────
export async function blockCollector(viewerId: string, userId: string): Promise<BlockResult<{ alreadyBlocked: boolean }>> {
  const result = await call('block_collector', { p_user_id: userId }, (data) => ({
    alreadyBlocked: (data as { already_blocked?: boolean } | null)?.already_blocked === true,
  }));
  if (result.ok) afterBlockChange(viewerId, userId, true);
  return result;
}

export async function unblockCollector(viewerId: string, userId: string): Promise<BlockResult<{ wasBlocked: boolean }>> {
  const result = await call('unblock_collector', { p_user_id: userId }, (data) => ({
    wasBlocked: (data as { was_blocked?: boolean } | null)?.was_blocked === true,
  }));
  if (result.ok) afterBlockChange(viewerId, userId, false);
  return result;
}

export function getBlockStatus(userId: string): Promise<BlockResult<{ blockedByMe: boolean }>> {
  return call('get_block_status', { p_user_id: userId }, (data) => ({
    blockedByMe: (data as { blocked_by_me?: boolean } | null)?.blocked_by_me === true,
  }));
}

export const BLOCKED_PAGE_SIZE = 50;

export function listBlockedCollectors(before?: string | null): Promise<BlockResult<BlockedCollector[]>> {
  return call('list_blocked_collectors', { p_limit: BLOCKED_PAGE_SIZE, p_before: before ?? null }, (data) =>
    ((data ?? []) as { user_id: string; username: string; display_name: string | null; avatar_url: string | null; blocked_at: string }[]).map(
      (row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        blockedAt: row.blocked_at,
      }),
    ),
  );
}

// ── Wording ──────────────────────────────────────────────────────────────
// Neutral, and never stronger than the backend: public content stays
// visible to people who aren't signed in.
export const BLOCK_COPY = {
  confirmTitle: (username: string) => `Block @${username}?`,
  confirmBody:
    'They won’t be able to message you, follow you, or interact with your posts and collection while they’re blocked, and you won’t see theirs. ' +
    'Your existing messages stay in your conversation. They won’t be notified that you blocked them. ' +
    'Anything you’ve made public can still be seen by people who aren’t signed in.',
  confirmAction: 'Block',
  unblockTitle: (username: string) => `Unblock @${username}?`,
  unblockBody:
    'They’ll be able to find you, follow you and message you again. Follows, tags and other connections removed when you blocked them won’t come back on their own.',
  unblockAction: 'Unblock',
  blockedNotice: (username: string) => `You blocked @${username}. They can’t message, follow or interact with you, and you won’t see their posts or collection.`,
  dmBlockedByMe: 'You blocked this collector. Unblock them to send messages again.',
  dmUnavailable: 'Messaging isn’t available in this conversation. You can still read your earlier messages.',
};

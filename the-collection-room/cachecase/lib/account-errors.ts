// Account-lifecycle errors raised by the database
// (supabase/migrations/20261103120000_add_account_lifecycle.sql,
// 20261104120000_account_lifecycle_dm_privacy.sql) and the words shown for
// them.
//   account_inactive    — the signed-in collector is scheduled for deletion,
//                         so normal activity is disabled.
//   account_suspended   — the signed-in collector's account is suspended
//                         (Phase 2B M3), so normal activity is disabled.
//   account_unavailable — the other collector (the one being followed,
//                         messaged, liked…) is unavailable right now.
// Deliberately says nothing about WHY another collector is unavailable.

import { notifyAccountInactive } from '@/lib/account-lifecycle-events';

export const ACCOUNT_INACTIVE_MESSAGE =
  'Your account is scheduled for deletion, so this isn’t available. Cancel the deletion to use CacheCase again.';
export const ACCOUNT_SUSPENDED_MESSAGE = 'Your account is suspended, so this isn’t available.';
export const ACCOUNT_UNAVAILABLE_MESSAGE = 'This collector isn’t available right now.';
export const CONVERSATION_CLOSED_MESSAGE = 'This account has been deleted, so the conversation is read-only.';

type MaybeError = { message?: unknown } | null | undefined;

export function accountErrorKind(error: MaybeError): 'inactive' | 'suspended' | 'unavailable' | 'closed' | null {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message === 'account_inactive') return 'inactive';
  if (message === 'account_suspended') return 'suspended';
  if (message === 'account_unavailable') return 'unavailable';
  // A direct conversation whose other account was permanently deleted.
  if (message === 'conversation_closed') return 'closed';
  return null;
}

// The words to show for an account-lifecycle error, or null for any other
// error (callers keep their existing copy). An account_inactive error also
// asks the app to re-check the signed-in collector's state, which shows the
// Pending Deletion screen if they've been scheduled from another device.
export function accountErrorMessage(error: MaybeError): string | null {
  const kind = accountErrorKind(error);
  if (kind === 'inactive') {
    notifyAccountInactive();
    return ACCOUNT_INACTIVE_MESSAGE;
  }
  if (kind === 'suspended') {
    // Re-checks the account, which shows the Account Suspended screen.
    notifyAccountInactive();
    return ACCOUNT_SUSPENDED_MESSAGE;
  }
  if (kind === 'unavailable') return ACCOUNT_UNAVAILABLE_MESSAGE;
  if (kind === 'closed') return CONVERSATION_CLOSED_MESSAGE;
  return null;
}

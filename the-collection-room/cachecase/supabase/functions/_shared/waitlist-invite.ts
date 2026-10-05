// Shared request rules for the public invite endpoints (validate-waitlist-
// invite, redeem-waitlist-invite). Email normalization matches join-waitlist
// and the waitlist_signups_normalized_email_key index: trim + lowercase.
// Username rules match the app's sign-up screen and the existing
// handle_new_user profile bootstrap (which itself does no validation).

import { hashInviteCode, normalizeInviteCode } from './invite-code.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const USERNAME_RE = /^[a-z0-9_]+$/;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;
const MIN_PASSWORD_LENGTH = 6; // current sign-up rule
const MAX_PASSWORD_LENGTH = 72; // bcrypt input limit enforced by Supabase Auth

// Hash of the normalized code, or null if the input can't be a code. The
// plaintext never leaves the caller's scope.
export async function inviteCodeHash(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const normalized = normalizeInviteCode(raw);
  return normalized ? await hashInviteCode(normalized) : null;
}

export function normalizeEmail(raw: unknown): string | null {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return email && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email) ? email : null;
}

// Returns the stored username (lowercased) and the display name (as typed,
// trimmed) — the same split the app's sign-up screen sends today.
export function normalizeUsername(raw: unknown): { username: string; displayName: string } | null {
  const displayName = typeof raw === 'string' ? raw.trim() : '';
  const username = displayName.toLowerCase();
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) return null;
  return USERNAME_RE.test(username) ? { username, displayName } : null;
}

export function validPassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= MIN_PASSWORD_LENGTH && raw.length <= MAX_PASSWORD_LENGTH;
}

export type InviteCheckRow = {
  outcome: 'valid' | 'expired' | 'used' | 'invalid';
  name: string | null;
  reserved_username: string | null;
  expires_at: string | null;
  email_matches: boolean | null;
};

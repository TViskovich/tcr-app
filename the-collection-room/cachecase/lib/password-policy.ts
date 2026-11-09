// The one password rule for every place a collector chooses a password:
// invite sign-up (app/(auth)/sign-up.tsx), password reset
// (app/(auth)/reset-password.tsx) and Change Password
// (app/account/password.tsx).
//
// At least 8 characters, and at most 72 bytes — the most Supabase Auth
// (bcrypt) uses; anything longer would be silently truncated, so it is
// refused rather than accepted. A password of only spaces is refused.
//
// The server enforces its own minimum too (Supabase Auth
// `minimum_password_length`, 8 in supabase/config.toml for local; the
// production setting must match — see the account-recovery rollout notes).
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters`;

const bytes = (value: string) => new TextEncoder().encode(value).length;

// null when the password is acceptable, otherwise a message for the collector.
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH || !password.trim()) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (bytes(password) > PASSWORD_MAX_BYTES) return 'That password is too long. Use a shorter one.';
  return null;
}

// A new password and its confirmation.
export function newPasswordProblem(password: string, confirmation: string): string | null {
  return passwordProblem(password) ?? (password === confirmation ? null : 'The passwords don’t match.');
}

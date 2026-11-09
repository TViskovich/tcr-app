// "Recently signed in" for sensitive account actions (scheduling deletion,
// Delete Now, requesting a data export): the access token's amr claim must
// record a PASSWORD sign-in within RECENT_AUTH_SECONDS. Only amr entries
// with method "password" count — a session from an emailed one-time code
// (password recovery, amr "otp") or any other, unknown or malformed method
// never does, so a half-finished password reset can't authorize these
// actions. The app asks for the password right before each of them
// (lib/edge-functions.ts confirmPassword), which records a fresh "password"
// entry. Refreshing a token doesn't renew that time.
//
// Product rule: 10 minutes. The optional ACCOUNT_RECENT_AUTH_SECONDS secret
// can only make the window SHORTER (local tests use a few seconds); it can
// never relax it.

const MAX_RECENT_AUTH_SECONDS = 10 * 60;

export const RECENT_AUTH_SECONDS = (() => {
  const configured = Number.parseInt(Deno.env.get('ACCOUNT_RECENT_AUTH_SECONDS') ?? '', 10);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(configured, MAX_RECENT_AUTH_SECONDS) : MAX_RECENT_AUTH_SECONDS;
})();

// Claims of a token that auth.getUser has ALREADY verified for this request.
function tokenClaims(token: string): { amr?: { method?: string; timestamp?: number }[] } | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// Clock skew allowed for a sign-in time slightly in the future.
const CLOCK_SKEW_SECONDS = 60;

// true when the verified token records a password sign-in within the window.
export function signedInRecently(token: string): boolean {
  const amr = tokenClaims(token)?.amr;
  if (!Array.isArray(amr)) return false;
  const passwordTimes = amr
    .filter((m) => !!m && typeof m === 'object' && m.method === 'password')
    .map((m) => m.timestamp)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0);
  if (passwordTimes.length === 0) return false;
  const age = Math.floor(Date.now() / 1000) - Math.max(...passwordTimes);
  return age >= -CLOCK_SKEW_SECONDS && age <= RECENT_AUTH_SECONDS;
}

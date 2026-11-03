// "Recently signed in" for sensitive account actions (scheduling deletion,
// requesting a data export): the latest sign-in recorded in the access
// token's amr claim must be within RECENT_AUTH_SECONDS. Refreshing a token
// doesn't renew that time, so the app asks for the password again.
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

// true when the verified token's most recent sign-in is within the window.
export function signedInRecently(token: string): boolean {
  const amr = tokenClaims(token)?.amr;
  if (!Array.isArray(amr) || amr.length === 0) return false;
  const latest = Math.max(...amr.map((m) => (typeof m?.timestamp === 'number' ? m.timestamp : 0)));
  if (!latest) return false;
  const age = Math.floor(Date.now() / 1000) - latest;
  return age >= -60 && age <= RECENT_AUTH_SECONDS;
}

// Shared by the image-signing Edge Functions (get-folder-cover-signed-url,
// get-collection-item-image-signed-url).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The user id a bearer token CLAIMS (its JWT `sub`), decoded without
// verification — used only to start a caller-specific RPC before
// verification finishes, and only ever trusted if resolveCaller then verifies
// that exact id (each handler re-runs the RPC for the verified id otherwise).
// null for no/malformed token, which is also correct speculation for an
// anonymous caller.
export function unverifiedTokenSubject(req: Request): string | null {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && UUID_RE.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

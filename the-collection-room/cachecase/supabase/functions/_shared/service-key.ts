// Server-side Supabase key resolution — the ONE place Edge Functions read
// their privileged API key.
//
// Supabase is replacing the legacy service_role JWT with secret API keys
// (sb_secret_…), which are NOT JWTs. During the transition:
//   1. the default key in SUPABASE_SECRET_KEYS (JSON keyed by name, provided
//      by the platform) is preferred;
//   2. SUPABASE_SERVICE_ROLE_KEY is the fallback — a legacy JWT, or a secret
//      key if the platform has remapped the variable;
//   3. neither → ServiceKeyUnavailable. Callers fail closed (500, logged as
//      server_key_unavailable) — never run unauthenticated.
// The key value is never logged, returned or stored by this module; only its
// kind ('secret' | 'legacy_jwt') may be logged.
//
// How to present the key:
//   * supabase-js (createClient) handles both kinds itself;
//   * raw Storage / TUS requests: storageAuthHeaders() — the apikey header,
//     plus Authorization: Bearer only for a legacy JWT (Storage rejects a
//     secret key sent as a Bearer token);
//   * never as a credential between functions (the gateway's JWT check
//     can't verify a secret key, and passing it isn't authorization).
//
// Local testing only (the CLI won't let an env file set SUPABASE_* names), when
// SUPABASE_URL is a local host:
//   CACHECASE_LOCAL_DISABLE_SECRET_KEYS=1  ignores SUPABASE_SECRET_KEYS
//                                          (exercise the legacy-JWT path)
//   CACHECASE_LOCAL_SECRET_KEYS            a stand-in SUPABASE_SECRET_KEYS
//   CACHECASE_LOCAL_DISABLE_LEGACY_KEY=1   ignores SUPABASE_SERVICE_ROLE_KEY
//                                          (emulate retired legacy keys)
// All three are ignored on hosted projects.

// source: the variable the key came from (a name, safe to log).
export type ServiceKey = {
  key: string;
  kind: 'secret' | 'legacy_jwt';
  source: 'SUPABASE_SECRET_KEYS' | 'CACHECASE_LOCAL_SECRET_KEYS' | 'SUPABASE_SERVICE_ROLE_KEY';
};

export class ServiceKeyUnavailable extends Error {
  constructor() {
    super('server_key_unavailable');
    this.name = 'ServiceKeyUnavailable';
  }
}

const SECRET_KEY_RE = /^sb_secret_[A-Za-z0-9_-]{8,}$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LOCAL_HOSTS = ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'];

type Env = { get(name: string): string | undefined };

function isLocal(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? '').hostname;
    return LOCAL_HOSTS.includes(host) || /^supabase_kong_[a-z0-9_-]+$/.test(host);
  } catch {
    return false;
  }
}

// The default secret key from a SUPABASE_SECRET_KEYS-shaped value, or null
// if it is missing or malformed.
function defaultSecretKey(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const value = (JSON.parse(json) as Record<string, unknown>)?.default;
    return typeof value === 'string' && SECRET_KEY_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function resolveServiceKey(env: Env = Deno.env): ServiceKey {
  const local = isLocal(env.get('SUPABASE_URL'));
  const secretIgnored = local && env.get('CACHECASE_LOCAL_DISABLE_SECRET_KEYS') === '1';
  const platformSecret = secretIgnored ? null : defaultSecretKey(env.get('SUPABASE_SECRET_KEYS'));
  if (platformSecret) return { key: platformSecret, kind: 'secret', source: 'SUPABASE_SECRET_KEYS' };
  const localSecret = local ? defaultSecretKey(env.get('CACHECASE_LOCAL_SECRET_KEYS')) : null;
  if (localSecret) return { key: localSecret, kind: 'secret', source: 'CACHECASE_LOCAL_SECRET_KEYS' };

  const legacyIgnored = local && env.get('CACHECASE_LOCAL_DISABLE_LEGACY_KEY') === '1';
  const legacy = legacyIgnored ? '' : (env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (JWT_RE.test(legacy)) return { key: legacy, kind: 'legacy_jwt', source: 'SUPABASE_SERVICE_ROLE_KEY' };
  if (SECRET_KEY_RE.test(legacy)) return { key: legacy, kind: 'secret', source: 'SUPABASE_SERVICE_ROLE_KEY' };
  throw new ServiceKeyUnavailable();
}

// resolveServiceKey() without throwing: null when no usable key exists.
export function tryResolveServiceKey(env: Env = Deno.env): ServiceKey | null {
  try {
    return resolveServiceKey(env);
  } catch {
    return null;
  }
}

// Headers for raw Storage API / TUS requests made with the server key.
export function storageAuthHeaders(serviceKey: ServiceKey): Record<string, string> {
  return serviceKey.kind === 'legacy_jwt'
    ? { apikey: serviceKey.key, Authorization: `Bearer ${serviceKey.key}` }
    : { apikey: serviceKey.key };
}

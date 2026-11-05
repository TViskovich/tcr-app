// Unit tests for the server key resolver. Run (no network, no Supabase):
//   deno test supabase/functions/_shared/service-key.test.ts
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';

import { resolveServiceKey, ServiceKeyUnavailable, storageAuthHeaders, tryResolveServiceKey } from './service-key.ts';

const SECRET = 'sb_secret_TEST0000000000000000000000';
const SECRET_2 = 'sb_secret_OTHER111111111111111111111';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
const HOSTED = 'https://abcdefghijklmnopqrst.supabase.co';
const LOCAL = 'http://kong:8000';
const env = (vars: Record<string, string | undefined>) => ({ get: (name: string) => vars[name] });

Deno.test('prefers the default secret key from SUPABASE_SECRET_KEYS', () => {
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET, billing: SECRET_2 }), SUPABASE_SERVICE_ROLE_KEY: JWT })),
    { key: SECRET, kind: 'secret', source: 'SUPABASE_SECRET_KEYS' });
});

Deno.test('falls back to the legacy service-role JWT', () => {
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, SUPABASE_SERVICE_ROLE_KEY: JWT })), { key: JWT, kind: 'legacy_jwt', source: 'SUPABASE_SERVICE_ROLE_KEY' });
});

Deno.test('malformed SUPABASE_SECRET_KEYS falls back to the legacy key', () => {
  for (const bad of ['{oops', '[]', '{}', JSON.stringify({ default: 'not-a-key' }), JSON.stringify({ default: 42 }), JSON.stringify({ billing: SECRET })]) {
    assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, SUPABASE_SECRET_KEYS: bad, SUPABASE_SERVICE_ROLE_KEY: JWT })).kind, 'legacy_jwt', bad);
  }
});

Deno.test('a remapped SUPABASE_SERVICE_ROLE_KEY holding a secret key is used as a secret key', () => {
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, SUPABASE_SERVICE_ROLE_KEY: SECRET })), { key: SECRET, kind: 'secret', source: 'SUPABASE_SERVICE_ROLE_KEY' });
});

Deno.test('no usable key: fails closed, without the value in the error', () => {
  for (const vars of [{} as Record<string, string>, { SUPABASE_SERVICE_ROLE_KEY: '' }, { SUPABASE_SERVICE_ROLE_KEY: 'garbage-value' },
    { SUPABASE_SECRET_KEYS: '{oops', SUPABASE_SERVICE_ROLE_KEY: 'not.a.jwt!' }, { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_ABCDEFGHIJKLMNOP' }]) {
    const err = assertThrows(() => resolveServiceKey(env({ SUPABASE_URL: HOSTED, ...vars })), ServiceKeyUnavailable);
    assertEquals(err.message, 'server_key_unavailable');
    assertEquals(tryResolveServiceKey(env({ SUPABASE_URL: HOSTED, ...vars })), null);
  }
});

Deno.test('local test overrides work only against a local stack', () => {
  const overrides = { CACHECASE_LOCAL_SECRET_KEYS: JSON.stringify({ default: SECRET }), CACHECASE_LOCAL_DISABLE_LEGACY_KEY: '1', SUPABASE_SERVICE_ROLE_KEY: JWT };
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: LOCAL, ...overrides })), { key: SECRET, kind: 'secret', source: 'CACHECASE_LOCAL_SECRET_KEYS' });
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: 'http://127.0.0.1:54321', ...overrides })).kind, 'secret');
  // Hosted: both overrides are ignored.
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, ...overrides })), { key: JWT, kind: 'legacy_jwt', source: 'SUPABASE_SERVICE_ROLE_KEY' });
  assertThrows(() => resolveServiceKey(env({ SUPABASE_URL: LOCAL, CACHECASE_LOCAL_DISABLE_LEGACY_KEY: '1', SUPABASE_SERVICE_ROLE_KEY: JWT })), ServiceKeyUnavailable);
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: 'https://kong.example.com', CACHECASE_LOCAL_DISABLE_LEGACY_KEY: '1', SUPABASE_SERVICE_ROLE_KEY: JWT })).kind, 'legacy_jwt');
});

Deno.test('local switch to ignore the platform secret key (legacy-path testing), never on hosted', () => {
  const vars = { SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), SUPABASE_SERVICE_ROLE_KEY: JWT, CACHECASE_LOCAL_DISABLE_SECRET_KEYS: '1' };
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: LOCAL, ...vars })).source, 'SUPABASE_SERVICE_ROLE_KEY');
  assertEquals(resolveServiceKey(env({ SUPABASE_URL: HOSTED, ...vars })).source, 'SUPABASE_SECRET_KEYS');
  assertThrows(() => resolveServiceKey(env({ SUPABASE_URL: LOCAL, ...vars, CACHECASE_LOCAL_DISABLE_LEGACY_KEY: '1' })), ServiceKeyUnavailable);
});

Deno.test('Storage headers: apikey always; Bearer only for a legacy JWT', () => {
  assertEquals(storageAuthHeaders({ key: SECRET, kind: 'secret', source: 'SUPABASE_SECRET_KEYS' }), { apikey: SECRET });
  assertEquals(storageAuthHeaders({ key: JWT, kind: 'legacy_jwt', source: 'SUPABASE_SERVICE_ROLE_KEY' }), { apikey: JWT, Authorization: `Bearer ${JWT}` });
});

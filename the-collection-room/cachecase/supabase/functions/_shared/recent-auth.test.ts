// Unit tests for signedInRecently (password-only recent sign-in).
// Run: deno test --no-lock --allow-env=ACCOUNT_RECENT_AUTH_SECONDS supabase/functions/_shared/recent-auth.test.ts
// ACCOUNT_RECENT_AUTH_SECONDS is unset here, so the window is the product
// rule: 10 minutes.
import { assertEquals } from 'jsr:@std/assert@1';

import { RECENT_AUTH_SECONDS, signedInRecently } from './recent-auth.ts';

const b64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// A token-shaped string with the given claims (signature irrelevant: the
// helper only reads claims of a token auth.getUser has already verified).
const token = (claims: unknown) => `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const amr = (...entries: unknown[]) => token({ sub: 'u', amr: entries });

Deno.test('window is the 10-minute product rule', () => {
  assertEquals(RECENT_AUTH_SECONDS, 600);
});

Deno.test('recent password sign-in succeeds', () => {
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() - 5 })), true);
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() - 599 })), true);
});

Deno.test('OTP-only recovery session fails, however recent', () => {
  assertEquals(signedInRecently(amr({ method: 'otp', timestamp: now() })), false);
  assertEquals(signedInRecently(amr({ method: 'recovery', timestamp: now() })), false);
});

Deno.test('old password sign-in plus recent OTP fails', () => {
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() - 3600 }, { method: 'otp', timestamp: now() - 1 })), false);
});

Deno.test('recent password sign-in plus older OTP succeeds', () => {
  assertEquals(signedInRecently(amr({ method: 'otp', timestamp: now() - 3600 }, { method: 'password', timestamp: now() - 10 })), true);
});

Deno.test('other and unknown methods never count', () => {
  for (const method of ['anonymous', 'magiclink', 'email/signup', 'invite', 'totp', 'oauth', 'sso/saml', 'PASSWORD', ' password', '', undefined]) {
    assertEquals(signedInRecently(amr({ method, timestamp: now() })), false, String(method));
  }
});

Deno.test('missing or empty amr fails', () => {
  assertEquals(signedInRecently(token({ sub: 'u' })), false);
  assertEquals(signedInRecently(token({ sub: 'u', amr: [] })), false);
  assertEquals(signedInRecently(token({ sub: 'u', amr: null })), false);
  assertEquals(signedInRecently(token({ sub: 'u', amr: { method: 'password', timestamp: now() } })), false); // not an array
});

Deno.test('malformed claim entries fail safely', () => {
  for (const entry of [null, 42, 'password', [], { method: 'password' }, { method: 'password', timestamp: 'now' },
    { method: 'password', timestamp: null }, { method: 'password', timestamp: Number.NaN }, { method: 'password', timestamp: 0 },
    { method: 'password', timestamp: -5 }, { method: 'password', timestamp: Infinity }, { method: ['password'], timestamp: now() }]) {
    assertEquals(signedInRecently(amr(entry)), false, JSON.stringify(entry));
  }
  // One good password entry among malformed ones still counts.
  assertEquals(signedInRecently(amr(null, { method: 'password', timestamp: 'x' }, { method: 'password', timestamp: now() - 3 })), true);
});

Deno.test('malformed tokens fail safely', () => {
  for (const t of ['', 'not-a-jwt', 'a.b', 'a.%%%.c', `${b64url('{}')}.${b64url('not json')}.s`, `x.${b64url('null')}.s`, `x.${b64url('42')}.s`]) {
    assertEquals(signedInRecently(t), false, t);
  }
});

Deno.test('future timestamps: within the 60 s skew allowance succeed, beyond it fail', () => {
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() + 30 })), true);
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() + 59 })), true);
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() + 120 })), false);
});

Deno.test('expired password sign-in fails', () => {
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() - 601 })), false);
  assertEquals(signedInRecently(amr({ method: 'password', timestamp: now() - 86400 })), false);
});

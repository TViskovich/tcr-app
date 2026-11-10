// Unit tests for the invite endpoints' password rule (validPassword).
// Run: deno test --no-lock supabase/functions/_shared/waitlist-invite.test.ts
import { assertEquals } from 'jsr:@std/assert@1';

import { passwordProblem } from '../../../lib/password-policy.ts';
import { validPassword } from './waitlist-invite.ts';

const bytes = (s: string) => new TextEncoder().encode(s).length;

Deno.test('7 characters fail, 8 succeed', () => {
  assertEquals(validPassword('Abcdef1'), false);
  assertEquals(validPassword('Abcdef12'), true);
  assertEquals(validPassword('short'), false);
  assertEquals(validPassword('123456'), false); // the old 6-character minimum
});

Deno.test('72 bytes succeed, 73 fail (ASCII)', () => {
  assertEquals(validPassword('a'.repeat(72)), true);
  assertEquals(validPassword('a'.repeat(73)), false);
});

Deno.test('the maximum counts UTF-8 bytes, not characters', () => {
  const euro24 = '€'.repeat(24); // 24 characters, 72 bytes
  assertEquals([euro24.length, bytes(euro24)], [24, 72]);
  assertEquals(validPassword(euro24), true);
  const euro25 = '€'.repeat(25); // 25 characters, 75 bytes
  assertEquals(validPassword(euro25), false);
  const accented = 'é'.repeat(37); // 37 characters, 74 bytes: passed the old character limit
  assertEquals(validPassword(accented), false);
  const mixed = 'é'.repeat(36) + 'a'; // 37 characters, 73 bytes
  assertEquals(bytes(mixed), 73);
  assertEquals(validPassword(mixed), false);
  assertEquals(validPassword('é'.repeat(36)), true); // 72 bytes
});

Deno.test('multibyte minimum is counted as the app counts it', () => {
  assertEquals(validPassword('ééééééé'), false); // 7 characters (14 bytes)
  assertEquals(validPassword('éééééééé'), true); // 8 characters
  assertEquals(validPassword('🔒🔒🔒🔒'), true); // 4 emoji = 8 UTF-16 units, as the app's length check sees it
  assertEquals(validPassword('🔒🔒🔒'), false); // 6 units
  assertEquals(validPassword('🔒'.repeat(18)), true); // 72 bytes
  assertEquals(validPassword('🔒'.repeat(18) + 'a'), false); // 73 bytes
});

Deno.test('normal passwords succeed', () => {
  for (const p of ['correct horse battery', 'Collector-2026!', 'p@ssw0rd-CacheCase', 'Ünïcødé-Pässwörd']) {
    assertEquals(validPassword(p), true, p);
  }
});

Deno.test('non-strings fail', () => {
  for (const v of [undefined, null, 12345678, ['abcdefgh'], { p: 'abcdefgh' }, true]) {
    assertEquals(validPassword(v), false, String(v));
  }
});

Deno.test('all-whitespace passwords fail, whatever the whitespace', () => {
  for (const p of [' '.repeat(8), ' '.repeat(72), '\t'.repeat(8), '\n'.repeat(8), ' \t\r\n \t\r\n',
    '\u00a0'.repeat(8), '\u3000'.repeat(8), '\u2003'.repeat(8), '\ufeff'.repeat(8)]) {
    assertEquals(validPassword(p), false, JSON.stringify(p));
  }
});

Deno.test('passwords containing spaces still succeed', () => {
  for (const p of ['correct horse battery', ' padded pass ', '        x', 'x        ', 'a b c d e', '\u00a0secret\u00a0phrase']) {
    assertEquals(validPassword(p), true, JSON.stringify(p));
  }
});

Deno.test('agrees with the app (lib/password-policy.ts) on every case', () => {
  const cases = ['', 'Abcdef1', 'Abcdef12', 'a'.repeat(72), 'a'.repeat(73), '€'.repeat(24), '€'.repeat(25),
    'é'.repeat(36), 'é'.repeat(37), '🔒🔒🔒🔒', '🔒🔒🔒', 'Collector-2026!', ' padded pass ', ' '.repeat(8), ' '.repeat(73),
    '\t'.repeat(8), '\u00a0'.repeat(8), '\u3000'.repeat(8), '        x', 'correct horse battery'];
  for (const p of cases) assertEquals(validPassword(p), passwordProblem(p) === null, JSON.stringify(p));
});

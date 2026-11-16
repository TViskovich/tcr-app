// Unit tests for the item-image-cleanup worker's decision logic. Run (no
// network, no Supabase):  deno test supabase/functions/_shared/item-image-cleanup.test.ts
import { assertEquals } from 'jsr:@std/assert@1';

import {
  asCompletionOutcome,
  completionCode,
  isSafeItemImagePath,
  LEASE_SECONDS,
  parseFault,
  pastDeadline,
  removablePaths,
  REMOVE_DEADLINE_MS,
  tally,
  withTimeout,
  type ClaimedDeletion,
} from './item-image-cleanup.ts';

const U = '00000000-0000-4000-8000-0000ce000001';
const c = (id: number, path: string): ClaimedDeletion => ({ id, path, claim_token: `t${id}` });

Deno.test('safe paths: owner-namespaced and relative only', () => {
  for (const ok of [`${U}/item/1.jpg`, `${U}/covers/c.png`, `${U}/1788.jpg`]) assertEquals(isSafeItemImagePath(ok), true, ok);
  for (const bad of ['', '/x', `${U}/../x.jpg`, `${U}//x.jpg`, `${U}\\x.jpg`, `${U}/x\0.jpg`, 'notauuid/x.jpg', U, `${U}/`, 42, null]) {
    assertEquals(isSafeItemImagePath(bad), false, String(bad));
  }
});

Deno.test('a failed hold check removes nothing', () => {
  assertEquals(removablePaths([c(1, `${U}/a/1.jpg`)], null), []);
});

Deno.test('held paths and unsafe paths are never sent to Storage', () => {
  const claims = [c(1, `${U}/a/1.jpg`), c(2, `${U}/a/2.jpg`), c(3, '../evil.jpg')];
  assertEquals(removablePaths(claims, [`${U}/a/1.jpg`, '../evil.jpg']), [`${U}/a/1.jpg`]);
});

Deno.test('completion codes', () => {
  const a = c(1, `${U}/a/1.jpg`);
  assertEquals(completionCode(a, [a.path], [a.path], false), null);
  assertEquals(completionCode(a, [a.path], [a.path], true), 'storage_error');
  assertEquals(completionCode(a, [], [], false), 'held');
  assertEquals(completionCode(a, null, [], false), 'held_check_failed');
  assertEquals(completionCode(c(2, '../x'), [], [], false), 'invalid_path');
});

Deno.test('outcomes: unknown answers are counted as complete_failed', () => {
  const o = {};
  tally(o, asCompletionOutcome('deleted'));
  tally(o, asCompletionOutcome('deleted'));
  tally(o, asCompletionOutcome('retry'));
  tally(o, asCompletionOutcome(undefined));
  assertEquals(o, { deleted: 2, retry: 1, complete_failed: 1 });
});

Deno.test('F1: the lease outlives any Edge Function run, and removal stops well before it', () => {
  assertEquals(LEASE_SECONDS >= 600, true);
  assertEquals(REMOVE_DEADLINE_MS < (LEASE_SECONDS * 1000) / 2, true);
});

Deno.test('F1: past the deadline nothing is sent to Storage and the claim completes as lease_deadline', () => {
  const t0 = 1_000_000;
  assertEquals(pastDeadline(t0, t0 + REMOVE_DEADLINE_MS), false);
  assertEquals(pastDeadline(t0, t0 + REMOVE_DEADLINE_MS + 1), true);
  const a = c(1, `${U}/a/1.jpg`);
  assertEquals(completionCode(a, [a.path], [], false, true), 'lease_deadline');
});

Deno.test('a stalled Storage call is abandoned after the timeout (reported as a storage error)', async () => {
  const never = new Promise<string>(() => {});
  assertEquals(await withTimeout(never, 10), { timedOut: true });
  assertEquals(await withTimeout(Promise.resolve('ok'), 1000), { timedOut: false, value: 'ok' });
});

Deno.test('fault injection is honoured only on a local stack with the switch set', () => {
  assertEquals(parseFault('storage_error', 'http://kong:8000', '1'), 'storage_error');
  assertEquals(parseFault('storage_error', 'http://supabase_kong_cachecase-p23:8000', '1'), 'storage_error');
  assertEquals(parseFault('storage_error', 'https://izlrxenomerfeqhmlyre.supabase.co', '1'), null);
  assertEquals(parseFault('storage_error', 'http://kong:8000', undefined), null);
  assertEquals(parseFault('rm_rf', 'http://kong:8000', '1'), null);
  assertEquals(parseFault(null, 'http://kong:8000', '1'), null);
});

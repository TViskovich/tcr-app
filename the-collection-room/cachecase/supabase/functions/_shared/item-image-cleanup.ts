// Pure decision logic for the item-image-cleanup worker (P2.3 Issue 1). No I/O,
// so it is unit-tested directly (item-image-cleanup.test.ts).
//
// The database decides WHAT may be deleted (item_image_deletion_claim re-checks
// every reference, hold, export and report under the per-path lock) and
// whether a deletion really happened (item_image_deletion_complete checks
// storage.objects). This module only decides which claimed paths the worker
// hands to Storage, and which error code each claim is completed with.

export type ClaimedDeletion = { id: number; path: string; claim_token: string };

export type CompletionCode =
  | null                    // removal attempted without a reported error
  | 'invalid_path'          // never sent to Storage
  | 'held'                  // a moderation hold appeared after the claim
  | 'held_check_failed'     // the hold check itself failed: nothing sent
  | 'lease_deadline'        // too long since the claim: nothing sent (retried later)
  | 'storage_error';        // Storage reported an error (or timed out) for the batch

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Defense in depth on top of the ledger's own CHECKs: an owner-namespaced,
// relative path with no traversal, backslash, NUL or empty segment.
export function isSafeItemImagePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  if (segments.length < 2 || segments.some((s) => s.length === 0)) return false;
  return UUID_SEGMENT.test(segments[0]);
}

// Which claimed paths go to Storage. `notHeld` is withoutHeldPaths' result:
// null means the hold check failed, so NOTHING is removed.
export function removablePaths(claims: ClaimedDeletion[], notHeld: string[] | null): string[] {
  if (notHeld === null) return [];
  const allowed = new Set(notHeld);
  return claims.filter((c) => isSafeItemImagePath(c.path) && allowed.has(c.path)).map((c) => c.path);
}

// The code each claim is completed with. The database still verifies the
// object's absence before anything is marked deleted, so a null code is never
// trusted on its own.
export function completionCode(
  claim: ClaimedDeletion,
  notHeld: string[] | null,
  removed: string[],
  storageFailed: boolean,
  deadlinePassed = false,
): CompletionCode {
  if (!isSafeItemImagePath(claim.path)) return 'invalid_path';
  if (deadlinePassed) return 'lease_deadline';
  if (notHeld === null) return 'held_check_failed';
  if (!removed.includes(claim.path)) return 'held';
  return storageFailed ? 'storage_error' : null;
}

export type CompletionOutcome = 'deleted' | 'retry' | 'failed' | 'stale_claim' | 'complete_failed';

export function tally(outcomes: Partial<Record<CompletionOutcome, number>>, outcome: CompletionOutcome): void {
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
}

export function asCompletionOutcome(value: unknown): CompletionOutcome {
  return value === 'deleted' || value === 'retry' || value === 'failed' || value === 'stale_claim' ? value : 'complete_failed';
}

// ── Timing (P2.3 review F1) ─────────────────────────────────────────────────
// NOT what makes deletion safe: the database refuses every new reference to an
// object once it has been claimed (condemned), so a removal landing at any
// later time is harmless. These bounds only keep a run short and avoid
// pointless duplicate work: the lease (600 s) outlives any Edge Function run,
// and nothing is sent to Storage more than 240 s after the claim.
export const LEASE_SECONDS = 600;
export const REMOVE_DEADLINE_MS = 240_000;
export const STORAGE_TIMEOUT_MS = 30_000;

export function pastDeadline(claimedAtMs: number, nowMs: number, deadlineMs = REMOVE_DEADLINE_MS): boolean {
  return nowMs - claimedAtMs > deadlineMs;
}

// Resolves to the call's result, or to { timedOut: true } after `ms`. A
// timed-out request may still complete at Storage later — safe, see above.
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Local-only fault injection (never on a hosted project): the
// x-cachecase-local-fault header, honoured only when SUPABASE_URL is a local
// stack AND CACHECASE_TEST_IIC_FAULTS=1.
export const FAULTS = new Set(['storage_error', 'deadline_exceeded', 'crash_after_remove']);
export type Fault = 'storage_error' | 'deadline_exceeded' | 'crash_after_remove';

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === 'kong' || /^supabase_kong_[a-z0-9_-]+$/.test(host);
  } catch {
    return false;
  }
}

export function parseFault(header: string | null, supabaseUrl: string | undefined, enabled: string | undefined): Fault | null {
  if (!isLocalUrl(supabaseUrl) || enabled !== '1' || !header) return null;
  return FAULTS.has(header) ? (header as Fault) : null;
}

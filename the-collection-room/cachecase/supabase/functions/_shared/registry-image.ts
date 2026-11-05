// Shared helpers for the registry durable-image Edge Functions
// (copy-registry-snapshot-image, get-registry-snapshot-image-url).
// Deliberately minimal — CORS, JSON responses, JWT/caller resolution,
// controlled error codes, and the service-role client factory only.
//
// The privileged key (SUPABASE_SECRET_KEYS' default secret key, or the
// legacy SUPABASE_SERVICE_ROLE_KEY) is resolved by _shared/service-key.ts from
// the platform-provided environment and never appears in any committed file,
// the Expo app bundle, or a client response.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { resolveServiceKey } from './service-key.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  return null;
}

// Controlled error codes only — never a raw exception message, URL, token,
// or Storage SDK response is persisted to registered_cards or returned to
// the client. state_changed covers copy-registry-snapshot-image's
// race-safe conditional-update rejection (ownership or linkage changed
// mid-copy).
export type SnapshotImageErrorCode =
  | 'source_missing'
  | 'source_unauthorized'
  | 'invalid_type'
  | 'file_too_large'
  | 'download_failed'
  | 'upload_failed'
  | 'database_update_failed'
  | 'state_changed';

// A privileged (RLS-bypassing) client, keyed by the shared resolver
// (_shared/service-key.ts): the default secret API key, or the legacy
// service-role JWT during the transition. Throws (fails closed) when no
// usable key is configured; the key itself never appears in the error.
export function serviceRoleClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Edge Function misconfigured: missing SUPABASE_URL');
  const { key } = resolveServiceKey();
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Distinguishes the three caller states required by the anonymous-access
// design:
//   - no Authorization header at all      -> { userId: null, invalid: false }
//   - a present but invalid/expired JWT   -> { userId: null, invalid: true }
//   - a valid JWT                         -> { userId: <uid>, invalid: false }
//   - a valid JWT for an account that is pending deletion or being deleted
//                                         -> { userId: null, invalid: true, inactive: true }
// Callers MUST reject invalid:true outright — never silently treat an
// invalid/expired token the same as "no token provided."
//
// The inactive case matters because these functions use the service role,
// which bypasses the database's own account-lifecycle guards
// (supabase/migrations/20261103120000_add_account_lifecycle.sql): every
// function that resolves its caller here therefore refuses a hidden
// collector, for reads and writes alike.
export async function resolveCaller(
  client: SupabaseClient,
  req: Request,
): Promise<{ userId: string | null; invalid: boolean; inactive?: boolean }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return { userId: null, invalid: false };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { userId: null, invalid: false };
  }

  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    return { userId: null, invalid: true };
  }

  const hidden = await hiddenAccountIds(client, [data.user.id]);
  if (hidden === null) {
    return { userId: null, invalid: true }; // fail closed on a lookup error
  }
  if (hidden.has(data.user.id)) {
    return { userId: null, invalid: true, inactive: true };
  }

  return { userId: data.user.id, invalid: false };
}

// Which of `userIds` are pending deletion or being deleted (rows in
// account_lifecycle). Needs the service-role client. null = the lookup
// failed and the caller must fail closed. A database without the lifecycle
// migration has no hidden accounts, so it reports none.
export async function hiddenAccountIds(client: SupabaseClient, userIds: string[]): Promise<Set<string> | null> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await client.from('account_lifecycle').select('user_id').in('user_id', userIds);
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return new Set();
    console.error('[hiddenAccountIds] lookup failed:', error.code);
    return null;
  }
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

// Mirrors registered_cards_select_visible's RLS condition exactly. Kept in
// sync deliberately rather than shared with the database layer (Edge
// Functions and Postgres policies can't share code directly), matching
// this app's established per-module duplication convention for
// RLS-mirroring logic (see app/registry/[id].tsx's own comments).
export function canViewRegisteredCard(
  record: { visibility: string; current_owner_id: string | null; created_by: string | null },
  callerId: string | null,
): boolean {
  if (record.visibility === 'public') return true;
  if (!callerId) return false;
  return callerId === record.current_owner_id || callerId === record.created_by;
}

// HEIC/HEIF added (post-photo copy-pipeline investigation) — a library
// pick with allowsEditing:false (app/post/new.tsx's Choose from Library,
// and item/new.tsx before it) returns the SOURCE asset's own format
// as-is, never force-converting it. On iOS, "High Efficiency" has been
// the default camera capture format since iPhone 7 (iOS 11+), so an
// unedited library selection is routinely HEIC, not JPEG — this
// allowlist rejecting it (extension undefined -> copy fails as
// 'unavailable') was a real, reachable gap, not a hypothetical one.
// Safe to serve publicly from share-snapshots: every consumer of a
// share-snapshots URL in this app is expo-image (post-card.tsx,
// attachment-image-grid.tsx) — never a plain web <img> or the public-web
// Next.js surface (verified: that surface only ever reads from the
// separate registry-images bucket, never share-snapshots or posts at
// all) — and expo-image decodes HEIC/HEIF natively on iOS (ImageIO) and
// via platform HEIF support on Android 8+.
export const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// Validates a raw storage path value before it is ever used in a Storage
// API call. Applied to BOTH: (a) collection_item_images.storage_path — a
// direct database column value, never assumed safe merely because it was
// fetched server-side rather than supplied by the client — and (b) the
// decoded result of parseItemImagesStoragePath below (defense in depth,
// shared validation logic rather than duplicated). Rejects anything that
// isn't a plain, single-level-relative "{segment}/{segment}/..." path:
// empty, a leading slash, '..', backslashes, a null byte, or any empty
// slash-separated segment. Every real upload path this app produces
// (lib/item-images.ts, lib/storage.ts) is {userId}/[...]/{filename} —
// never any of the above.
export function validateItemImagesStoragePath(path: string): string | null {
  if (!path) return null;
  if (path.startsWith('/')) return null;
  if (path.includes('..')) return null;
  if (path.includes('\\')) return null;
  if (path.includes('\0')) return null;
  if (path.split('/').some((segment) => segment.length === 0)) return null;
  return path;
}

// Strictly constrained to THIS project's own public item-images bucket —
// the only URL shape the trusted-source resolver in
// copy-registry-snapshot-image will ever accept. Never matches any other
// domain, bucket, or path. Returns null (never guesses) for anything else.
//
// Validation happens on the DECODED path, not the raw encoded remainder —
// checking an encoded string for '..' before decoding it is unsafe, since
// an encoded traversal sequence (e.g. %2e%2e%2f) contains no literal '..'
// until after decodeURIComponent runs. Only a single decode pass is
// performed, matching how these URLs are actually produced by
// supabase.storage.from(...).getPublicUrl() (single-encoded); a value
// that only becomes dangerous after a second decode pass is out of scope
// here and would still be caught by this same check once decoded once,
// in the overwhelming majority of real cases.
export function parseItemImagesStoragePath(url: string, projectUrl: string): string | null {
  const marker = `${projectUrl}/storage/v1/object/public/item-images/`;
  if (!url.startsWith(marker)) return null;

  const encodedRemainder = url.slice(marker.length);
  if (!encodedRemainder) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedRemainder);
  } catch {
    return null;
  }

  return validateItemImagesStoragePath(decoded);
}

// Same shape/rationale as parseItemImagesStoragePath above, for the
// share-snapshots bucket instead (POST DELETION beta blocker —
// delete-post's own storage cleanup step). Strictly constrained to THIS
// project's own public share-snapshots bucket; returns null (never
// guesses) for anything else, including a still-unmigrated item-images
// URL — delete-post relies on that null to skip such a value entirely
// rather than ever attempting to delete from item-images.
export function parseShareSnapshotsStoragePath(url: string, projectUrl: string): string | null {
  const marker = `${projectUrl}/storage/v1/object/public/share-snapshots/`;
  if (!url.startsWith(marker)) return null;

  const encodedRemainder = url.slice(marker.length);
  if (!encodedRemainder) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedRemainder);
  } catch {
    return null;
  }

  return validateItemImagesStoragePath(decoded);
}

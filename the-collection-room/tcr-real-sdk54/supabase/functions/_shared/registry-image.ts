// Shared helpers for the registry durable-image Edge Functions
// (copy-registry-snapshot-image, get-registry-snapshot-image-url).
// Deliberately minimal — CORS, JSON responses, JWT/caller resolution,
// controlled error codes, and the service-role client factory only.
//
// SUPABASE_SERVICE_ROLE_KEY is read from Deno.env (an Edge Function
// secret set via `supabase secrets set`) and never appears in any
// committed file, the Expo app bundle, or a client response.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

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

export function serviceRoleClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('Edge Function misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Distinguishes the three caller states required by the anonymous-access
// design:
//   - no Authorization header at all      -> { userId: null, invalid: false }
//   - a present but invalid/expired JWT   -> { userId: null, invalid: true }
//   - a valid JWT                         -> { userId: <uid>, invalid: false }
// Callers MUST reject invalid:true outright — never silently treat an
// invalid/expired token the same as "no token provided."
export async function resolveCaller(
  client: SupabaseClient,
  req: Request,
): Promise<{ userId: string | null; invalid: boolean }> {
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

  return { userId: data.user.id, invalid: false };
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

export const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
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

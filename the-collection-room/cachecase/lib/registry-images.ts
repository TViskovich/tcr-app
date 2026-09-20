import { supabase } from './supabase';
import type { RegistrySnapshotImageErrorCode } from '@/types';

export type CopyRegistrySnapshotImageResult =
  | { status: 'ready' }
  | { status: 'unavailable' }
  | { status: 'failed'; error_code?: RegistrySnapshotImageErrorCode };

// Best-effort — callers should treat every outcome (including 'failed') as
// non-fatal to whatever triggered it. supabase.functions.invoke attaches
// the current session's access token automatically; this function never
// touches the service-role key, which lives only in the Edge Function's
// own server-side secrets.
export async function copyRegistrySnapshotImage(
  registeredCardId: string,
): Promise<CopyRegistrySnapshotImageResult> {
  const { data, error } = await supabase.functions.invoke('copy-registry-snapshot-image', {
    body: { registered_card_id: registeredCardId },
  });

  if (error) {
    return { status: 'failed' };
  }

  return data as CopyRegistrySnapshotImageResult;
}

export type GetRegistrySnapshotImageUrlResult =
  | { status: 'ok'; signed_url: string; expires_in: number }
  | { status: 'unavailable' };

// Works for unauthenticated callers (public registry records) since the
// Edge Function itself is deployed with gateway JWT verification disabled
// and enforces visibility internally — see
// supabase/functions/get-registry-snapshot-image-url/index.ts. The
// returned signed_url is short-lived and must never be persisted (stored
// in state that outlives this call, written to a table, cached to disk) —
// callers should use it immediately as an <Image> source and discard it.
export async function getRegistrySnapshotImageUrl(
  registeredCardId: string,
): Promise<GetRegistrySnapshotImageUrlResult> {
  const { data, error } = await supabase.functions.invoke('get-registry-snapshot-image-url', {
    body: { registered_card_id: registeredCardId },
  });

  if (error) {
    return { status: 'unavailable' };
  }

  return data as GetRegistrySnapshotImageUrlResult;
}

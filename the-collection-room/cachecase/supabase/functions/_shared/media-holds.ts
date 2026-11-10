// Phase 2B M2.3b (supabase/migrations/20261119120000_media_quarantine_
// foundation.sql): Storage objects held for moderation quarantine are evidence.
// The service role bypasses the Storage guards that stop collectors deleting
// them, so every service-role cleanup path must filter them out itself.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

// The subset of `paths` in `bucket` that may be deleted (i.e. not held), or
// null if the check itself failed — callers must then delete nothing.
export async function withoutHeldPaths(
  client: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const { data, error } = await client.rpc('storage_paths_held', { p_bucket: bucket, p_paths: paths });
  if (error) {
    console.error('[withoutHeldPaths] held-path check failed:', error.code);
    return null;
  }
  const held = new Set((data ?? []) as string[]);
  if (held.size) console.log('[withoutHeldPaths] keeping held objects:', held.size);
  return paths.filter((p) => !held.has(p));
}

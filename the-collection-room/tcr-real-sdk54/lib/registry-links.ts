// Single source of truth for the public CacheCase Registry URL — nothing
// else in the app should construct this domain/path directly. Follows this
// project's existing EXPO_PUBLIC_* env-var convention (see
// EXPO_PUBLIC_SUPABASE_URL in lib/supabase.ts) so a real domain can be
// supplied later without touching any call site.
//
// No fallback domain is used here on purpose. Until
// EXPO_PUBLIC_CACHECASE_BASE_URL is actually configured, the public
// registry URL is unavailable.
export const CACHECASE_PUBLIC_BASE_URL: string | null =
  process.env.EXPO_PUBLIC_CACHECASE_BASE_URL?.trim().replace(/\/+$/, '') || null;

// Builds the public registry URL for a given CC ID.
// Only pass the public cc_id, never an internal database identifier.
export function getRegistryPublicUrl(ccId: string): string | null {
  const trimmedId = ccId.trim();

  if (!CACHECASE_PUBLIC_BASE_URL || !trimmedId) {
    return null;
  }

  return `${CACHECASE_PUBLIC_BASE_URL}/registry/${encodeURIComponent(trimmedId)}`;
}
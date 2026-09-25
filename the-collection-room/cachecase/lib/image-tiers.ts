// Client-side half of tiered private-image delivery. The client only ever
// names a tier — the actual transform values (width/quality/resize) live in
// supabase/functions/_shared/image-tiers.ts, the single authoritative place,
// so a caller can never request an arbitrary transformation. Deno Edge
// Functions can't import from this app's lib/, which is why the type is
// declared in both places rather than shared.
//
//   preview  ~500px wide,  q80 — feeds, grids, small previews
//   detail   ~1400px wide, q85 — item/post detail, large presentations
//   original no transform      — full-screen/zoom viewer, source-of-truth
//
// 'original' is the default everywhere (see useSignedItemImages), so any
// caller that doesn't opt into a tier behaves exactly as it did before tiers
// existed.
export type ImageTier = 'preview' | 'detail' | 'original';

export const DEFAULT_IMAGE_TIER: ImageTier = 'original';

// Tier for small/compact surfaces (grid cells, thumbnails, compact cards).
// Every such surface uses this one constant for its signed-URL request AND
// its expo-image/warmup cacheKeys, so the three layers can't disagree.
export const COMPACT_IMAGE_TIER: ImageTier = 'preview';

// Suffix used to keep a tier's identity distinct from the same image's other
// tiers in every cache layer (in-memory signed-URL cache, persisted
// AsyncStorage cache, expo-image cacheKey). 'original' deliberately maps to
// NO suffix so every pre-existing cache entry/key (which never had a tier)
// stays valid and unchanged — only the new non-original tiers get a
// distinct identity.
export function imageTierCacheSuffix(tier: ImageTier): string {
  return tier === 'original' ? '' : `:${tier}`;
}

// Server-authoritative image tier definitions for private item-image
// delivery. Clients send only a tier NAME (never width/quality numbers), and
// this file maps it to the approved Supabase Storage transform — so no caller
// can request an arbitrary transformation. The client's mirror of the type
// lives in lib/image-tiers.ts (Deno functions can't import from the app).
//
// Resize choice: width ONLY, resize 'contain', no height. With no height
// there is nothing to crop or letterbox — the image is scaled to the target
// width with its aspect ratio (and therefore ALL of its source content)
// intact. Any presentation crop is left to the client (expo-image
// contentFit="cover" inside a fixed-aspect tile). 'cover' would be the
// Storage default but exists to crop when both dimensions are given; being
// explicit with 'contain' guards against a future default change ever
// cropping delivered content. `format` is intentionally omitted so Storage
// serves its optimized modern format (WebP) — smaller bytes, fast decode.

export type ImageTier = 'preview' | 'detail' | 'original';

export type TierTransform = { width: number; quality: number; resize: 'contain' };

export const IMAGE_TIER_TRANSFORMS: Record<Exclude<ImageTier, 'original'>, TierTransform> = {
  preview: { width: 500, quality: 80, resize: 'contain' },
  detail: { width: 1400, quality: 85, resize: 'contain' },
};

// undefined/absent => 'original' (backwards compatible with every existing
// caller, which never sent a tier). Anything present but not a known tier
// returns null so the request can be rejected outright.
export function parseImageTier(value: unknown): ImageTier | null {
  if (value === undefined) return 'original';
  if (value === 'preview' || value === 'detail' || value === 'original') return value;
  return null;
}

// Pure request/response shaping for get-public-item-share — no Deno,
// Supabase or network dependencies, so it can be unit tested on its own
// (share_test.ts). The authorization decision itself is NOT here: it lives
// in resolve_public_item_share's WHERE clause (see the migration), and this
// module only ever sees rows that already passed it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShareAsset = 'metadata' | 'preview_image';

export type ShareRequest = { itemId: string; asset: ShareAsset };

// Request: { item_id: <collection_items.id>, asset?: 'preview_image' }.
// Anything else (missing/non-UUID id, unknown asset, extra shapes) is
// rejected as a whole — never coerced. The result depends only on the
// request's own syntax, never on whether the item exists.
export function parseShareRequest(body: unknown): ShareRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const itemId = typeof b.item_id === 'string' ? b.item_id.trim() : null;
  if (!itemId || !UUID_RE.test(itemId)) return null;
  if (b.asset === undefined || b.asset === 'metadata') return { itemId: itemId.toLowerCase(), asset: 'metadata' };
  if (b.asset === 'preview_image') return { itemId: itemId.toLowerCase(), asset: 'preview_image' };
  return null;
}

// One row of resolve_public_item_share.
export type ResolvedShareRow = {
  item_type: string;
  title: string | null;
  subtitle: string | null;
  owner_username: string | null;
  owner_display_name: string | null;
  image_storage_path: string | null;
};

export type PublicItemShare = {
  item_type: string;
  title: string | null;
  subtitle: string | null;
  owner: { username: string; display_name: string | null } | null;
  has_image: boolean;
};

// Builds the public response from an already-authorized row, field by field
// (never by spreading the row), so the storage path — or any column a later
// change adds to the RPC — can't reach the response by accident. The image
// is only ever referenced as has_image; its bytes are fetched with
// asset: 'preview_image'.
export function toPublicItemShare(row: ResolvedShareRow, imageAvailable: boolean): PublicItemShare {
  return {
    item_type: row.item_type,
    title: row.title,
    subtitle: row.subtitle,
    owner: row.owner_username ? { username: row.owner_username, display_name: row.owner_display_name } : null,
    has_image: imageAvailable,
  };
}

// Image types this endpoint will stream — the ones a browser and a link
// preview can render. HEIC/HEIF originals (allowed at upload) are left out:
// a public web page can't display them, so they are reported as no image.
export const SHAREABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const MAX_SHARE_IMAGE_BYTES = 5 * 1024 * 1024;

// "image/jpeg; charset=binary" -> "image/jpeg"; null when not shareable.
export function shareableImageType(contentType: string | null): string | null {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return SHAREABLE_IMAGE_TYPES.has(mime) ? mime : null;
}

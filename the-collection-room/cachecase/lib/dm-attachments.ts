import type { CollectibleItemType } from '@/types';

import { attachPrimaryImageIds } from '@/lib/item-images';
import { supabase } from '@/lib/supabase';

// DM item attachments (supabase/migrations/
// 20261004120000_add_message_item_attachments.sql). A message stores only
// attachment_type + attachment_item_id — no copied title/image — and every
// render resolves the item LIVE under the viewer's own items_select_public
// RLS. An item the viewer can't see (made private after sending, or
// deleted → attachment_item_id nulled by ON DELETE SET NULL) simply doesn't
// come back from the query and renders as "Item unavailable".

// Single column list for every DM message read/insert-return path (initial
// load, poll, reconcile, own send), so all paths yield the same shape.
export const MESSAGE_COLUMNS =
  'id, sender_id, body, created_at, attachment_type, attachment_item_id, attachment_storage_path, attachment_width, attachment_height';

export type MessageAttachmentType = 'item' | 'image';

export type DmItemPreview = {
  id: string;
  ownerId: string;
  ownerUsername: string | null;
  title: string;
  subtitle: string | null;
  primaryImageId: string | null;
};

export type DmItemPreviewState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; preview: DmItemPreview };

export const ITEM_TYPE_LABEL: Record<CollectibleItemType, string> = {
  sports_card: 'Sports card',
  pokemon: 'Pokémon card',
  figurine: 'Figurine',
  comic_book: 'Comic book',
};

type ItemIdentityFields = {
  item_type: CollectibleItemType | null;
  title: string | null;
  player: string | null;
  year: number | null;
  brand: string | null;
};

type ItemRow = ItemIdentityFields & {
  id: string;
  user_id: string;
};

// Compact identity, aligned with app/item/[id].tsx's buildIdentity for
// sports cards (player → title, "year set" line). Pokémon/comic set lines
// live in per-type detail tables; rather than fan out extra queries per
// attachment, those types fall back to a plain type label. Shared with the
// Share Item picker so the picker tile and the sent card always agree.
// `detail` is buildIdentity's card-title line (the item title when the
// player name is the headline) — shown only where there's room for it.
export function compactItemIdentity(row: ItemIdentityFields): {
  title: string;
  subtitle: string | null;
  detail: string | null;
} {
  if (!row.item_type || row.item_type === 'sports_card') {
    const title = row.player?.trim() || row.title?.trim() || 'Untitled Item';
    const subtitle = [row.year != null ? String(row.year) : null, row.brand].filter(Boolean).join(' ') || null;
    const detail = row.title?.trim() && row.title.trim() !== title ? row.title.trim() : null;
    return { title, subtitle, detail };
  }
  return { title: row.title?.trim() || 'Untitled Item', subtitle: ITEM_TYPE_LABEL[row.item_type] ?? null, detail: null };
}

// Resolves every requested item id in one batched pass. Returns null on a
// query failure (outcome unknown — callers keep showing "loading" and retry
// later rather than wrongly flagging items unavailable). On success, every
// requested id is present: 'ready' if visible, 'unavailable' otherwise.
export async function fetchDmItemPreviews(
  itemIds: string[],
  signal: AbortSignal,
): Promise<Map<string, DmItemPreviewState> | null> {
  const ids = Array.from(new Set(itemIds));
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from('collection_items')
    .select('id, user_id, item_type, title, player, year, brand')
    .in('id', ids)
    .abortSignal(signal);
  if (signal.aborted) return null;
  if (error) {
    if (__DEV__) console.error('[dm-attachments] item lookup failed:', error.message);
    return null;
  }

  const rows = (data ?? []) as ItemRow[];
  const ownerIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const [withImages, ownersRes] = await Promise.all([
    attachPrimaryImageIds(rows),
    ownerIds.length
      ? supabase.from('profiles').select('id, username').in('id', ownerIds).abortSignal(signal)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (signal.aborted) return null;

  const usernameById = new Map(
    ((ownersRes.data ?? []) as { id: string; username: string | null }[]).map((p) => [p.id, p.username]),
  );

  const result = new Map<string, DmItemPreviewState>();
  for (const id of ids) result.set(id, { status: 'unavailable' });
  for (const row of withImages) {
    const { title, subtitle } = compactItemIdentity(row);
    result.set(row.id, {
      status: 'ready',
      preview: {
        id: row.id,
        ownerId: row.user_id,
        ownerUsername: usernameById.get(row.user_id) ?? null,
        title,
        subtitle,
        primaryImageId: row.primary_image_id,
      },
    });
  }
  return result;
}

// The server-side share check (enforce_message_attachment_visibility)
// raises this when the sender or recipient can't view the item.
export function isItemNotShareableError(error: { code?: string; message?: string } | null | undefined) {
  return !!error && error.code === '42501' && !!error.message?.includes('item_not_shareable');
}

// One-line inbox preview for a message row.
export function messagePreviewText(row: { body: string | null; attachment_type?: string | null }) {
  if (row.body) return row.body;
  if (row.attachment_type === 'item') return 'Shared an item';
  if (row.attachment_type === 'image') return 'Sent a photo';
  return null;
}

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addItemImages,
  type AddItemImagesResult,
  getItemImages,
  removeItemImage,
  reorderItemImages,
  setPrimaryItemImage,
} from '@/lib/item-images';
import type { CollectionItemImage } from '@/types';

// Single source of gallery data for an item, shared by both the item-detail
// carousel (view mode) and the gallery manager (edit mode) — both read
// `images` from this same hook instance rather than maintaining separate
// copies. Mutations are optimistic where the new state is cheap to compute
// locally (remove, reorder) and roll back on failure; all of them refresh
// from the server afterward so sort_order/is_primary renumbering done by
// the RPC helpers (see lib/item-images.ts) is always reflected exactly.
// onChanged (optional, P2.3 Issue 4): called after every SUCCESSFUL server
// mutation of this item's photos — the caller uses it to refresh caches that
// derive from the item's primary photo (its folder's first-card / item cover).
export function useItemImages(itemId: string | undefined, onChanged?: () => void) {
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  const notifyChanged = useCallback(() => {
    try {
      onChangedRef.current?.();
    } catch {
      // a cache refresh must never turn a successful mutation into a failure
    }
  }, []);
  const [images, setImages] = useState<CollectionItemImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async () => {
    if (!itemId) {
      setImages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setImages(await getItemImages(itemId));
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addImages = useCallback(
    async (userId: string, uris: string[]): Promise<AddItemImagesResult> => {
      if (!itemId) return { added: [], failed: uris.length };
      setMutating(true);
      try {
        const result = await addItemImages(itemId, userId, uris);
        if (result.added.length) notifyChanged();
        await refresh();
        return result;
      } finally {
        setMutating(false);
      }
    },
    [itemId, refresh, notifyChanged],
  );

  const removeImage = useCallback(
    async (imageId: string) => {
      const prev = images;
      setImages((cur) => cur.filter((img) => img.id !== imageId));
      setMutating(true);
      try {
        await removeItemImage(imageId);
        notifyChanged();
        await refresh();
      } catch (e) {
        setImages(prev);
        throw e;
      } finally {
        setMutating(false);
      }
    },
    [images, refresh, notifyChanged],
  );

  const setPrimary = useCallback(
    async (imageId: string) => {
      if (!itemId) return;
      setMutating(true);
      try {
        await setPrimaryItemImage(itemId, imageId);
        notifyChanged();
        await refresh();
      } finally {
        setMutating(false);
      }
    },
    [itemId, refresh, notifyChanged],
  );

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!itemId) return;
      const prev = images;
      const byId = new Map(images.map((img) => [img.id, img]));
      setImages(
        orderedIds
          .map((id, i) => {
            const img = byId.get(id);
            return img ? { ...img, sort_order: i, is_primary: i === 0 } : null;
          })
          .filter((img): img is CollectionItemImage => img !== null),
      );
      setMutating(true);
      try {
        await reorderItemImages(itemId, orderedIds);
        notifyChanged();
        await refresh();
      } catch (e) {
        setImages(prev);
        throw e;
      } finally {
        setMutating(false);
      }
    },
    [images, itemId, refresh, notifyChanged],
  );

  return { images, loading, mutating, refresh, addImages, removeImage, setPrimary, reorder };
}

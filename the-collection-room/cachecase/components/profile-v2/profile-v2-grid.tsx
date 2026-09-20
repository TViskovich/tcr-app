import { useMemo } from 'react';
import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PrivateImageWarmup } from '@/components/images/private-image-warmup';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';
import type { CollectionItem, Folder, GrailSlot } from '@/types';

import { GrailSlotPreview } from './grail-slot-preview';
import { PV2 } from './profile-v2-theme';

const SLOT_COUNT = 9;
const COLS = 3;

// Exported so profile-v2-identity-card.tsx can align the identity photo's
// left edge to this exact same value, rather than a second, independently
// hardcoded number that could drift out of sync with this one.
export const GRID_HORIZONTAL_MARGIN = 3;
// Exported so horizontal-card-preview.tsx's compact (profile Collection
// tab) row can use this exact same column gap, rather than a second,
// independently hardcoded value that could drift out of sync with this
// one — see that file's own tileWidth/cardGap comments.
export const GRID_GAP = 2;
const GRID_WIDTH = Dimensions.get('window').width - GRID_HORIZONTAL_MARGIN * 2;

// Standard trading-card proportion (2.5in x 3.5in), not a square — must
// match grail-slot-preview.tsx's own CARD_ASPECT_RATIO (styles.slot)
// exactly, since loadingCell (below) is this same grid's own loading-
// state placeholder and needs to occupy the identical shape so nothing
// visibly changes shape once real data replaces it.
const CARD_ASPECT_RATIO = 2.5 / 3.5;

// Three columns of CARD_ASPECT_RATIO cells and two row gaps. Each cell's
// width is GRID_WIDTH's three-way flex split (minus the two horizontal
// gaps between them); its height is that width divided by the card
// ratio. Three such rows plus two row gaps gives the real grid's total
// height — used so the initial-error state reserves the same
// approximate height as the normal loaded/loading grid, and Retry
// succeeding doesn't visibly jump the rest of the profile layout.
// Exported for the same reason as GRID_HORIZONTAL_MARGIN above —
// profile-v2-identity-card.tsx sizes the identity photo to this exact
// value so its right edge lands exactly where the first grid cell's right
// edge does, rather than a second, independently hardcoded width that can
// only coincidentally match on some device widths and drift on others
// (this cell width is a device-width-proportional fraction, not fixed).
export const GRID_CELL_WIDTH = (GRID_WIDTH - GRID_GAP * 2) / COLS;
const GRID_CELL_HEIGHT = GRID_CELL_WIDTH / CARD_ASPECT_RATIO;
const GRID_HEIGHT = GRID_CELL_HEIGHT * 3 + GRID_GAP * 2;

type Props = {
  slots: GrailSlot[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  // Owner-only affordances (empty-slot "+", long-press Replace/Remove) are
  // gated per-slot inside GrailSlotPreview itself — passed through here,
  // not branched on at this level.
  isOwnProfile: boolean;
  onPressEmpty: (slotIndex: number) => void;
  onPressItem: (item: CollectionItem) => void;
  onPressCollection: (collection: Folder) => void;
  onReplace: (slotIndex: number) => void;
  onRemove: (slotIndex: number) => void;
};

export function ProfileV2Grid({
  slots,
  loading,
  error,
  onRetry,
  isOwnProfile,
  onPressEmpty,
  onPressItem,
  onPressCollection,
  onReplace,
  onRemove,
}: Props) {
  // Same identity useSignedItemImages itself keys its cache by — reused
  // here only to build each warmed image's stable expo-image cacheKey
  // (Phase 2/3 of the private-image caching upgrade — see
  // lib/private-image-cache-key.ts). Never a second identity concept.
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';

  // One batched call for the whole 3x3 grid — never one signing request per
  // slot, and never one per collection slot's preview images either
  // (item-images beta privacy hardening, Phase 3C / signed-delivery
  // migration): an item slot contributes its own primary_image_id, a
  // collection slot contributes every id in its previewImageIds, all
  // resolved together in this single call.
  const slotImageIds = slots.flatMap((s) => (s.entry_type === 'item' ? [s.item?.primary_image_id] : (s.previewImageIds ?? [])));
  const { urls: signedImageUrls } = useSignedItemImages(slotImageIds);

  // Warms expo-image's own cache for the whole grid up front, the moment
  // the signing batch resolves — same pattern app/collection/[folderId].tsx
  // already uses for its own hero carousel. Without this, each slot's own
  // <Image> independently triggers its own fetch/decode the instant its
  // URL becomes available, and 9 near-simultaneous but uncoordinated
  // fetches to the same host land at visibly staggered times (connection-
  // pool limits, decode timing, each with its own fade-in) — the grid
  // "feeling ready together" instead of popping in one by one is exactly
  // what a shared prefetch buys, without changing signing (still one
  // batched useSignedItemImages call) or storage/RLS architecture at all.
  //
  // Phase 3: this used to be a plain Image.prefetch(url[]) call, but that
  // API has no cacheKey option in the installed expo-image version — it
  // would only ever populate a cache entry keyed by the URL itself, which
  // GrailSlotPreview (Phase 2) no longer reads from (it reads by stable
  // cacheKey). PrivateImageWarmup below, given the same ids this grid
  // already resolved for signing, mounts hidden <Image>s with the exact
  // {uri, cacheKey} shape the real slots use — genuinely bounded (never
  // more than SLOT_COUNT item ids, plus each collection slot's own small
  // previewImageIds list), never "warm the whole collection."
  const warmupEntries = useMemo(
    () =>
      slotImageIds.flatMap((imageId) => {
        const uri = imageId ? signedImageUrls.get(imageId) : undefined;
        if (!imageId || !uri) return [];
        return [{ id: imageId, uri, cacheKey: itemImageCacheKey(identity, imageId) }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotImageIds.join(','), signedImageUrls, identity],
  );

  // State: initial load failed, nothing loaded yet — never render 9 empty
  // owner-editable "+" slots for a failed query, which would misrepresent
  // an error as "you have no Grails."
  if (!loading && error && slots.length === 0) {
    return (
      <View style={styles.errorState}>
        <Text style={styles.errorTitle}>Couldn&apos;t load Grails</Text>
        <TouchableOpacity style={styles.retryButton} onPress={onRetry} activeOpacity={0.8}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Slot-index-addressed, not positional — a user with only slots 0/3/7
  // filled sees gaps exactly there, not compacted into the first three
  // cells.
  const bySlotIndex = new Map(slots.map((s) => [s.slot_index, s]));
  const grid: (GrailSlot | null)[] = Array.from({ length: SLOT_COUNT }, (_, i) => bySlotIndex.get(i) ?? null);
  const rows: (GrailSlot | null)[][] = [];
  for (let i = 0; i < grid.length; i += COLS) rows.push(grid.slice(i, i + COLS));

  return (
    <View style={styles.grid}>
      {/* Absolutely positioned/invisible (see PrivateImageWarmup itself) —
          never participates in this View's own layout (gap/margin), safe
          as the first child regardless of position. */}
      <PrivateImageWarmup entries={warmupEntries} />
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((slot, colIndex) => {
            const slotIndex = rowIndex * COLS + colIndex;
            // State: loading — every cell renders as a plain,
            // non-interactive box, no "+" at all, regardless of
            // ownership, so nothing flashes "add a Grail" right before
            // real data arrives.
            if (loading) {
              return <View key={`loading-${slotIndex}`} style={styles.loadingCell} />;
            }
            // Real empty state and stale-data-after-a-failed-refresh both
            // fall through to this same render — the grid looks identical
            // either way; a refresh failure only ever shows in the
            // console (see useGrailSlots), never blocks or hides
            // already-loaded slots.
            return (
              <GrailSlotPreview
                key={slot?.id ?? `empty-${slotIndex}`}
                slot={slot}
                slotIndex={slotIndex}
                signedImageUrls={signedImageUrls}
                isOwnProfile={isOwnProfile}
                onPressEmpty={onPressEmpty}
                onPressItem={onPressItem}
                onPressCollection={onPressCollection}
                onReplace={onReplace}
                onRemove={onRemove}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    marginTop: 2,
    gap: GRID_GAP,
  },
  row: {
    flexDirection: 'row',
    gap: GRID_GAP,
  },
  // borderRadius: 0 — kept in sync with grail-slot-preview.tsx's own
  // styles.slot (square, 90°-cornered tiles, matching this file's own
  // "never visibly change shape when data arrives" invariant already
  // applied to CARD_ASPECT_RATIO above).
  loadingCell: {
    flex: 1,
    aspectRatio: CARD_ASPECT_RATIO,
    borderRadius: 0,
    backgroundColor: PV2.emptyCardBg,
  },
  errorState: {
    marginHorizontal: GRID_HORIZONTAL_MARGIN,
    marginTop: 2,
    minHeight: GRID_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});

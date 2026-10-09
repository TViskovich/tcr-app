import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { PrivateImageWarmup } from '@/components/images/private-image-warmup';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
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

// One batched call for the whole 3x3 grid — never one signing request per
// slot, and never one per collection slot's preview images either
// (item-images beta privacy hardening, Phase 3C / signed-delivery
// migration): an item slot contributes its own primary_image_id, a
// collection slot contributes every id in its previewImageIds, all
// resolved together in this single call.
function grailSlotImageIds(slots: GrailSlot[]) {
  return slots.flatMap((s) => (s.entry_type === 'item' ? [s.item?.primary_image_id] : (s.previewImageIds ?? [])));
}

// The grid's one signing call, shared by ProfileV2Grid and
// GrailImagesWarmup so both hit the exact same ids/tier/options — i.e. the
// same shared cache entries and in-flight requests, never a second request.
//
// displayExpiredWhileRefreshing — OWN profile only: on a return after the
// 5-minute signed-URL lifetime, every slot already has its bytes on disk
// under its stable cacheKey, so render those immediately instead of
// waiting ~0.8s for the re-sign (see useSignedItemImages). Safe for the
// owner, who can always see their own images. Never for someone else's
// profile: an image there may have been made private since it was cached,
// so it must wait for a fresh signing answer and stays hidden if that
// answer is 'unavailable'. Every image here is rendered through expo-image
// with the stable cacheKey; nothing fetches or shares these URLs.
function useGrailSlotImages(slots: GrailSlot[], isOwnProfile: boolean) {
  return useSignedItemImages(grailSlotImageIds(slots), COMPACT_IMAGE_TIER, {
    displayExpiredWhileRefreshing: isOwnProfile,
  });
}

// Signs and downloads the Grails grid's preview images as soon as the slot
// rows are known — mounted by the profile screen OUTSIDE its `profile`
// gate, because the grid itself only renders once useProfile has settled
// (the profile row plus six count queries), and signing used to wait for
// that even when the slot rows had already arrived.
//
// Bytes: PrivateImageWarmup mounts hidden <Image>s with the exact
// {uri, cacheKey} shape GrailSlotPreview renders, so expo-image fills the
// entries the real slots read — the moment the signing batch resolves, and
// together rather than nine uncoordinated per-slot fetches popping in one
// by one. (A plain Image.prefetch(url[]) can't be used: it has no cacheKey
// option in the installed expo-image, so it would fill a URL-keyed entry
// the slots never read.) Bounded to the grid's own ids: at most SLOT_COUNT
// item ids plus each collection slot's small previewImageIds list, preview
// tier only.
export function GrailImagesWarmup({ slots, isOwnProfile }: { slots: GrailSlot[]; isOwnProfile: boolean }) {
  // Same identity useSignedItemImages keys its cache by — used only to
  // build the stable cacheKeys (lib/private-image-cache-key.ts).
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const slotImageIds = grailSlotImageIds(slots);
  const { urls: signedImageUrls, servedTiers } = useGrailSlotImages(slots, isOwnProfile);

  // Plain per-render list (a handful of entries) — PrivateImageWarmup keys
  // its hidden images by cacheKey, so a new array identity remounts nothing.
  const warmupEntries = slotImageIds.flatMap((imageId) => {
    const uri = imageId ? signedImageUrls.get(imageId) : undefined;
    if (!imageId || !uri) return [];
    return [{ id: imageId, uri, cacheKey: itemImageCacheKey(identity, imageId, COMPACT_IMAGE_TIER, servedTiers) }];
  });

  return <PrivateImageWarmup entries={warmupEntries} />;
}

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
  // Reorder mode (owner only) — ranked slot ids, in tap order; see
  // GrailSlotPreview.
  reorderMode?: boolean;
  rankedSlotIds?: string[];
  onToggleRank?: (slotId: string) => void;
  onEnterReorder?: () => void;
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
  reorderMode = false,
  rankedSlotIds,
  onToggleRank,
  onEnterReorder,
}: Props) {
  // Same batched, preview-tier call as GrailImagesWarmup (above), which the
  // profile screen mounts before this grid can render — so by the time the
  // grid mounts, these URLs are already in the shared cache or in flight
  // and this call never issues a request of its own.
  const { urls: signedImageUrls, servedTiers } = useGrailSlotImages(slots, isOwnProfile);

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
                servedTiers={servedTiers}
                isOwnProfile={isOwnProfile}
                onPressEmpty={onPressEmpty}
                onPressItem={onPressItem}
                onPressCollection={onPressCollection}
                onReplace={onReplace}
                onRemove={onRemove}
                reorderMode={reorderMode}
                rank={reorderMode && slot && rankedSlotIds ? rankedSlotIds.indexOf(slot.id) + 1 : 0}
                onToggleRank={onToggleRank}
                onEnterReorder={onEnterReorder}
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

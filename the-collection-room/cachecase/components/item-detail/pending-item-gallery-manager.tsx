import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

// A photo the user has picked and run through PhotoAdjuster for a NEW item
// that hasn't been saved yet — no database id, no Storage object, no
// signed URL. adjustedUri is a local file:// path (PhotoAdjuster's own
// manipulateAsync() output) and is what actually gets uploaded on Save;
// originalUri is kept only in case a future pass wants to let the user
// re-open/re-crop a pending photo (unused by this component today).
export type PendingItemPhoto = {
  id: string;
  originalUri: string;
  adjustedUri: string;
  width?: number;
  height?: number;
};

// Same 5:7 trading-card portrait ratio ItemImageGalleryManager uses for its
// own large photo (see that file's own comment for the other places this
// exact ratio is declared) — kept as its own copy rather than a shared
// import, matching this codebase's existing convention for this value.
const LARGE_PHOTO_ASPECT_RATIO = 5 / 7;
const LARGE_PHOTO_WIDTH_FRACTION = 0.64;
const LARGE_PHOTO_RADIUS = 16;

const TILE_WIDTH = 64;
const TILE_ASPECT_RATIO = 5 / 7;
const TILE_RADIUS = 10;

type Props = {
  photos: PendingItemPhoto[];
  coverId: string | null;
  maxImages: number;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onSetCover: (id: string) => void;
};

// Pending-photo sibling of ItemImageGalleryManager (components/item-detail/
// item-image-gallery-manager.tsx) for New Item, before the item — and so
// every one of these photos' real database rows — exists yet. Deliberately
// a separate, smaller component rather than reusing that one directly: it
// assumes a persisted CollectionItemImage[] (real ids, signed URLs via
// useSignedItemImages, is_primary from the DB) which a local, pre-save
// photo simply doesn't have. Visual structure (large preview + nav/cover
// row + thumbnail strip + add tile + count) intentionally mirrors it
// closely so New Item and Edit Item read as the same UI language.
export function PendingItemGalleryManager({ photos, coverId, maxImages, onAdd, onRemove, onSetCover }: Props) {
  const atCapacity = photos.length >= maxImages;
  const { width: windowWidth } = useWindowDimensions();
  const largeWidth = Math.round(windowWidth * LARGE_PHOTO_WIDTH_FRACTION);
  const largeHeight = Math.round(largeWidth / LARGE_PHOTO_ASPECT_RATIO);

  // Same resolution pattern as ItemImageGalleryManager's own
  // resolvedActiveId: an explicit user tap wins while it still points at a
  // photo that still exists, otherwise falls back to the cover (or simply
  // the first photo) — never an effect reconciling a stale id, just
  // re-derived every render.
  const [activeId, setActiveId] = useState<string | null>(null);
  const resolvedActiveId =
    activeId && photos.some((p) => p.id === activeId)
      ? activeId
      : (photos.find((p) => p.id === coverId)?.id ?? photos[0]?.id ?? null);
  const activeIndex = photos.findIndex((p) => p.id === resolvedActiveId);
  const activePhoto = activeIndex >= 0 ? photos[activeIndex] : null;

  function goPrev() {
    if (activeIndex > 0) setActiveId(photos[activeIndex - 1].id);
  }

  function goNext() {
    if (activeIndex >= 0 && activeIndex < photos.length - 1) setActiveId(photos[activeIndex + 1].id);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Photos</Text>
        <Text style={styles.count}>
          {photos.length} / {maxImages}
        </Text>
      </View>

      {photos.length === 0 ? (
        <Pressable
          style={[styles.largeBox, styles.largeAddBox, { width: largeWidth, height: largeHeight }]}
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add photos">
          <IconSymbol name="plus" size={26} color={PV2.textSecondary} />
          <Text style={styles.addLabel}>Add Photos</Text>
        </Pressable>
      ) : (
        <>
          <View style={[styles.largeBox, { width: largeWidth, height: largeHeight }]}>
            {activePhoto ? (
              <Image source={{ uri: activePhoto.adjustedUri }} style={styles.largeImage} contentFit="contain" transition={150} />
            ) : null}

            {activePhoto?.id === coverId ? (
              <View style={styles.coverBadge}>
                <Text style={styles.coverBadgeText}>COVER</Text>
              </View>
            ) : null}

            <Pressable
              style={styles.removeButtonLarge}
              onPress={() => activePhoto && onRemove(activePhoto.id)}
              disabled={!activePhoto}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remove this photo">
              <IconSymbol name="xmark" size={15} color="#fff" />
            </Pressable>
          </View>

          <View style={styles.navRow}>
            <Pressable
              onPress={goPrev}
              disabled={activeIndex <= 0}
              hitSlop={10}
              style={styles.navBtn}
              accessibilityRole="button"
              accessibilityLabel="Previous photo">
              <IconSymbol name="chevron.left" size={18} color={activeIndex <= 0 ? PV2.textTertiary : PV2.textPrimary} />
            </Pressable>

            <Pressable
              onPress={() => activePhoto && activePhoto.id !== coverId && onSetCover(activePhoto.id)}
              disabled={!activePhoto || activePhoto.id === coverId}
              hitSlop={10}
              style={styles.coverToggle}
              accessibilityRole="button"
              accessibilityLabel={activePhoto?.id === coverId ? 'This is the cover photo' : 'Set as cover photo'}>
              <IconSymbol
                name={activePhoto?.id === coverId ? 'star.fill' : 'star'}
                size={15}
                color={activePhoto?.id === coverId ? PV2.accent : PV2.textSecondary}
              />
              <Text style={[styles.coverToggleText, activePhoto?.id === coverId && styles.coverToggleTextActive]}>
                {activePhoto?.id === coverId ? 'Cover' : 'Set as Cover'}
              </Text>
            </Pressable>

            <Pressable
              onPress={goNext}
              disabled={activeIndex < 0 || activeIndex >= photos.length - 1}
              hitSlop={10}
              style={styles.navBtn}
              accessibilityRole="button"
              accessibilityLabel="Next photo">
              <IconSymbol
                name="chevron.right"
                size={18}
                color={activeIndex >= photos.length - 1 ? PV2.textTertiary : PV2.textPrimary}
              />
            </Pressable>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
            {photos.map((photo) => {
              const isActive = photo.id === resolvedActiveId;
              return (
                <Pressable
                  key={photo.id}
                  onPress={() => setActiveId(photo.id)}
                  style={[styles.thumb, isActive && styles.thumbActive]}
                  accessibilityRole="button"
                  accessibilityLabel={photo.id === coverId ? 'Cover photo' : 'Photo'}
                  accessibilityState={{ selected: isActive }}>
                  <Image source={{ uri: photo.adjustedUri }} style={styles.thumbImage} contentFit="cover" transition={150} />
                  {photo.id === coverId && (
                    <View style={styles.thumbCoverDot}>
                      <IconSymbol name="star.fill" size={9} color="#fff" />
                    </View>
                  )}
                </Pressable>
              );
            })}

            {!atCapacity ? (
              <Pressable style={styles.addTile} onPress={onAdd} accessibilityRole="button" accessibilityLabel="Add photos">
                <IconSymbol name="plus" size={18} color={PV2.textSecondary} />
              </Pressable>
            ) : null}
          </ScrollView>

          {atCapacity ? <Text style={styles.capacityNote}>Maximum of {maxImages} photos reached</Text> : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '92%',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  header: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  count: {
    color: PV2.textTertiary,
    fontSize: 12,
  },
  largeBox: {
    alignSelf: 'center',
    borderRadius: LARGE_PHOTO_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  largeAddBox: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    borderColor: PV2.borderStrong,
  },
  largeImage: {
    width: '100%',
    height: '100%',
  },
  coverBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
    backgroundColor: 'rgba(232,24,26,0.92)',
  },
  coverBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  removeButtonLarge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    marginTop: 10,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  coverToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  coverToggleTextActive: {
    color: PV2.textPrimary,
  },
  thumbRow: {
    gap: 10,
    paddingTop: 14,
    paddingBottom: 4,
    justifyContent: 'center',
    flexGrow: 1,
  },
  thumb: {
    width: TILE_WIDTH,
    aspectRatio: TILE_ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  thumbActive: {
    borderColor: PV2.accent,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbCoverDot: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: 15,
    height: 15,
    borderRadius: 7.5,
    backgroundColor: 'rgba(232,24,26,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTile: {
    width: TILE_WIDTH,
    aspectRatio: TILE_ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    borderWidth: 1.5,
    borderColor: PV2.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: {
    color: PV2.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  capacityNote: {
    color: PV2.textTertiary,
    fontSize: 11,
    marginTop: 8,
    textAlign: 'center',
  },
});

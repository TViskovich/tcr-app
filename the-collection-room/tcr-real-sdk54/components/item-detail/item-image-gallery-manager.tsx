import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';

import { ItemPhotoViewerModal } from '@/components/item-detail/item-photo-viewer-modal';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import type { CollectionItemImage } from '@/types';

// Same 5:7 trading-card portrait ratio already used throughout this app
// (item-image-carousel.tsx's own IMAGE_ASPECT_RATIO, PREVIEW_CARD_ASPECT_RATIO,
// ProfileV2Grid's CARD_ASPECT_RATIO) — each file declares its own copy
// rather than importing one shared constant, matching this codebase's
// existing convention for this exact value.
const LARGE_PHOTO_ASPECT_RATIO = 5 / 7;
// Trimmed from 0.72 — read as slightly too large/top-heavy on Edit Item.
// 0.64 keeps the photo big enough to read card details while landing
// Card Details a bit higher on screen. Derived from useWindowDimensions()
// (see largeWidth below), never a device-specific literal, so this scales
// correctly on any screen size.
const LARGE_PHOTO_WIDTH_FRACTION = 0.64;
const LARGE_PHOTO_RADIUS = 16;

const TILE_WIDTH = 64;
const TILE_ASPECT_RATIO = 5 / 7;
const TILE_RADIUS = 10;

type Props = {
  images: CollectionItemImage[];
  loading: boolean;
  mutating: boolean;
  maxImages: number;
  onAdd: () => void;
  onRemove: (imageId: string) => void;
  onSetPrimary: (imageId: string) => void;
  onReorder: (orderedIds: string[]) => void;
};

// Owner-only editable gallery — replaces the old single "Change Photo"
// hero tap. Shown in place of the hero/carousel while editMode is on (see
// app/item/[id].tsx); view mode renders ItemImageCarousel against the same
// underlying images from useItemImages instead.
//
// Redesigned (Edit Item photo readability pass) from an all-thumbnails
// strip into a large reference photo + a compact thumbnail/nav strip
// below it: the whole point of this section on Edit Item is reading
// printed card details (title, player, team, year, grade...) directly off
// the photo while filling in Card Details right below it, which a
// TILE_WIDTH=96 thumbnail can't support. Manual reordering (the previous
// per-tile move-left/move-right chevrons) is deliberately dropped here —
// not something this pass was asked to preserve, and the old per-tile
// button row is exactly the clutter this redesign is trying to remove;
// onReorder stays wired (unused by this component now) since
// app/item/[id].tsx's handleReorderPhotos/reorderGalleryImages are still
// real, working infrastructure this could reconnect to later.
export function ItemImageGalleryManager({
  images,
  loading,
  mutating,
  maxImages,
  onAdd,
  onRemove,
  onSetPrimary,
}: Props) {
  const atCapacity = images.length >= maxImages;
  const { width: windowWidth } = useWindowDimensions();
  const largeWidth = Math.round(windowWidth * LARGE_PHOTO_WIDTH_FRACTION);
  const largeHeight = Math.round(largeWidth / LARGE_PHOTO_ASPECT_RATIO);

  // One batched call for this item's whole gallery — never one signing
  // request per tile. `unavailable`/still-loading tiles intentionally show
  // no image (see the imageBox fallback below) rather than falling back to
  // image.image_url's raw public URL, so this surface actually exercises
  // the authorized delivery path instead of masking it. The large photo
  // and the thumbnail strip both read from this same map — no second
  // signing call for the large image.
  const { urls: signedUrls } = useSignedItemImages(images.map((img) => img.id));

  // The user's explicit pick (via tapping a thumbnail or the nav
  // chevrons) — null means "no explicit choice yet, use the default
  // below." Deliberately not the single source of truth on its own: if
  // the image it points at is removed, or nothing has been picked yet,
  // resolvedActiveId (below) falls back to the primary photo (or simply
  // the first one) every render, rather than needing an effect to
  // reconcile a stale id after every images-array change.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewerVisible, setViewerVisible] = useState(false);

  const resolvedActiveId =
    activeId && images.some((img) => img.id === activeId)
      ? activeId
      : (images.find((img) => img.is_primary)?.id ?? images[0]?.id ?? null);
  const activeIndex = images.findIndex((img) => img.id === resolvedActiveId);
  const activeImage = activeIndex >= 0 ? images[activeIndex] : null;
  const activeUrl = activeImage ? signedUrls.get(activeImage.id) : undefined;

  function confirmRemove(imageId: string) {
    Alert.alert('Remove Photo', 'Are you sure you want to remove this photo?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onRemove(imageId) },
    ]);
  }

  function goPrev() {
    if (activeIndex > 0) setActiveId(images[activeIndex - 1].id);
  }

  function goNext() {
    if (activeIndex >= 0 && activeIndex < images.length - 1) setActiveId(images[activeIndex + 1].id);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Photos</Text>
        <Text style={styles.count}>
          {images.length} / {maxImages}
        </Text>
      </View>

      {loading ? (
        <View style={[styles.largeBox, { width: largeWidth, height: largeHeight }]}>
          <ActivityIndicator color={PV2.textSecondary} />
        </View>
      ) : images.length === 0 ? (
        <Pressable
          style={[styles.largeBox, styles.largeAddBox, { width: largeWidth, height: largeHeight }]}
          onPress={onAdd}
          disabled={mutating}
          accessibilityRole="button"
          accessibilityLabel="Add photos">
          {mutating ? (
            <ActivityIndicator color={PV2.textSecondary} />
          ) : (
            <>
              <IconSymbol name="plus" size={26} color={PV2.textSecondary} />
              <Text style={styles.addLabel}>Add Photos</Text>
            </>
          )}
        </Pressable>
      ) : (
        <>
          {/* Tappable — opens ItemPhotoViewerModal for a substantially
              larger, pinch-zoomable look, since even at 72% screen width
              some printed card text can still be hard to read. */}
          <Pressable
            onPress={() => setViewerVisible(true)}
            style={[styles.largeBox, { width: largeWidth, height: largeHeight }]}
            accessibilityRole="imagebutton"
            accessibilityLabel="View photo full screen">
            {activeUrl ? (
              <Image source={{ uri: activeUrl }} style={styles.largeImage} contentFit="contain" transition={150} />
            ) : null}

            {activeImage?.is_primary ? (
              <View style={styles.coverBadge}>
                <Text style={styles.coverBadgeText}>COVER</Text>
              </View>
            ) : null}

            <Pressable
              style={styles.removeButtonLarge}
              onPress={() => activeImage && confirmRemove(activeImage.id)}
              disabled={mutating || !activeImage}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remove this photo">
              <IconSymbol name="xmark" size={15} color="#fff" />
            </Pressable>
          </Pressable>

          {/* Navigate between photos (changes which one is large/active)
              + toggle cover status for whichever is currently active —
              two distinct actions sharing one row, matching the
              requested "< * cover >" shape. Always shown once there's at
              least one photo (not just when there's more than one) so
              cover status stays visible and the row doesn't appear/
              disappear as photos are added/removed; the chevrons simply
              render disabled at either end. */}
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
              onPress={() => activeImage && !activeImage.is_primary && onSetPrimary(activeImage.id)}
              disabled={mutating || !activeImage || activeImage.is_primary}
              hitSlop={10}
              style={styles.coverToggle}
              accessibilityRole="button"
              accessibilityLabel={activeImage?.is_primary ? 'This is the cover photo' : 'Set as cover photo'}>
              <IconSymbol
                name={activeImage?.is_primary ? 'star.fill' : 'star'}
                size={15}
                color={activeImage?.is_primary ? PV2.accent : PV2.textSecondary}
              />
              <Text style={[styles.coverToggleText, activeImage?.is_primary && styles.coverToggleTextActive]}>
                {activeImage?.is_primary ? 'Cover' : 'Set as Cover'}
              </Text>
            </Pressable>

            <Pressable
              onPress={goNext}
              disabled={activeIndex < 0 || activeIndex >= images.length - 1}
              hitSlop={10}
              style={styles.navBtn}
              accessibilityRole="button"
              accessibilityLabel="Next photo">
              <IconSymbol
                name="chevron.right"
                size={18}
                color={activeIndex >= images.length - 1 ? PV2.textTertiary : PV2.textPrimary}
              />
            </Pressable>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbRow}>
            {images.map((image) => {
              const isActive = image.id === resolvedActiveId;
              return (
                <Pressable
                  key={image.id}
                  onPress={() => setActiveId(image.id)}
                  style={[styles.thumb, isActive && styles.thumbActive]}
                  accessibilityRole="button"
                  accessibilityLabel={image.is_primary ? 'Cover photo' : 'Photo'}
                  accessibilityState={{ selected: isActive }}>
                  {signedUrls.has(image.id) && (
                    <Image
                      source={{ uri: signedUrls.get(image.id) }}
                      style={styles.thumbImage}
                      contentFit="cover"
                      transition={150}
                    />
                  )}
                  {image.is_primary && (
                    <View style={styles.thumbCoverDot}>
                      <IconSymbol name="star.fill" size={9} color="#fff" />
                    </View>
                  )}
                </Pressable>
              );
            })}

            {!atCapacity ? (
              <Pressable
                style={styles.addTile}
                onPress={onAdd}
                disabled={mutating}
                accessibilityRole="button"
                accessibilityLabel="Add photos">
                {mutating ? (
                  <ActivityIndicator color={PV2.textSecondary} />
                ) : (
                  <IconSymbol name="plus" size={18} color={PV2.textSecondary} />
                )}
              </Pressable>
            ) : null}
          </ScrollView>

          {atCapacity ? <Text style={styles.capacityNote}>Maximum of {maxImages} photos reached</Text> : null}
        </>
      )}

      <ItemPhotoViewerModal visible={viewerVisible} uri={activeUrl} onClose={() => setViewerVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '92%',
    alignSelf: 'center',
    marginTop: 12,
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
  // Centered — largeWidth (72% of screen width) is narrower than this
  // wrap's own 92%, so it never overflows; centering just reads more
  // deliberate than left-aligning a narrower box within a wider one.
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
  // contentFit="contain" (set on the Image itself, not here) is what
  // actually keeps the whole card visible, uncropped, whatever its real
  // aspect ratio — this box is a fixed 5:7 frame, but a differently-
  // shaped (e.g. landscape) source photo still renders in full,
  // letterboxed within it, never cropped or stretched to fill it.
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

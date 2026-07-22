import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { CollectionItemImage } from '@/types';

const TILE_WIDTH = 96;
const TILE_ASPECT_RATIO = 5 / 7;
const TILE_RADIUS = 12;

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
export function ItemImageGalleryManager({
  images,
  loading,
  mutating,
  maxImages,
  onAdd,
  onRemove,
  onSetPrimary,
  onReorder,
}: Props) {
  const atCapacity = images.length >= maxImages;

  function confirmRemove(imageId: string) {
    Alert.alert('Remove Photo', 'Are you sure you want to remove this photo?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onRemove(imageId) },
    ]);
  }

  function moveLeft(index: number) {
    if (index === 0) return;
    const ids = images.map((img) => img.id);
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    onReorder(ids);
  }

  function moveRight(index: number) {
    if (index === images.length - 1) return;
    const ids = images.map((img) => img.id);
    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
    onReorder(ids);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Photos</Text>
        <Text style={styles.count}>
          {images.length} / {maxImages}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}>
        {loading ? (
          <View style={styles.loadingTile}>
            <ActivityIndicator color={PV2.textSecondary} />
          </View>
        ) : (
          images.map((image, index) => (
            <View key={image.id} style={styles.tile}>
              <View style={styles.imageBox}>
                <Image source={{ uri: image.image_url }} style={styles.image} contentFit="cover" transition={150} />

                {image.is_primary ? (
                  <View style={styles.coverBadge}>
                    <Text style={styles.coverBadgeText}>COVER</Text>
                  </View>
                ) : null}

                <Pressable
                  style={styles.removeButton}
                  onPress={() => confirmRemove(image.id)}
                  disabled={mutating}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove photo ${index + 1} of ${images.length}`}>
                  <IconSymbol name="xmark" size={13} color="#fff" />
                </Pressable>
              </View>

              <View style={styles.controlsRow}>
                <Pressable
                  style={[styles.controlButton, index === 0 && styles.controlButtonDisabled]}
                  onPress={() => moveLeft(index)}
                  disabled={mutating || index === 0}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Move photo ${index + 1} earlier`}>
                  <IconSymbol name="chevron.left" size={14} color={index === 0 ? PV2.textTertiary : PV2.textPrimary} />
                </Pressable>

                {image.is_primary ? (
                  <View style={styles.controlButton}>
                    <IconSymbol name="star.fill" size={13} color={PV2.accent} />
                  </View>
                ) : (
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => onSetPrimary(image.id)}
                    disabled={mutating}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Set photo ${index + 1} as cover`}>
                    <IconSymbol name="star" size={13} color={PV2.textSecondary} />
                  </Pressable>
                )}

                <Pressable
                  style={[styles.controlButton, index === images.length - 1 && styles.controlButtonDisabled]}
                  onPress={() => moveRight(index)}
                  disabled={mutating || index === images.length - 1}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Move photo ${index + 1} later`}>
                  <IconSymbol
                    name="chevron.right"
                    size={14}
                    color={index === images.length - 1 ? PV2.textTertiary : PV2.textPrimary}
                  />
                </Pressable>
              </View>
            </View>
          ))
        )}

        {!loading && !atCapacity ? (
          <Pressable
            style={styles.addTile}
            onPress={onAdd}
            disabled={mutating}
            accessibilityRole="button"
            accessibilityLabel="Add photos">
            {mutating ? (
              <ActivityIndicator color={PV2.textSecondary} />
            ) : (
              <>
                <IconSymbol name="plus" size={22} color={PV2.textSecondary} />
                <Text style={styles.addLabel}>Add</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </ScrollView>

      {atCapacity ? <Text style={styles.capacityNote}>Maximum of {maxImages} photos reached</Text> : null}
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
  row: {
    gap: 12,
    paddingBottom: 4,
  },
  loadingTile: {
    width: TILE_WIDTH,
    aspectRatio: TILE_ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    backgroundColor: PV2.collectorPanelBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    width: TILE_WIDTH,
  },
  imageBox: {
    width: TILE_WIDTH,
    aspectRatio: TILE_ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  coverBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(232,24,26,0.92)',
  },
  coverBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  removeButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingHorizontal: 2,
  },
  controlButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonDisabled: {
    opacity: 0.35,
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
    gap: 6,
  },
  addLabel: {
    color: PV2.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  capacityNote: {
    color: PV2.textTertiary,
    fontSize: 11,
    marginTop: 8,
  },
});

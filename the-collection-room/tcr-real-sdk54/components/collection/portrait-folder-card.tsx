import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

// portrait-folder-v1. This branch forked from main before the dark-themed
// redesign work on the other branches, so there's no shared PV2 theme file
// here yet — these are the only dark tokens this grid needs, kept local to
// this component (and reused by app/(tabs)/collection.tsx for the screen's
// own chrome) rather than standing up a whole theme registry for one screen.
export const PORTRAIT_SCREEN_BG = '#0a0a0f';
export const PORTRAIT_TILE_BG = '#15151a';
export const PORTRAIT_TILE_BORDER = 'rgba(255,255,255,0.10)';
export const PORTRAIT_TEXT_PRIMARY = '#FFFFFF';
export const PORTRAIT_TEXT_MUTED = 'rgba(255,255,255,0.45)';

const ASPECT_RATIO = 0.86;
const TILE_RADIUS = 20;

type Props = {
  title: string;
  itemCount: number;
  previewSource?: string | null;
  // Computed by the caller from the real window/container width and grid
  // spacing (see app/(tabs)/collection.tsx) — this component never guesses
  // a device-specific width itself.
  tileWidth: number;
  onPress: () => void;
};

// Pure visual renderer — no data fetching, no preview-source priority logic
// of its own. The caller passes folder.cover_image_url straight through;
// hooks/use-collection.ts's resolveCovers() has already resolved it to the
// right value (custom upload, latest-card image, or null).
export function PortraitFolderCard({ title, itemCount, previewSource, tileWidth, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.group, { width: tileWidth }, pressed && styles.groupPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}>
      {/* The tile's own dark surface is the permanent base layer, not a
          state-driven fallback — it's what's already there under the image
          while it decodes, and what's left showing if the image fails to
          load, so there's no white flash and no extra error-state
          plumbing needed. */}
      <View style={[styles.tile, { width: tileWidth }]}>
        {previewSource && (
          <Image
            source={{ uri: previewSource }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
          />
        )}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {itemCount} {itemCount === 1 ? 'item' : 'items'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {},
  groupPressed: {
    opacity: 0.85,
  },
  tile: {
    aspectRatio: ASPECT_RATIO,
    borderRadius: TILE_RADIUS,
    backgroundColor: PORTRAIT_TILE_BG,
    borderWidth: 1,
    borderColor: PORTRAIT_TILE_BORDER,
    overflow: 'hidden',
  },
  title: {
    marginTop: 9,
    color: PORTRAIT_TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: '700',
  },
  meta: {
    marginTop: 3,
    color: PORTRAIT_TEXT_MUTED,
    fontSize: 14,
  },
});

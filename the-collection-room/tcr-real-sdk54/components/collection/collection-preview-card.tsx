import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Matches components/collection/item-card.tsx's existing 5:7 trading-card
// proportions (the same aspect ratio already used for items in the folder
// detail grid), re-themed dark for this preview context.
export const PREVIEW_CARD_ASPECT_RATIO = 5 / 7;
export const PREVIEW_CARD_RADIUS = 12;

type Props = {
  imageUrl?: string | null;
  // Stable expo-image cacheKey (lib/private-image-cache-key.ts) — decouples
  // the byte-cache entry from `imageUrl` itself, which rotates on every
  // signed-URL re-sign even when the underlying image hasn't changed.
  // Optional: omitted for a folder cover whose cover_source is
  // 'first_card' (no stable identity available — see that helper's own
  // comment), in which case expo-image falls back to keying on imageUrl,
  // same as before Phase 2.
  cacheKey?: string;
  title?: string | null;
  // Year/set, shown as a second, smaller line beneath the title.
  subtitle?: string | null;
  tileWidth: number;
  onPress: () => void;
  // "compact" shrinks the caption typography AND squares off the tile's
  // corners (see compactSquareCorners below) while keeping its border —
  // border, gradients/scrim, and the placeholder treatment are otherwise
  // identical to "full" (the default) at any size, per the shared
  // PREVIEW_CARD_* constants below, which never vary by variant.
  variant?: 'full' | 'compact';
  // Opt-in, preview-local override (default false) — square corners, no
  // border — instead of touching the shared PREVIEW_CARD_RADIUS/border
  // used by every other caller of this component (Profile tab's compact
  // rows, the registry claim picker, the Grails pickers). Only the main
  // Collections screen's own (non-compact) HorizontalCardPreview rows pass
  // this, to match the folder-detail grid's Instagram-style square-tile
  // treatment — everyone else keeps today's rounded, bordered look.
  squareEdges?: boolean;
  // Optional — callers with a stable, deterministic key (e.g. the folder
  // screen's grouping grid, see app/collection/[folderId].tsx) pass one
  // through for automated-test selection; title/subtitle alone are
  // dynamic, user-generated text with no fixed pattern to match against.
  testID?: string;
};

// Pure visual renderer — no data fetching, no folder/item resolution of its
// own. The caller passes item.image_url straight through, the same field
// item-card.tsx already uses for the folder-detail grid.
export function CollectionPreviewCard({
  imageUrl,
  cacheKey,
  title,
  subtitle,
  tileWidth,
  onPress,
  variant = 'full',
  squareEdges = false,
  testID,
}: Props) {
  const compact = variant === 'compact';
  return (
    <Pressable
      testID={testID}
      style={({ pressed }) => [{ width: tileWidth }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title ?? 'Collection item'}>
      {/* The tile's own dark surface is the permanent base layer — what's
          already there while the image decodes, and what's left showing if
          it fails to load, so there's no white flash and no extra
          error-state plumbing needed. */}
      <View
        style={[
          styles.tile,
          squareEdges && styles.tileSquareEdges,
          compact && styles.compactSquareCorners,
          { width: tileWidth },
        ]}>
        {imageUrl && (
          <Image
            source={{ uri: imageUrl, cacheKey }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
          />
        )}
        {/* Overlaid on the photo itself (clipped by the tile's own
            rounded corners/overflow:hidden), not a separate block below
            the tile — a semi-transparent scrim keeps the text legible
            over any photo without needing a fixed-height gradient area. */}
        {(title || subtitle) && (
          <View style={styles.captionBar}>
            {title && (
              <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
                {title}
              </Text>
            )}
            {subtitle && (
              <Text style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={1}>
                {subtitle}
              </Text>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.85,
  },
  tile: {
    aspectRatio: PREVIEW_CARD_ASPECT_RATIO,
    borderRadius: PREVIEW_CARD_RADIUS,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  // squareEdges override (see Props) — square corners, no border, matching
  // the folder-detail grid's tiles. Layered on top of `tile` above rather
  // than replacing PREVIEW_CARD_RADIUS/the border there, so every other
  // caller of this component is unaffected.
  tileSquareEdges: {
    borderRadius: 0,
    borderWidth: 0,
  },
  // Profile V3 Collection-tab refinement — square corners for the compact
  // variant too, but (unlike tileSquareEdges above) KEEPING the existing
  // border thickness/color, so this tile reads as a sharp-cornered card
  // rather than a borderless Instagram-style tile. Scoped to `compact`
  // specifically (not `variant` generally, and independent of
  // `squareEdges`), so app/(tabs)/collection.tsx's own "full" rows — the
  // only other real caller of this component — are entirely unaffected.
  compactSquareCorners: {
    borderRadius: 0,
  },
  captionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  titleCompact: {
    fontSize: 11,
  },
  subtitle: {
    marginTop: 1,
    // Brighter than PV2.textTertiary (0.36) — this now sits on a dark
    // scrim over a photo instead of the page's own near-black background,
    // and needs more contrast to stay legible against varied photo content.
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
  },
  subtitleCompact: {
    fontSize: 10,
  },
});

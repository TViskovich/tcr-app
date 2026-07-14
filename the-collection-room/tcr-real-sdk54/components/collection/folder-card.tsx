import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';

import { detectFolderIcon, FolderIconGlyph } from './folder-icon';
import type { Folder } from '@/types';

// Same three-layer trick the old embossed letter used (dark offset
// down-right + light offset up-left + a faint true-center base) — just
// applied to an SVG icon glyph instead of a Text character.
const EMBOSS_SHADOW_COLOR = 'rgba(0,0,0,0.58)';
const EMBOSS_HIGHLIGHT_COLOR = 'rgba(255,255,255,0.22)';
const EMBOSS_BASE_COLOR = 'rgba(255,255,255,0.105)';

// A dense field of tiny, faint flecks reads as texture; a sparse one reads as
// dust — the previous 16-dot version was sparse enough that each fleck stood
// out on its own. Denser count + smaller/fainter dots so no single fleck is
// individually noticeable, only the aggregate grain. Still deterministic
// per-index jitter (not a tiled/repeating grid) so it stays organic-looking.
const GRAIN_COUNT = 70;
const GRAIN_DOTS = Array.from({ length: GRAIN_COUNT }, (_, i) => ({
  x: (i * 13 + (i % 7) * 5) % 100,
  y: (i * 29 + (i % 5) * 11) % 100,
  r: 0.3 + ((i * 17) % 10) / 30,
  light: i % 2 === 0,
}));

// Premium leather binder tones — a lighter base cover color, a clearly darker
// spine shade (kept dark/graphite, not gray), and light/dark sheen stops for
// the matte wash. Keyed (not a plain array) so a folder can pin a specific
// tone via folder.color; FOLDER_COLOR_KEYS preserves display/hash order.
export type FolderColorKey = 'graphite' | 'navy' | 'forest' | 'plum' | 'chestnut' | 'charcoal';

export const LEATHER_TONES: Record<
  FolderColorKey,
  { base: string; spine: string; sheenLight: string; sheenDark: string }
> = {
  graphite: { base: '#2C2C2F', spine: '#131315', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
  navy: { base: '#26374C', spine: '#101B28', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.24)' },
  forest: { base: '#213A2A', spine: '#0D1912', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.25)' },
  plum: { base: '#332543', spine: '#170F20', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.25)' },
  chestnut: { base: '#4C3320', spine: '#291A0E', sheenLight: 'rgba(255,255,255,0.075)', sheenDark: 'rgba(0,0,0,0.24)' },
  charcoal: { base: '#2E363D', spine: '#161B1F', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
};

export const FOLDER_COLOR_KEYS = Object.keys(LEATHER_TONES) as FolderColorKey[];

// folder.color is a free-text DB column — an unrecognized or legacy value
// (or null, for every folder created before this existed) falls back to the
// original name-hash so nothing breaks and every existing folder keeps
// rendering exactly as it does today.
function leatherTone(folder: Folder) {
  if (folder.color && folder.color in LEATHER_TONES) {
    return LEATHER_TONES[folder.color as FolderColorKey];
  }
  return LEATHER_TONES[FOLDER_COLOR_KEYS[folder.name.charCodeAt(0) % FOLDER_COLOR_KEYS.length]];
}

const SPINE_WIDTH = 11;
const CONTENT_INSET = SPINE_WIDTH + 9;
// Left (spine-side) corners read tighter/more structured than the outer-right
// ones — a plain uniform radius is what made the card feel like a generic tile.
const SPINE_RADIUS = 16;
const OUTER_RADIUS = 21;

// A fixed pixel width (not a percentage of row width) so the card is exactly
// the same size whether a row has one folder or two — the previous '42%'
// approach meant the leftover space in a two-up row had nowhere consistent
// to go, producing a big uneven middle gutter. collection.tsx derives its
// page padding from these two constants so the grid always fits exactly:
// pagePadding = (screenWidth - 2*CARD_WIDTH - CARD_GUTTER) / 2.
export const CARD_WIDTH = 150;
export const CARD_GUTTER = 14;

type Props = {
  folder: Folder;
  onPress: () => void;
  itemCount?: number;
};

export function FolderCard({ folder, onPress, itemCount }: Props) {
  const tone = leatherTone(folder);
  const icon = detectFolderIcon(folder.name);
  const countLabel =
    typeof itemCount === 'number' ? (itemCount === 1 ? '1 card' : `${itemCount} cards`) : null;

  return (
    <Pressable
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
      onPress={onPress}>
      {/* Shadow layer — kept separate from the clipped binder below, since
          overflow:'hidden' (needed for the rounded cover/spine) would also
          clip a shadow applied on the same view. */}
      <View style={styles.shadowWrap}>
        <View style={[styles.binder, { backgroundColor: tone.base }]}>
          {/* Matte material shading — a faint top-to-bottom wash, not a
              diagonal shine (a diagonal streak reads as glossy). */}
          <LinearGradient
            colors={[tone.sheenLight, 'transparent', tone.sheenDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          />

          {/* Fine grain — soft-touch material texture, only visible up close. */}
          <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject} pointerEvents="none">
            {GRAIN_DOTS.map((dot, i) => (
              <Circle
                key={i}
                cx={`${dot.x}%`}
                cy={`${dot.y}%`}
                r={dot.r}
                fill={dot.light ? '#FFFFFF' : '#000000'}
                opacity={dot.light ? 0.035 : 0.045}
              />
            ))}
          </Svg>

          {/* Faint highlight along the right edge — physical cover depth. */}
          <View style={styles.rightEdgeHighlight} pointerEvents="none" />
          {/* Restrained shadow along the bottom edge — suggests cover thickness. */}
          <View style={styles.bottomEdgeShadow} pointerEvents="none" />

          {/* Spine — darker strip down the left edge. A faint horizontal
              bevel keeps it from reading as one flat dark bar, a raised-edge
              line marks where it meets the cover, and one seam line sits
              further in. */}
          <View style={[styles.spine, { backgroundColor: tone.spine }]} pointerEvents="none">
            <LinearGradient
              colors={['rgba(255,255,255,0.16)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFillObject}
            />
            <View style={styles.spineSeam} />
            <View style={styles.spineRaisedEdge} />
          </View>
          <LinearGradient
            colors={['rgba(0,0,0,0.42)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.spineInnerShadow}
            pointerEvents="none"
          />

          <View style={styles.content}>
            {folder.cover_image_url ? (
              <>
                <Image
                  source={{ uri: folder.cover_image_url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={200}
                />
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.14)', 'rgba(0,0,0,0.72)']}
                  locations={[0, 0.45, 1]}
                  style={styles.gradient}
                />
              </>
            ) : (
              <>
                {/* Embossed sport/category icon — same three-layer carved-in
                    trick the old initial used, now on an SVG glyph. */}
                <View style={styles.embossWrap} pointerEvents="none">
                  <Svg
                    width={34}
                    height={34}
                    viewBox="0 0 40 40"
                    color={EMBOSS_SHADOW_COLOR}
                    style={[styles.embossIconLayer, styles.embossIconShadowOffset]}>
                    <FolderIconGlyph icon={icon} />
                  </Svg>
                  <Svg
                    width={34}
                    height={34}
                    viewBox="0 0 40 40"
                    color={EMBOSS_HIGHLIGHT_COLOR}
                    style={[styles.embossIconLayer, styles.embossIconHighlightOffset]}>
                    <FolderIconGlyph icon={icon} />
                  </Svg>
                  <Svg
                    width={34}
                    height={34}
                    viewBox="0 0 40 40"
                    color={EMBOSS_BASE_COLOR}
                    style={styles.embossIconLayer}>
                    <FolderIconGlyph icon={icon} />
                  </Svg>
                </View>
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.08)', 'rgba(0,0,0,0.28)']}
                  locations={[0, 0.45, 1]}
                  style={styles.gradient}
                />
              </>
            )}

            <View style={styles.label} pointerEvents="none">
              <Text style={styles.folderName} numberOfLines={1}>
                {folder.name}
              </Text>
              {countLabel && <Text style={styles.folderCount}>{countLabel}</Text>}
            </View>
          </View>

          {/* Tiny embossed 9-Grail mark (3x3 grid) — a quiet nod to the
              brand, not a logo. Same gray/opacity treatment and top-right
              placement as before, just a 3x3 grid instead of 2x2. */}
          <View style={styles.premiumMark} pointerEvents="none">
            <View style={styles.premiumMarkRow}>
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
            </View>
            <View style={styles.premiumMarkRow}>
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
            </View>
            <View style={styles.premiumMarkRow}>
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
              <View style={styles.premiumMarkDot} />
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Fixed pixel width (see CARD_WIDTH above) rather than flex:1 or a
  // percentage — this way every card is exactly the same size no matter how
  // many are in a row, and collection.tsx can derive page padding that fits
  // it exactly instead of leaving a leftover gap for space-between to fill.
  cell: {
    width: CARD_WIDTH,
    aspectRatio: 0.79,
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.97 }],
  },
  shadowWrap: {
    flex: 1,
    borderTopLeftRadius: SPINE_RADIUS,
    borderBottomLeftRadius: SPINE_RADIUS,
    borderTopRightRadius: OUTER_RADIUS,
    borderBottomRightRadius: OUTER_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 7,
    elevation: 4,
  },
  binder: {
    flex: 1,
    borderTopLeftRadius: SPINE_RADIUS,
    borderBottomLeftRadius: SPINE_RADIUS,
    borderTopRightRadius: OUTER_RADIUS,
    borderBottomRightRadius: OUTER_RADIUS,
    overflow: 'hidden',
  },
  spine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SPINE_WIDTH,
  },
  spineSeam: {
    position: 'absolute',
    left: SPINE_WIDTH - 3,
    top: 10,
    bottom: 10,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  // Marks where the spine's raised edge meets the cover, right at the
  // boundary — distinct from spineSeam (the stitch line, set further in).
  spineRaisedEdge: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.24)',
  },
  // Narrow shadow cast onto the cover by the spine's raised edge.
  spineInnerShadow: {
    position: 'absolute',
    left: SPINE_WIDTH,
    top: 0,
    bottom: 0,
    width: 9,
  },
  rightEdgeHighlight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  bottomEdgeShadow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  content: {
    flex: 1,
    marginLeft: CONTENT_INSET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  embossWrap: {
    width: 34,
    height: 34,
    transform: [{ translateY: -10 }],
  },
  embossIconLayer: {
    position: 'absolute',
  },
  embossIconShadowOffset: {
    transform: [{ translateX: 1.4 }, { translateY: 1.7 }],
  },
  embossIconHighlightOffset: {
    transform: [{ translateX: -1 }, { translateY: -1 }],
  },
  // Gradient occupies the bottom ~30% of the card, anchoring the label.
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '30%',
  },
  label: {
    position: 'absolute',
    left: 16,
    right: 12,
    bottom: 16,
  },
  folderName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.1,
  },
  folderCount: {
    color: 'rgba(255,255,255,0.70)',
    fontSize: 11,
    fontWeight: '400',
    marginTop: 2,
  },
  // Tiny 3x3 "9 Grail" grid mark, upper-right — quiet brand nod, not a logo
  // lockup. Dot size/gap shrunk from the old 2x2 version so the overall
  // footprint (~10x10) and position stay the same with one more row/column.
  premiumMark: {
    position: 'absolute',
    top: 12,
    right: 12,
    gap: 1.25,
    opacity: 0.30,
  },
  premiumMarkRow: {
    flexDirection: 'row',
    gap: 1.25,
  },
  premiumMarkDot: {
    width: 2.5,
    height: 2.5,
    borderRadius: 0.65,
    backgroundColor: '#FFFFFF',
  },
});

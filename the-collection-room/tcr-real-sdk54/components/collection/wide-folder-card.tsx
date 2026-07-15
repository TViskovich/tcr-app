import { useEffect, useRef, useState } from 'react';
import { Image as RNImage, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// wide-folder-v1. Title + item count sit in one row above the shell (Apple
// Photos album-title placement, spacing/hierarchy only — not a visual
// copy); the shell itself shows the folder's resolved cover image, or the
// dark surface underneath it when there isn't one.
export const WIDE_FOLDER_CARD_HEIGHT = 116;
const CARD_RADIUS = 20;

// ── Cover-photo pan animation ────────────────────────────────────────────
// A very slow vertical drift through the FULL source image — the image is
// laid out at its true aspect ratio scaled to the shell's real width
// (measured, not an arbitrary overscan guess), so the far/bottom endpoint
// of the pan is exactly renderedHeight - shellHeight and nothing below the
// bottom of the real image is ever skipped or invented.
//
// The resting/start position is nudged down by START_OFFSET_TARGET px so
// the crop doesn't sit flush against the image's literal top edge. That
// offset is applied as a static `top` shift on the pan layer (not part of
// the animated range) and clamped to the available overflow — a pan layer
// exactly renderedHeight tall has no extra content above its true top edge
// to reveal, so an *animated* +20 would just expose blank shell background.
// Shifting the layer's base position instead guarantees the shell is
// always fully covered, and the animated range is shortened by the same
// amount so the far endpoint still lands exactly on the image's true
// bottom edge.
const START_OFFSET_TARGET = 20;
const MIN_MEANINGFUL_RANGE = 4; // px of remaining travel below which a pan isn't worth animating
const HOLD_MS = 1750; // pause at both the lowered start and the panned-up end, ~1.5-2s
const STAGGER_STEP_MS = 600;
const STAGGER_CYCLE = 5; // wraps so a long list doesn't accumulate a huge initial delay
const DURATION_BASE_MS = 20000;
const DURATION_SPREAD_MS = 4000; // one-way pan lands in [20s, 24s), centered on the 22s default

// Deterministic (not Math.random()) — the same folder always gets the same
// duration, derived from its id rather than its list position, so duration
// variation doesn't correlate with (and therefore doesn't visually repeat)
// the position-based stagger delay below.
function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

type Props = {
  id: string;
  // Row position in the current (stable, name-sorted) list — drives the
  // deterministic stagger delay ("row 1 immediate, row 2 +0.6s, ..."), not
  // a per-render random value.
  index: number;
  title: string;
  // No real "sub-folder" concept exists in this app's data model today, and
  // the one-row title/count layout below only has room for a single count
  // anyway — accepted for interface stability, not rendered.
  folderCount?: number;
  itemCount?: number;
  // The caller (app/(tabs)/collection.tsx) passes folder.cover_image_url
  // straight through — hooks/use-collection.ts's resolveCovers() already
  // resolves that field to the right value by the time it reaches here:
  // the real uploaded URL when cover_source is 'upload', the latest item's
  // image_url when it's 'first_card', or null when neither exists. No
  // priority logic lives in this component.
  previewSource?: string | null;
  // Whether this row is currently inside the FlatList's viewport, and
  // whether the list is actively being dragged/flung right now — both
  // default true/false so this component still behaves sensibly for any
  // caller that doesn't track them (e.g. a future non-scrolling usage).
  isVisible?: boolean;
  isScrolling?: boolean;
  onPress: () => void;
};

// Title row + shell together are one tappable "folder group" — tapping
// either the title or the shell opens the same folder, matching how Apple
// Photos album titles/thumbnails both open the album.
export function WideFolderCard({
  id,
  index,
  title,
  itemCount,
  previewSource,
  isVisible = true,
  isScrolling = false,
  onPress,
}: Props) {
  const progress = useSharedValue(0);
  const hasStartedRef = useRef(false);
  const reducedMotion = useReducedMotion();

  // Measured, not assumed — the shell's real rendered width (it's a
  // responsive flex-stretched card, no fixed pixel width known ahead of
  // time) and the source image's true natural dimensions.
  const [shellWidth, setShellWidth] = useState(0);
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);

  useEffect(() => {
    if (!previewSource) {
      setNaturalAspect(null);
      return;
    }
    let cancelled = false;
    RNImage.getSize(
      previewSource,
      (w, h) => {
        if (!cancelled && h > 0) setNaturalAspect(w / h);
      },
      () => {
        if (!cancelled) setNaturalAspect(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [previewSource]);

  const onShellLayout = (e: LayoutChangeEvent) => setShellWidth(e.nativeEvent.layout.width);

  // The image laid out at its true aspect ratio, scaled to fill the shell's
  // real width — this is the "renderedImageHeight" the pan range is derived
  // from, not a guessed overscan percentage.
  const renderedHeight = shellWidth && naturalAspect ? shellWidth / naturalAspect : 0;
  const panRange = Math.max(0, renderedHeight - WIDE_FOLDER_CARD_HEIGHT);

  // The lowered start position is clamped to whatever overflow actually
  // exists — never more than panRange itself, so the static top-shift below
  // can never expose blank shell background above the image.
  const startOffset = Math.min(START_OFFSET_TARGET, panRange);
  // Remaining travel from the lowered start up to the image's true bottom
  // edge. If clamping ate the whole range (a nearly-square image with just
  // enough overflow for the start offset and no more), there's nothing left
  // worth animating.
  const animatedRange = Math.max(0, panRange - startOffset);
  const canPan = animatedRange > MIN_MEANINGFUL_RANGE;

  const durationMs = DURATION_BASE_MS + (hashSeed(id) % DURATION_SPREAD_MS);
  const staggerDelayMs = (index % STAGGER_CYCLE) * STAGGER_STEP_MS;

  const shouldAnimate = isVisible && !isScrolling && canPan && !reducedMotion;

  useEffect(() => {
    if (!shouldAnimate) {
      // Freezes at whatever value it's currently at — resuming later
      // continues the drift from there instead of restarting at 0.
      cancelAnimation(progress);
      return;
    }
    const initialDelay = hasStartedRef.current ? 0 : staggerDelayMs;
    hasStartedRef.current = true;
    progress.value = withDelay(
      initialDelay,
      withRepeat(
        withSequence(
          // Rest at the lowered start position for a beat, then pan slowly
          // up toward the image's true bottom edge.
          withDelay(HOLD_MS, withTiming(1, { duration: durationMs, easing: Easing.linear })),
          // Rest at the panned-up end for a beat, then pan back down.
          withDelay(HOLD_MS, withTiming(0, { duration: durationMs, easing: Easing.linear })),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(progress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAnimate, durationMs, staggerDelayMs, animatedRange]);

  // progress:0 is the lowered start (translateY:0 on top of the pan layer's
  // own `top: -startOffset`, landing net -startOffset from the image's true
  // top edge). progress:1 is -animatedRange, which combined with that same
  // startOffset shift lands net at -panRange: the image's true bottom edge,
  // exactly renderedHeight - shellHeight, flush with the shell's bottom.
  const panStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -progress.value * animatedRange }],
  }));

  return (
    <Pressable
      style={({ pressed }) => [styles.group, pressed && styles.groupPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}>
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {itemCount !== undefined && (
          <Text style={styles.meta} numberOfLines={1}>
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </Text>
        )}
      </View>

      {/* The shell's own dark background is the permanent base layer, not
          a state-driven fallback — while the image decodes, and if it
          fails to load at all (bad/missing URL), this dark surface is just
          what's already there underneath, so there's no white flash and no
          extra error-state plumbing needed for the "fall back safely"
          requirement. */}
      <View style={styles.shell} onLayout={onShellLayout}>
        {previewSource &&
          (canPan ? (
            // Explicit width/height (not a percentage guess) — matches the
            // image's true aspect ratio exactly, so contentFit="cover" here
            // never needs to crop anything away; overflow:hidden on the
            // shell is what does the "revealing," not the Image itself.
            <Animated.View
              style={[
                styles.panLayer,
                { width: shellWidth, height: renderedHeight, top: -startOffset },
                panStyle,
              ]}>
              <Image
                source={{ uri: previewSource }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={150}
                cachePolicy="memory-disk"
              />
            </Animated.View>
          ) : (
            // No vertical overflow to pan through — plain static cover fit.
            <Image
              source={{ uri: previewSource }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
          ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    width: '100%',
  },
  groupPressed: {
    opacity: 0.85,
  },
  // Same width/left-right alignment as the shell below it (both are direct
  // children of `group`, which has no horizontal padding of its own).
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 9,
  },
  title: {
    flex: 1,
    marginRight: 12,
    color: PV2.textPrimary,
    fontSize: 21,
    fontWeight: '700',
  },
  meta: {
    color: PV2.textTertiary,
    fontSize: 15,
  },
  shell: {
    width: '100%',
    alignSelf: 'stretch',
    height: WIDE_FOLDER_CARD_HEIGHT,
    borderRadius: CARD_RADIUS,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  // Absolute + explicit measured width/height, the React Native equivalent
  // of objectPosition:'center top'. `top` is set per-instance (-startOffset)
  // so the lowered resting position never exposes blank shell background.
  panLayer: {
    position: 'absolute',
    left: 0,
  },
});

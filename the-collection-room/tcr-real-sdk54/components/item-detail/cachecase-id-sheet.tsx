import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Polygon, Stop } from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const SHEET_HEIGHT_RATIO = 0.8;
const BACKDROP_MAX_OPACITY = 0.55;
const CLOSE_DURATION = 220;
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 900;
const OPEN_SPRING = { damping: 26, stiffness: 230, mass: 0.9, overshootClamping: true };

const SHEET_CONTENT_PADDING = 18;
// Matches the original CacheCase ID page's own hero item-image treatment
// (5:7 trading-card ratio, ~38% of the content width) — same size/
// placement convention, reused here.
const ITEM_IMAGE_WIDTH_RATIO = 0.38;
const ITEM_IMAGE_ASPECT_RATIO = 5 / 7;
// Same mint/cyan/violet/pink family as the Collection page's RailLine
// shimmer (app/(tabs)/collection.tsx's RAIL_CORE), at full opacity — a
// border needs solid color, not that line's translucent version. Static
// here on purpose; the request was for the color, not the motion.
const ITEM_IMAGE_BORDER_COLORS = ['#8FE3C0', '#8FC7EA', '#A08CDC', '#F2A6C9'] as const;
const ITEM_IMAGE_BORDER_WIDTH = 2;

// Same white-card-on-dark-header treatment the retired standalone page
// used for its ownership table — self-contained contrast, so it doesn't
// need recoloring for this sheet's dark shell.
const TABLE_HEADER_BG = '#6E6E76';
const TABLE_TEXT_DARK = '#1C1C1E';
const PLACEHOLDER_OWNERSHIP_ROWS = [
  { owner: '@username', history: '10.02.26 - owner', sold: 'ebay' },
  { owner: '@username', history: '08.23.26 - 10.02.26', sold: 'Hitz Card Shop LV    $30' },
];
const QR_BOX_SIZE = 132;

// Wordmark that drops in from above the screen while the sheet rises
// from below, timed to arrive together — see logoRestingY below.
const LOGO_SIZE = 56;
// Comfortably above any screen's top edge, so the logo starts fully
// hidden regardless of device height.
const LOGO_HIDDEN_OFFSET = -160;

// Accent line under the logo — starts its own slide-in this long after
// the sheet/logo animations START (not after they finish; springs don't
// have a precise "landed" callback moment short of chaining onto
// withSpring's completion, and a flat delay lands convincingly after
// both have visually settled anyway, since OPEN_SPRING settles well
// within 500ms).
const ACCENT_LINE_DELAY = 700;
const ACCENT_LINE_FADE_DURATION = 150;
const ACCENT_LINE_WIDTH = 120;
const ACCENT_LINE_HEIGHT = 3;
// How far in from each tip the shape widens to full height — a pointed
// (not rounded) lens/sliver silhouette rather than a rounded-pill line.
const ACCENT_LINE_TAPER = 16;
// Slides in from this far off to the side rather than just appearing.
const ACCENT_LINE_SLIDE_DISTANCE = 56;
const ACCENT_LINE_SPRING = { damping: 14, stiffness: 180, mass: 0.7 };
// Where it settles horizontally, relative to dead-center under the logo.
const ACCENT_LINE_FINAL_X = -7;

// Pointed hexagonal "lens" outline: a point at each end, widening to a
// flat-topped/bottomed bar in the middle — the shape is built once (it
// only depends on the two constants above, not on any runtime value).
const ACCENT_LINE_POINTS = [
  `0,${ACCENT_LINE_HEIGHT / 2}`,
  `${ACCENT_LINE_TAPER},0`,
  `${ACCENT_LINE_WIDTH - ACCENT_LINE_TAPER},0`,
  `${ACCENT_LINE_WIDTH},${ACCENT_LINE_HEIGHT / 2}`,
  `${ACCENT_LINE_WIDTH - ACCENT_LINE_TAPER},${ACCENT_LINE_HEIGHT}`,
  `${ACCENT_LINE_TAPER},${ACCENT_LINE_HEIGHT}`,
].join(' ');

type Props = {
  visible: boolean;
  onClose: () => void;
  // The item's own hero image — shown large, left-aligned below the
  // header, so it's clear which card this ID belongs to.
  itemImageUrl?: string | null;
};

// Instagram-comments-style bottom sheet for the CacheCase ID folder,
// opened from the logo button in ItemActionBar. Replaces the earlier
// standalone-route navigation (app/cachecase-id.tsx, removed) and the
// tap-only overlay from the previous pass — this version adds the
// drag-to-dismiss gesture, fixed sheet height, and Instagram-style shell
// (rounded top corners, drag handle, centered title) requested here.
//
// Same Modal + Animated translateY + backdrop + pan-gesture pattern
// already established by GalleryCommentsSheet/FolderCommentsSheet (kept
// mounted through the close animation via `mounted` state, so dismissal
// is never an abrupt cut).
//
// Drag handle, title, and the same content blocks the retired standalone
// CacheCase ID page had (hero image, title/description, CC# number/link,
// ownership-history table, QR placeholder) — all visual-only scaffolding
// here, no real data, ownership logic, or QR generation wired up yet. No
// folder asset in this version.
export function CacheCaseIdSheet({ visible, onClose, itemImageUrl }: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetHeight = windowHeight * SHEET_HEIGHT_RATIO;
  const itemImageWidth = (windowWidth - SHEET_CONTENT_PADDING * 2) * ITEM_IMAGE_WIDTH_RATIO;
  // Where the logo settles: straddling the sheet's top edge (half above
  // it, half overlapping down into it) so the two genuinely appear to
  // meet rather than the logo just stopping short above the sheet.
  const logoRestingY = windowHeight - sheetHeight - LOGO_SIZE / 2;
  const translateY = useSharedValue(sheetHeight);
  const logoTranslateY = useSharedValue(LOGO_HIDDEN_OFFSET);
  const lineOpacity = useSharedValue(0);
  const lineTranslateX = useSharedValue(ACCENT_LINE_FINAL_X - ACCENT_LINE_SLIDE_DISTANCE);
  const [mounted, setMounted] = useState(false);

  function handleClosed() {
    setMounted(false);
    onClose();
  }

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = withSpring(0, OPEN_SPRING);
      logoTranslateY.value = withSpring(logoRestingY, OPEN_SPRING);
      lineOpacity.value = withDelay(ACCENT_LINE_DELAY, withTiming(1, { duration: ACCENT_LINE_FADE_DURATION }));
      lineTranslateX.value = withDelay(ACCENT_LINE_DELAY, withSpring(ACCENT_LINE_FINAL_X, ACCENT_LINE_SPRING));
    } else {
      translateY.value = withTiming(sheetHeight, { duration: CLOSE_DURATION }, (finished) => {
        if (finished) runOnJS(handleClosed)();
      });
      logoTranslateY.value = withTiming(LOGO_HIDDEN_OFFSET, { duration: CLOSE_DURATION });
      lineOpacity.value = withTiming(0, { duration: ACCENT_LINE_FADE_DURATION });
      lineTranslateX.value = withTiming(ACCENT_LINE_FINAL_X - ACCENT_LINE_SLIDE_DISTANCE, {
        duration: ACCENT_LINE_FADE_DURATION,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function dismiss() {
    translateY.value = withTiming(sheetHeight, { duration: CLOSE_DURATION }, (finished) => {
      if (finished) runOnJS(handleClosed)();
    });
    logoTranslateY.value = withTiming(LOGO_HIDDEN_OFFSET, { duration: CLOSE_DURATION });
    lineOpacity.value = withTiming(0, { duration: ACCENT_LINE_FADE_DURATION });
    lineTranslateX.value = withTiming(ACCENT_LINE_FINAL_X - ACCENT_LINE_SLIDE_DISTANCE, {
      duration: ACCENT_LINE_FADE_DURATION,
    });
  }

  // Follows the finger downward only — clamped at 0 so an upward drag
  // can't pull the sheet past its resting (fully open) position.
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const shouldClose = e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY;
      if (shouldClose) {
        runOnJS(dismiss)();
      } else {
        translateY.value = withSpring(0, OPEN_SPRING);
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: BACKDROP_MAX_OPACITY * (1 - Math.min(1, translateY.value / sheetHeight)),
  }));

  const logoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: logoTranslateY.value }],
  }));

  const lineStyle = useAnimatedStyle(() => ({
    opacity: lineOpacity.value,
    transform: [{ translateX: lineTranslateX.value }],
  }));

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <GestureHandlerRootView style={styles.fill}>
        <View style={styles.fill}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel="Close CacheCase ID" />
          </Animated.View>

          <GestureDetector gesture={pan}>
            <Animated.View
              style={[
                styles.sheet,
                { height: sheetHeight, paddingBottom: Math.max(insets.bottom, 12) + 16 },
                sheetStyle,
              ]}>
              {/* Accent line — slides in from the side and settles (spring,
                  not a plain fade) about 0.5s after the sheet/logo start
                  opening, once both have visually settled. Pointed lens
                  silhouette, not a rounded pill — a Polygon rather than a
                  plain rect, since expo-linear-gradient can only fill a
                  rectangle. Sits right under the logo's landing spot. */}
              <Animated.View style={[styles.accentLineWrap, lineStyle]} pointerEvents="none">
                <Svg width={ACCENT_LINE_WIDTH} height={ACCENT_LINE_HEIGHT}>
                  <Defs>
                    <SvgLinearGradient id="accentLineGradient" x1="0" y1="0" x2="1" y2="0">
                      {ITEM_IMAGE_BORDER_COLORS.map((color, index) => (
                        <Stop
                          key={color}
                          offset={index / (ITEM_IMAGE_BORDER_COLORS.length - 1)}
                          stopColor={color}
                        />
                      ))}
                    </SvgLinearGradient>
                  </Defs>
                  <Polygon points={ACCENT_LINE_POINTS} fill="url(#accentLineGradient)" />
                </Svg>
              </Animated.View>

              {itemImageUrl && (
                <View style={styles.body}>
                  <View style={styles.identityRow}>
                    <LinearGradient
                      colors={ITEM_IMAGE_BORDER_COLORS}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={[
                        styles.itemImageBorder,
                        { width: itemImageWidth, aspectRatio: ITEM_IMAGE_ASPECT_RATIO },
                      ]}>
                      <Image source={{ uri: itemImageUrl }} style={styles.itemImage} contentFit="cover" />
                    </LinearGradient>

                    {/* Placeholders for the fields not wired up yet — same
                        two-row layout the retired standalone CacheCase ID
                        page used, recolored for this sheet's dark shell. */}
                    <View style={styles.identityText}>
                      <Text style={styles.itemTitle} numberOfLines={1}>
                        TITLE
                      </Text>
                      <Text style={styles.itemDescription} numberOfLines={2}>
                        Description
                      </Text>
                    </View>
                  </View>

                  <View style={styles.identityRow}>
                    <Text style={[styles.ccNumber, { width: itemImageWidth }]}>CC# 000000</Text>
                    <Text style={styles.linkText}>Link</Text>
                  </View>

                  {/* Ownership-history and QR placeholders — same
                      visual-only scaffolding the retired page had, no
                      real data or QR generation wired up. */}
                  <View style={styles.table}>
                    <View style={[styles.tableRow, styles.tableHeaderRow]}>
                      <Text style={[styles.tableHeaderCell, styles.colOwnership]} numberOfLines={1}>
                        Ownership
                      </Text>
                      <Text style={[styles.tableHeaderCell, styles.colHistory]} numberOfLines={1}>
                        Transaction History
                      </Text>
                      <Text style={[styles.tableHeaderCell, styles.colSold]} numberOfLines={1}>
                        Sold
                      </Text>
                    </View>
                    {PLACEHOLDER_OWNERSHIP_ROWS.map((row, index) => (
                      <View key={index} style={styles.tableRow}>
                        <Text style={[styles.tableCell, styles.colOwnership]} numberOfLines={1}>
                          {row.owner}
                        </Text>
                        <Text style={[styles.tableCell, styles.colHistory]} numberOfLines={1}>
                          {row.history}
                        </Text>
                        <Text style={[styles.tableCell, styles.colSold]} numberOfLines={1}>
                          {row.sold}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <View style={styles.qrSection}>
                    <LinearGradient
                      colors={ITEM_IMAGE_BORDER_COLORS}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.qrBorder}>
                      <View style={styles.qrBox}>
                        <Text style={styles.qrLabel}>QR code</Text>
                      </View>
                    </LinearGradient>
                  </View>
                </View>
              )}
            </Animated.View>
          </GestureDetector>

          {/* Drops in from above the screen while the sheet rises from
              below, settling straddling the sheet's top edge so the two
              appear to meet. Rendered after the sheet (not inside its
              GestureDetector) so it draws on top and stays independent
              of the drag gesture. */}
          <Animated.View style={[styles.logoDropWrap, logoStyle]} pointerEvents="none">
            <CacheCaseLogo variant="light" size={LOGO_SIZE} />
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: '#000',
  },
  logoDropWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#15171d',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    // Clears the dropped-in logo overlapping the top edge — previously
    // the (now-removed) header row's own height/margins provided this.
    paddingTop: 44,
  },
  accentLineWrap: {
    alignItems: 'center',
    marginTop: -5,
    marginBottom: 8,
  },
  body: {
    paddingHorizontal: SHEET_CONTENT_PADDING,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 12,
  },
  // Gradient rect that shows through as a thin multicolor border around
  // the photo — the same "padding = border width" trick used for the
  // CacheCase pill on the profile page (profile-v2-selector.tsx).
  itemImageBorder: {
    borderRadius: 14,
    padding: ITEM_IMAGE_BORDER_WIDTH,
    overflow: 'hidden',
  },
  itemImage: {
    flex: 1,
    borderRadius: 14 - ITEM_IMAGE_BORDER_WIDTH,
  },
  identityText: {
    flex: 1,
    marginLeft: 14,
  },
  itemTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: PV2.textPrimary,
  },
  itemDescription: {
    marginTop: 4,
    fontSize: 14,
    color: PV2.textSecondary,
  },
  ccNumber: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textTertiary,
  },
  linkText: {
    flex: 1,
    marginLeft: 14,
    fontSize: 14,
    fontWeight: '600',
    color: PV2.link,
  },
  table: {
    width: '100%',
    marginTop: 14,
    borderRadius: 10,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  tableHeaderRow: {
    backgroundColor: TABLE_HEADER_BG,
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  tableCell: {
    fontSize: 12,
    color: TABLE_TEXT_DARK,
  },
  colOwnership: {
    flex: 1,
  },
  colHistory: {
    flex: 1.6,
  },
  colSold: {
    flex: 1.3,
    textAlign: 'right',
  },
  qrSection: {
    alignItems: 'center',
    marginTop: 20,
  },
  qrBorder: {
    width: QR_BOX_SIZE,
    height: QR_BOX_SIZE,
    borderRadius: 18,
    padding: ITEM_IMAGE_BORDER_WIDTH,
  },
  qrBox: {
    flex: 1,
    borderRadius: 18 - ITEM_IMAGE_BORDER_WIDTH,
    backgroundColor: PV2.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
});

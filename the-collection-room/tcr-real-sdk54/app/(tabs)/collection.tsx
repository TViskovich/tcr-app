import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import { BOX_ASPECT_RATIO, FolderCard } from '@/components/collection/folder-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAuth } from '@/lib/auth';
import { useFolders } from '@/hooks/use-collection';
import type { Folder } from '@/types';

// Header/rail margin — no longer tied to a grid column formula (the
// carousel below scrolls edge-to-edge on purpose), just a fixed inset.
const PAGE_PADDING = 22;

// Restrained, low-opacity version of the same iridescent family as the
// CacheCase pill on the Profile page (mint/pink/cyan), with a muted violet
// added per this pass — used for the straight header rail lines below, not
// an enclosing outline.
const RAIL_CORE = [
  'rgba(143,227,192,0.42)', // mint
  'rgba(143,199,234,0.42)', // cool cyan
  'rgba(160,140,220,0.36)', // muted violet
  'rgba(242,166,201,0.28)', // very subtle pink
] as const;
const RAIL_HALO = [
  'rgba(143,227,192,0.12)',
  'rgba(143,199,234,0.12)',
  'rgba(160,140,220,0.10)',
  'rgba(242,166,201,0.08)',
] as const;

// Same four hues as RAIL_CORE, brightened and bookended with transparent so
// it reads as a traveling band of light rather than a static line — this is
// the "light passing through" layer, not a new color family.
const RAIL_SHIMMER = [
  'rgba(143,227,192,0)',
  'rgba(143,227,192,0.85)',
  'rgba(143,199,234,0.85)',
  'rgba(160,140,220,0.7)',
  'rgba(242,166,201,0.5)',
  'rgba(242,166,201,0)',
] as const;
const RAIL_SHIMMER_WIDTH = 160;
const RAIL_SHIMMER_DURATION = 2600;

// A straight, full-width ~1px iridescent line with a faint, slightly taller
// halo behind it (a stacked fainter copy, not a real blur) — one continuous
// line, not segments broken around content. A bright band of the same
// colors ping-pongs end to end on a loop, like light bouncing back and
// forth. Both directions share the exact same 0→1→0 driver (so they bounce
// identically) — only the translateX output range is mirrored, which is
// what actually makes 'rtl' start from the right edge instead of the left.
function RailLine({ direction = 'ltr' }: { direction?: 'ltr' | 'rtl' }) {
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: RAIL_SHIMMER_DURATION,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: RAIL_SHIMMER_DURATION,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange:
      direction === 'ltr' ? [-RAIL_SHIMMER_WIDTH, width] : [width, -RAIL_SHIMMER_WIDTH],
  });

  return (
    <View style={styles.railWrap} pointerEvents="none">
      <LinearGradient
        colors={RAIL_HALO}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFillObject}
      />
      <LinearGradient
        colors={RAIL_CORE}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.railCore}
      />
      <Animated.View
        style={[styles.railShimmer, { width: RAIL_SHIMMER_WIDTH, transform: [{ translateX }] }]}>
        <LinearGradient
          colors={RAIL_SHIMMER}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFillObject}
        />
      </Animated.View>
    </View>
  );
}

// Page-wide grain — same deterministic-jitter technique as folder-card.tsx's
// GRAIN_DOTS (not Math.random, so it's stable across re-renders), just
// scaled up to cover the page instead of one card. Capped to a fixed field
// height (like premium-empty-card.tsx's DUST_FIELD_HEIGHT) rather than the
// full scrollable content — it's meant to texture the header/upper-fold
// area, not every row all the way down.
const PAGE_GRAIN_COUNT = 130;
const PAGE_GRAIN_FIELD_HEIGHT = 620;
const PAGE_GRAIN_DOTS = Array.from({ length: PAGE_GRAIN_COUNT }, (_, i) => ({
  x: (i * 17 + (i % 11) * 7) % 100,
  y: (i * 23 + (i % 9) * 13) % 100,
  r: 0.3 + ((i * 13) % 10) / 35,
  light: i % 2 === 0,
}));

// Layered background environment — vertical charcoal-to-black base, a
// broad low-opacity violet/blue atmospheric wash behind the header, a
// soft overhead highlight bled mostly above the top edge, and the grain
// field above. All pointerEvents="none", all fixed (renders once behind
// the header/FlatList, doesn't scroll with content) so it reads as the
// room the binders sit in rather than something printed on the list.
function CollectionAtmosphere({ width }: { width: number }) {
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={['#18181f', '#0d0d12', PV2.bg]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFillObject}
      />

      {/* Violet → cool-blue wash, same hue family as hero-canvas-theme.tsx's
          'foil' layer 1 (rgba(120,60,220,...) / rgba(40,80,220,...)), at a
          fraction of its opacity since this sits behind an entire page
          rather than one focused hero. Bled well past the sides/top so it
          has no visible edge. */}
      <Svg width={width * 1.4} height={420} style={{ position: 'absolute', top: -60, left: -width * 0.2 }}>
        <Defs>
          <RadialGradient id="collectionAtmo" cx="50%" cy="35%" rx="55%" ry="60%">
            <Stop offset="0%" stopColor="#8C6EDC" stopOpacity={0.055} />
            <Stop offset="55%" stopColor="#5A78D2" stopOpacity={0.028} />
            <Stop offset="100%" stopColor="#5A78D2" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width * 1.4} height={420} fill="url(#collectionAtmo)" />
      </Svg>

      {/* Soft overhead highlight — mostly bled above the top edge (top:-150
          inside a SafeAreaView means it never touches the actual OS status
          bar, just the app's own background). */}
      <Svg width={width * 1.6} height={220} style={{ position: 'absolute', top: -150, left: -width * 0.3 }}>
        <Defs>
          <RadialGradient id="collectionTopLight" cx="50%" cy="50%" rx="60%" ry="50%">
            <Stop offset="0%" stopColor="#E4E8FF" stopOpacity={0.05} />
            <Stop offset="100%" stopColor="#E4E8FF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width * 1.6} height={220} fill="url(#collectionTopLight)" />
      </Svg>

      <Svg width="100%" height={PAGE_GRAIN_FIELD_HEIGHT} style={{ position: 'absolute', top: 0, left: 0 }}>
        {PAGE_GRAIN_DOTS.map((d, i) => (
          <Circle
            key={i}
            cx={`${d.x}%`}
            cy={`${d.y}%`}
            r={d.r}
            fill={d.light ? '#FFFFFF' : '#000000'}
            opacity={d.light ? 0.02 : 0.025}
          />
        ))}
      </Svg>
    </View>
  );
}

// How far apart adjacent binders sit — the visible gap between them once
// centered (not the item's own rendered width).
const CAROUSEL_GAP = 20;

// A horizontal, snap-to-center carousel — swipe/scroll left or right to
// browse binders one at a time, tap the one you want to open it. The
// centered item renders at full size/opacity; neighbors scale down and dim
// as they move away from center, purely driven by scroll position (no
// separate "selected index" state to keep in sync).
function FolderCarousel({
  folders,
  itemCounts,
  onFolderPress,
  windowWidth,
}: {
  folders: Folder[];
  itemCounts: Record<string, number>;
  onFolderPress: (folder: Folder) => void;
  windowWidth: number;
}) {
  const itemWidth = Math.min(268, windowWidth * 0.68);
  const slotWidth = itemWidth + CAROUSEL_GAP;
  const sidePadding = (windowWidth - itemWidth) / 2;
  const carouselHeight = itemWidth / BOX_ASPECT_RATIO + 60;
  const scrollX = useRef(new Animated.Value(0)).current;

  return (
    <Animated.FlatList<Folder>
      data={folders}
      horizontal
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      snapToInterval={slotWidth}
      decelerationRate="fast"
      style={{ height: carouselHeight }}
      contentContainerStyle={{ paddingHorizontal: sidePadding }}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
      })}
      scrollEventThrottle={16}
      renderItem={({ item, index }) => {
        const inputRange = [(index - 1) * slotWidth, index * slotWidth, (index + 1) * slotWidth];
        const scale = scrollX.interpolate({
          inputRange,
          outputRange: [0.86, 1, 0.86],
          extrapolate: 'clamp',
        });
        const opacity = scrollX.interpolate({
          inputRange,
          outputRange: [0.5, 1, 0.5],
          extrapolate: 'clamp',
        });
        return (
          <Animated.View style={[styles.carouselSlot, { width: slotWidth, transform: [{ scale }], opacity }]}>
            <FolderCard
              folder={item}
              itemCount={itemCounts[item.id] ?? 0}
              width={itemWidth}
              maxBoxWidth={itemWidth}
              onPress={() => onFolderPress(item)}
            />
          </Animated.View>
        );
      }}
    />
  );
}

export default function CollectionScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? '';
  const { folders, loading, refresh, itemCounts } = useFolders(userId);
  const [showModal, setShowModal] = useState(false);
  const router = useRouter();

  const { width: windowWidth } = useWindowDimensions();
  const pagePadding = PAGE_PADDING;

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <CollectionAtmosphere width={windowWidth} />

      <RailLine direction="ltr" />

      <View style={[styles.header, { paddingHorizontal: pagePadding }]}>
        <View style={styles.headerTitleRow}>
          <CacheCaseLogo variant="icon" size={28} />
          <Text style={styles.headerTitle}>Collection . . .</Text>
        </View>
      </View>

      <RailLine direction="rtl" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      ) : folders.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyPanel}>
            <View style={styles.emptyGlowWrap} pointerEvents="none">
              <Svg width={180} height={180}>
                <Defs>
                  <RadialGradient id="collectionEmptyGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.09} />
                    <Stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect x={0} y={0} width={180} height={180} fill="url(#collectionEmptyGlow)" />
              </Svg>
            </View>

            <CacheCaseLogo variant="icon" size="lg" style={styles.emptyLogo} />

            <Text style={styles.emptyTitle}>No collections yet</Text>
            <Text style={styles.emptyBody}>
              Start organizing your cards into folders — by set, player, team, or however you collect.
            </Text>

            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => setShowModal(true)}
              activeOpacity={0.82}>
              <Text style={styles.emptyButtonText}>Create First Collection</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.carouselWrap}>
          <FolderCarousel
            folders={folders}
            itemCounts={itemCounts}
            windowWidth={windowWidth}
            onFolderPress={(folder) =>
              router.push({
                pathname: '/folder/[id]',
                params: { id: folder.id, name: folder.name },
              })
            }
          />
        </View>
      )}

      {folders.length > 0 && (
        <View style={styles.newFolderRow}>
          <TouchableOpacity
            style={styles.newFolderButton}
            onPress={() => setShowModal(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.7}>
            <Text style={styles.newFolderText}>+ New Folder</Text>
          </TouchableOpacity>
        </View>
      )}

      <CreateFolderModal
        visible={showModal}
        userId={userId}
        onClose={() => setShowModal(false)}
        onCreated={() => {
          setShowModal(false);
          refresh();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  // Row between the two RailLines — just the icon+title now. The RailLines
  // themselves render outside any horizontal padding so they run
  // edge-to-edge; paddingHorizontal is applied to this row alone (inline,
  // via pagePadding) so its content still lines up with the binder grid's
  // margins underneath.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginLeft: -10,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: PV2.textPrimary,
    letterSpacing: 0.2,
  },
  railWrap: {
    height: 3,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  railCore: {
    height: 1,
  },
  railShimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  // Now sits below the carousel instead of crowding the header rail area,
  // with enough bottom padding to clear the tab bar.
  newFolderRow: {
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 24,
  },
  // Given real button weight per this pass — translucent graphite fill,
  // thin cool-toned border, pill radius — rather than the bare unboxed
  // text action used previously.
  newFolderButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  newFolderText: {
    color: PV2.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  // ── Empty state — same restrained dark-panel language as the Profile
  // page's collector panel (reuses its exact bg/border tokens), not the
  // ornate gold Grails pedestal.
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  emptyPanel: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 24,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    paddingVertical: 36,
    paddingHorizontal: 28,
    alignItems: 'center',
    transform: [{ translateY: -24 }],
  },
  emptyGlowWrap: {
    position: 'absolute',
    top: -10,
    alignSelf: 'center',
  },
  emptyLogo: {
    opacity: 0.85,
    marginBottom: 18,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: 22,
    height: 46,
    paddingHorizontal: 26,
    borderRadius: 23,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  carouselWrap: {
    paddingTop: 28,
    paddingBottom: 12,
  },
  carouselSlot: {
    alignItems: 'center',
  },
});

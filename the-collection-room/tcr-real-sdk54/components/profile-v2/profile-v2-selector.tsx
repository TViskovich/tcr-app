import { useMemo, useRef } from 'react';
import {
  Animated,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from './profile-v2-theme';

const IRIDESCENT_BORDER = ['#8FE3C0', '#F2A6C9', '#8FC7EA', '#B9E8B0'] as const;

// Real logo asset (cachecase-primary.png, 1627x684) rendered at this height
// inside the pill — width follows from CacheCaseLogo's own aspect ratio math.
const CACHECASE_LOGO_HEIGHT = 30;

// All three (now four, for the owner) pills share this exact footprint —
// "collections" being a longer word than "posts" no longer widens its box;
// its Text instead shrinks to fit via adjustsFontSizeToFit below. Widened
// from the initial 108 to give the logo pill more breathing room around the
// wordmark, which was crowding the gradient border closely enough to read
// as "cut off."
const PILL_WIDTH = 122;
const PILL_HEIGHT = 44;
const CACHECASE_BORDER_WIDTH = 1.5;

// 'bookmarked' stays removed (bookmarks are private to the account owner
// — see app/(tabs)/profile.tsx). 'transfers' was removed again (P0 fix):
// it only ever rendered fabricated data from lib/placeholder-transactions.ts,
// indistinguishable from real data to a viewer — see
// components/profile-v2/transfers-preview.tsx, which stays in the repo but
// is no longer imported by Profile V2. This union is still the source of
// truth for which sections can ever be selected, so a removed key can't be
// reached through stale state.
//
// 'transfer' (singular — a real, safe, owner-only landing section, not the
// removed 'transfers' preview above) was added for the rail's fourth,
// owner-only destination. See ProfileV2Selector's `sections` useMemo below
// for how it's excluded entirely from a visitor's rail, and
// profile-v2-transfer-landing.tsx for what actually renders when it's
// selected — a static "choose a card" prompt, never a direct transfer
// action from this tap alone.
export type ProfileV2Section = 'posts' | 'cachecase' | 'collections' | 'transfer';

// Fixed per-item width, same idea as the Collection tab's FolderCarousel
// (see app/(tabs)/collection.tsx) — a constant slot each pill centers
// within, so the carousel's snap math doesn't have to account for pills
// changing size on selection anymore (that's now the scale animation's job).
const SLOT_WIDTH = 132;

// A true mathematically-infinite loop isn't possible with a finite list, so
// instead the FlatList's data is `sections` repeated many times over, with
// the initial scroll position starting deep in the middle of that buffer.
// That gives ~100 loops' worth of scroll room in either direction before
// hitting a physical edge — far more than anyone will ever swipe through in
// one sitting, so it reads as endless without any scroll-position-reset
// hack (which risks a visible jump/flicker) to actually stitch the ends
// together.
const LOOP_COUNT = 200;

type Props = {
  active: ProfileV2Section;
  onChange: (section: ProfileV2Section) => void;
  // Gates the fourth 'transfer' pill entirely — a visitor's rail never
  // includes it in `sections` below, so it can never be scrolled to,
  // tapped, or landed on via the loop math. Public profile behavior is
  // otherwise byte-identical to before this pill existed.
  isOwnProfile: boolean;
};

// A horizontal, snap-to-center carousel — the exact same mechanics as
// FolderCarousel: fixed-width slots, scroll-position-driven scale/opacity
// falloff on neighbors, and the centered slot IS the active selection.
// Tapping a pill scrolls it to center (which is what actually flips
// `active`, via onMomentumScrollEnd) rather than switching state directly,
// so there's a single source of truth for "what's selected."
export function ProfileV2Selector({ active, onChange, isOwnProfile }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const sidePadding = (windowWidth - SLOT_WIDTH) / 2;
  const scrollX = useRef(new Animated.Value(0)).current;
  const listRef = useRef<FlatList<ProfileV2Section>>(null);

  // cachecase is the carousel's default/starting selection — its position
  // in this array only matters for which pill starts under the finger; the
  // carousel finds it via sections.indexOf(active), so no fixed "center
  // index" bookkeeping is required as sections are added or removed.
  // Recomputed only when isOwnProfile changes (never mid-session for a
  // given screen instance in practice), not on every render.
  const { sections, loopedSections, loopStart } = useMemo(() => {
    const sections: ProfileV2Section[] = isOwnProfile
      ? ['posts', 'collections', 'cachecase', 'transfer']
      : ['posts', 'collections', 'cachecase'];
    const loopedSections: ProfileV2Section[] = Array.from({ length: LOOP_COUNT }, () => sections).flat();
    const loopStart = Math.floor(LOOP_COUNT / 2) * sections.length;
    return { sections, loopedSections, loopStart };
  }, [isOwnProfile]);

  const initialIndex = loopStart + Math.max(0, sections.indexOf(active));

  const goToIndex = (index: number) => {
    onChange(loopedSections[index]);
    listRef.current?.scrollToIndex({ index, animated: true });
  };

  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SLOT_WIDTH);
    const clamped = Math.min(loopedSections.length - 1, Math.max(0, index));
    const section = loopedSections[clamped];
    if (section !== active) onChange(section);
  };

  return (
    <View style={styles.wrap}>
      <Animated.FlatList<ProfileV2Section>
        ref={listRef}
        data={loopedSections}
        horizontal
        keyExtractor={(s, index) => `${s}-${index}`}
        showsHorizontalScrollIndicator={false}
        snapToInterval={SLOT_WIDTH}
        decelerationRate="fast"
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({ length: SLOT_WIDTH, offset: SLOT_WIDTH * index, index })}
        contentContainerStyle={{ paddingHorizontal: sidePadding }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: true,
        })}
        onMomentumScrollEnd={handleMomentumEnd}
        scrollEventThrottle={16}
        renderItem={({ item, index }) => {
          const inputRange = [(index - 1) * SLOT_WIDTH, index * SLOT_WIDTH, (index + 1) * SLOT_WIDTH];
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
            <View style={styles.slot}>
              <Animated.View style={{ transform: [{ scale }], opacity }}>
                {item === 'cachecase' ? (
                  <TouchableOpacity
                    testID={`profile-section-${item}`}
                    onPress={() => goToIndex(index)}
                    activeOpacity={0.85}>
                    <LinearGradient
                      colors={IRIDESCENT_BORDER}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.cachecaseBorder}>
                      <View style={styles.cachecasePill}>
                        <CacheCaseLogo variant="light" size={CACHECASE_LOGO_HEIGHT} />
                      </View>
                    </LinearGradient>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    testID={`profile-section-${item}`}
                    style={styles.pill}
                    onPress={() => goToIndex(index)}
                    activeOpacity={0.8}>
                    <Text
                      style={styles.pillLabel}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}>
                      {item}
                    </Text>
                  </TouchableOpacity>
                )}
              </Animated.View>
            </View>
          );
        }}
      />

      <View style={styles.dots}>
        {sections.map((s) => (
          <View key={s} style={[styles.dot, s === active && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 10,
    alignItems: 'center',
  },
  slot: {
    width: SLOT_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // One constant pill size now (both across posts/collections/transfer AND
  // matching the cachecase logo pill below) — the scroll-driven scale above
  // is what makes the centered pill read as "active," not a per-pill size
  // swap.
  pill: {
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: 'rgba(16,16,26,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.0,
    textTransform: 'lowercase',
  },
  // Gradient rect that shows through as a thin border around the black
  // interior — the standard "gradient border" trick (padding = border
  // width). Sized to PILL_WIDTH/HEIGHT so its outer footprint matches the
  // other two pills exactly. overflow:hidden keeps the gradient strictly
  // clipped to its own rounded corners.
  cachecaseBorder: {
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    borderRadius: 13,
    padding: CACHECASE_BORDER_WIDTH,
    overflow: 'hidden',
  },
  // Explicit width/height (PILL minus the border padding on each side)
  // rather than flex:1 — sidesteps any flex-sizing ambiguity inside a
  // LinearGradient, which was letting this pill's content brush right up
  // against (and visually interrupt) the gradient border on some edges.
  cachecasePill: {
    width: PILL_WIDTH - CACHECASE_BORDER_WIDTH * 2,
    height: PILL_HEIGHT - CACHECASE_BORDER_WIDTH * 2,
    borderRadius: 11.5,
    backgroundColor: 'rgba(16,16,26,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dots: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 10,
    marginBottom: 12,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  dotActive: {
    width: 16,
    backgroundColor: PV2.accent,
  },
});

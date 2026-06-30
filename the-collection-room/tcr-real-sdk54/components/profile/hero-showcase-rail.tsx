import { useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

// ─── Badge data ───────────────────────────────────────────────────────────────

export type Badge = {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlocked: boolean;
  count?: number;
};

const BADGES: Badge[] = [
  {
    id: 'grail-hunter',
    title: 'Grail Hunter',
    description: 'Added 3 or more cards to your Grails collection.',
    icon: '🏆',
    unlocked: true,
    count: 3,
  },
  {
    id: 'century-club',
    title: 'Century Club',
    description: 'Reached 100 cards in your collection.',
    icon: '💯',
    unlocked: true,
    count: 142,
  },
  {
    id: 'first-pull',
    title: 'First Pull',
    description: 'Added your very first card to The Collection Room.',
    icon: '🎴',
    unlocked: true,
  },
  {
    id: 'og',
    title: 'OG Collector',
    description: 'Joined during launch month.',
    icon: '⭐',
    unlocked: true,
  },
  {
    id: 'curator',
    title: 'Curator',
    description: 'Created 5 or more folders to organize your collection.',
    icon: '📁',
    unlocked: false,
  },
  {
    id: 'going-viral',
    title: 'Going Viral',
    description: 'Reached 50 followers on The Collection Room.',
    icon: '🦋',
    unlocked: false,
  },
];

// ─── Layout constants ─────────────────────────────────────────────────────────

const SCREEN_W = Dimensions.get('window').width;

// Container height is the same as the original arc layout so PHASE2_MAX_TRANSLATE
// (546 - AVATAR_SIZE) stays correct and the identity stack doesn't shift.
const ROW_HEIGHT = 113;

// Badge pill card dimensions
const PILL_W = 130;
const PILL_H = 76;

// Center showcase badge dimensions
const BADGE_W = 116;
const BADGE_H = 94;
const BADGE_RADIUS = 20;

// Gap between pills in the scroll content
const GAP = 8;

// Badges are split 3 left / 3 right with the showcase badge spacer in the middle.
const SLOTS = 3;

// Compute the initial scroll offset so the showcase badge lines up with screen center.
//   Left content width: 3 pills + 2 gaps = 3×130 + 2×8 = 406
//   Badge center from left edge of scroll content: 406 + GAP + BADGE_W/2 = 470
const LEFT_CONTENT_W = SLOTS * PILL_W + (SLOTS - 1) * GAP;
const BADGE_CENTER_X = LEFT_CONTENT_W + GAP + BADGE_W / 2;
const INITIAL_SCROLL_X = Math.max(0, BADGE_CENTER_X - SCREEN_W / 2);

// Vertical center of the container — used to pin the showcase badge
const CX = SCREEN_W / 2;
const CY = ROW_HEIGHT / 2;

// Colors
const PILL_COLORS: [string, string] = ['rgba(14, 22, 58, 0.96)', 'rgba(4, 8, 22, 0.92)'];
const PILL_HIGHLIGHT: [string, string] = ['rgba(255,255,255,0.10)', 'transparent'];
const BADGE_HIGHLIGHT: [string, string] = ['rgba(255,255,255,0.15)', 'rgba(255,255,255,0)'];

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  avatarUri: string | null;
  showcaseBadgeUri?: string | null;
  displayName?: string;
  editMode?: boolean;
  onBadgePress?: () => void;
  onPillPress?: (id: string) => void;
  activePills?: string[];
};

// ─── HeroShowcaseRail ─────────────────────────────────────────────────────────

export function HeroShowcaseRail({
  avatarUri,
  showcaseBadgeUri,
  displayName = '',
  editMode = false,
  onBadgePress,
}: Props) {
  const initial = displayName.charAt(0).toUpperCase();
  const badgeImageUri = showcaseBadgeUri ?? avatarUri;

  // Scale animation for the showcase badge in edit mode
  const badgeScale = useRef(new Animated.Value(1)).current;
  function handleBadgePressIn() {
    Animated.timing(badgeScale, {
      toValue: 1.03,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }
  function handleBadgePressOut() {
    Animated.timing(badgeScale, {
      toValue: 1.0,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }

  const [selectedBadge, setSelectedBadge] = useState<Badge | null>(null);

  // Split into left half and right half
  const leftBadges = BADGES.slice(0, SLOTS);
  const rightBadges = BADGES.slice(SLOTS);

  function renderPill(badge: Badge) {
    return (
      <Pressable
        key={badge.id}
        onPress={() => setSelectedBadge(badge)}
        hitSlop={4}
        style={[styles.pillWrap, !badge.unlocked && styles.pillLocked]}
      >
        <LinearGradient colors={PILL_COLORS} style={styles.pill}>
          <LinearGradient
            colors={PILL_HIGHLIGHT}
            locations={[0, 0.45]}
            style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
            pointerEvents="none"
          />
          <Text style={styles.pillIcon}>{badge.icon}</Text>
          <Text style={styles.pillTitle} numberOfLines={1}>{badge.title}</Text>
        </LinearGradient>
      </Pressable>
    );
  }

  return (
    <View style={styles.outerWrap} pointerEvents="box-none">

      {/*
        Horizontal scroll rail — sits behind the showcase badge.
        zIndex 5 keeps all pills below the pinned showcase badge (zIndex 10).
        The transparent spacer in the center holds the gap where the badge sits.
        contentOffset pre-scrolls to the spacer center so the badge and spacer align.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        contentOffset={{ x: INITIAL_SCROLL_X, y: 0 }}
        style={styles.scrollRail}
        contentContainerStyle={styles.rail}
      >
        {leftBadges.map(b => renderPill(b))}

        {/* Transparent spacer — same size as the showcase badge — holds scroll geometry */}
        <View style={styles.badgeSpacer} />

        {rightBadges.map(b => renderPill(b))}
      </ScrollView>

      {/*
        Center showcase badge — absolutely pinned, never moves.
        zIndex 10 keeps it above the scroll rail so pills slide underneath.
      */}
      <View style={styles.badgeAnchor} pointerEvents="box-none">
        <Animated.View style={[styles.badgeShadow, { transform: [{ scale: badgeScale }] }]}>
          <Pressable
            onPress={editMode ? onBadgePress : undefined}
            onPressIn={editMode ? handleBadgePressIn : undefined}
            onPressOut={editMode ? handleBadgePressOut : undefined}
            style={styles.badge}
          >
            {badgeImageUri ? (
              <Image
                source={{ uri: badgeImageUri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            ) : (
              <Text style={styles.badgeInitial}>{initial}</Text>
            )}
            <LinearGradient
              colors={BADGE_HIGHLIGHT}
              locations={[0, 0.5]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {editMode && (
              <View style={styles.badgeEditOverlay} pointerEvents="none">
                <Text style={styles.badgeEditText}>Change</Text>
              </View>
            )}
          </Pressable>
        </Animated.View>
      </View>

      {/* ── Badge detail sheet ──────────────────────────────────────────────── */}
      <Modal
        visible={selectedBadge !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedBadge(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setSelectedBadge(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            {selectedBadge && (
              <>
                <Text style={styles.sheetIcon}>{selectedBadge.icon}</Text>
                <Text style={styles.sheetTitle}>{selectedBadge.title}</Text>
                <View
                  style={[
                    styles.sheetStatusPill,
                    selectedBadge.unlocked
                      ? styles.sheetStatusUnlocked
                      : styles.sheetStatusLocked,
                  ]}
                >
                  <Text style={styles.sheetStatusText}>
                    {selectedBadge.unlocked ? '✓  Unlocked' : '🔒  Locked'}
                  </Text>
                </View>
                {selectedBadge.count != null && (
                  <Text style={styles.sheetCount}>×{selectedBadge.count}</Text>
                )}
                <Text style={styles.sheetDesc}>{selectedBadge.description}</Text>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Explicit height so HeroInfo (The Card God / @tvisko) is not pushed off-screen.
  // Same as the original arc layout height → PHASE2_MAX_TRANSLATE unchanged.
  outerWrap: {
    width: SCREEN_W,
    height: ROW_HEIGHT,
    marginTop: 10,
    marginBottom: 6,
  },

  // ── Scroll rail ─────────────────────────────────────────────────────────────

  // absoluteFill so the ScrollView is constrained to outerWrap's bounds
  // and doesn't contribute extra height to the flex column.
  scrollRail: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: GAP,
    // minHeight forces vertical centering to work against the scroll container height
    minHeight: ROW_HEIGHT,
  },
  pillWrap: {
    width: PILL_W,
    height: PILL_H,
  },
  pillLocked: {
    opacity: 0.35,
  },
  pill: {
    flex: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.40,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  pillIcon: {
    fontSize: 22,
  },
  pillTitle: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  // Transparent spacer — same footprint as the showcase badge — preserves scroll geometry
  badgeSpacer: {
    width: BADGE_W,
    height: BADGE_H,
  },

  // ── Showcase badge (pinned) ─────────────────────────────────────────────────

  badgeAnchor: {
    position: 'absolute',
    top: CY - BADGE_H / 2,
    left: CX - BADGE_W / 2,
    zIndex: 10,
    elevation: 10,
  },
  badgeShadow: {
    borderRadius: BADGE_RADIUS,
    shadowColor: '#000',
    shadowOpacity: 0.50,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 7 },
    elevation: 8,
  },
  badge: {
    width: BADGE_W,
    height: BADGE_H,
    borderRadius: BADGE_RADIUS,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.24)',
    backgroundColor: '#2A2A2A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeInitial: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '700',
  },
  badgeEditOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeEditText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  // ── Badge detail sheet ──────────────────────────────────────────────────────

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingBottom: 48,
    paddingTop: 12,
    alignItems: 'center',
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: 24,
  },
  sheetIcon: {
    fontSize: 54,
    marginBottom: 12,
  },
  sheetTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 12,
    textAlign: 'center',
  },
  sheetStatusPill: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    marginBottom: 16,
  },
  sheetStatusUnlocked: {
    backgroundColor: 'rgba(34, 197, 94, 0.18)',
  },
  sheetStatusLocked: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  sheetStatusText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  sheetCount: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 14,
  },
  sheetDesc: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});

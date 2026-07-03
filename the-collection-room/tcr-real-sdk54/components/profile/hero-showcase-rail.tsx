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

// ─── Rail item data ───────────────────────────────────────────────────────────

export type RailItemType = 'stat' | 'achievement' | 'progress' | 'shortcut';

export type RailItem = {
  id: string;
  type: RailItemType;
  icon: string;
  title: string;
  value?: string;
  locked?: boolean;
  description?: string;
  action?: string;
  destination?: string;
};

const DEFAULT_ITEMS: RailItem[] = [
  { id: 'grails',        type: 'stat',        icon: '🏆', title: 'Grails',       value: '127'       },
  { id: 'collections',   type: 'stat',        icon: '📁', title: 'Collections',  value: '18'        },
  { id: 'followers',     type: 'stat',        icon: '👥', title: 'Followers',    value: '1.2K'      },
  { id: 'views',         type: 'stat',        icon: '📈', title: 'Views',        value: '4.9K'      },
  { id: 'likes',         type: 'stat',        icon: '❤️', title: 'Likes',       value: '812'       },
  { id: 'og-collector',  type: 'achievement', icon: '🥇', title: 'OG Collector'                    },
  { id: 'century-club',  type: 'achievement', icon: '💯', title: 'Century Club'                    },
  { id: 'gem-hunter',    type: 'achievement', icon: '💎', title: 'Gem Hunter'                      },
  { id: 'baseball',      type: 'progress',    icon: '⚾', title: 'Baseball',     value: '82%'       },
  { id: 'basketball',    type: 'progress',    icon: '🏀', title: 'Basketball',   value: '61%'       },
  { id: 'add-card',      type: 'shortcut',    icon: '➕', title: 'Add Card',     action: 'add-card' },
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
const PILL_COLORS: [string, string] = ['rgba(36, 36, 46, 0.86)', 'rgba(10, 10, 14, 0.80)'];
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
  items?: RailItem[];
};

// ─── HeroShowcaseRail ─────────────────────────────────────────────────────────

export function HeroShowcaseRail({
  avatarUri,
  showcaseBadgeUri,
  displayName = '',
  editMode = false,
  onBadgePress,
  items = DEFAULT_ITEMS,
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

  const [selectedItem, setSelectedItem] = useState<RailItem | null>(null);

  // Split into left half and right half
  const leftItems = items.slice(0, SLOTS);
  const rightItems = items.slice(SLOTS);

  function renderPill(item: RailItem) {
    return (
      <Pressable
        key={item.id}
        onPress={() => setSelectedItem(item)}
        hitSlop={4}
        style={[styles.pillWrap, item.locked && styles.pillLocked]}
      >
        <LinearGradient colors={PILL_COLORS} style={styles.pill}>
          <LinearGradient
            colors={PILL_HIGHLIGHT}
            locations={[0, 0.45]}
            style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
            pointerEvents="none"
          />
          {item.locked && (
            <View style={styles.pillLockBadge} pointerEvents="none">
              <Text style={styles.pillLockText}>🔒</Text>
            </View>
          )}
          <Text style={styles.pillIcon}>{item.icon}</Text>
          {item.value !== undefined && (
            <Text style={styles.pillValue}>{item.value}</Text>
          )}
          <Text style={styles.pillTitle} numberOfLines={1}>{item.title}</Text>
        </LinearGradient>
      </Pressable>
    );
  }

  function renderSheetContent(item: RailItem) {
    const fallback =
      item.type === 'stat'        ? 'Profile stat for this collector.'              :
      item.type === 'achievement' ? (item.locked
                                    ? 'Keep collecting to unlock this achievement.'
                                    : 'Collector achievement.')                     :
      item.type === 'progress'    ? 'Collection progress for this category.'        :
                                    'Quick action.';
    const desc = item.description ?? fallback;

    if (item.type === 'achievement') {
      return (
        <>
          <Text style={styles.sheetIcon}>{item.icon}</Text>
          <Text style={styles.sheetTitle}>{item.title}</Text>
          <View style={[styles.sheetStatusPill, item.locked ? styles.sheetStatusLocked : styles.sheetStatusUnlocked]}>
            <Text style={styles.sheetStatusText}>
              {item.locked ? '🔒  Locked' : '✓  Unlocked'}
            </Text>
          </View>
          <Text style={styles.sheetDesc}>{desc}</Text>
        </>
      );
    }

    return (
      <>
        <Text style={styles.sheetIcon}>{item.icon}</Text>
        <Text style={styles.sheetTitle}>{item.title}</Text>
        {item.value != null && (
          <Text style={styles.sheetCount}>{item.value}</Text>
        )}
        <Text style={styles.sheetDesc}>{desc}</Text>
      </>
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
        {leftItems.map(item => renderPill(item))}

        {/* Transparent spacer — same size as the showcase badge — holds scroll geometry */}
        <View style={styles.badgeSpacer} />

        {rightItems.map(item => renderPill(item))}
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

      {/* ── Item detail sheet ───────────────────────────────────────────────── */}
      <Modal
        visible={selectedItem !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedItem(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setSelectedItem(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            {selectedItem && renderSheetContent(selectedItem)}
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
    opacity: 0.50,
  },
  pill: {
    flex: 1,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.13)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 3,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pillLockBadge: {
    position: 'absolute',
    top: 5,
    right: 6,
  },
  pillLockText: {
    fontSize: 9,
  },
  pillIcon: {
    fontSize: 18,
  },
  pillValue: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  pillTitle: {
    color: 'rgba(255,255,255,0.80)',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
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

import { useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Animated,
  Dimensions,
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

// Must stay 113 so PHASE2_MAX_TRANSLATE (546 - AVATAR_SIZE) is unchanged.
const ROW_HEIGHT = 113;

const PILL_W = 172;
const PILL_H = 99;
const GAP = -30;

// Padding so the first (and last) pill sits centered on screen at rest.
// scrollTarget for pill i = i × (PILL_W + GAP), which is clean whole numbers.
const LEADING_PAD = Math.floor((SCREEN_W - PILL_W) / 2);

// Colors
const PILL_COLORS: [string, string] = ['rgba(16, 16, 22, 0.90)', 'rgba(4, 4, 8, 0.87)'];
const PILL_HIGHLIGHT: [string, string] = ['rgba(255,255,255,0.10)', 'transparent'];

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
  items = DEFAULT_ITEMS,
}: Props) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const [selectedItem, setSelectedItem] = useState<RailItem | null>(null);

  function renderPill(item: RailItem, index: number) {
    // At scrollX == scrollTarget the pill center aligns with SCREEN_W/2.
    const scrollTarget = index * (PILL_W + GAP);

    const scale = scrollX.interpolate({
      inputRange: [scrollTarget - PILL_W, scrollTarget, scrollTarget + PILL_W],
      outputRange: [1.0, 1.05, 1.0],
      extrapolate: 'clamp',
    });

    const opacity = scrollX.interpolate({
      inputRange: [scrollTarget - PILL_W, scrollTarget, scrollTarget + PILL_W],
      outputRange: [0.87, 1.0, 0.87],
      extrapolate: 'clamp',
    });

    return (
      <Animated.View
        key={item.id}
        style={[styles.pillWrap, { transform: [{ scale }], opacity }]}
      >
        <Pressable
          onPress={() => setSelectedItem(item)}
          hitSlop={4}
          style={[styles.pillContent, item.locked && styles.pillLocked]}
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
      </Animated.View>
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

      <Animated.ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: true },
        )}
        style={styles.scrollRail}
        contentContainerStyle={styles.rail}
      >
        {items.map((item, index) => renderPill(item, index))}
      </Animated.ScrollView>

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
  outerWrap: {
    width: SCREEN_W,
    height: ROW_HEIGHT,
    marginTop: 10,
    marginBottom: 6,
  },
  scrollRail: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_HEIGHT,
    paddingLeft: LEADING_PAD,
    paddingRight: LEADING_PAD,
  },
  pillWrap: {
    width: PILL_W,
    height: PILL_H,
    marginRight: GAP,
  },
  pillContent: {
    flex: 1,
    paddingHorizontal: 22,
    paddingVertical: 13,
  },
  pillLocked: {
    opacity: 0.50,
  },
  pill: {
    flex: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.30,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  pillLockBadge: {
    position: 'absolute',
    top: 3,
    right: 4,
  },
  pillLockText: {
    fontSize: 7,
  },
  pillIcon: {
    fontSize: 15,
  },
  pillValue: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  pillTitle: {
    color: 'rgba(255,255,255,0.80)',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    textAlign: 'center',
    paddingHorizontal: 6,
  },

  // ── Item detail sheet ─────────────────────────────────────────────────────

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

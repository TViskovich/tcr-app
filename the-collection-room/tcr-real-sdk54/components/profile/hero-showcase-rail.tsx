import { useRef } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

type PillDef = { id: string; label: string };

// Ordered: left-outer, left-inner, right-inner, right-outer
const PILL_DEFS: PillDef[] = [
  { id: 'followers', label: 'Followers' },
  { id: 'posts',     label: 'Posts' },
  { id: 'folders',   label: 'Folders' },
  { id: 'following', label: 'Following' },
];

// Deeper navy for richer collector-card feel
const PILL_COLORS: [string, string] = ['rgba(14, 22, 58, 0.96)', 'rgba(4, 8, 22, 0.92)'];
// Pill top-gloss — fades from 10% white to transparent at 45% height
const PILL_HIGHLIGHT: [string, string] = ['rgba(255,255,255,0.10)', 'transparent'];
// Badge top-edge highlight
const BADGE_HIGHLIGHT: [string, string] = ['rgba(255,255,255,0.15)', 'rgba(255,255,255,0)'];

const PILL_W = 104;
const PILL_H = 72;
const BADGE_W = 116;
const BADGE_H = 94;
const BADGE_RADIUS = 20;
const GAP = 6;

// Arc formula: badge sits at apex. Pills drop downward with distance from center.
//
//   marginTop(slot) = CENTER_OFFSET + slot × DROP_PX
//
//   CENTER_OFFSET = (BADGE_H − PILL_H) / 2 = 11 px
//     Aligns pill vertical-center to badge vertical-center when drop = 0.
//   slot = distance in pill-slots from badge (inner = 1, outer = 2)
//   DROP_PX = 10 px/slot
//
// Resulting pill-center offset below badge center:
//   inner (slot 1): +10 px
//   outer (slot 2): +20 px
//
// Pill x-distances from badge center (for reference / future animation math):
//   inner: BADGE_W/2 + GAP + PILL_W/2 = 58 + 6 + 52 = 116 px
//   outer: inner + GAP + PILL_W       = 116 + 6 + 104 = 226 px
const CENTER_OFFSET = (BADGE_H - PILL_H) / 2; // 11
const DROP_PX = 10;

type Props = {
  avatarUri: string | null;
  showcaseBadgeUri?: string | null;
  displayName?: string;
  editMode?: boolean;
  onBadgePress?: () => void;
  // Called when user taps an active pill or the center badge (id === 'grails').
  // The rail has no knowledge of routes — parents decide what to do with each id.
  onPillPress?: (id: string) => void;
  // IDs of the four surrounding pills that are interactive. The badge ('grails')
  // is always tappable when onPillPress is provided — it does not appear in this array.
  activePills?: string[];
};

export function HeroShowcaseRail({
  avatarUri,
  showcaseBadgeUri,
  displayName = '',
  editMode = false,
  onBadgePress,
  onPillPress,
  activePills = [],
}: Props) {
  const left = PILL_DEFS.slice(0, 2);  // [followers (outer), posts (inner)]
  const right = PILL_DEFS.slice(2);    // [folders (inner), following (outer)]
  const initial = displayName.charAt(0).toUpperCase();

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

  // Resolution order: custom badge → avatar → null (initials)
  const badgeImageUri = showcaseBadgeUri ?? avatarUri;

  return (
    // box-none: the rail container is touch-transparent so it never blocks vertical
    // scrolling. Only explicit Pressable children consume touch events.
    <View style={styles.rail} pointerEvents="box-none">

      {left.map((pill, i) => {
        const slot = left.length - i; // [0]=outermost→slot 2, [1]=inner→slot 1
        const marginTop = CENTER_OFFSET + slot * DROP_PX;
        const isActive = activePills.includes(pill.id);

        const pillFace = (
          <LinearGradient
            colors={PILL_COLORS}
            style={[styles.pill, !isActive && styles.pillDisabled]}
          >
            <LinearGradient
              colors={PILL_HIGHLIGHT}
              locations={[0, 0.45]}
              style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
              pointerEvents="none"
            />
            <Text style={styles.pillText}>{pill.label}</Text>
          </LinearGradient>
        );

        return isActive && onPillPress ? (
          <Pressable
            key={pill.id}
            style={{ marginTop }}
            onPress={() => onPillPress(pill.id)}
            hitSlop={6}
          >
            {pillFace}
          </Pressable>
        ) : (
          <View key={pill.id} style={{ marginTop }} pointerEvents="none">
            {pillFace}
          </View>
        );
      })}

      {/* Collector badge — visual hub of the wheel. Fully inert in view mode.
          Edit mode only: tapping opens the badge picker via onBadgePress. */}
      <View style={styles.badgeColumn}>
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
            {/* Top gloss — fades to transparent at 50%, does not affect lower half */}
            <LinearGradient
              colors={BADGE_HIGHLIGHT}
              locations={[0, 0.5]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {/* Edit overlay — dark scrim + "Change" label, only in edit mode */}
            {editMode && (
              <View style={styles.badgeEditOverlay} pointerEvents="none">
                <Text style={styles.badgeEditText}>Change</Text>
              </View>
            )}
          </Pressable>
        </Animated.View>
      </View>

      {right.map((pill, i) => {
        const slot = i + 1; // [0]=inner→slot 1, [1]=outermost→slot 2
        const marginTop = CENTER_OFFSET + slot * DROP_PX;
        const isActive = activePills.includes(pill.id);

        const pillFace = (
          <LinearGradient
            colors={PILL_COLORS}
            style={[styles.pill, !isActive && styles.pillDisabled]}
          >
            <LinearGradient
              colors={PILL_HIGHLIGHT}
              locations={[0, 0.45]}
              style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
              pointerEvents="none"
            />
            <Text style={styles.pillText}>{pill.label}</Text>
          </LinearGradient>
        );

        return isActive && onPillPress ? (
          <Pressable
            key={pill.id}
            style={{ marginTop }}
            onPress={() => onPillPress(pill.id)}
            hitSlop={6}
          >
            {pillFace}
          </Pressable>
        ) : (
          <View key={pill.id} style={{ marginTop }} pointerEvents="none">
            {pillFace}
          </View>
        );
      })}

    </View>
  );
}

// Row width: 4×104 (pills) + 116 (badge) + 4×6 (gaps) = 556px → ~83px bleed each side on 390px
const styles = StyleSheet.create({
  // box-none is set inline so the container is scroll-transparent.
  rail: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: GAP,
    marginTop: 10,
    marginBottom: 6,
  },
  pill: {
    width: PILL_W,
    height: PILL_H,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.40,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // Mute the entire pill (gradient + text + border) as one unit.
  pillDisabled: {
    opacity: 0.38,
  },
  pillText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'capitalize',
    letterSpacing: 0.3,
  },
  // Badge column: image badge stacked above the "Grails" label.
  badgeColumn: {
    alignItems: 'center',
  },
  // Shadow wrapper sits outside overflow:hidden so iOS shadow renders unclipped.
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
});

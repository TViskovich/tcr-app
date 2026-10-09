import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  FadeOutDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

// Pull distance / fling velocity past which a downward drag dismisses.
const DISMISS_DISTANCE = 60;
const DISMISS_VELOCITY = 700;

type IconName = Parameters<typeof IconSymbol>[0]['name'];

type Props = {
  onClose: () => void;
  // Row handlers. A missing handler renders that row as "Coming soon".
  onShareItem?: () => void;
  onCamera?: () => void;
  onPhotos?: () => void;
};

// Compact popover-style attachment menu anchored just above the DM
// composer (rendered by the screen inside the composer's wrapper, NOT in a
// Modal — so the composer, its draft and the floating nav stay mounted and
// visible underneath). Tap-outside is handled by the screen's backdrop;
// this handles swipe-down and its own rows.
export function AttachmentSheet({ onClose, onShareItem, onCamera, onPhotos }: Props) {
  const dragY = useSharedValue(0);

  const pan = Gesture.Pan()
    // Downward drags only, and only once clearly vertical — leaves row taps
    // untouched.
    .activeOffsetY(8)
    .failOffsetX([-15, 15])
    .onUpdate((e) => {
      dragY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(onClose)();
      } else {
        dragY.value = withSpring(0, { damping: 18, stiffness: 220 });
      }
    });

  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));

  const shareItemEnabled = !!onShareItem;

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(150)}
      style={styles.anchor}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.shadow, dragStyle]}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.handle} />

            <Row
              icon="shippingbox"
              title="Share Item"
              subtitle={shareItemEnabled ? 'Send a card or collectible' : 'Coming soon'}
              primary
              disabled={!shareItemEnabled}
              onPress={onShareItem}
            />
            <View style={styles.divider} />
            <Row
              icon="camera"
              title="Camera"
              subtitle={onCamera ? 'Take a photo' : 'Coming soon'}
              disabled={!onCamera}
              onPress={onCamera}
            />
            <View style={styles.divider} />
            <Row
              icon="photo"
              title="Photos"
              subtitle={onPhotos ? 'Choose from your library' : 'Coming soon'}
              disabled={!onPhotos}
              onPress={onPhotos}
            />

            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => [styles.cancelBtn, pressed && styles.rowPressed]}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
          {/* Tail pointing down at the paperclip. */}
          <View style={styles.tail} />
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

// Row/divider/cancel treatment mirrors components/share/share-sheet.tsx
// (the app's Share Item sheet): flat rows on the panel separated by
// hairline dividers, 44px rounded-square icon tiles, PV2 text tokens. The
// accent is limited to the primary row's icon tile.
function Row({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  primary,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const accented = primary && !disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}>
      <View style={[styles.iconWrap, accented && styles.iconWrapPrimary]}>
        <IconSymbol name={icon} size={20} color={accented ? CHAT.accent : PV2.textSecondary} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {!!subtitle && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
      </View>
      {!disabled ? <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} /> : null}
    </Pressable>
  );
}

const SHEET_RADIUS = 20;

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    bottom: '100%',
    left: 12,
    right: 56,
    marginBottom: 6,
  },
  // Neutral float shadow — same black drop the floating nav uses.
  shadow: {
    borderRadius: SHEET_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  sheet: {
    borderRadius: SHEET_RADIUS,
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    paddingHorizontal: 16,
    paddingBottom: 14,
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: 10,
    marginBottom: 6,
  },
  tail: {
    position: 'absolute',
    bottom: -6,
    left: 22,
    width: 14,
    height: 14,
    backgroundColor: PV2.panel,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: PV2.panelBorder,
    transform: [{ rotate: '45deg' }],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 11,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowDisabled: {
    opacity: 0.45,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  iconWrapPrimary: {
    backgroundColor: CHAT.accentSoft,
    borderColor: CHAT.accentBorder,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  rowSubtitle: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
  },
  // Same fill/radius/type as share-sheet's cancelButton, kept as a
  // centered button per the earlier layout request.
  cancelBtn: {
    alignSelf: 'center',
    minWidth: 160,
    marginTop: 10,
    paddingVertical: 13,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
});

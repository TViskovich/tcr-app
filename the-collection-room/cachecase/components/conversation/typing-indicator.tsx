import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';

const AVATAR_SIZE = 30;
const DOT_SIZE = 6;

function Dot({ delay }: { delay: number }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(reduceMotion ? 0.7 : 0.3);

  useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withDelay(
      delay,
      withRepeat(withSequence(withTiming(1, { duration: 360 }), withTiming(0.3, { duration: 360 })), -1),
    );
    return () => cancelAnimation(opacity);
  }, [delay, opacity, reduceMotion]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, style]} />;
}

type Props = {
  avatarUrl: string | null | undefined;
  name: string;
};

// Incoming-aligned "• • •" bubble — same row geometry as an incoming
// MessageBubble (avatar slot + dark bordered bubble), just smaller.
export function TypingIndicator({ avatarUrl, name }: Props) {
  return (
    <View style={styles.row} accessibilityLiveRegion="polite" accessibilityLabel={`${name} is typing`}>
      <View style={styles.avatarSlot}>
        <ChatAvatar uri={avatarUrl} name={name} size={AVATAR_SIZE} />
      </View>
      <View style={styles.bubble}>
        <Dot delay={0} />
        <Dot delay={160} />
        <Dot delay={320} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  avatarSlot: {
    width: AVATAR_SIZE,
    marginRight: 8,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    borderBottomLeftRadius: 6,
    backgroundColor: CHAT.incomingBg,
    borderWidth: 1,
    borderColor: CHAT.incomingBorder,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
});

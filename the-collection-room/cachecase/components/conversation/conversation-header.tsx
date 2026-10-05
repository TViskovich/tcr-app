import { StyleSheet, Text, View } from 'react-native';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { BackButton } from '@/components/ui/back-button';

type Props = {
  title: string;
  subtitle: string;
  avatarUrl: string | null | undefined;
  topInset: number;
};

// Compact glass conversation header — replaces the native Stack header for
// this route (headerShown: false is set statically in app/_layout.tsx). The
// right side is intentionally empty: no call/info actions exist yet, and the
// subtitle is a static, truthful label — there is no presence data to back
// an "Active recently" line.
export function ConversationHeader({ title, subtitle, avatarUrl, topInset }: Props) {
  return (
    <View style={[styles.outer, { paddingTop: topInset + 6 }]}>
      <View style={styles.card}>
        {/* Fallback for deep links / no history — same destination the
            native headerLeft used before this redesign. */}
        <BackButton fallbackHref="/(tabs)/messages" size={22} />
        <ChatAvatar uri={avatarUrl} name={title} size={44} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 4,
    paddingRight: 16,
    borderRadius: 26,
    backgroundColor: CHAT.glassBg,
    borderWidth: 1,
    borderColor: CHAT.glassBorder,
    borderTopColor: 'rgba(255,255,255,0.13)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
    letterSpacing: 0.1,
  },
  subtitle: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
});

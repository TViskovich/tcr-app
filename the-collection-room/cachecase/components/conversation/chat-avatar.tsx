import { StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

type Props = {
  uri: string | null | undefined;
  name: string;
  size: number;
};

// Same image-or-initial treatment as the inbox row avatar
// (app/(tabs)/messages.tsx ConversationRow), sized per call site.
export function ChatAvatar({ uri, name, size }: Props) {
  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size / 2 }]}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
      ) : (
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>
          {name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  initial: {
    fontWeight: '700',
    color: PV2.textPrimary,
  },
});

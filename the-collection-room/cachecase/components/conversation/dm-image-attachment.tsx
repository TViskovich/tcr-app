import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { dmImageCacheKey, useDmImageUrl } from '@/hooks/use-dm-image-url';
import { useAuth } from '@/lib/auth';

const MAX_WIDTH = 240;
const MAX_HEIGHT = 320;
const MIN_SIDE = 120;
const DEFAULT_ASPECT = 4 / 3; // width / height, when no size was stored

type Props = {
  storagePath: string | null;
  width: number | null;
  height: number | null;
  // Opens the full-screen viewer with the already-signed URL.
  onOpen: (url: string) => void;
};

// Fits the stored pixel size into the bubble bounds, keeping aspect ratio,
// so the frame is reserved at the right shape before the image loads.
function frameSize(width: number | null, height: number | null) {
  const aspect = width && height ? width / height : DEFAULT_ASPECT;
  let w = MAX_WIDTH;
  let h = w / aspect;
  if (h > MAX_HEIGHT) {
    h = MAX_HEIGHT;
    w = h * aspect;
  }
  return { width: Math.max(MIN_SIDE, Math.round(w)), height: Math.max(MIN_SIDE, Math.round(h)) };
}

// DM photo attachment. Neutral rounded frame in both directions (never the
// red/brand outgoing bubble) — alignment carries the sender side. The image
// is a private dm-attachments object resolved to a short-lived signed URL;
// the expo-image cacheKey is the storage path, so the on-disk cache survives
// URL rotation.
export function DmImageAttachment({ storagePath, width, height, onOpen }: Props) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const state = useDmImageUrl(storagePath);
  const size = frameSize(width, height);

  if (state.status === 'unavailable') {
    return (
      <View style={[styles.frame, styles.unavailable]} accessibilityLabel="Photo unavailable">
        <IconSymbol name="photo" size={18} color={PV2.textTertiary} />
        <Text style={styles.unavailableText}>Photo unavailable</Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={state.status === 'ready' ? () => onOpen(state.url) : undefined}
      disabled={state.status !== 'ready'}
      style={({ pressed }) => [styles.frame, size, pressed && styles.pressed]}
      accessibilityRole="imagebutton"
      accessibilityLabel="Photo. Opens full screen">
      {state.status === 'ready' && storagePath ? (
        <Image
          source={{ uri: state.url, cacheKey: dmImageCacheKey(identity, storagePath) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          cachePolicy="disk"
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: CHAT.glassBorder,
  },
  pressed: {
    opacity: 0.85,
  },
  unavailable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  unavailableText: {
    fontSize: 13,
    color: PV2.textSecondary,
  },
});

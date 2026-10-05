import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import type { DmItemPreviewState } from '@/lib/dm-attachments';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import { itemImageCacheKey } from '@/lib/private-image-cache-key';

const CARD_WIDTH = 248;
const THUMB_WIDTH = 54;
const THUMB_HEIGHT = 74;

type Props = {
  state: DmItemPreviewState;
  onOpenItem: (itemId: string) => void;
  onOpenOwner: (ownerId: string, username: string) => void;
};

// Compact shared-item card for the DM stream. Neutral elevated surface in
// both directions (never recolored red for outgoing) — the row's alignment
// carries the sender direction. Thumbnail goes through the same signed,
// compact-tier private image path as every other item tile; nothing about
// the image is stored on the message.
export function DmItemAttachmentCard({ state, onOpenItem, onOpenOwner }: Props) {
  const { session } = useAuth();
  const identity = session?.user?.id ?? 'anon';
  const preview = state.status === 'ready' ? state.preview : null;
  const { urls, servedTiers } = useSignedItemImages([preview?.primaryImageId], COMPACT_IMAGE_TIER);

  if (state.status === 'unavailable') {
    return (
      <View style={[styles.card, styles.cardMuted]} accessibilityLabel="Shared item unavailable">
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <IconSymbol name="rectangle.stack.fill" size={20} color={PV2.textTertiary} />
        </View>
        <View style={styles.body}>
          <Text style={styles.unavailableTitle}>Item unavailable</Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            This item was removed or is no longer visible.
          </Text>
        </View>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.card} accessibilityLabel="Loading shared item">
        <View style={[styles.thumb, styles.thumbEmpty]} />
        <View style={styles.body}>
          <View style={[styles.skeletonLine, { width: '70%' }]} />
          <View style={[styles.skeletonLine, { width: '45%' }]} />
        </View>
      </View>
    );
  }

  const imageUri = preview.primaryImageId ? urls.get(preview.primaryImageId) : undefined;

  return (
    <Pressable
      onPress={() => onOpenItem(preview.id)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Shared item: ${preview.title}. View item`}>
      <View style={styles.thumb}>
        {imageUri ? (
          <Image
            source={{
              uri: imageUri,
              cacheKey: itemImageCacheKey(identity, preview.primaryImageId!, COMPACT_IMAGE_TIER, servedTiers),
            }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.thumbEmpty]}>
            <IconSymbol name="rectangle.stack.fill" size={20} color={PV2.textTertiary} />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {preview.title}
        </Text>
        {!!preview.subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {preview.subtitle}
          </Text>
        )}
        {!!preview.ownerUsername && (
          <Text
            style={styles.owner}
            numberOfLines={1}
            suppressHighlighting
            onPress={() => onOpenOwner(preview.ownerId, preview.ownerUsername!)}
            accessibilityRole="link">
            @{preview.ownerUsername}
          </Text>
        )}
        <View style={styles.cta}>
          <Text style={styles.ctaText}>View Item</Text>
          <IconSymbol name="chevron.right" size={11} color={PV2.textSecondary} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 18,
    backgroundColor: CHAT.glassBg,
    borderWidth: 1,
    borderColor: CHAT.glassBorder,
    borderTopColor: 'rgba(255,255,255,0.13)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardMuted: {
    shadowOpacity: 0,
    elevation: 0,
  },
  thumb: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PV2.panel,
  },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: CHAT.controlBorder,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  unavailableTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  subtitle: {
    fontSize: 12.5,
    color: PV2.textSecondary,
  },
  owner: {
    fontSize: 12.5,
    color: PV2.textTertiary,
    alignSelf: 'flex-start',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 4,
  },
  ctaText: {
    fontSize: 12,
    fontWeight: '600',
    color: PV2.textSecondary,
  },
  skeletonLine: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginVertical: 3,
  },
});

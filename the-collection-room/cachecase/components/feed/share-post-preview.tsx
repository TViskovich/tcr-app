import { StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import { CardSharePostBody } from '@/components/feed/card-share-post-body';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import type { CardShareItem } from '@/types';

type Props = {
  avatarUrl: string | null;
  displayName: string;
  username: string;
  caption: string;
  cards: CardShareItem[];
};

// Lightweight "what this will look like in Feed" preview for the Share Card
// compose flow (app/share-card/new.tsx) — NOT the real PostCard (that
// component is built around a fully-fetched FeedPost row, with like/
// comment/rating state and handlers that make no sense before a post
// exists). This reuses the one piece of Feed's actual rendering that's
// both non-trivial and directly reusable as-is — CardSharePostBody's real
// swipeable carousel, dot indicator, and per-slide title/subtitle overlay
// — rather than re-implementing any of that. Everything else here (the
// small header row, caption line, card frame) is intentionally simple,
// static markup: a visual approximation, not an interactive Feed card.
export function SharePostPreview({ avatarUrl, displayName, username, caption, cards }: Props) {
  if (cards.length === 0) return null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{(displayName || '?').charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </View>
        <View style={styles.identity}>
          <Text style={styles.displayName} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            @{username}
          </Text>
        </View>
      </View>

      {caption.trim() ? <Text style={styles.caption}>{caption.trim()}</Text> : null}

      {/* Same aspectRatio as PostCard's own cardImageWrap, so the preview's
          proportions match what the real Feed card will actually be. */}
      <View style={styles.mediaWrap}>
        <CardSharePostBody cards={cards} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: PV2.panel,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    borderRadius: 14,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  identity: {
    flex: 1,
  },
  displayName: {
    color: PV2.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  username: {
    color: PV2.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  caption: {
    color: PV2.textPrimary,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  mediaWrap: {
    aspectRatio: 5 / 7,
    backgroundColor: PV2.collectorPanelBg,
    overflow: 'hidden',
  },
});

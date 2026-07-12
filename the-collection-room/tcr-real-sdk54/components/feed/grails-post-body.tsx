import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';

import type { RateMyGrailCard } from '@/types';

const SCORES = Array.from({ length: 10 }, (_, i) => i + 1);

type Props = {
  cards: RateMyGrailCard[];
  caption?: string | null;
  avg: number | null;
  count: number;
  myRating: number | null;
  isOwner: boolean;
  submitting: boolean;
  onRate: (score: number) => void;
};

// Renders a Rate My Grails post's body — the snapshot grid plus the average/
// rating control. Used identically by the feed's PostCard and the post
// detail page (post/[id].tsx), so the two surfaces never drift apart.
export function GrailsPostBody({
  cards,
  caption,
  avg,
  count,
  myRating,
  isOwner,
  submitting,
  onRate,
}: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {cards.map((card) => (
          <Pressable
            key={card.id}
            style={styles.slot}
            disabled={!card.item_id}
            onPress={() =>
              card.item_id && router.push({ pathname: '/item/[id]', params: { id: card.item_id } })
            }>
            {card.snapshot_image_url ? (
              <Image
                source={{ uri: card.snapshot_image_url }}
                style={styles.image}
                contentFit="cover"
                transition={200}
              />
            ) : (
              <View style={styles.noImage}>
                <Text style={styles.noImageText} numberOfLines={2}>
                  {card.snapshot_title ?? '—'}
                </Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      {caption ? <Text style={styles.caption}>{caption}</Text> : null}

      <View style={styles.ratingSummary}>
        <Text style={styles.ratingLabel}>Rate My Grails</Text>
        {count > 0 ? (
          <>
            <Text style={styles.ratingScore}>{(avg ?? 0).toFixed(1)} / 10</Text>
            <Text style={styles.ratingCount}>
              Based on {count} rating{count === 1 ? '' : 's'}
            </Text>
          </>
        ) : (
          <Text style={styles.ratingCount}>No ratings yet</Text>
        )}
      </View>

      {!isOwner &&
        (expanded ? (
          <View style={styles.chipRow}>
            {SCORES.map((score) => (
              <Pressable
                key={score}
                disabled={submitting}
                style={[styles.chip, myRating === score && styles.chipActive]}
                onPress={() => {
                  onRate(score);
                  setExpanded(false);
                }}>
                <Text style={[styles.chipText, myRating === score && styles.chipTextActive]}>
                  {score}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Pressable style={styles.rateToggle} onPress={() => setExpanded(true)}>
            <Text style={styles.rateToggleText}>
              {myRating !== null ? `Your rating: ${myRating} — Edit` : 'Rate this'}
            </Text>
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  slot: {
    width: '31%',
    aspectRatio: 3 / 4,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111111',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  noImage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  noImageText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.34)',
    textAlign: 'center',
  },
  caption: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
  },
  ratingSummary: {
    gap: 2,
    alignItems: 'center',
  },
  ratingLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
  },
  ratingScore: {
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  ratingCount: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
    textAlign: 'center',
  },
  rateToggle: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  rateToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
  },
  chip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  chipActive: {
    backgroundColor: '#0a7ea4',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.70)',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
});

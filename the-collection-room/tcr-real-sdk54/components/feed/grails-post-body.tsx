import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

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

  // Marker position along the 1–10 scale, derived from the real average.
  const clampedAvg = avg != null ? Math.min(10, Math.max(1, avg)) : 1;
  const markerPercent = ((clampedAvg - 1) / 9) * 100;

  return (
    <View style={styles.wrap}>
      {/* Compact showcase header — restrained, no emoji, flanked by two
          small diamond ornaments. */}
      <View style={styles.showcaseHeaderRow}>
        <View style={styles.diamond} />
        <Text style={styles.showcaseHeaderText}>Rate My Grails</Text>
        <View style={styles.diamond} />
      </View>

      {/* Showcase panel — its own inset surface, distinct from the post
          card behind it. A single soft radial wash sits behind the grid,
          strongest at center and fading outward — doubles as the panel's
          ambient lighting and the center card's atmosphere, so there's
          only one glow layer rather than several stacked ones. */}
      <View style={styles.panel}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%">
            <Defs>
              <RadialGradient id="grailGlow" cx="50%" cy="44%" r="62%">
                <Stop offset="0%" stopColor="#D6AA3E" stopOpacity={0.12} />
                <Stop offset="100%" stopColor="#D6AA3E" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect x={0} y={0} width="100%" height="100%" fill="url(#grailGlow)" />
          </Svg>
        </View>

        <View style={styles.grid}>
          {cards.map((card) => (
            <View key={card.id} style={styles.slotShadow}>
              <Pressable
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
            </View>
          ))}
        </View>
      </View>

      {caption ? <Text style={styles.caption}>{caption}</Text> : null}

      <View style={styles.ratingSection}>
        <Text style={styles.ratingSectionLabel}>Community Rating</Text>
        {count > 0 ? (
          <>
            <Text style={styles.ratingScore}>{(avg ?? 0).toFixed(1)}</Text>
            <Text style={styles.outOfLabel}>Out of 10</Text>
            <Text style={styles.ratingCount}>
              Based on {count} rating{count === 1 ? '' : 's'}
            </Text>

            {/* Restrained 1–10 scale — marker derived from the real average. */}
            <View style={styles.scaleWrap}>
              <Text style={styles.scaleEndpoint}>1</Text>
              <View style={styles.scaleTrack}>
                <View style={[styles.scaleMarker, { left: `${markerPercent}%` }]} />
              </View>
              <Text style={styles.scaleEndpoint}>10</Text>
            </View>
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
              {myRating !== null ? `Your rating: ${myRating} — Edit` : 'Rate This Collection'}
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
  },

  // ── Showcase header ────────────────────────────────────────────
  showcaseHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 12,
  },
  showcaseHeaderText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    letterSpacing: 2.6,
    color: 'rgba(214,170,62,0.88)',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  diamond: {
    width: 5,
    height: 5,
    backgroundColor: 'rgba(214,170,62,0.55)',
    transform: [{ rotate: '45deg' }],
  },

  // ── Showcase panel ─────────────────────────────────────────────
  panel: {
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: 'rgba(201,154,43,0.34)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 18,
    marginBottom: 16,
    overflow: 'hidden',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },

  // ── Card frames ────────────────────────────────────────────────
  // Split into an outer shadow-casting wrapper (no overflow:'hidden', so
  // the shadow isn't clipped) and an inner frame that clips the image to
  // its rounded corners — same pattern used elsewhere in this app for
  // shadow + rounded-corner combinations.
  slotShadow: {
    width: '31%',
    aspectRatio: 3 / 4,
    borderRadius: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.24,
    shadowRadius: 8,
    elevation: 4,
  },
  slot: {
    flex: 1,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: '#101010',
    borderWidth: 1,
    borderColor: 'rgba(219,174,59,0.64)',
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
    marginBottom: 14,
  },

  // ── Rating hierarchy ───────────────────────────────────────────
  ratingSection: {
    alignItems: 'center',
    marginBottom: 18,
  },
  ratingSectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    color: 'rgba(255,255,255,0.54)',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  ratingScore: {
    fontSize: 38,
    lineHeight: 42,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: 4,
  },
  outOfLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.8,
    color: 'rgba(214,170,62,0.82)',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  ratingCount: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.52)',
    textAlign: 'center',
    marginTop: 6,
  },

  // ── 1–10 scale ─────────────────────────────────────────────────
  scaleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    width: '70%',
  },
  scaleEndpoint: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.38)',
  },
  scaleTrack: {
    flex: 1,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  scaleMarker: {
    position: 'absolute',
    top: -3,
    marginLeft: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#D6AA3E',
  },

  // ── CTA ────────────────────────────────────────────────────────
  rateToggle: {
    alignSelf: 'center',
    minWidth: 190,
    height: 46,
    paddingHorizontal: 24,
    borderRadius: 23,
    backgroundColor: 'rgba(214,170,62,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(214,170,62,0.58)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateToggleText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E7BD4D',
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

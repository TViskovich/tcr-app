import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { ShowcaseItem } from '@/types';

type Props = {
  item: ShowcaseItem;
  onPress?: () => void;
};

export function GrailsSlot({ item, onPress }: Props) {
  return (
    // Layer 1: outer glow/shadow ring.
    // width:'32%' — grid's space-between math depends on this value.
    // No overflow:'hidden' — would clip the shadow.
    <View style={styles.shadowWrap}>

      {/* Layer 2: slot frame — dark bg, gold border, padding creates ceiling strip. */}
      <Pressable
        style={({ pressed }) => [styles.slotFrame, pressed && styles.pressed]}
        onPress={onPress}>

        {/* Top spotlight — absolute, sits in dark ceiling strip above the card.
            Shadow cast downward creates a warm display-light spill onto the image. */}
        <View style={styles.topSpotWrap}>
          <View style={styles.topSpot} />
        </View>

        {/* Layer 3: image clip. overflow:'hidden' rounds the card corners. */}
        <View style={styles.innerCard}>
          {item.item.image_url ? (
            <Image
              source={{ uri: item.item.image_url }}
              style={styles.image}
              contentFit="cover"
              transition={200}
            />
          ) : (
            <View style={styles.noImage}>
              <Text style={styles.noImageText} numberOfLines={2}>
                {item.item.title ?? '—'}
              </Text>
            </View>
          )}
        </View>

        {/* Bottom reflection — subtle upward glow, mimics floor reflection
            in a lit display case. */}
        <View style={styles.bottomSpotWrap}>
          <View style={styles.bottomSpot} />
        </View>

      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Layer 1: outer glow / shadow ──────────────────────────────
  // Every Grail gets the same bright gold display-case glow.
  // Opacity 0.62 (not max) so all 9 in a grid don't visually compete.
  shadowWrap: {
    width: '32%',
    borderRadius: 12,
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.62,
    shadowRadius: 16,
    elevation: 16,
  },

  // ── Layer 2: slot frame ───────────────────────────────────────
  // Bright gold border on every card. paddingTop/Bottom create
  // the dark ceiling and floor strips for spotlight effects.
  slotFrame: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 208, 0, 0.78)',
    backgroundColor: '#111111',
    paddingHorizontal: 4,
    paddingTop: 11,
    paddingBottom: 6,
  },
  pressed: {
    opacity: 0.68,
  },

  // ── Top spotlight ─────────────────────────────────────────────
  // Centered via wrapping View. Shadow points downward onto the card face.
  topSpotWrap: {
    position: 'absolute',
    top: 3,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  topSpot: {
    width: 22,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 246, 190, 0.90)',
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1.0,
    shadowRadius: 12,
    elevation: 12,
  },

  // ── Layer 3: image ────────────────────────────────────────────
  // width:'100%' fills slotFrame minus paddingHorizontal.
  // aspectRatio derives height from that resolved width — no explicit height needed.
  innerCard: {
    borderRadius: 8,
    overflow: 'hidden',
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#0A0806',
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
    color: 'rgba(255, 255, 255, 0.34)',
    textAlign: 'center',
  },

  // ── Bottom reflection ─────────────────────────────────────────
  // shadowOffset points upward — mimics a subtle floor reflection.
  bottomSpotWrap: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  bottomSpot: {
    width: 14,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 215, 80, 0.26)',
    shadowColor: '#FFE060',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.42,
    shadowRadius: 6,
    elevation: 4,
  },
});

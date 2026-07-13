import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { PremiumCardHeader, PremiumEmptyCard, VAULT_COLORS } from '@/components/ui/premium-empty-card';
import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress?: (item: ShowcaseItem) => void;
  onCabinetPress?: () => void;
  onAddFirstGrail?: () => void;
  vaultMargin?: number;
};

const COLS = 3;
const MAX_SLOTS = 9;

export function GrailsGrid({
  grails,
  editable = false,
  onItemPress,
  onCabinetPress,
  onAddFirstGrail,
  vaultMargin = 14,
}: Props) {
  // Explicit pixel width ensures identical screen-edge margins regardless of parent padding.
  const { width: screenWidth } = useWindowDimensions();
  const vaultWidth = screenWidth - vaultMargin * 2;

  // Press animation — declared before early return to satisfy Rules of Hooks.
  const pressScale = useRef(new Animated.Value(1)).current;
  const pressOpacity = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.parallel([
      Animated.spring(pressScale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 0 }),
      Animated.timing(pressOpacity, { toValue: 0.65, duration: 100, useNativeDriver: true }),
    ]).start();
  }

  function handlePressOut() {
    Animated.parallel([
      Animated.spring(pressScale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 5 }),
      Animated.timing(pressOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
  }

  // ── Zero state ────────────────────────────────────────────────
  if (grails.length === 0) {
    if (!editable) return null;

    return (
      <PremiumEmptyCard
        title="GRAILS"
        heading={"A grail isn't just rare.\nIt's personal."}
        body="Every collector has one."
        ctaLabel="➕ Add First Grail"
        onCtaPress={onAddFirstGrail}
        vaultMargin={vaultMargin}
      />
    );
  }

  // ── Filled grid ───────────────────────────────────────────────
  const slots = grails.slice(0, MAX_SLOTS);

  // Split into rows of 3 so each row can choose its own justifyContent.
  const rows: ShowcaseItem[][] = [];
  for (let i = 0; i < slots.length; i += COLS) {
    rows.push(slots.slice(i, i + COLS));
  }

  // Gap between cards in a full row: cards are 32% wide, so 3 cards = 96%,
  // leaving 4% split across 2 gaps = 2% each. Used as explicit gap on partial rows.
  const gridWidth = vaultWidth - 20; // vault has paddingHorizontal: 10 each side
  const cardGap = Math.round(gridWidth * 0.02);

  const vault = (
    // Outer View: subtle shadow ring. No overflow:'hidden' — clips shadow.
    <View style={[styles.vaultShadow, { width: vaultWidth, alignSelf: 'center' }]}>
      {/* Inner gradient: overflow:'hidden' clips gradient to border radius. */}
      <LinearGradient colors={VAULT_COLORS} style={styles.vault} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
        <PremiumCardHeader title="GRAILS" />
        <View style={styles.grid}>
          {rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[
                styles.row,
                row.length === COLS ? styles.rowFull : { justifyContent: 'center', gap: cardGap },
              ]}>
              {row.map((item) => (
                <GrailsSlot
                  key={item.id}
                  item={item}
                  // When the whole cabinet is tappable, individual slots are passive.
                  onPress={onCabinetPress ? undefined : () => onItemPress?.(item)}
                />
              ))}
            </View>
          ))}
        </View>
      </LinearGradient>
    </View>
  );

  return onCabinetPress ? (
    <Pressable
      onPress={onCabinetPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}>
      <Animated.View style={{ transform: [{ scale: pressScale }], opacity: pressOpacity }}>
        {vault}
      </Animated.View>
    </Pressable>
  ) : vault;
}

const styles = StyleSheet.create({
  // ── Vault panel ───────────────────────────────────────────────
  // Width is set dynamically (14px margin each side). No marginHorizontal here.
  // Shadow kept minimal — cards are the visual focus, not the container.
  vaultShadow: {
    marginTop: 16,
    marginBottom: 8,
    borderRadius: 20,
    shadowColor: '#B8860B',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 3,
  },
  vault: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(180, 128, 20, 0.30)',
    paddingHorizontal: 10,
    paddingTop: 14,
    paddingBottom: 14,
  },

  // ── Row-based grid ────────────────────────────────────────────
  // Each row is its own View so partial rows can be centered independently.
  grid: {
    gap: 8, // vertical gap between rows
  },
  row: {
    flexDirection: 'row',
  },
  // Full 3-card rows use space-between so cards sit at the edges with even gaps.
  rowFull: {
    justifyContent: 'space-between',
  },
});

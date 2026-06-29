import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress?: (item: ShowcaseItem) => void;
  onCabinetPress?: () => void;
  vaultMargin?: number;
};

const COLS = 3;
const MAX_SLOTS = 9;

// Warm near-black — aged wood / display case felt
const VAULT_COLORS = ['#1A1510', '#0F0D09', '#080604'] as const;

export function GrailsGrid({ grails, editable = false, onItemPress, onCabinetPress, vaultMargin = 14 }: Props) {
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
      <View style={[styles.vaultShadow, { width: vaultWidth, alignSelf: 'center' }]}>
        <LinearGradient colors={VAULT_COLORS} style={styles.vault} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
          <VaultHeader />
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Showcase your favorite cards here.</Text>
            <Text style={styles.emptyBody}>Add your first Grail from any item page.</Text>
          </View>
        </LinearGradient>
      </View>
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
        <VaultHeader />
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

function VaultHeader() {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>🏆 GRAILS 🏆</Text>
      {/* Thin gold lines flanking the diamond per spec */}
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.diamond}>◆</Text>
        <View style={styles.dividerLine} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Vault panel ───────────────────────────────────────────────
  // Width is set dynamically (14px margin each side). No marginHorizontal here.
  // Shadow kept minimal — cards are the visual focus, not the container.
  vaultShadow: {
    marginTop: -14,
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

  // ── Header ────────────────────────────────────────────────────
  header: {
    alignItems: 'center',
    marginBottom: 12,
    gap: 4,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#D4A520',
    letterSpacing: 4,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dividerLine: {
    width: 28,
    height: 0.5,
    backgroundColor: 'rgba(212, 165, 32, 0.55)',
  },
  diamond: {
    fontSize: 8,
    color: 'rgba(212, 165, 32, 0.70)',
    lineHeight: 10,
  },
  subtitle: {
    fontSize: 11,
    fontStyle: 'italic',
    color: 'rgba(200, 158, 58, 0.62)',
    letterSpacing: 0.3,
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

  // ── Empty state ───────────────────────────────────────────────
  emptyState: {
    paddingVertical: 18,
    alignItems: 'center',
    gap: 6,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.58)',
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.34)',
    textAlign: 'center',
  },
});

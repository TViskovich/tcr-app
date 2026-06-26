import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { GrailsSlot } from '@/components/profile/grails-slot';
import type { ShowcaseItem } from '@/types';

type Props = {
  grails: ShowcaseItem[];
  editable?: boolean;
  onItemPress: (item: ShowcaseItem) => void;
};

const COLS = 3;
const MAX_SLOTS = 9;

// Warm near-black — aged wood / display case felt
const VAULT_COLORS = ['#1A1510', '#0F0D09', '#080604'] as const;

export function GrailsGrid({ grails, editable = false, onItemPress }: Props) {
  // Explicit pixel width ensures identical screen-edge margins (14px) regardless
  // of which profile screen renders this — each has different parent padding.
  const { width: screenWidth } = useWindowDimensions();
  const vaultWidth = screenWidth - 28; // 14px margin each side

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
  const remainder = slots.length % COLS;
  const spacers = remainder === 0 ? 0 : COLS - remainder;

  return (
    // Outer View: subtle shadow ring. No overflow:'hidden' — clips shadow.
    <View style={[styles.vaultShadow, { width: vaultWidth, alignSelf: 'center' }]}>
      {/* Inner gradient: overflow:'hidden' clips gradient to border radius. */}
      <LinearGradient colors={VAULT_COLORS} style={styles.vault} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}>
        <VaultHeader />
        <View style={styles.grid}>
          {slots.map((item) => (
            <GrailsSlot
              key={item.id}
              item={item}
              onPress={() => onItemPress(item)}
            />
          ))}
          {/* Invisible spacers keep space-between aligned on partial last rows */}
          {Array.from({ length: spacers }).map((_, i) => (
            <View key={`spacer-${i}`} style={styles.spacer} />
          ))}
        </View>
      </LinearGradient>
    </View>
  );
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

  // ── 3-column grid ─────────────────────────────────────────────
  // space-between distributes ~4% leftover (~7px) evenly as column gaps.
  // rowGap lets the dark vault background show through between rows.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 8,
  },
  // Invisible spacer — same width as a card slot.
  // Keeps space-between alignment correct when last row is incomplete.
  spacer: {
    width: '32%',
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

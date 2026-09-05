import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { PV2 } from './profile-v2-theme';

// Left-to-right neon signature — cyan/blue into purple into pink. A
// horizontal (not diagonal) 3-stop gradient, distinct from
// ProfileV2Selector's diagonal IRIDESCENT_BORDER: this card's border reads
// left-to-right on purpose, matching the reference design.
const NEON_BORDER = ['#3FD8FF', '#8B5CF6', '#FF5FA2'] as const;

const BORDER_WIDTH = 2.5;
// Square, 90°-corner frame — no rounding anywhere in this card, outer
// border or inner content.
const RADIUS = 0;
// The whole row's height — the avatar block below fills it edge-to-edge
// (no padding around it, per the reference), so this is also the avatar's
// own height.
const CARD_HEIGHT = 80;
// Wide, not square — roughly matches the reference's photo proportions,
// deliberately much wider than a typical circular-avatar footprint.
const AVATAR_WIDTH = 116;
const CACHECASE_LOGO_HEIGHT = 33;

// No dedicated account/collector-number column exists on Profile yet (see
// types/index.ts) — this derives a stable, real, per-user display code from
// the profile's own id (a UUID) rather than inventing a fake number. Not a
// substitute for a real "member number" column if one gets added later.
function accountCodeFromId(id: string): string {
  return id.replace(/-/g, '').slice(-6).toUpperCase();
}

type Props = {
  username: string;
  // Collector/display title — callers pass the same hero_display_name →
  // display_name → username fallback already used elsewhere on this screen.
  title: string;
  itemCount: number;
  avatarUri: string | null;
  profileId: string;
  // Owner-only avatar tap target, same convention as the collector panel
  // this replaces — omitted entirely for a visitor, leaving the avatar
  // non-interactive.
  onAvatarPress?: () => void;
};

// Compact horizontal identity header — Profile V3's shared top shell. A
// wide, edge-to-edge rectangular avatar fills the full left side (not a
// small padded/circular one), username/title/item count stacked center,
// CacheCase mark + account code on the right — read as a collector
// credential/pass rather than a social hero banner. Intentionally small and
// self-contained: no scroll/section logic, no data fetching, just
// presentation over props the caller already has.
export function ProfileV2IdentityCard({ username, title, itemCount, avatarUri, profileId, onAvatarPress }: Props) {
  const acctCode = accountCodeFromId(profileId);

  return (
    <LinearGradient
      colors={NEON_BORDER}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.borderWrap}>
      <View style={styles.card}>
        <Pressable
          style={styles.avatar}
          onPress={onAvatarPress}
          disabled={!onAvatarPress}
          accessibilityRole={onAvatarPress ? 'button' : undefined}
          accessibilityLabel={onAvatarPress ? 'Change profile photo' : undefined}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{(username || '?').charAt(0).toUpperCase()}</Text>
            </View>
          )}
        </Pressable>

        <View style={styles.middleCol}>
          <View style={styles.nameGroup}>
            <Text style={styles.username} numberOfLines={1}>@{username}</Text>
            {title ? (
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
            ) : null}
          </View>
          <View style={styles.itemsRow}>
            <Text style={styles.itemsLabel}>ITEMS</Text>
            <Text style={styles.itemsValue}>{itemCount}</Text>
          </View>
        </View>

        {/* One grouped brand block — logo upper, ACCT# directly beneath it
            — rather than the logo alone with ACCT# detached elsewhere in
            the card, so the two visually belong together. */}
        <View style={styles.rightCol}>
          <CacheCaseLogo variant="light" size={CACHECASE_LOGO_HEIGHT} placement="header" />
          <Text style={styles.acctText}>ACCT# {acctCode}</Text>
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  // Gradient rect showing through as the card's thin border — same
  // padding-equals-border-width trick as ProfileV2Selector's cachecaseBorder.
  borderWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: RADIUS,
    padding: BORDER_WIDTH,
  },
  // No padding of its own — the avatar below is meant to sit flush against
  // the top/left/bottom edges (only the middle/right columns carry their
  // own inset). Fixed CARD_HEIGHT rather than content-driven, since the
  // avatar needs a concrete height to fill edge-to-edge.
  card: {
    flexDirection: 'row',
    height: CARD_HEIGHT,
    borderRadius: RADIUS,
    backgroundColor: PV2.bg,
    overflow: 'hidden',
  },
  avatar: {
    width: AVATAR_WIDTH,
    height: '100%',
    backgroundColor: '#2A2A2A',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  // Split top (username/title) vs bottom (ITEMS) via space-between, with
  // the same paddingTop/paddingBottom as rightCol below — so ITEMS lines up
  // with ACCT# at the same distance from the card's bottom edge, and
  // username lines up with the logo at the same distance from the top.
  middleCol: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  nameGroup: {
    gap: 3,
  },
  username: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  title: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '400',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  itemsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  itemsLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  itemsValue: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 9,
    fontWeight: '700',
  },
  // Logo pinned toward the top, ACCT# toward the bottom — matches the
  // reference's rhythm, where the logo sits near the card's top edge and
  // ACCT# sits near the bottom, roughly level with ITEMS on the left,
  // rather than the two floating together as a centered pair.
  // flex-start (not flex-end) is deliberate: the cropped
  // cachecase-wordmark-nav.png asset's own left edge already lines up with
  // the "case" line's left edge (the "cache" line above it is the one
  // that's indented), so left-aligning ACCT# to the logo's shrink-wrapped
  // box lines its own left edge up with "Case" — an intentional visual
  // match, not a numeric one (ACCT# is shorter than the logo either way).
  rightCol: {
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  acctText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});

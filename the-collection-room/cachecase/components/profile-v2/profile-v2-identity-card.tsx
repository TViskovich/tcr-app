import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { GRID_CELL_WIDTH, GRID_HORIZONTAL_MARGIN } from './profile-v2-grid';
import { PV2 } from './profile-v2-theme';

// Left-to-right neon signature — cyan/blue into purple into pink. A
// horizontal (not diagonal) 3-stop gradient, distinct from
// ProfileV2Selector's diagonal IRIDESCENT_BORDER: this card's border reads
// left-to-right on purpose, matching the reference design. Pink stop
// pushed more saturated/magenta (was #FF5FA2, a softer rose) to match a
// later reference screenshot more closely — cyan/purple were already close.
const NEON_BORDER = ['#2DD4FF', '#8B5CF6', '#FF3CAC'] as const;

const BORDER_WIDTH = 4;
// Square, 90°-corner frame — no rounding anywhere in this card, outer
// border or inner content.
const RADIUS = 0;
// The whole row's height — the avatar block below fills it edge-to-edge
// (no padding around it, per the reference), so this is also the avatar's
// own height.
const CARD_HEIGHT = 80;
// Right-edge alignment fix: was a fixed 136 (116 + a 20px compensation for
// `card`'s removed left padding — see BORDER_WIDTH_LEFT's own comment
// below for that history). A fixed width can only coincidentally match the
// Grails grid's first cell's own right edge, since GRID_CELL_WIDTH (see
// profile-v2-grid.tsx) is a device-width-proportional fraction, not a
// fixed value — on narrower devices 136 overshoots past the grid's right
// edge (the reported bug: the photo visibly wider than the card below
// it), on wider devices it would undershoot instead. Importing
// GRID_CELL_WIDTH directly (rather than tuning a second hardcoded number
// to approximate it) guarantees the photo's right edge lands exactly on
// the first grid cell's right edge on every device width, the same way
// BORDER_WIDTH_LEFT already guarantees their LEFT edges match.
const AVATAR_WIDTH = GRID_CELL_WIDTH;
// Alignment fix: `borderWrap`'s own padding (BORDER_WIDTH, the gradient
// border's thickness) insets EVERYTHING inside it — including the avatar,
// which has no paddingLeft of its own — by BORDER_WIDTH from the screen's
// left edge. The Grails/card grid directly below this card
// (profile-v2-grid.tsx) insets its own first column by the smaller
// GRID_HORIZONTAL_MARGIN instead, so the two left edges landed 1dp apart.
// Used as borderWrap's own paddingLeft (replacing BORDER_WIDTH on that one
// side only — see borderWrap below) so `card`, and therefore the avatar
// inside it, starts exactly GRID_HORIZONTAL_MARGIN from the screen edge,
// same as the grid's first column. A plain negative margin on the avatar
// itself can't do this: `card` has overflow: 'hidden', so anything pulled
// left of `card`'s own left edge would simply be clipped, not moved.
// GRID_HORIZONTAL_MARGIN is imported, not duplicated, so the two can never
// drift out of sync again. Top/right/bottom border thickness (BORDER_WIDTH)
// is untouched — only the left edge's rendered gradient sliver narrows by
// the same 1dp the avatar moves, which is what actually closes the gap.
const BORDER_WIDTH_LEFT = GRID_HORIZONTAL_MARGIN;
// Right-side inset for rightCol's content (logo/ACCT#) off the inside of
// the right gradient border — the ONLY source of that gap (rightCol
// itself no longer contributes its own right-side padding; see rightCol's
// paddingLeft-only spec below), so this one value is exactly the visual
// gap between the logo/ACCT# and the border.
const CARD_PADDING_RIGHT = 10;
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
  // Toggles the expanded profile-details panel the caller renders directly
  // below this card (profile-v2-screen.tsx's ProfileV2ExpandedDetails).
  // The avatar keeps its own nested Pressable above (RN's responder system
  // gives a tap inside it to that Pressable, never bubbling out to this
  // one), so avatar-editing and expand/collapse never conflict.
  onPress?: () => void;
  expanded?: boolean;
};

// Compact horizontal identity header — Profile V3's shared top shell. A
// wide, edge-to-edge rectangular avatar fills the full left side (not a
// small padded/circular one), username/title/item count stacked center,
// CacheCase mark + account code on the right — read as a collector
// credential/pass rather than a social hero banner. Intentionally small and
// self-contained: no scroll/section logic, no data fetching, just
// presentation over props the caller already has.
export function ProfileV2IdentityCard({
  username,
  title,
  itemCount,
  avatarUri,
  profileId,
  onAvatarPress,
  onPress,
  expanded,
}: Props) {
  const acctCode = accountCodeFromId(profileId);

  return (
    <LinearGradient
      colors={NEON_BORDER}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.borderWrap}>
      <Pressable
        style={styles.card}
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityState={onPress ? { expanded: !!expanded } : undefined}
        accessibilityLabel={onPress ? 'Profile details' : undefined}>
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
      </Pressable>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  // Gradient rect showing through as the card's border — same
  // padding-equals-border-width trick as ProfileV2Selector's cachecaseBorder.
  // BORDER_WIDTH (4) is the sole source of the border's visible thickness on
  // top/right/bottom; `card` beneath it has a fixed CARD_HEIGHT and its own
  // opaque background, so thickening this padding only grows borderWrap's
  // own outer frame — it never squeezes or shifts any of card's inner
  // content (avatar/text/logo/ACCT#), which is sized and positioned
  // independently. No marginHorizontal — the header runs edge-to-edge
  // across the screen; `card`'s own paddingRight is what keeps rightCol off
  // the right screen edge (the avatar deliberately has no matching left
  // inset — see `card` below). paddingLeft is BORDER_WIDTH_LEFT, not
  // BORDER_WIDTH — narrowed to exactly GRID_HORIZONTAL_MARGIN so `card`
  // (and the avatar flush against its left edge) starts at the same
  // distance from the screen edge as the Grails/card grid's first column
  // below it, instead of BORDER_WIDTH's slightly wider inset (see
  // BORDER_WIDTH_LEFT's own comment). The border's visible thickness is
  // therefore ~1dp narrower on the left edge only than on the other three;
  // every other edge is untouched.
  borderWrap: {
    marginTop: 12,
    borderRadius: RADIUS,
    paddingTop: BORDER_WIDTH,
    paddingRight: BORDER_WIDTH,
    paddingBottom: BORDER_WIDTH,
    paddingLeft: BORDER_WIDTH_LEFT,
  },
  // paddingRight (not paddingHorizontal) keeps rightCol's content off the
  // right screen edge now that borderWrap runs full-width. Deliberately no
  // paddingLeft: the avatar is this row's first child, so with no left
  // inset here it starts flush against the card's own left edge — i.e.
  // flush against the inside of the gradient border, no blank gap (see
  // AVATAR_WIDTH's own comment above for how its right edge is now kept
  // aligned to the grid below instead). paddingVertical is 0 so the avatar's
  // height: '100%' still fills the row edge-to-edge top/bottom, matching
  // the reference. Fixed CARD_HEIGHT rather than content-driven, since the
  // avatar needs a concrete height to fill edge-to-edge.
  card: {
    flexDirection: 'row',
    height: CARD_HEIGHT,
    borderRadius: RADIUS,
    backgroundColor: PV2.bg,
    overflow: 'hidden',
    paddingRight: CARD_PADDING_RIGHT,
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
  // paddingLeft only (was paddingHorizontal 14) — a right-side value here
  // used to stack on top of `card`'s own paddingRight, pushing the logo/
  // ACCT# further from the border than intended. `card`'s paddingRight
  // (CARD_PADDING_RIGHT) is now the single source of that gap; this
  // paddingLeft is purely the separation from `middleCol`'s text, unrelated
  // to the border.
  rightCol: {
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingLeft: 14,
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

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { getProfileBannerDefinition, type ProfileBannerVariant } from './profile-banner-variants';
import { getProfileLogoDefinition, type ProfileLogoVariant } from './profile-logo-variants';
import { GRID_CELL_WIDTH, GRID_HORIZONTAL_MARGIN } from './profile-v2-grid';
import { PV2 } from './profile-v2-theme';

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
// The legacy wordmark's rendered box (cachecase-primary.png is 1627x684 —
// see CacheCaseLogo's ASPECT_RATIO). A selected profile logo (the
// near-square CC monogram) is drawn inside a box of exactly this size, so
// rightCol — and therefore middleCol's width and the username's shrink —
// never changes with the logo choice. The monogram fills the box's height
// (same visual height as the wordmark) and is centered in it, so it sits
// on the same center line as ACCT# beneath it (see rightCol).
const LOGO_BOX = { width: CACHECASE_LOGO_HEIGHT * (1627 / 684), height: CACHECASE_LOGO_HEIGHT };
// Floor for the username's fit-to-width shrink (14pt -> 7pt at most). Only
// reached by pathological all-wide-letter 15-char handles on the narrowest
// supported width (375pt); see the username <Text> below.
const USERNAME_MIN_FONT_SCALE = 0.5;

// Permanent sequential member number (profiles.account_number, assigned by
// the database), shown as CC + 6 zero-padded digits, e.g. 42 -> CC000042.
// Null (not assigned/loaded) renders a plain dash — never a made-up number.
function formatAccountNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return `CC${String(n).padStart(6, '0')}`;
}

type Props = {
  username: string;
  // Collector/display title — callers pass the same hero_display_name →
  // display_name → username fallback already used elsewhere on this screen.
  title: string;
  itemCount: number;
  avatarUri: string | null;
  accountNumber: number | null | undefined;
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
  // Outer frame treatment (profiles.banner_variant). Only the frame
  // changes — interior and layout are identical for every variant; the logo
  // is its own prop below.
  // null/omitted renders the original neon frame (legacy profiles).
  bannerVariant?: ProfileBannerVariant | null;
  // CacheCase logo style (profiles.profile_logo_variant), resolved
  // independently of bannerVariant. null/omitted renders the original
  // production wordmark (legacy profiles).
  logoVariant?: ProfileLogoVariant | null;
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
  accountNumber,
  onAvatarPress,
  onPress,
  expanded,
  bannerVariant,
  logoVariant,
}: Props) {
  const acctCode = formatAccountNumber(accountNumber);
  const banner = getProfileBannerDefinition(bannerVariant);
  const logo = getProfileLogoDefinition(logoVariant);

  return (
    <LinearGradient
      colors={banner.colors}
      locations={banner.locations}
      start={banner.start}
      end={banner.end}
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
            {/* Usernames are up to 15 chars (16 with "@"). Handles that fit
                stay at 14pt; longer ones shrink only as far as needed to
                stay whole on one line. Realistic 15-char handles land at
                ~10.5pt on a 375pt-wide screen; the 0.5 floor exists so even
                an all-"W" handle fits there (needs ~0.52) instead of being
                ellipsized. */}
            <Text
              style={styles.username}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={USERNAME_MIN_FONT_SCALE}>
              @{username}
            </Text>
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
          {logo ? (
            <View style={LOGO_BOX} pointerEvents="none">
              <Image source={logo.source} style={StyleSheet.absoluteFill} contentFit="contain" contentPosition="center" />
            </View>
          ) : (
            <CacheCaseLogo variant="light" size={CACHECASE_LOGO_HEIGHT} placement="header" />
          )}
          <Text style={styles.acctText} numberOfLines={1}>ACCT# {acctCode}</Text>
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
  // alignItems: 'center' stacks the logo and ACCT# on one shared horizontal
  // center line. The column's width is the wider child — the fixed-size logo
  // box (LOGO_BOX, or the legacy wordmark at the same size), never ACCT#,
  // which is always CC + 6 digits and narrower — so centering never changes
  // rightCol's width, middleCol's available width, or the username's shrink,
  // and a different account number can't shift the logo.
  // paddingLeft only (was paddingHorizontal 14) — a right-side value here
  // used to stack on top of `card`'s own paddingRight, pushing the logo/
  // ACCT# further from the border than intended. `card`'s paddingRight
  // (CARD_PADDING_RIGHT) is now the single source of that gap; this
  // paddingLeft is purely the separation from `middleCol`'s text, unrelated
  // to the border.
  rightCol: {
    alignItems: 'center',
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

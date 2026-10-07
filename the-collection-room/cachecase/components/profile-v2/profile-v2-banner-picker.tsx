import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  LayoutAnimationConfig,
  LinearTransition,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';

import {
  getProfileBannerPickerOrder,
  LEGACY_PROFILE_BANNER,
  PROFILE_BANNER_VARIANT_IDS,
  PROFILE_BANNER_VARIANTS,
  type ProfileBannerVariant,
} from './profile-banner-variants';
import {
  DEFAULT_PROFILE_LOGO_VARIANT,
  getProfileLogoLabel,
  PROFILE_LOGO_VARIANT_IDS,
  PROFILE_LOGO_VARIANTS,
  type ProfileLogoVariant,
} from './profile-logo-variants';
import { ProfileV2IdentityCard } from './profile-v2-identity-card';
import { PV2 } from './profile-v2-theme';

// Edit Profile's "Profile Banner" summary row + its picker sheet. One
// workflow for both identity-card preferences: banner color is the primary
// list; tapping a banner expands it inline into exactly two live
// ProfileV2IdentityCard previews — that banner with each CacheCase logo —
// rendered with the owner's own data, so each preview is exactly what the
// profile will show. Tapping a preview picks that banner + logo combination
// (8 banners x 2 logos). Choosing only updates the caller's drafts; they're
// persisted together by Edit Profile's own Save.
//
// banner/logo null = a pre-existing profile still on the original neon
// frame / original wordmark. The summary reads "Original" and no
// combination is checked; "Original" itself isn't offered as a choice, so
// once a combination is saved there's no way back to it. Merely opening the
// sheet changes nothing.
// Expand/collapse motion for a banner row revealing its two logo previews.
// The row's own height animates (LinearTransition, clipped by overflow:
// 'hidden'), so it opens downward and closes upward while the rows below
// glide with it; the revealed previews slide down into place on open and
// back up on close, crossfading with the single collapsed preview. Ease-out
// cubic, no spring — the same curve as the collection section toggle
// (SECTION_TOGGLE_EASING), slightly longer since a row here is much taller.
// Reanimated's default ReduceMotion.System turns all of this off when the
// OS "reduce motion" setting is on.
const EXPAND_DURATION_MS = 260;
const EXPAND_EASING = Easing.out(Easing.cubic);
const ROW_LAYOUT = LinearTransition.duration(EXPAND_DURATION_MS).easing(EXPAND_EASING);
const COMBOS_ENTER = FadeInDown.duration(EXPAND_DURATION_MS).easing(EXPAND_EASING);
const COMBOS_EXIT = FadeOutUp.duration(EXPAND_DURATION_MS).easing(EXPAND_EASING);
const SUMMARY_ENTER = FadeIn.duration(EXPAND_DURATION_MS);
const SUMMARY_EXIT = FadeOut.duration(180);

type Props = {
  banner: ProfileBannerVariant | null;
  logo: ProfileLogoVariant | null;
  onChange: (banner: ProfileBannerVariant, logo: ProfileLogoVariant) => void;
  preview: {
    username: string;
    title: string;
    itemCount: number;
    avatarUri: string | null;
    accountNumber: number | null | undefined;
  };
};

export function ProfileV2BannerPicker({ banner, logo, onChange, preview }: Props) {
  const [open, setOpen] = useState(false);
  // The one banner currently showing its two logo previews (accordion).
  const [expanded, setExpanded] = useState<ProfileBannerVariant | null>(null);
  // Row order, captured once per open (current banner first — see
  // getProfileBannerPickerOrder). Frozen while the sheet is open: picking a
  // combination closes the sheet, and the list must not reshuffle under the
  // closing slide; the new choice leads on the next open.
  const [order, setOrder] = useState<readonly ProfileBannerVariant[]>(PROFILE_BANNER_VARIANT_IDS);
  const scrollRef = useRef<ScrollView>(null);
  // Banner whose option should be scrolled into view on its next layout —
  // set when it expands (its height changes, so onLayout re-fires), so the
  // two revealed previews aren't left below the fold.
  const pendingScrollRef = useRef<ProfileBannerVariant | null>(null);

  const bannerLabel = (banner ? PROFILE_BANNER_VARIANTS[banner] : LEGACY_PROFILE_BANNER).label;
  const logoLabel = getProfileLogoLabel(logo);
  // Collapsed rows preview each banner with the draft logo (or the default
  // for a legacy profile), so the list reads as "this banner, as you'd get it".
  const summaryLogo = logo ?? DEFAULT_PROFILE_LOGO_VARIANT;

  function openSheet() {
    // The current banner leads the list, already expanded so its two
    // combinations are visible right away at the top (the sheet's fresh
    // ScrollView starts at offset 0); legacy profiles keep the normal order,
    // all collapsed.
    setOrder(getProfileBannerPickerOrder(banner));
    setExpanded(banner);
    pendingScrollRef.current = null;
    setOpen(true);
  }

  function toggleBanner(id: ProfileBannerVariant) {
    const next = expanded === id ? null : id;
    pendingScrollRef.current = next;
    setExpanded(next);
  }

  return (
    <>
      <TouchableOpacity
        style={styles.row}
        onPress={openSheet}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`Profile banner. Banner style ${bannerLabel}. Logo ${logoLabel}`}>
        <View style={styles.rowLines}>
          <View style={styles.rowLine}>
            <Text style={styles.rowLabel}>Banner Style</Text>
            <Text style={styles.rowValue}>{bannerLabel}</Text>
          </View>
          <View style={styles.rowLine}>
            <Text style={styles.rowLabel}>Logo</Text>
            <Text style={styles.rowValue}>{logoLabel}</Text>
          </View>
        </View>
        <IconSymbol name="chevron.right" size={14} color={PV2.textTertiary} />
      </TouchableOpacity>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.sheet} edges={['top', 'bottom']}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Profile Banner</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} accessibilityRole="button">
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView ref={scrollRef} contentContainerStyle={styles.list}>
            {/* No entering animations on the sheet's first render (the
                pre-expanded current banner should simply be there) and no
                exiting ones when the sheet itself closes — only taps inside
                an open sheet animate. */}
            <LayoutAnimationConfig skipEntering skipExiting>
              {order.map((id) => {
                const bannerDef = PROFILE_BANNER_VARIANTS[id];
                const isExpanded = expanded === id;
                const bannerSelected = id === banner;
                return (
                  <Animated.View
                    key={id}
                    style={styles.option}
                    layout={ROW_LAYOUT}
                    onLayout={(e) => {
                      if (pendingScrollRef.current !== id) return;
                      pendingScrollRef.current = null;
                      scrollRef.current?.scrollTo({ y: e.nativeEvent.layout.y, animated: true });
                    }}>
                    <Pressable
                      onPress={() => toggleBanner(id)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isExpanded, selected: bannerSelected }}
                      accessibilityLabel={`${bannerDef.label} banner`}
                      accessibilityHint={isExpanded ? undefined : 'Shows Color and Silver logo options'}>
                      <View style={styles.optionHeader}>
                        <Text style={[styles.optionLabel, bannerSelected && styles.optionLabelSelected]}>
                          {bannerDef.label}
                        </Text>
                        {bannerSelected ? (
                          <IconSymbol name="checkmark.circle.fill" size={14} color={PV2.textPrimary} />
                        ) : null}
                        <View style={styles.flexSpacer} />
                        <IconSymbol
                          name={isExpanded ? 'chevron.up' : 'chevron.down'}
                          size={12}
                          color={PV2.textTertiary}
                        />
                      </View>
                      {/* Preview only — the card's own touch targets are
                          disabled so the whole option is one tap target. */}
                      {!isExpanded ? (
                        <Animated.View pointerEvents="none" entering={SUMMARY_ENTER} exiting={SUMMARY_EXIT}>
                          <ProfileV2IdentityCard {...preview} bannerVariant={id} logoVariant={summaryLogo} />
                        </Animated.View>
                      ) : null}
                    </Pressable>

                    {isExpanded ? (
                      <Animated.View entering={COMBOS_ENTER} exiting={COMBOS_EXIT}>
                        {PROFILE_LOGO_VARIANT_IDS.map((logoId) => {
                          const logoDef = PROFILE_LOGO_VARIANTS[logoId];
                          const selected = bannerSelected && logoId === logo;
                          return (
                            <Pressable
                              key={logoId}
                              style={styles.combo}
                              onPress={() => {
                                onChange(id, logoId);
                                setOpen(false);
                              }}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              accessibilityLabel={`${bannerDef.label} with ${logoDef.label} CacheCase logo`}>
                              <View pointerEvents="none">
                                <ProfileV2IdentityCard {...preview} bannerVariant={id} logoVariant={logoId} />
                              </View>
                              <View style={styles.comboLabelRow}>
                                <Text style={[styles.comboLabel, selected && styles.comboLabelSelected]}>
                                  {logoDef.label} Logo
                                </Text>
                                {selected ? (
                                  <IconSymbol name="checkmark.circle.fill" size={14} color={PV2.textPrimary} />
                                ) : null}
                              </View>
                            </Pressable>
                          );
                        })}
                      </Animated.View>
                    ) : null}
                  </Animated.View>
                );
              })}
            </LayoutAnimationConfig>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PV2.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PV2.panelBorder,
  },
  rowLines: {
    flex: 1,
    gap: 10,
  },
  rowLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
  },
  rowValue: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  sheet: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  done: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  list: {
    paddingBottom: 32,
  },
  // overflow: 'hidden' clips the revealed previews to the row's animating
  // height, so expand/collapse reads as the row opening/closing rather than
  // previews spilling over the rows below mid-transition.
  option: {
    paddingTop: 16,
    overflow: 'hidden',
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  flexSpacer: {
    flex: 1,
  },
  optionLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  optionLabelSelected: {
    color: PV2.textPrimary,
  },
  combo: {
    paddingBottom: 4,
  },
  comboLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  comboLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
  },
  comboLabelSelected: {
    color: PV2.textPrimary,
    fontWeight: '600',
  },
});

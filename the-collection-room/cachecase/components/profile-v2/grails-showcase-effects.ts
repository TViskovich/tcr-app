// The Profile V2 Grails showcase's appearance modes —
// profiles.grails_showcase_effect. Mutually exclusive; the owner picks one in
// Edit Profile and visitors see the owner's saved choice.
//
// Keep the ids in sync with profiles_grails_showcase_effect_check
// (supabase/migrations/20261028120000_add_profile_grails_showcase_effect.sql).

import type { ColorValue } from 'react-native';

import type { Profile } from '@/types';

import { getProfileBannerAccent, getProfileBannerDefinition } from './profile-banner-variants';

export type GrailsShowcaseEffect = 'off' | 'animated_dividers' | 'static_outlines';

export const GRAILS_SHOWCASE_EFFECTS: Record<GrailsShowcaseEffect, { label: string; hint: string }> = {
  off: {
    label: 'Off',
    hint: 'Original Grails appearance',
  },
  animated_dividers: {
    label: 'Animated Dividers',
    hint: 'Moving theme-colored lights',
  },
  static_outlines: {
    label: 'Static Outlines',
    hint: 'Subtle borders around each Grail',
  },
};

// Picker order.
export const GRAILS_SHOWCASE_EFFECT_IDS: readonly GrailsShowcaseEffect[] = ['off', 'animated_dividers', 'static_outlines'];

// A profile row -> its mode. Rows without grails_showcase_effect (own-profile
// cache entries written before the column existed) fall back to the legacy
// grails_divider_glow boolean, which the database keeps as a mirror of
// 'animated_dividers'; anything unrecognized is 'off'.
export function resolveGrailsShowcaseEffect(
  profile: Pick<Profile, 'grails_showcase_effect' | 'grails_divider_glow'> | null | undefined,
): GrailsShowcaseEffect {
  const value = profile?.grails_showcase_effect;
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(GRAILS_SHOWCASE_EFFECTS, value)) {
    return value as GrailsShowcaseEffect;
  }
  return profile?.grails_divider_glow ? 'animated_dividers' : 'off';
}

// ── Effect colours ──────────────────────────────────────────────────────────
// The effects normally draw in the owner's banner colours. A black or
// near-black banner would give them nothing visible to draw with, so those
// banners get a "luminous" treatment instead: silver-white light (Animated
// Dividers) or a graphite/silver outline (Static Outlines). Only the effects
// change — the banner itself and the saved choice don't.

// Silver-white streak stops for luminous Animated Dividers — a bright, cool
// centre with greyer shoulders, so it glows without reading as neon.
export const LUMINOUS_STREAK_COLORS: readonly ColorValue[] = ['#AEB4BE', '#F4F6FA', '#AEB4BE'];

// A banner counts as dark-neutral when EVERY one of its own stops is both
// near-black (WCAG relative luminance ≤ DARK_LUMINANCE_MAX, about #3F3F3F)
// and neutral (RGB channel spread ≤ NEUTRAL_CHROMA_MAX). The chroma test is
// what keeps deep saturated themes — e.g. Red Gradient's #870000 stop, which
// is about as dark — on their own colours. Judged from the banner's colours,
// never from the device's light/dark setting. Today only Black qualifies; a
// future charcoal banner would too, automatically.
const DARK_LUMINANCE_MAX = 0.05;
const NEUTRAL_CHROMA_MAX = 0.1;

function parseHex(color: ColorValue): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function isDarkNeutral(color: ColorValue): boolean {
  const rgb = parseHex(color);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance <= DARK_LUMINANCE_MAX && Math.max(...rgb) - Math.min(...rgb) <= NEUTRAL_CHROMA_MAX;
}

export function isDarkNeutralBanner(bannerValue: unknown): boolean {
  return getProfileBannerDefinition(bannerValue).colors.every(isDarkNeutral);
}

// What the Grails effects (and the Edit Profile picker's glyphs) draw with for
// a stored/draft banner value.
export function getGrailsEffectTheme(bannerValue: unknown): { colors: readonly ColorValue[]; luminous: boolean } {
  return isDarkNeutralBanner(bannerValue)
    ? { colors: LUMINOUS_STREAK_COLORS, luminous: true }
    : { colors: getProfileBannerAccent(bannerValue).colors, luminous: false };
}

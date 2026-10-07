// The single registry of Profile V2 identity-card banner (outer frame)
// treatments — profiles.banner_variant. Components never branch on a
// variant id; they resolve the stored value here and render whatever the
// definition says.
//
// Banner color ONLY. The CacheCase logo on the card is independent of this
// and stays the current production logo for every banner. A future logo
// preference (e.g. profiles.profile_logo_variant + its own
// PROFILE_LOGO_VARIANTS registry next to this one) should be resolved
// separately and passed to the card on its own, so any banner can pair with
// any logo — never add combined "banner + logo" entries here.
//
// Keep the ids in sync with profiles_banner_variant_check
// (supabase/migrations/20261010120000_add_profile_banner_variant.sql).
//
// A stored NULL is NOT one of these seven — it means "the original
// production neon frame" (NEON_BORDER below). Every profile that existed
// before banner_variant did is NULL, and keeps that frame until its owner
// picks a banner; new profiles default to 'black' in the database.

import type { ColorValue } from 'react-native';

export type ProfileBannerVariant =
  | 'black'
  | 'blue_gradient'
  | 'brand_gradient'
  | 'gold'
  | 'gold_silver'
  | 'red_gradient'
  | 'silver';

export type ProfileBannerDefinition = {
  label: string;
  // Fed straight to expo-linear-gradient. A solid banner is two equal stops.
  colors: readonly [ColorValue, ColorValue, ...ColorValue[]];
  locations?: readonly [number, number, ...number[]];
  start: { x: number; y: number };
  end: { x: number; y: number };
};

const HORIZONTAL = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } as const;

// Left-to-right neon signature — cyan/blue into purple into pink. A
// horizontal (not diagonal) 3-stop gradient, distinct from
// ProfileV2Selector's diagonal IRIDESCENT_BORDER: this card's border reads
// left-to-right on purpose, matching the reference design. Pink stop
// pushed more saturated/magenta (was #FF5FA2, a softer rose) to match a
// later reference screenshot more closely — cyan/purple were already close.
const NEON_BORDER = ['#2DD4FF', '#8B5CF6', '#FF3CAC'] as const;

// The original production frame, used for a NULL (legacy) or unrecognized
// banner_variant. Not selectable in the picker.
export const LEGACY_PROFILE_BANNER: ProfileBannerDefinition = {
  label: 'Original',
  colors: NEON_BORDER,
  ...HORIZONTAL,
};

export const PROFILE_BANNER_VARIANTS: Record<ProfileBannerVariant, ProfileBannerDefinition> = {
  black: {
    label: 'Black',
    colors: ['#000000', '#000000'],
    ...HORIZONTAL,
  },
  blue_gradient: {
    label: 'Blue Gradient',
    colors: ['#2E8BFF', '#0B4DFF', '#1E90FF', '#0019D6'],
    locations: [0, 0.35, 0.6, 1],
    ...HORIZONTAL,
  },
  // Stops taken from the brand gradient's design file (pink -> peach ->
  // cream -> cyan -> blue).
  brand_gradient: {
    label: 'Brand Gradient',
    colors: ['#D991CB', '#ECCE9D', '#F8F1DC', '#8DD5EE', '#4D7FBF'],
    locations: [0, 0.24, 0.57, 0.73, 1],
    ...HORIZONTAL,
  },
  gold: {
    label: 'Gold',
    colors: ['#FFD94A', '#E08A00', '#F7B54B', '#FFE27A', '#E39A1F'],
    locations: [0, 0.3, 0.55, 0.75, 1],
    ...HORIZONTAL,
  },
  gold_silver: {
    label: 'Gold Silver',
    colors: ['#FFD54A', '#E3A33A', '#C9CDD3', '#F4F5F7', '#A7ACB3'],
    locations: [0, 0.3, 0.6, 0.8, 1],
    ...HORIZONTAL,
  },
  red_gradient: {
    label: 'Red Gradient',
    colors: ['#8E0000', '#E00000', '#FF2A2A', '#C40000'],
    locations: [0, 0.4, 0.7, 1],
    ...HORIZONTAL,
  },
  silver: {
    label: 'Silver',
    colors: ['#8D9299', '#D8DBDF', '#FFFFFF', '#A3A8AF', '#E6E8EB'],
    locations: [0, 0.3, 0.55, 0.8, 1],
    ...HORIZONTAL,
  },
};

// Picker order.
export const PROFILE_BANNER_VARIANT_IDS: readonly ProfileBannerVariant[] = [
  'black',
  'blue_gradient',
  'brand_gradient',
  'gold',
  'gold_silver',
  'red_gradient',
  'silver',
];

// Stored value -> selectable variant, or null for the legacy neon frame.
// null/undefined (pre-banner profiles, or own-profile cache entries written
// before the column existed) and any unrecognized string both resolve to
// null, so they render exactly as the card always has.
export function resolveProfileBannerVariant(value: unknown): ProfileBannerVariant | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILE_BANNER_VARIANTS, value)
    ? (value as ProfileBannerVariant)
    : null;
}

// What the card actually draws for a stored/draft value.
export function getProfileBannerDefinition(value: unknown): ProfileBannerDefinition {
  const variant = resolveProfileBannerVariant(value);
  return variant ? PROFILE_BANNER_VARIANTS[variant] : LEGACY_PROFILE_BANNER;
}

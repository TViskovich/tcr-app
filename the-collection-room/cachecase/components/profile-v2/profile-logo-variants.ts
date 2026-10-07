// The single registry of Profile V2 identity-card CacheCase logo styles —
// profiles.profile_logo_variant. Independent of the banner registry
// (profile-banner-variants.ts): the card resolves banner and logo separately,
// so any banner pairs with any logo. Components never branch on a logo id;
// they resolve the stored value here and render whatever the definition says.
//
// Keep the ids in sync with profiles_profile_logo_variant_check
// (supabase/migrations/20261012120000_add_profile_logo_variant.sql).
//
// A stored NULL is NOT one of these — it means "the original production
// logo" (the CacheCase wordmark, rendered by CacheCaseLogo). Every profile
// that existed before profile_logo_variant did is NULL, and keeps that
// wordmark until its owner picks a logo; new profiles default to 'color' in
// the database.

import type { ImageSource } from 'expo-image';

export type ProfileLogoVariant = 'color' | 'silver';

export type ProfileLogoDefinition = {
  label: string;
  // Official brand artwork — rendered as-is, never recolored in code. Both
  // assets share the same 858x801 transparent canvas, so they occupy the
  // same footprint inside the card's logo box.
  source: ImageSource;
};

// The original production logo, used for a NULL (legacy) or unrecognized
// profile_logo_variant. Not selectable in the picker.
export const LEGACY_PROFILE_LOGO_LABEL = 'Original';

export const PROFILE_LOGO_VARIANTS: Record<ProfileLogoVariant, ProfileLogoDefinition> = {
  color: {
    label: 'Color',
    source: require('@/assets/profile-logos/CC-Color-Mono.png'),
  },
  silver: {
    label: 'Silver',
    source: require('@/assets/profile-logos/CC-Silver-Mono.png'),
  },
};

// Picker order.
export const PROFILE_LOGO_VARIANT_IDS: readonly ProfileLogoVariant[] = ['color', 'silver'];

// Matches the column default for new profiles. Used where the picker needs a
// concrete logo to preview a banner with before one has been chosen.
export const DEFAULT_PROFILE_LOGO_VARIANT: ProfileLogoVariant = 'color';

// Stored value -> selectable logo, or null for the legacy wordmark.
// null/undefined (pre-logo profiles, or own-profile cache entries written
// before the column existed) and any unrecognized string both resolve to
// null, so they render exactly as the card always has.
export function resolveProfileLogoVariant(value: unknown): ProfileLogoVariant | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILE_LOGO_VARIANTS, value)
    ? (value as ProfileLogoVariant)
    : null;
}

// What the card draws for a stored/draft value: a selectable logo's
// definition, or null for the legacy wordmark.
export function getProfileLogoDefinition(value: unknown): ProfileLogoDefinition | null {
  const variant = resolveProfileLogoVariant(value);
  return variant ? PROFILE_LOGO_VARIANTS[variant] : null;
}

export function getProfileLogoLabel(value: unknown): string {
  return getProfileLogoDefinition(value)?.label ?? LEGACY_PROFILE_LOGO_LABEL;
}

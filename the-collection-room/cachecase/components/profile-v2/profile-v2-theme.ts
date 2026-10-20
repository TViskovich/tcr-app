// Shared color tokens for the profile-v2 redesign (figma-profile-prototype
// branch only). Kept in one place so the 6+ profile-v2 components agree on
// the same dark palette instead of each hardcoding its own near-black hex.
export const PV2 = {
  bg: '#0a0a0f',
  panel: '#141416',
  panelBorder: 'rgba(255,255,255,0.10)',
  border: 'rgba(255,255,255,0.14)',
  borderStrong: 'rgba(255,255,255,0.22)',
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.70)',
  textTertiary: 'rgba(255,255,255,0.36)',
  accent: '#e8181a',
  accentSoft: 'rgba(232,24,26,0.14)',
  link: '#5AA9F0',
  // Semantic action colors. Normal (non-destructive) actions — add, save,
  // share, send, move, select, follow — are blue; `accent` red stays
  // reserved for destructive actions, privacy indicators, errors and the
  // brand. actionPrimary (= link) is for text, icons, borders and selection
  // rings on the dark background; actionPrimaryFill is the deeper blue
  // (the app's own tint, constants/theme.ts) for solid fills behind white
  // text, where the lighter blue would fall below readable contrast.
  actionPrimary: '#5AA9F0',
  actionPrimaryFill: '#0a7ea4',
  actionPrimarySoft: 'rgba(90,169,240,0.14)',
  // Neutral fill for a primary button that can't be pressed yet.
  actionDisabled: 'rgba(255,255,255,0.14)',
  // Share Elsewhere (leaving CacheCase via the system share sheet) — the
  // Share sheet's original green, kept deeper than statusPositive so its
  // white glyph stays legible (3.2:1 vs 2.2:1).
  actionExternalFill: '#3CA36B',
  // Neutral gray icon tile (opaque) — Share Item's Elsewhere tile. iOS's
  // dark-mode systemGray3; a white glyph stays clearly legible on it.
  actionNeutralFill: '#48484A',
  // The bottom navigation's active Feed tint (TAB_ACCENTS.index in
  // app/(tabs)/_layout.tsx) — keep the two in sync.
  feedActive: '#74F5C8',
  // Outcome status text (e.g. transfer status pills). Same green as the
  // Registry's status dots and the iOS-red already used for Delete — both
  // stay readable as small text on their soft tint, where `accent` red
  // falls below 4.5:1.
  statusPositive: '#34C759',
  statusPositiveSoft: 'rgba(52,199,89,0.14)',
  statusNegative: '#FF3B30',
  // Figma measurement pass — component-specific tokens (kept distinct from
  // the generic panel/border/border above rather than overloading them,
  // since the spec calls these out for specific elements only).
  collectorPanelBg: 'rgba(12,12,20,0.97)',
  collectorPanelBorder: 'rgba(255,255,255,0.11)',
  emptyCardBg: 'rgba(255,255,255,0.04)',
  dividerColor: 'rgba(255,255,255,0.08)',
} as const;

// >=1000 formats as "1.2k" / "1.5M" — mirrors common social-app stat styling.
// Below 1000 shows the exact number (most stats in a new app are small).
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

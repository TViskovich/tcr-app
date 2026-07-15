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

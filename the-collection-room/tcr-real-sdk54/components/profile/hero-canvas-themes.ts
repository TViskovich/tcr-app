// Registry of selectable hero canvas themes.
// Add new entries here + a render branch in hero-canvas-theme.tsx to extend.
export type HeroCanvasThemeId = 'classic' | 'foil';

export type HeroCanvasThemeDef = {
  id: HeroCanvasThemeId;
  label: string;
  // Two colors used to render the picker swatch.
  swatch: [string, string];
};

export const HERO_CANVAS_THEMES: HeroCanvasThemeDef[] = [
  { id: 'classic', label: 'Classic', swatch: ['#2A2A2A', '#0D0D0D'] },
  { id: 'foil', label: 'Foil', swatch: ['#783CDC', '#DCB428'] },
];

export const DEFAULT_HERO_CANVAS_THEME: HeroCanvasThemeId = 'classic';

export function resolveHeroCanvasTheme(theme: string | null | undefined): HeroCanvasThemeId {
  return HERO_CANVAS_THEMES.some((t) => t.id === theme)
    ? (theme as HeroCanvasThemeId)
    : DEFAULT_HERO_CANVAS_THEME;
}

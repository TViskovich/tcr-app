import type { ImageContentPosition, ImageSource } from 'expo-image';

// Registry of selectable hero canvas themes.
//
// Two kinds of theme:
//  - 'procedural' (classic, foil): rendered with gradients/effects, needs a
//    matching render branch in hero-canvas-theme.tsx.
//  - 'image' (neonCosmic, and future drops like Downtown/Black Ice/Gold Vinyl/
//    Galaxy): a bundled artwork PNG rendered full-bleed as-is. These need NO
//    new render branch — HeroCanvasImage renders any 'image' theme generically.
//    Adding one is: drop the PNG in assets/materials/<name>/, add the id to
//    HeroCanvasThemeId, and add one object below.
export type HeroCanvasThemeId = 'classic' | 'foil' | 'neonCosmic' | 'blackIce';

export type HeroCanvasImageAsset = {
  // Local require()'d asset. Bundled statically, rendered at native resolution.
  source: ImageSource | number;
  // Flat dark overlay for text legibility on bright/vibrant artwork. Keep this
  // subtle (10-18%) — it must not desaturate or dull the source art. Omit for
  // artwork dark enough to skip it entirely.
  vignetteOpacity?: number;
  // Crop anchor for contentFit="cover" (expo-image's contentPosition format,
  // e.g. { left: '60%', top: '50%' }). The source art is almost always wider
  // than the portrait hero canvas, so cover crops most of it away — this picks
  // which region survives. Omit for centered (default) cropping.
  focalPoint?: ImageContentPosition;
};

export type HeroCanvasThemeDef =
  | {
      id: HeroCanvasThemeId;
      label: string;
      kind: 'procedural';
      // Two colors used to render the picker swatch.
      swatch: [string, string];
      // Retired from new selection but still fully rendered/resolved for
      // profiles that already have this theme saved — see resolveHeroCanvasTheme
      // and getHeroCanvasPickerThemes below. Omit (or false) for a normal theme.
      hidden?: boolean;
    }
  | {
      id: HeroCanvasThemeId;
      label: string;
      kind: 'image';
      asset: HeroCanvasImageAsset;
      hidden?: boolean;
    };

export const HERO_CANVAS_THEMES: HeroCanvasThemeDef[] = [
  { id: 'classic', label: 'Classic', kind: 'procedural', swatch: ['#2A2A2A', '#0D0D0D'] },
  // Hidden from the picker (no longer offered for new selection) but kept in
  // the registry/render path so existing profiles with hero_theme = 'foil'
  // keep rendering correctly.
  { id: 'foil', label: 'Foil', kind: 'procedural', swatch: ['#783CDC', '#DCB428'], hidden: true },
  {
    id: 'neonCosmic',
    label: 'Neon Cosmic',
    kind: 'image',
    asset: {
      source: require('../../assets/materials/neonCosmic/neon-cosmic-bg.png'),
      vignetteOpacity: 0.14,
      // Slightly right-of-center: keeps the dark central vortex, the pink
      // frame line, and the blue neon line in view, with the golden-red
      // blob at top-right still bringing in bright color. Centered vertically.
      focalPoint: { left: '60%', top: '50%' },
    },
  },
  {
    id: 'blackIce',
    label: 'Black Ice',
    kind: 'image',
    asset: {
      source: require('../../assets/materials/blackIce/black-ice-bg.png'),
      vignetteOpacity: 0.14,
      // No focalPoint: the artwork is already portrait with a dark, clear
      // center and crystal shards framing all four edges — a centered crop
      // (the default) keeps that framing symmetric behind the identity stack.
    },
  },
];

export const DEFAULT_HERO_CANVAS_THEME: HeroCanvasThemeId = 'classic';

export function resolveHeroCanvasTheme(theme: string | null | undefined): HeroCanvasThemeId {
  return HERO_CANVAS_THEMES.some((t) => t.id === theme)
    ? (theme as HeroCanvasThemeId)
    : DEFAULT_HERO_CANVAS_THEME;
}

// Themes offered for new selection in the Hero Theme picker. Excludes
// hidden/retired themes (e.g. foil) without removing them from the registry —
// resolveHeroCanvasTheme and the renderers still see the full list, so
// existing profiles already on a hidden theme keep working unchanged.
export function getHeroCanvasPickerThemes(): HeroCanvasThemeDef[] {
  return HERO_CANVAS_THEMES.filter((t) => !t.hidden);
}

// Image-kind themes are canvas-replacement material (like Spectra): they ARE
// the display surface, rendered opaque at Layer 1 instead of overlaying the
// hero photo. This lookup lets hero-background.tsx treat any current or
// future image theme correctly without hardcoding each theme id.
export function getHeroCanvasImageAsset(
  theme: string | null | undefined
): HeroCanvasImageAsset | undefined {
  const def = HERO_CANVAS_THEMES.find((t) => t.id === theme);
  return def?.kind === 'image' ? def.asset : undefined;
}

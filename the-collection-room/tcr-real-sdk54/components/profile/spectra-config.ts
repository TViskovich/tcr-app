// Layer data for the Spectra hero canvas material (M-001).
// Spectra replaces the entire hero canvas background (it is the display surface
// the showcase circle is mounted on), not an overlay on the hero photo — see the
// Material M-001 design language for the full rationale.
//
// Boldness pass: the previous version (soft broad reflection + one thin white
// sheen + a barely-visible film wash) read as too subtle against a reference
// target. Replaced with SPECTRA_STREAKS — five clearly-visible colored diagonal
// lines sharing one axis with the base gradient, plus a genuinely vivid chrome
// bezel ring around the showcase circle instead of a faint neutral halo. Only
// grain remains a raster asset — real pixel noise isn't practical to fake with
// linear gradients; everything else is procedural.

export const SPECTRA_BASE = {
  colors: ['#22262e', '#0e1013', '#020203'] as const,
  locations: [0, 0.55, 1] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

// Kept deliberately faint and full-bleed — this project has no masking/blend
// library to restrict grain to "lit" areas only, so it stays a single quiet
// texture pass rather than trying to fake light-dependent visibility.
export const SPECTRA_GRAIN = {
  source: require('../../assets/materials/spectra/spectra-metallic-grain-v2.png'),
  opacity: 0.1,
};

// Five clearly-visible diagonal streaks sharing one axis with the base
// gradient (so they read as one lighting environment, not scattered effects).
// Each is a tight transparent -> color -> transparent band — a crisp line,
// not a blurred wash. Cyan/violet/white/magenta/cyan, in that order along the
// diagonal, mirroring the reference's laser-line look.
export const SPECTRA_STREAKS = [
  {
    colors: ['transparent', 'rgba(70,170,255,0.5)', 'transparent'],
    locations: [0.06, 0.13, 0.2],
  },
  {
    colors: ['transparent', 'rgba(155,93,229,0.48)', 'transparent'],
    locations: [0.27, 0.34, 0.41],
  },
  {
    // The brightest line — plays the role of the crisp specular highlight.
    colors: ['transparent', 'rgba(255,255,255,0.55)', 'transparent'],
    locations: [0.44, 0.5, 0.56],
  },
  {
    colors: ['transparent', 'rgba(241,91,181,0.46)', 'transparent'],
    locations: [0.6, 0.67, 0.74],
  },
  {
    colors: ['transparent', 'rgba(70,190,220,0.38)', 'transparent'],
    locations: [0.8, 0.87, 0.94],
  },
] as const;

export const SPECTRA_STREAK_AXIS = {
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

// Center darkening — dims the band directly behind the showcase circle so the
// circle reads clearly against a calm backdrop while the surrounding hero
// (edges/corners) carries the lighting energy. A true radial vignette isn't
// renderable without SVG here, so this is a vertical band positioned to match
// the avatar's actual footprint (see hero-canvas-theme.tsx).
export const SPECTRA_CENTER_DARKENING = {
  colors: ['transparent', 'rgba(0,0,0,0.24)', 'transparent'] as const,
  locations: [0, 0.5, 1] as const,
};

// Edge lighting — thin strips at each of the 4 edges, suggesting the canvas is
// beveled and catching light at its border, not emitting a glow from it.
const EDGE_COLOR_STRONG = 'rgba(205,225,235,0.2)';
const EDGE_COLOR_SOFT = 'rgba(205,225,235,0.16)';

export const SPECTRA_EDGE_TOP = {
  colors: [EDGE_COLOR_STRONG, 'transparent'] as const,
  locations: [0, 1] as const,
  start: { x: 0, y: 0 },
  end: { x: 0, y: 1 },
  height: 56,
};

export const SPECTRA_EDGE_BOTTOM = {
  colors: [EDGE_COLOR_SOFT, 'transparent'] as const,
  locations: [0, 1] as const,
  start: { x: 0, y: 1 },
  end: { x: 0, y: 0 },
  height: 56,
};

export const SPECTRA_EDGE_LEFT = {
  colors: [EDGE_COLOR_SOFT, 'transparent'] as const,
  locations: [0, 1] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 0 },
  width: 40,
};

export const SPECTRA_EDGE_RIGHT = {
  colors: [EDGE_COLOR_SOFT, 'transparent'] as const,
  locations: [0, 1] as const,
  start: { x: 1, y: 0 },
  end: { x: 0, y: 0 },
  width: 40,
};

// Showcase integration — contact shadow + a vivid chrome bezel ring, sized and
// positioned from the real AVATAR_SIZE constant so the circle reads as
// physically resting on the material. Geometry only (not motion) — stays
// anchored per the "showcase/UI stays anchored" motion rule. The bezel is a
// few px larger than the avatar; since the (unmodified) avatar renders on top
// of this in the real tree, only the ring around its edge shows through.
//
// Color neutralized (was rgba(0,0,0,0.42)) — showed through as a faint dark
// rounded "ghost" pill above the badge rail. Sizing/position kept so this is
// a one-line restore if the contact-shadow effect comes back later.
export const SPECTRA_CONTACT_SHADOW = {
  color: 'transparent',
  widthRatio: 0.62,
  heightRatio: 0.1,
  overlapRatio: 0.4, // fraction of its own height it overlaps up into the avatar
};

// Vivid gradient bezel — a real chrome-ring look, not a faint halo.
export const SPECTRA_RIM_BEZEL = {
  colors: ['rgba(74,168,255,0.9)', 'rgba(155,93,229,0.9)', 'rgba(241,91,181,0.85)'] as const,
  locations: [0, 0.5, 1] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  extraSize: 14,
};

// One soft outer glow behind the bezel for falloff — kept neutral so the
// bezel's own color carries the effect.
export const SPECTRA_RIM_GLOW = {
  extraSize: 30,
  borderWidth: 10,
  color: 'rgba(180,200,255,0.1)',
};

// Motion — scroll-driven parallax for the streak layer only (no gyroscope
// library in this project; scroll is the explicitly-approved fallback).
// Small, heavily damped: outputs stay within ~3-8px across a wide scroll range.
export const SPECTRA_MOTION = {
  inputRange: [0, 400] as const,
  streaksX: [0, 7] as const,
  streaksY: [0, -5] as const,
  // Oversize so a few px of translation never reveals an edge gap.
  overscan: 20,
};

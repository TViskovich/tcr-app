// Shared layout constants for all hero sub-components.
// Import from here rather than from profile-hero.tsx.
export const HERO_HEIGHT = 348;
export const AVATAR_SIZE = 116;

// Glow ring extends GLOW_DELTA/2 beyond the avatar on each side
const GLOW_DELTA = 24;
export const GLOW_SIZE = AVATAR_SIZE + GLOW_DELTA;
export const GLOW_OFFSET = GLOW_DELTA / 2; // how far the ring extends past the avatar edge

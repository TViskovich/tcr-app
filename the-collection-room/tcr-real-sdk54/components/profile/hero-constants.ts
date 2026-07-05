import { Dimensions } from 'react-native';

// Shared layout constants for all hero sub-components.
// Import from here rather than from profile-hero.tsx.
// 40px extended from 780 to create a docking zone at the bottom for the name block.
export const HERO_HEIGHT = 820;

// Avatar intentionally exceeds screen width so the circle bleeds ~8px off each side.
// Using screen width at module load time — portrait-only app, no orientation concerns.
export const AVATAR_SIZE = Dimensions.get('window').width + 16;

// heroContent's paddingTop in profile-hero.tsx — the avatar's top offset within
// the hero canvas. Shared so hero-canvas-theme.tsx can position Spectra's
// showcase-integration elements (contact shadow, rim rings) to exactly match
// where the avatar actually renders, without the two files silently drifting.
export const IDENTITY_TOP_PADDING = 48;

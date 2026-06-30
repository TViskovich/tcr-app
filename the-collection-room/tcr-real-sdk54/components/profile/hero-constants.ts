import { Dimensions } from 'react-native';

// Shared layout constants for all hero sub-components.
// Import from here rather than from profile-hero.tsx.
// 40px extended from 780 to create a docking zone at the bottom for the name block.
export const HERO_HEIGHT = 820;

// Avatar intentionally exceeds screen width so the circle bleeds ~8px off each side.
// Using screen width at module load time — portrait-only app, no orientation concerns.
export const AVATAR_SIZE = Dimensions.get('window').width + 16;

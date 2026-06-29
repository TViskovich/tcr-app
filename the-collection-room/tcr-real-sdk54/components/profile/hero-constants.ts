import { Dimensions } from 'react-native';

// Shared layout constants for all hero sub-components.
// Import from here rather than from profile-hero.tsx.
export const HERO_HEIGHT = 780;

// Avatar intentionally exceeds screen width so the circle bleeds ~8px off each side.
// Using screen width at module load time — portrait-only app, no orientation concerns.
export const AVATAR_SIZE = Dimensions.get('window').width + 16;

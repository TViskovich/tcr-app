import { IRIDESCENT_STROKE } from '@/components/navigation/cachecase-grid-icon';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';

const [BRAND_CYAN, BRAND_VIOLET, BRAND_LAVENDER] = IRIDESCENT_STROKE;

// DM-screen-only surface tokens (premium chat redesign, pass 1). Built on top
// of PV2 rather than replacing it — PV2.bg/accent/text* are still the source
// of truth; these only name the glass/bubble surfaces this screen adds.
export const CHAT = {
  bg: PV2.bg,
  glassBg: 'rgba(20,20,28,0.88)',
  glassBorder: 'rgba(255,255,255,0.09)',
  // Faint top-edge highlight on glass surfaces — reads as a lit bevel
  // without an actual blur (expo-blur isn't installed; a static translucent
  // fill keeps scroll cost at zero).
  glassHighlight: 'rgba(255,255,255,0.05)',
  controlBg: 'rgba(255,255,255,0.05)',
  controlBorder: 'rgba(255,255,255,0.10)',
  incomingBg: 'rgba(26,26,36,0.95)',
  incomingBorder: 'rgba(255,255,255,0.09)',
  // CacheCase brand foil (the nav's CacheCase grid icon palette) replaces
  // red as the DM accent. These fills are light, so content on them uses
  // onAccent (dark), never white.
  accent: BRAND_VIOLET,
  accentSoft: 'rgba(154,140,255,0.16)',
  accentBorder: 'rgba(154,140,255,0.45)',
  accentGradient: [BRAND_CYAN, BRAND_VIOLET] as const,
  accentGlow: BRAND_LAVENDER,
  onAccent: PV2.bg,
  onAccentMuted: 'rgba(10,10,15,0.55)',
  sendDisabledBg: 'rgba(154,140,255,0.22)',
  timestamp: 'rgba(255,255,255,0.38)',
  statusRead: 'rgba(255,255,255,0.62)',
  separator: 'rgba(255,255,255,0.42)',
} as const;

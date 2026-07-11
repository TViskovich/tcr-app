import { Image, type ImageSource } from 'expo-image';
import { StyleProp, View, ViewStyle } from 'react-native';

export type CacheCaseLogoVariant = 'icon' | 'light' | 'dark';
export type CacheCaseLogoSize = 'xs' | 'sm' | 'md' | 'lg';
export type CacheCaseLogoPlacement = 'header' | 'hero' | 'emptyState' | 'splash';

// icon: cachecase-icon.png (454x359). light/dark: cachecase-{primary,dark}.png (1627x684).
// Never redraw/recolor/distort these — official brand assets, cropped tight to content only.
const SOURCES: Record<CacheCaseLogoVariant, ImageSource> = {
  icon: require('@/assets/brand/cachecase-icon.png'),
  light: require('@/assets/brand/cachecase-primary.png'),
  dark: require('@/assets/brand/cachecase-dark.png'),
};

const ASPECT_RATIO: Record<CacheCaseLogoVariant, number> = {
  icon: 454 / 359,
  light: 1627 / 684,
  dark: 1627 / 684,
};

const ICON_HEIGHT: Record<CacheCaseLogoSize, number> = { xs: 14, sm: 18, md: 24, lg: 34 };
const WORDMARK_HEIGHT: Record<CacheCaseLogoSize, number> = { xs: 16, sm: 22, md: 32, lg: 56 };

// Placement only handles positioning/spacing — callers still decide where in
// the tree the logo sits. "hero" anchors to a corner of a relatively-positioned
// parent; the others just add breathing room appropriate to that context.
const PLACEMENT_STYLE: Record<CacheCaseLogoPlacement, ViewStyle> = {
  header: {},
  // Inset scales with the larger corner-signature size so it still reads as
  // deliberately placed rather than tucked into the edge.
  hero: { position: 'absolute', top: 24, right: 24 },
  emptyState: { marginBottom: 14 },
  splash: {},
};

type Props = {
  variant: CacheCaseLogoVariant;
  // Accepts a token for the common cases, or an exact pixel height when a
  // placement needs to land on a specific size (e.g. matching a heading).
  size?: CacheCaseLogoSize | number;
  placement?: CacheCaseLogoPlacement;
  style?: StyleProp<ViewStyle>;
};

export function CacheCaseLogo({ variant, size = 'md', placement = 'header', style }: Props) {
  const height =
    typeof size === 'number' ? size : variant === 'icon' ? ICON_HEIGHT[size] : WORDMARK_HEIGHT[size];
  const width = height * ASPECT_RATIO[variant];

  return (
    <View style={[PLACEMENT_STYLE[placement], style]} pointerEvents="none">
      <Image source={SOURCES[variant]} style={{ width, height }} contentFit="contain" />
    </View>
  );
}

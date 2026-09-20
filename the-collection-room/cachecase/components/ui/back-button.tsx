import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { type Href, useRouter } from 'expo-router';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

type Props = {
  // Where to land when there's no back history to pop — every screen this
  // replaced already had its own fallback destination before conversion
  // (Feed, a profile tab, messages, etc.); this preserves that per-screen
  // choice rather than forcing everything to one default. Ignored when
  // `onPress` is provided. Required unless `onPress` is provided.
  fallbackHref?: Href;
  // Escape hatch for a screen whose back control does more than plain
  // canGoBack()/back()/fallback navigation — e.g. app/claim-card/[id].tsx's
  // multi-step wizard, where Back on the review step returns to the
  // previous step instead of leaving the screen. When provided, this is
  // called instead of the built-in navigation and `fallbackHref` is
  // ignored (that screen owns its own fallback, if any, inside onPress).
  onPress?: () => void;
  // Positioning only (margin/alignSelf/etc.) — never pass backgroundColor/
  // borderRadius/borderWidth here. The visible glyph has no container by
  // design; only the invisible 44x44 touch target exists.
  style?: StyleProp<ViewStyle>;
  size?: number;
  color?: string;
  hitSlop?: number;
};

// The one standardized back control for every back button in the app —
// bare chevron-left, no pill/circle/background/border, 44x44 invisible
// touch target. Extracted from the public-profile back chevron
// (components/profile-v2/profile-v2-screen.tsx's original publicBackBtn),
// which is the visual reference this app is standardizing on. Also used as
// a native Stack.Screen's headerLeft in place of react-navigation's own
// HeaderBackButton — on-device (iPhone, iOS 18+) HeaderBackButton picks up
// the OS's own rounded/"Liquid Glass" pill chrome around header bar
// buttons, which no amount of app-level style-prop inspection surfaces
// (it's applied by the native header, not by any style this component
// controls) — a fully custom headerLeft like this one renders as opaque
// React content instead, so it never gets wrapped in that native chrome.
export function BackButton({ fallbackHref, onPress, style, size = 24, color = PV2.textPrimary, hitSlop = 10 }: Props) {
  const router = useRouter();

  function handlePress() {
    if (onPress) {
      onPress();
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (fallbackHref) router.replace(fallbackHref);
  }

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={hitSlop}
      style={[styles.button, style]}
      accessibilityRole="button"
      accessibilityLabel="Back">
      <IconSymbol name="chevron.left" size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

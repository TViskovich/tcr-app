// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolWeight, SymbolViewProps } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

type IconMapping = Record<SymbolViewProps['name'], ComponentProps<typeof MaterialIcons>['name']>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'bookmark.fill': 'bookmark',
  'bookmark': 'bookmark-border',
  'chevron.left': 'chevron-left',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'folder.fill': 'folder',
  'bell.fill': 'notifications',
  'message.fill': 'chat',
  'person.fill': 'person',
  'gearshape.fill': 'settings',
  'magnifyingglass': 'search',
  'crown.fill': 'emoji-events',
  // Create menu icons
  'plus': 'add',
  'square.and.pencil': 'edit',
  'square.and.arrow.up': 'share',
  'camera.fill': 'camera-alt',
  'rectangle.stack.fill': 'layers',
  'sparkles': 'auto-awesome',
  // Bottom tab bar — thin outline glyphs (vs the .fill glyphs above)
  'house': 'home',
  'message': 'chat-bubble-outline',
  'person': 'person-outline',
  'square.grid.2x2': 'grid-view',
  'heart': 'favorite-border',
  'heart.fill': 'favorite',
  'line.3.horizontal': 'menu',
  'star': 'star-border',
  'star.fill': 'star',
  'ellipsis': 'more-horiz',
  'xmark': 'close',
  // Profile expanded-details location row (profile-v2-expanded-details.tsx).
  'mappin': 'place',
  // Move Item modal's current-folder indicator (move-item-modal.tsx).
  'checkmark.circle.fill': 'check-circle',
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  accessible,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
  // Omitted by default (native RN default applies) — only pass this when a
  // decorative icon's own glyph text would otherwise override its
  // touchable parent's explicit accessibilityLabel/testID on Android. See
  // components/profile-v2/profile-v2-screen.tsx's Settings gear for why.
  accessible?: boolean;
}) {
  return (
    <MaterialIcons
      color={color}
      size={size}
      name={MAPPING[name]}
      style={style}
      accessible={accessible}
    />
  );
}

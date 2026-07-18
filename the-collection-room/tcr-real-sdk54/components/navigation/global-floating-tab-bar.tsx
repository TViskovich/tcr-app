import * as Haptics from 'expo-haptics';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useUnreadMessages } from '@/hooks/use-unread-messages';
import { useAuth } from '@/lib/auth';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// The same floating pill rendered inside the (tabs) group (see
// app/(tabs)/_layout.tsx's AnimatedTabBar), but pathname-driven instead of
// Tabs-navigator-driven so it can sit on top of every stack screen that
// lives outside the tabs group (folder, item, user, saved, settings,
// conversation, post, etc). Routes that already render their own instance
// via the Tabs navigator are skipped here to avoid a duplicate bar. Kept
// as its own copy (same constants, same shell/glow styling) rather than
// sharing code with the tabs-group version, so that working bar is left
// untouched.
const BAR_HEIGHT = TAB_BAR_HEIGHT;
const BAR_HORIZONTAL_INSET = 18;
const BAR_BOTTOM_GAP = 8;
const BAR_RADIUS = BAR_HEIGHT / 2;
const BAR_BG = 'rgba(9,10,16,1)';
const BAR_BORDER = 'rgba(100,105,145,0.28)';
const ICON_SIZE = 22;
const INACTIVE_COLOR = '#555762';

type GlobalTabName = 'index' | 'collection' | 'search' | 'messages' | 'profile';

const TABS: {
  name: GlobalTabName;
  route: '/' | '/collection' | '/search' | '/messages' | '/profile';
  icon: 'house' | 'square.grid.2x2' | 'magnifyingglass' | 'message' | 'person';
}[] = [
  { name: 'index', route: '/', icon: 'house' },
  { name: 'collection', route: '/collection', icon: 'square.grid.2x2' },
  { name: 'search', route: '/search', icon: 'magnifyingglass' },
  { name: 'messages', route: '/messages', icon: 'message' },
  { name: 'profile', route: '/profile', icon: 'person' },
];

// Paths that already have the Tabs-navigator's own floating bar rendered —
// don't stack a second one on top of those.
const TAB_COVERED_PATHS = new Set(['/', '/collection', '/search', '/messages', '/profile', '/notifications']);

export function GlobalFloatingTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { unreadCount: unreadMessages } = useUnreadMessages(session?.user?.id);

  if (TAB_COVERED_PATHS.has(pathname)) return null;

  const messageBadge = unreadMessages === 0 ? undefined : unreadMessages > 99 ? '99+' : unreadMessages;

  return (
    <View style={[styles.rootWrap, { bottom: insets.bottom + BAR_BOTTOM_GAP }]} pointerEvents="box-none">
      <View style={styles.tabBarShadow}>
        <View style={styles.tabBarShell}>
          <View style={styles.tabBarContent}>
            {TABS.map((tab) => {
              const onPress = () => {
                if (process.env.EXPO_OS === 'ios') {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                router.navigate(tab.route as any);
              };
              return (
                <TouchableOpacity
                  key={tab.name}
                  onPress={onPress}
                  style={styles.tabItem}
                  activeOpacity={0.7}
                  accessibilityRole="button">
                  <View style={styles.iconWrap}>
                    <View style={styles.iconLitWrap}>
                      <IconSymbol size={ICON_SIZE} name={tab.icon} color={INACTIVE_COLOR} />
                    </View>
                    {tab.name === 'messages' && messageBadge != null ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{messageBadge}</Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rootWrap: {
    position: 'absolute',
    left: BAR_HORIZONTAL_INSET,
    right: BAR_HORIZONTAL_INSET,
  },
  tabBarShadow: {
    borderRadius: BAR_RADIUS,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  tabBarShell: {
    height: BAR_HEIGHT,
    borderRadius: BAR_RADIUS,
    backgroundColor: BAR_BG,
    borderWidth: 1,
    borderColor: BAR_BORDER,
    overflow: 'hidden',
  },
  tabBarContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
  },
  iconWrap: {
    position: 'relative',
  },
  iconLitWrap: {
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#e53935',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },
});

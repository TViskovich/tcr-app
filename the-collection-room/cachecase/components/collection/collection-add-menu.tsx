import { useRef } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CollectionSearchResults,
  type CollectionSearchResult,
  useCollectionSearch,
  useKeyboardShown,
} from '@/components/collection/collection-search';
import { CollectionSearchBar } from '@/components/collection/collection-search-bar';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

// The floating tab bar's gap above the bottom safe-area inset
// (BAR_BOTTOM_GAP in components/navigation/global-floating-tab-bar.tsx).
const FLOATING_NAV_BOTTOM_GAP = 4;
// Breathing room between the status bar and the sheet's top edge when the
// sheet is as tall as it can get (design spacing, not a keyboard offset).
const SHEET_TOP_GAP = 12;
// Gap kept under the results while the sheet sits on the keyboard.
const KEYBOARD_BOTTOM_GAP = 12;

type Props = {
  visible: boolean;
  onClose: () => void;
  onAddFolder: () => void;
  onAddItem: () => void;
  // Optional "Search Collections" field above the options — Profile V2's
  // owner long-press only. Searches the owner's own collections (private
  // and nested ones included); choosing a result calls onSelect, and the
  // caller closes the menu and opens it. Omitted (the Collections screens'
  // "+ Add"), the menu is just the two options, exactly as before.
  search?: {
    ownerId: string;
    onSelect: (collection: CollectionSearchResult) => void;
  };
  // Optional switch row after Add Collection — Profile V2's "List View"
  // switch (on = List View, off = Grid View). Flipping it doesn't close the
  // menu. Omitted everywhere else.
  toggleOption?: {
    icon: 'list.bullet';
    title: string;
    subtitle: string;
    value: boolean;
    onChange: (value: boolean) => void;
  };
};

type MenuOption = {
  id: string;
  icon: 'folder.fill' | 'rectangle.stack.fill';
  title: string;
  subtitle: string;
  onSelect: () => void;
};

// The Collections screen's "+ Add" chooser — same bottom-sheet shell shape
// (backdrop dismiss, drag handle, divided icon rows) as
// components/create/create-menu.tsx, kept as its own small component
// rather than added to that one since these two options (Add Item / Add
// Collection) are specific to the Collections screen, not general
// content-create types like Text Post/Share Card. Icons match the Create
// menu's own item (Share Item) and collection (Share a Collection) icons.
// "Add Collection" is UI wording only — it still creates a folder.
export function CollectionAddMenu({
  visible,
  onClose,
  onAddFolder,
  onAddItem,
  search: searchConfig,
  toggleOption,
}: Props) {
  // The options sit above where the floating tab bar normally is — up in
  // easy thumb reach — rather than down against the home indicator. Once
  // the keyboard is up (only possible with the search field) the sheet sits
  // on it instead, so that space would just be a gap.
  const insets = useSafeAreaInsets();
  const keyboardShown = useKeyboardShown();
  const bottomSpace = keyboardShown ? KEYBOARD_BOTTOM_GAP : insets.bottom + FLOATING_NAV_BOTTOM_GAP + TAB_BAR_HEIGHT;
  const inputRef = useRef<TextInput>(null);
  // Same search logic, privacy rules and results list as a visitor's Search
  // Collections sheet (components/collection/collection-search.tsx) — here
  // the owner's own collections, private ones included.
  const search = useCollectionSearch(searchConfig?.ownerId, { includePrivate: true });
  const { setQuery } = search;
  const showingResults = !!searchConfig && (!!search.needle || (!search.list && search.failed));

  // Every way out resets the query, so the next open shows the options.
  function close() {
    inputRef.current?.blur();
    setQuery('');
    onClose();
  }

  const OPTIONS: MenuOption[] = [
    {
      id: 'item',
      icon: 'rectangle.stack.fill',
      title: 'Add Item',
      subtitle: 'Add a card to a collection',
      onSelect: onAddItem,
    },
    {
      id: 'folder',
      icon: 'folder.fill',
      title: 'Add Collection',
      subtitle: 'Create a new collection',
      onSelect: onAddFolder,
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent>
      {/* Keyboard-aware by layout (same as the Search Collections sheet):
          KeyboardAvoidingView pads the bottom by the keyboard's height (iOS
          — Android's modal window resizes itself), the backdrop keeps the
          status-bar inset clear, and the sheet (flexShrink) only ever takes
          the space between them — so the search field stays on screen
          above the keyboard and results scroll within what's left. With no
          search field there's never a keyboard, and this lays out as
          before. */}
      <KeyboardAvoidingView
        style={[styles.backdrop, { paddingTop: insets.top + SHEET_TOP_GAP }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />

        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          {searchConfig && (
            // Not focused on open — the keyboard only comes up when the
            // field is tapped, which is also when the collections load.
            <CollectionSearchBar
              inputRef={inputRef}
              value={search.query}
              onChange={setQuery}
              onFocus={search.load}
              placeholder="Search Collections"
              style={styles.search}
            />
          )}

          {showingResults && searchConfig ? (
            <View style={styles.results}>
              <CollectionSearchResults
                search={search}
                onSelect={(collection) => {
                  inputRef.current?.blur();
                  setQuery('');
                  searchConfig.onSelect(collection);
                }}
              />
            </View>
          ) : (
            OPTIONS.map((option, index) => (
              <View key={option.id}>
                {index > 0 && <View style={styles.divider} />}
                <TouchableOpacity
                  style={styles.row}
                  onPress={option.onSelect}
                  activeOpacity={0.65}>

                  <View style={styles.iconWrap}>
                    <IconSymbol name={option.icon} size={20} color="#FFFFFF" />
                  </View>

                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{option.title}</Text>
                    <Text style={styles.rowSubtitle}>{option.subtitle}</Text>
                  </View>

                  <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />
                </TouchableOpacity>
              </View>
            ))
          )}

          {!showingResults && toggleOption && (
            <View>
              <View style={styles.divider} />
              {/* Same row shape as the options above, a switch in place of
                  the chevron — the app's established switch styling (as in
                  the item details forms): light-blue track when on, white
                  thumb. The whole row flips it too. */}
              <Pressable
                style={styles.row}
                onPress={() => toggleOption.onChange(!toggleOption.value)}
                accessibilityRole="switch"
                accessibilityLabel={toggleOption.title}
                accessibilityState={{ checked: toggleOption.value }}>
                <View style={styles.iconWrap}>
                  <IconSymbol name={toggleOption.icon} size={20} color="#FFFFFF" />
                </View>

                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{toggleOption.title}</Text>
                  <Text style={styles.rowSubtitle}>{toggleOption.subtitle}</Text>
                </View>

                <Switch
                  value={toggleOption.value}
                  onValueChange={toggleOption.onChange}
                  trackColor={{ false: PV2.collectorPanelBg, true: PV2.actionPrimary }}
                  thumbColor="#fff"
                />
              </Pressable>
            </View>
          )}

          {/* Lifts the options into thumb reach (see bottomSpace) */}
          <View style={{ height: bottomSpace }} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    // Shrinks to the space between the status bar and the keyboard.
    flexShrink: 1,
    backgroundColor: '#161616',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginBottom: 20,
  },
  search: {
    marginBottom: 8,
  },
  // Takes the sheet's remaining height and scrolls inside it (the results'
  // FlatList), under the search field.
  results: {
    flexShrink: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 14,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 11,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  rowSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.50)',
  },
});

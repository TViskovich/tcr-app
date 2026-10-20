import { type ReactNode, useRef } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardShown } from '@/components/collection/collection-search';
import { CollectionSearchBar } from '@/components/collection/collection-search-bar';

// Breathing room between the status bar and the sheet's top edge when the
// sheet is as tall as it can get (design spacing, not a keyboard offset).
const SHEET_TOP_GAP = 12;

type Props = {
  visible: boolean;
  query: string;
  onChangeQuery: (query: string) => void;
  placeholder: string;
  // Every way out (backdrop tap, Android back) — the caller resets its
  // query here, so the next open starts empty. (Not reset on open: the
  // field is already focused then, and could already hold typed letters.)
  onClose: () => void;
  // The results, under the field. Scrolls within whatever height is left.
  children: ReactNode;
};

// The bottom-sheet search shell shared by Profile V2's long-press searches
// (Search Collections, Search Items): same presentation, animation and
// keyboard behavior for both.
//
// Fade, not slide: the sheet's rise comes from the keyboard. The field
// autoFocuses as the sheet mounts, so the keyboard starts up immediately and
// KeyboardAvoidingView carries the sheet up on the keyboard's own animation
// — search bar and keyboard move as one.
//
// Keyboard-aware by layout, not offsets: KeyboardAvoidingView pads the
// bottom by the keyboard's height (iOS — Android's modal window resizes
// itself), the backdrop keeps the status-bar inset clear at the top, and
// the sheet (flexShrink) is only ever as tall as the space left between
// them. So the field stays on screen above the keyboard on every screen
// size, and the results scroll underneath it. An overlay, so dismissing it
// leaves the profile's layout and scroll position untouched.
export function ProfileV2SearchSheet({ visible, query, onChangeQuery, placeholder, onClose, children }: Props) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  // While the keyboard is up the sheet sits on it, so the home-indicator
  // inset below the results no longer applies.
  const keyboardShown = useKeyboardShown();

  function close() {
    inputRef.current?.blur();
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      // Fallback only — e.g. Android, where autoFocus inside a Modal can miss
      // opening the keyboard. A no-op when the field is already focused.
      onShow={() => inputRef.current?.focus()}
      statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.backdrop, { paddingTop: insets.top + SHEET_TOP_GAP }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Tapping outside the sheet dismisses it */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close search" />

        <View style={[styles.sheet, { paddingBottom: (keyboardShown ? 0 : insets.bottom) + 12 }]}>
          <View style={styles.handle} />
          <CollectionSearchBar
            inputRef={inputRef}
            autoFocus
            value={query}
            onChange={onChangeQuery}
            placeholder={placeholder}
            style={styles.search}
          />
          <View style={styles.results}>{children}</View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Same bottom-sheet shell as components/collection/collection-add-menu.tsx.
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
    marginBottom: 16,
  },
  search: {
    marginBottom: 8,
  },
  // Takes the sheet's remaining height and scrolls inside it (the results'
  // FlatList), under the search field. No minimum: with no query there's
  // nothing here, so the sheet is just the search field.
  results: {
    flexShrink: 1,
  },
});

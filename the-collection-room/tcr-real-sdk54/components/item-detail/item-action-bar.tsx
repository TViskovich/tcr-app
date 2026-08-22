import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

const IcLogo = require('@/assets/icons/ic-logo-transparent.png');

type Props = {
  // Opens the consolidated CacheCase Registry page (app/registry/[id].tsx)
  // when this item is registered, or a short "Not Registered" notice
  // otherwise — see app/item/[id].tsx's handleCacheCaseIdPress. Previously
  // opened a local placeholder bottom sheet (components/item-detail/
  // cachecase-id-sheet.tsx, removed) with no real data; this button now
  // leads to the one real registry screen instead of a second, fake one.
  onPressCacheCaseId: () => void;
  // Bookmark is the one icon in this row with real, already-existing
  // business logic elsewhere on the same screen (useSavedCard) — wired
  // here rather than left as a placeholder. Omitted entirely — renders the
  // same static placeholder icon as before — when the viewer is the
  // item's owner, matching the header BookmarkButton's own owner-gating
  // (an owner isn't offered a control to bookmark their own card).
  isSaved?: boolean;
  onPressBookmark?: () => void;
  savingBookmark?: boolean;
};

// Heart/comment/search/share were removed from this row (beta polish —
// they rendered as plain, non-interactive Views that looked identically
// tappable to the real CacheCase ID and Bookmark controls beside them, but
// had no backing feature at all: this app has no item-like, item-comment,
// or item-search concept anywhere, and share exists elsewhere — e.g.
// app/collection/[folderId].tsx's own handleShare — but was never wired
// here). Only CacheCase ID (always wired) and Bookmark (wired when
// onPressBookmark is passed) remain. The centered dots stay as a
// deliberate decorative accent, not a control — flex:1 on both `side`
// containers keeps it truly centered regardless of how many real icons
// end up on either side.
export function ItemActionBar({ onPressCacheCaseId, isSaved, onPressBookmark, savingBookmark }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={onPressCacheCaseId}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="CacheCase ID">
          {/* Brand mark, not a tintable glyph — no color prop, kept exactly
              as designed (metallic silver, own transparency). */}
          <Image source={IcLogo} contentFit="contain" style={styles.icLogo} />
        </TouchableOpacity>
      </View>

      <View style={styles.center}>
        <Text style={styles.dots}>•  •  •</Text>
      </View>

      <View style={[styles.side, styles.sideRight]}>
        {onPressBookmark ? (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onPressBookmark}
            disabled={savingBookmark}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={isSaved ? 'Remove bookmark' : 'Bookmark'}
            accessibilityState={{ selected: !!isSaved, disabled: !!savingBookmark }}>
            {/* Same active/inactive glyph+color convention as the folder-
                detail bookmark control (app/collection/[folderId].tsx) —
                filled + PV2.accent when saved, outline + PV2.textPrimary
                otherwise. */}
            <IconSymbol
              name={isSaved ? 'bookmark.fill' : 'bookmark'}
              size={21}
              color={isSaved ? PV2.accent : PV2.textPrimary}
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconBtn}>
            <IconSymbol name="bookmark" size={21} color={PV2.textPrimary} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  side: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sideRight: {
    justifyContent: 'flex-end',
  },
  center: {
    paddingHorizontal: 10,
  },
  dots: {
    color: PV2.textTertiary,
    fontSize: 13,
    letterSpacing: 1,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Matches the 21px height of the surrounding icons; width follows the
  // source PNG's own aspect ratio (563x350) rather than a hand-picked
  // number, so it can't distort. iconBtn's own centering keeps it
  // optically aligned with the rest of the row — same as every other icon.
  icLogo: {
    height: 21,
    aspectRatio: 563 / 350,
  },
});

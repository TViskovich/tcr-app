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
  // Comment/Like/Share — the item-detail social row, one-for-one matching
  // app/collection/[folderId].tsx's own galleryActionsGroup (order, icons,
  // active-state color). Comment opens ItemCommentsSheet (item_comments,
  // hooks/use-item-comments.ts); Like is the optimistic item_likes toggle
  // (hooks/use-item-likes.ts). Share is native Share.share(), shown for the
  // owner too (never owner-gated). No logic here changed by the one-row
  // layout pass below — same props, same handlers, just repositioned.
  onPressComment: () => void;
  liked: boolean;
  likeCount: number;
  likeInFlight: boolean;
  onPressLike: () => void;
  onPressShare: () => void;
};

// One row now: CacheCase ID on the left, Comment/Like/Share grouped on the
// right — replaces the previous two-row layout (CacheCase ID + decorative
// "•  •  •" dots on top, Comment/Like/Share on their own row below). The
// dots are gone entirely (they read as a second, redundant overflow
// control sitting below the header's own real "..."/Edit-Save menu) rather
// than folded into this row — there was never a real action behind them.
export function ItemActionBar({
  onPressCacheCaseId,
  onPressComment,
  liked,
  likeCount,
  likeInFlight,
  onPressLike,
  onPressShare,
}: Props) {
  return (
    <View style={styles.row}>
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

      {/* Comment / Like / Share — same order/icons/active-state color as
          the collection detail screen's own social row. */}
      <View style={styles.socialRow}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={onPressComment}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Comment">
          <IconSymbol name="message" size={20} color={PV2.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.likeBtn}
          onPress={onPressLike}
          disabled={likeInFlight}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={liked ? 'Unlike' : 'Like'}
          accessibilityState={{ selected: liked, disabled: likeInFlight }}>
          <IconSymbol name={liked ? 'heart.fill' : 'heart'} size={20} color={liked ? PV2.accent : PV2.textPrimary} />
          <Text style={[styles.likeCount, liked && styles.likeCountActive]}>{likeCount}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.iconBtn}
          onPress={onPressShare}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Share">
          <IconSymbol name="square.and.arrow.up" size={20} color={PV2.textPrimary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
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
  // Comment/Like/Share — same gap as before (24, unchanged), now the
  // row's right-hand flex child instead of a separate row underneath.
  socialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
  },
  likeCount: {
    fontSize: 13,
    fontWeight: '500',
    color: PV2.textSecondary,
    minWidth: 16,
  },
  likeCountActive: {
    color: PV2.accent,
  },
});

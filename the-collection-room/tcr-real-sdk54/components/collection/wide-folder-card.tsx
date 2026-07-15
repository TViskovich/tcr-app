import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Structural framework only (wide-folder-v1, first pass) — no cover
// artwork, animation, or decoration yet. The right-hand region is reserved
// space for a future Image, sized/inset now so wiring one in later doesn't
// require touching this card's layout.
export const WIDE_FOLDER_CARD_HEIGHT = 116;
const CARD_RADIUS = 20;
const PREVIEW_RADIUS = 14;
const PREVIEW_WIDTH_PERCENT = '30%';
const PREVIEW_INSET = 10;

type Props = {
  title: string;
  // No real "sub-folder" concept exists in this app's data model today —
  // this stays optional/unrendered unless a caller actually has a count to
  // pass, rather than this component inventing a fake number.
  folderCount?: number;
  itemCount?: number;
  // Accepted now for interface stability; deliberately unused in this
  // pass's JSX — see previewSlot below.
  previewSource?: string | null;
  onPress: () => void;
};

export function WideFolderCard({ title, folderCount, itemCount, onPress }: Props) {
  const metaParts: string[] = [];
  if (folderCount !== undefined) {
    metaParts.push(`${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`);
  }
  if (itemCount !== undefined) {
    metaParts.push(`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`);
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}>
      <View style={styles.left}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {metaParts.length > 0 && (
          <Text style={styles.meta} numberOfLines={1}>
            {metaParts.join(' • ')}
          </Text>
        )}
      </View>

      {/* Reserved for real cover artwork later — a bare neutral surface
          only, no image/icon/text/button in this pass. The 30% outer slot
          width is what "reserves" the space; the inset inner surface is
          just how it reads as intentional rather than unfinished today. */}
      <View style={styles.previewSlot}>
        <View style={styles.previewSurface} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    height: WIDE_FOLDER_CARD_HEIGHT,
    flexDirection: 'row',
    borderRadius: CARD_RADIUS,
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.85,
  },
  left: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 18,
  },
  title: {
    color: PV2.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  meta: {
    marginTop: 4,
    color: PV2.textTertiary,
    fontSize: 13,
  },
  previewSlot: {
    width: PREVIEW_WIDTH_PERCENT,
  },
  previewSurface: {
    flex: 1,
    margin: PREVIEW_INSET,
    borderRadius: PREVIEW_RADIUS,
    backgroundColor: PV2.emptyCardBg,
  },
});

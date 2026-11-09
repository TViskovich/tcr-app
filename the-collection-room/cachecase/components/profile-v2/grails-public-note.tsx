import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';

// Shown in the Top 9 Grails pickers (app/grail-slot/pick-item.tsx and
// pick-collection.tsx) above the choices, so a collector sees it before
// tapping Save. Placing something in Grails publishes it — "Grail placement
// = implicit publish" (supabase/migrations/20260910120000_grail_slot_
// visibility_exception.sql):
//   * an item: its collection_items row (title, brand, year, player/team,
//     grade, grading company, serial number, description, estimated value)
//     and its photos (collection_item_images; signed by
//     get-collection-item-image-signed-url) become visible to anyone, even
//     if the item is private. Its category-specific details, purchase price
//     (collection_item_private_details, owner-only), comments, likes and the
//     rest of its collection are NOT made visible.
//   * a collection: only its own record (name and details such as its
//     description) becomes visible — not the items inside, and not a private
//     cover photo (get-folder-cover-signed-url has no Grails exception).
// Keep this wording in step with those rules.
export const GRAILS_PUBLIC_NOTE = {
  item:
    'Your Grails are public. Anyone can see an item you add here, including its photos and main details such as title, grade, serial number and estimated value, even if the item is private. Its purchase price and the rest of your collection stay private.',
  collection:
    'Your Grails are public. Anyone can see the name and details of a collection you add here, such as its description, even if it’s private. The items inside keep their own privacy settings.',
} as const;

export function GrailsPublicNote({ kind, style }: { kind: keyof typeof GRAILS_PUBLIC_NOTE; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.note, style]} accessible accessibilityRole="text" accessibilityLabel={GRAILS_PUBLIC_NOTE[kind]}>
      <Text style={styles.text}>{GRAILS_PUBLIC_NOTE[kind]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PV2.collectorPanelBorder,
    backgroundColor: PV2.collectorPanelBg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  text: {
    color: PV2.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
});

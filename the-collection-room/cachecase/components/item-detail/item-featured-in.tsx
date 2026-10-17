import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRouter } from 'expo-router';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useFolderAncestry } from '@/hooks/use-folder-ancestry';

type Props = {
  // The item's own collection_items.folder_id.
  folderId: string | null | undefined;
};

// "Featured In" — the collection path an item lives in, outermost first
// (DC Comics › Absolute Batman), each name opening that collection. Only
// collections this viewer can see are ever listed (see useFolderAncestry);
// if the item's own collection isn't visible, a muted line replaces the
// links. Renders nothing while loading or if the lookup failed, so the
// page never shows a broken or placeholder link.
export function ItemFeaturedIn({ folderId }: Props) {
  const router = useRouter();
  const { status, path } = useFolderAncestry(folderId);

  if (status === 'loading' || status === 'error') return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>Featured In</Text>
      {path ? (
        <View style={styles.trail}>
          {path.map((crumb, index) => (
            <Fragment key={crumb.id}>
              {index > 0 && (
                <IconSymbol name="chevron.right" size={11} color={PV2.textTertiary} style={styles.separator} />
              )}
              <Pressable
                onPress={() =>
                  router.push({ pathname: '/collection/[folderId]', params: { folderId: crumb.id, title: crumb.name } })
                }
                hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
                style={({ pressed }) => [styles.crumb, pressed && styles.crumbPressed]}
                accessibilityRole="link"
                accessibilityLabel={`Open collection ${crumb.name}`}>
                <Text style={styles.crumbText} numberOfLines={1}>
                  {crumb.name}
                </Text>
              </Pressable>
            </Fragment>
          ))}
        </View>
      ) : (
        <Text style={styles.unavailable}>Collection not available</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same horizontal inset/spacing rhythm as ItemMetadataSection above it.
  wrap: {
    marginTop: 20,
    paddingHorizontal: 20,
  },
  // Same section-label treatment as RelatedItemsGrid's header.
  header: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  // Wraps onto further lines for a long or deep path; each name is capped
  // to one line and truncates within the row's width.
  trail: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    rowGap: 6,
  },
  crumb: {
    flexShrink: 1,
    maxWidth: '100%',
    paddingVertical: 4,
  },
  crumbPressed: {
    opacity: 0.6,
  },
  crumbText: {
    fontSize: 14,
    fontWeight: '600',
    color: PV2.actionPrimary,
  },
  separator: {
    marginHorizontal: 6,
  },
  unavailable: {
    fontSize: 14,
    color: PV2.textTertiary,
  },
});

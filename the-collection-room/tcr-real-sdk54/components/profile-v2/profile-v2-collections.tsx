import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CollectionPreviewSection } from '@/components/collection/collection-preview-section';
import type { CollectionGridEntry } from '@/hooks/use-collection';
import type { CollectionItem, Folder } from '@/types';
import { PV2 } from './profile-v2-theme';

type Props = {
  folders: Folder[];
  // Keyed by folder id — same shape hooks/use-collection.ts's useFolders()
  // returns for app/(tabs)/collection.tsx, passed straight through by the
  // caller rather than re-fetched here. Mixed item/child-folder entries,
  // already recency-sorted (buildPreviewEntries) — this component does no
  // ordering of its own.
  previewEntries: Record<string, CollectionGridEntry[]>;
  onOpenFolder: (folder: Folder) => void;
  // Opens a specific card's item-detail page — tapping a preview tile
  // should land on that card, not the folder it lives in (matches the
  // main Collection page's own HorizontalCardPreview behavior).
  onOpenItem: (item: CollectionItem) => void;
  // Opens a direct child folder from a mixed preview row — the same
  // recursive /collection/[folderId] route, distinct from onOpenFolder
  // (which always opens the row's own top-level folder).
  onOpenChildFolder: (folder: Folder) => void;
  // Owner-only — omitted when viewing someone else's profile. Folder
  // navigation (above) always works either way; only the "add a card" /
  // "create a folder" actions are gated, since those would otherwise add
  // to the *viewer's* own collection while looking like they belong to
  // the profile being viewed.
  onAddItem?: (folder: Folder) => void;
  onCreatePress?: () => void;
};

// A compact, vertically-stacked preview of the same folder rows the main
// Collection page renders (app/(tabs)/collection.tsx) — same
// CollectionPreviewSection/CollectionHeaderRow/HorizontalCardPreview/
// CollectionPreviewCard components, just in variant="compact" so
// dimensions/typography shrink to fit beneath the profile tab selector.
// No data fetching, no folder/item resolution, no separate navigation
// logic of its own — folders/previewItems and every handler come from the
// caller (app/(tabs)/profile.tsx), which already scopes them to whichever
// profile is being viewed.
//
// Renders inside the profile screen's single outer ScrollView (not its own
// FlatList) — a nested *vertical* list here would fight that outer scroll,
// but each row's own HorizontalCardPreview is a horizontal FlatList, which
// doesn't conflict.
export function ProfileV2Collections({
  folders,
  previewEntries,
  onOpenFolder,
  onOpenItem,
  onOpenChildFolder,
  onAddItem,
  onCreatePress,
}: Props) {
  if (folders.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <CacheCaseLogo variant="icon" size="md" style={styles.emptyLogo} />
        <Text style={styles.emptyTitle}>No collections yet</Text>
        <Text style={styles.emptyBody}>
          Start organizing your cards into folders — by set, player, team, or however you collect.
        </Text>
        {onCreatePress && (
          <TouchableOpacity style={styles.emptyButton} onPress={onCreatePress} activeOpacity={0.85}>
            <Text style={styles.emptyButtonText}>Create First Collection</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {folders.map((folder, index) => (
        <View key={folder.id} style={index > 0 && styles.rowSeparator}>
          <CollectionPreviewSection
            folderId={folder.id}
            title={folder.name}
            entries={previewEntries[folder.id] ?? []}
            isExpanded
            onOpenFolder={() => onOpenFolder(folder)}
            // Rows here never actually collapse (isExpanded is always
            // true above) — passing onToggle isn't wiring real
            // expand/collapse, it's what makes CollectionHeaderRow render
            // its trailing chevron at all (see the `{onToggle && (...)}`
            // guard there), so the reference's right-edge "expand
            // indicator" appears. Pointed at the same onOpenFolder as the
            // title tap, since there's nothing to actually toggle.
            onToggle={() => onOpenFolder(folder)}
            onOpenItem={onOpenItem}
            onOpenChildFolder={onOpenChildFolder}
            onAddItem={() => onAddItem?.(folder)}
            variant="compact"
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // No top margin — the starting offset below the sticky tab row is now
  // owned entirely by profile-v2-screen.tsx's shared TAB_CONTENT_TOP_GAP
  // (tabBodyWrap), so every tab body begins at the same height. Spacing
  // BETWEEN sections (rowSeparator below) is unrelated and untouched.
  list: {},
  // Tighter than app/(tabs)/collection.tsx's own 22px rowSeparator — this
  // is the "tighten vertical spacing between entries" compaction, same
  // idea, smaller value.
  rowSeparator: {
    marginTop: 14,
  },
  // Same restrained dark-panel language as the main Collection page's own
  // empty state (app/(tabs)/collection.tsx), scaled down to sit inline in
  // the profile tab rather than filling the whole screen.
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  emptyLogo: {
    opacity: 0.85,
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: PV2.textSecondary,
    textAlign: 'center',
    maxWidth: 280,
  },
  emptyButton: {
    marginTop: 18,
    height: 42,
    paddingHorizontal: 22,
    borderRadius: 21,
    backgroundColor: PV2.accentSoft,
    borderWidth: 1,
    borderColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
});

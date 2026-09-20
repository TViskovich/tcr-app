import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CollectionPreviewSection } from '@/components/collection/collection-preview-section';
import { IconSymbol } from '@/components/ui/icon-symbol';
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
  // Authoritative per-folder active-item counts — hooks/use-collection.ts's
  // useFolders().itemCounts, passed straight through by the caller
  // (profile-v2-screen.tsx). Drives each row's own "+N more" overflow tile
  // (see components/collection/horizontal-card-preview.tsx) — a folder
  // missing from this map (not yet loaded, or genuinely zero items) is
  // treated as 0, same fallback convention already used for the "N items"
  // labels in move-item-modal.tsx/claim-folder-picker.tsx.
  itemCounts: Record<string, number>;
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
  // Owner-only, same gating as onCreatePress/onAddItem above — the small
  // "+" rendered at the end of this tab's real content (see the render
  // below), distinct from onCreatePress: this opens the actual
  // CreateFolderModal in place (profile-v2-screen.tsx owns that state),
  // rather than navigating away to the old Collection page the way
  // onCreatePress's empty-state button still does. Kept as a separate prop
  // rather than repointing onCreatePress itself, so that existing button's
  // behavior is left untouched.
  onCreateFolderPress?: () => void;
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
  itemCounts,
  onOpenFolder,
  onOpenItem,
  onOpenChildFolder,
  onAddItem,
  onCreatePress,
  onCreateFolderPress,
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
        {onCreateFolderPress && (
          <TouchableOpacity
            style={styles.addFolderButton}
            onPress={onCreateFolderPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Create new collection">
            <IconSymbol name="plus" size={30} color={PV2.textPrimary} />
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
            itemCount={itemCounts[folder.id] ?? 0}
            isExpanded
            onOpenFolder={() => onOpenFolder(folder)}
            // No onToggle here (deliberately) — rows in this compact
            // profile view never actually collapse (isExpanded is always
            // true above), and CollectionHeaderRow only renders its
            // trailing chevron when an onToggle is passed at all. This
            // row used to fake one (pointed at the same onOpenFolder as
            // the title tap) purely to make that decorative chevron
            // appear; removed so the far-right control is gone entirely
            // rather than duplicating the title's own navigation. The
            // main Collection page (app/(tabs)/collection.tsx) still
            // passes a real onToggle for its own genuine collapse/expand.
            onOpenItem={onOpenItem}
            onOpenChildFolder={onOpenChildFolder}
            onAddItem={() => onAddItem?.(folder)}
            variant="compact"
          />
        </View>
      ))}

      {/* Owner-only "+" — create-new-folder action, directly after the real
          folder content. Plain content flow (not absolutely positioned, no
          extra spacer/minHeight), so it's simply the last thing in this
          tab's own intrinsic height — profile-v2-screen.tsx's ScrollView
          nav-clearance padding (TAB_BAR_HEIGHT + insets.bottom + 24,
          unchanged) is what lets it clear the floating nav, the same as
          every other tab. */}
      {onCreateFolderPress && (
        <TouchableOpacity
          style={styles.addFolderButton}
          onPress={onCreateFolderPress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Create new collection">
          <IconSymbol name="plus" size={30} color={PV2.textPrimary} />
        </TouchableOpacity>
      )}
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
  // Just a "+" glyph — no pill, no label, no filled circle, transparent
  // background. 44x44 touch target (accessibility minimum) even though the
  // glyph itself (size 30, within the requested 28-34px range) is smaller;
  // centered horizontally as the last thing in this tab's content, with
  // enough top spacing to read as a distinct action below the real content
  // above it, not squeezed against it.
  addFolderButton: {
    alignSelf: 'center',
    marginTop: 20,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

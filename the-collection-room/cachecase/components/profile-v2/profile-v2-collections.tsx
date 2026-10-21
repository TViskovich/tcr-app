import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Image } from 'expo-image';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CollectionPreviewSection } from '@/components/collection/collection-preview-section';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { CollectionGridEntry } from '@/hooks/use-collection';
import type { ProfileViewMode } from '@/hooks/use-profile-view-mode';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { COMPACT_IMAGE_TIER } from '@/lib/image-tiers';
import type { CollectionItem, Folder } from '@/types';
import { PV2 } from './profile-v2-theme';

// Hold time on a collection/item entry before it enters Edit Mode — the
// same as the tab pills' long-press menus.
export const ENTRY_LONG_PRESS_MS = 400;
// A top-level List View row's height (48pt cover + 8pt padding above and
// below) — Edit Mode's sortable list positions rows by it.
export const COLLECTION_ROW_HEIGHT = 48 + 8 * 2;

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
  // Grid View (the default — the photo preview rows below) or List View
  // (compact rows; the viewer's own preference, see
  // hooks/use-profile-view-mode.ts). Same data either way.
  layout?: ProfileViewMode;
  // Owner only: long-pressing a top-level collection (its List View row or
  // Grid View title) enters Edit Mode. Omitted for a visitor.
  onLongPressCollection?: (folder: Folder) => void;
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
  layout = 'grid',
  onLongPressCollection,
}: Props) {
  const isList = layout === 'list';
  // List View's direct child collections per root — the folder entries of
  // the same preview rows Grid View draws, in the same order, so both views
  // show the same collections. Deeper levels open from there, as in Grid.
  const childFoldersByRoot = useMemo(() => {
    const byRoot: Record<string, Folder[]> = {};
    for (const folder of folders) {
      byRoot[folder.id] = (previewEntries[folder.id] ?? []).flatMap((e) => (e.kind === 'folder' ? [e.folder] : []));
    }
    return byRoot;
  }, [folders, previewEntries]);
  // Small covers for List View only (none signed in Grid View) — one batched
  // compact-tier call, the same hook and cache the other collection tiles use.
  const listFolderIds = isList ? folders.flatMap((f) => [f.id, ...childFoldersByRoot[f.id].map((c) => c.id)]) : [];
  const { coverSource } = useSignedFolderCovers(listFolderIds, COMPACT_IMAGE_TIER);

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
      {isList ? (
        <View style={styles.listView}>
          {folders.map((folder, index) => (
            <View key={folder.id}>
              {index > 0 && <View style={styles.listDivider} />}
              <CollectionListRow
                folder={folder}
                cover={coverSource(folder)}
                subtitle={`${itemCounts[folder.id] ?? 0} ${(itemCounts[folder.id] ?? 0) === 1 ? 'item' : 'items'}`}
                onPress={() => onOpenFolder(folder)}
                onLongPress={onLongPressCollection ? () => onLongPressCollection(folder) : undefined}
              />
              {/* Nested under their parent, indented — never mixed in with
                  other roots' collections. */}
              {childFoldersByRoot[folder.id].map((child) => (
                <CollectionListRow
                  key={child.id}
                  folder={child}
                  cover={coverSource(child)}
                  nested
                  onPress={() => onOpenChildFolder(child)}
                />
              ))}
            </View>
          ))}
        </View>
      ) : folders.map((folder, index) => (
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
            onLongPressTitle={onLongPressCollection ? () => onLongPressCollection(folder) : undefined}
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

// One List View row: small cover, title, item count (roots — the count Grid
// View's rows use; child counts aren't loaded here), three bars. Child rows
// are indented with a smaller cover so they read as belonging to the
// parent row above.
export function CollectionListRow({
  folder,
  cover,
  subtitle,
  nested = false,
  highlighted = false,
  onPress,
  onLongPress,
}: {
  folder: Folder;
  cover: { uri: string; cacheKey?: string } | null;
  subtitle?: string;
  nested?: boolean;
  // Edit Mode's initially selected entry — a subtle accent outline.
  highlighted?: boolean;
  // Omitted (Edit Mode) = a static row: nothing to tap, so no navigation.
  onPress?: () => void;
  // Owner only: enters Edit Mode; once it fires, the release doesn't
  // also open the collection.
  onLongPress?: () => void;
}) {
  const style = [styles.listRow, nested && styles.listRowNested, highlighted && styles.listRowHighlighted];
  const content = (
    <>
      <View style={[styles.listCover, nested && styles.listCoverNested]}>
        {cover ? (
          <Image source={cover} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        ) : (
          <IconSymbol name="folder.fill" size={nested ? 14 : 18} color={PV2.textTertiary} />
        )}
      </View>
      <View style={styles.listRowText}>
        <Text style={[styles.listTitle, nested && styles.listTitleNested]} numberOfLines={1}>
          {folder.name}
        </Text>
        {!!subtitle && <Text style={styles.listSubtitle}>{subtitle}</Text>}
      </View>
      {/* Three bars — the reorder handle look. The drag itself is the
          owner's Edit Mode (long-press anywhere on the row); otherwise the
          whole row opens the collection. */}
      <IconSymbol name="line.3.horizontal" size={14} color="rgba(255,255,255,0.28)" />
    </>
  );
  const label = [folder.name, subtitle].filter(Boolean).join(', ');
  if (!onPress) {
    return (
      <View style={style} accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={style}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? ENTRY_LONG_PRESS_MS : undefined}
      activeOpacity={0.65}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? 'Long press to rearrange collections' : undefined}>
      {content}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // List View — compact rows in the page's own 16px inset, subtle dividers
  // between root collections (each root's children stay grouped with it).
  listView: {
    marginHorizontal: 16,
  },
  listDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: PV2.dividerColor,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  listRowHighlighted: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PV2.actionPrimary,
    paddingHorizontal: 6,
    marginHorizontal: -7,
    // 1pt less padding offsets the 1pt border, so the row's height (which
    // the Edit Mode list positions by) doesn't change.
    paddingVertical: 7,
  },
  listRowNested: {
    paddingLeft: 24,
    paddingVertical: 6,
  },
  listCover: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listCoverNested: {
    width: 36,
    height: 36,
    borderRadius: 6,
  },
  listRowText: {
    flex: 1,
    gap: 2,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  listTitleNested: {
    fontSize: 14,
    fontWeight: '500',
  },
  listSubtitle: {
    fontSize: 12,
    color: PV2.textTertiary,
  },
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
    backgroundColor: PV2.actionPrimarySoft,
    borderWidth: 1,
    borderColor: PV2.actionPrimary,
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

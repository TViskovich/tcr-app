import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { FolderCard } from '@/components/collection/folder-card';
import type { Folder } from '@/types';
import { PV2 } from './profile-v2-theme';

type Props = {
  folders: Folder[];
  onFolderPress: (folder: Folder) => void;
  onCreatePress: () => void;
};

// Plain flex-wrap grid, not a FlatList — this renders inside the profile
// screen's single outer ScrollView, and a nested scrollable list here would
// fight that outer scroll.
export function ProfileV2Collections({ folders, onFolderPress, onCreatePress }: Props) {
  if (folders.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No folders yet</Text>
        <TouchableOpacity style={styles.emptyBtn} onPress={onCreatePress} activeOpacity={0.85}>
          <Text style={styles.emptyBtnLabel}>Create First Folder</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.grid}>
      {folders.map((folder) => (
        <FolderCard key={folder.id} folder={folder} onPress={() => onFolderPress(folder)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
    paddingHorizontal: 16,
    marginTop: 14,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: PV2.textSecondary,
    fontSize: 15,
    marginBottom: 16,
  },
  emptyBtn: {
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    backgroundColor: PV2.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBtnLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});

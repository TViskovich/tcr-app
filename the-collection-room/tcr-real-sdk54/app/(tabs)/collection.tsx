import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import {
  PORTRAIT_SCREEN_BG,
  PORTRAIT_TEXT_MUTED,
  PORTRAIT_TEXT_PRIMARY,
  PortraitFolderCard,
} from '@/components/collection/portrait-folder-card';
import { useAuth } from '@/lib/auth';
import { useFolders } from '@/hooks/use-collection';

// portrait-folder-v1 grid spacing — one consistent outer screen gutter, a
// tighter gap between the two columns, and a taller gap between rows so
// folder groups read as distinct rows rather than one dense mass.
const OUTER_GUTTER = 18;
const COLUMN_GAP = 12;
const ROW_GAP = 22;

export default function CollectionScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? '';
  const { folders, loading, refresh, itemCounts } = useFolders(userId);
  const [showModal, setShowModal] = useState(false);
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Derived from the real window width and the grid's own spacing constants
  // — never a hardcoded card width tied to one device.
  const tileWidth = (windowWidth - OUTER_GUTTER * 2 - COLUMN_GAP) / 2;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Collection</Text>
        <TouchableOpacity onPress={() => setShowModal(true)} style={styles.newButton}>
          <Text style={styles.newButtonText}>+ New Folder</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : folders.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>📁</Text>
          <Text style={styles.emptyTitle}>No folders yet</Text>
          <Text style={styles.emptyBody}>
            Create your first folder to start organizing your collection.
          </Text>
          <TouchableOpacity
            style={styles.emptyButton}
            onPress={() => setShowModal(true)}>
            <Text style={styles.emptyButtonText}>Create Folder</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={folders}
          numColumns={2}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PortraitFolderCard
              title={item.name}
              itemCount={itemCounts[item.id] ?? 0}
              previewSource={item.cover_image_url}
              tileWidth={tileWidth}
              onPress={() =>
                router.push({
                  pathname: '/folder/[id]',
                  params: { id: item.id, name: item.name },
                })
              }
            />
          )}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
        />
      )}

      <CreateFolderModal
        visible={showModal}
        userId={userId}
        onClose={() => setShowModal(false)}
        onCreated={() => {
          setShowModal(false);
          refresh();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PORTRAIT_SCREEN_BG,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 18,
    backgroundColor: PORTRAIT_SCREEN_BG,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: PORTRAIT_TEXT_PRIMARY,
  },
  newButton: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: '#0a7ea4',
    borderRadius: 20,
  },
  newButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: PORTRAIT_TEXT_PRIMARY,
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: PORTRAIT_TEXT_MUTED,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  grid: {
    paddingHorizontal: OUTER_GUTTER,
    paddingTop: 16,
    paddingBottom: 104,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: ROW_GAP,
  },
});

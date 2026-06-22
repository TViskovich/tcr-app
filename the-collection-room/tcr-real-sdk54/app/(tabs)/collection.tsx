import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import { FolderCard } from '@/components/collection/folder-card';
import { useAuth } from '@/lib/auth';
import { useFolders } from '@/hooks/use-collection';

export default function CollectionScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? '';
  const { folders, loading, refresh } = useFolders(userId);
  const [showModal, setShowModal] = useState(false);
  const router = useRouter();

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
            <FolderCard
              folder={item}
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
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#11181C',
  },
  newButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0a7ea4',
    borderRadius: 8,
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
    color: '#11181C',
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: '#687076',
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
    padding: 10,
  },
  row: {
    justifyContent: 'flex-start',
  },
});

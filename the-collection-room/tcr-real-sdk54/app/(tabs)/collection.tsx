import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { CreateFolderModal } from '@/components/collection/create-folder-modal';
import { FolderCard } from '@/components/collection/folder-card';
import { useAuth } from '@/lib/auth';
import { useFolders } from '@/hooks/use-collection';

export default function CollectionScreen() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? '';
  const { folders, loading, refresh, itemCounts } = useFolders(userId);
  const [showModal, setShowModal] = useState(false);
  const router = useRouter();

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <CacheCaseLogo variant="icon" size={30} />
          <Text style={styles.headerTitle}>Collection</Text>
        </View>
        {folders.length > 0 && (
          <TouchableOpacity onPress={() => setShowModal(true)} style={styles.newButton}>
            <Text style={styles.newButtonText}>+ New Folder</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : folders.length === 0 ? (
        <View style={styles.collectionEmptyState}>
          <View style={styles.collectionEmptyContent}>
            <View style={styles.folderDisplay}>
              <View style={styles.folderShelf} pointerEvents="none" />

              <View style={[styles.folderShell, styles.folderBackLeft]}>
                <View style={styles.folderTabSmall} />
                <CacheCaseLogo variant="icon" size={34} />
              </View>

              <View style={[styles.folderShell, styles.folderBackRight]}>
                <View style={styles.folderTabSmall} />
                <CacheCaseLogo variant="icon" size={34} />
              </View>

              <View style={styles.cardStack} pointerEvents="none">
                <View style={[styles.cardSilhouette, styles.cardLeft, styles.cardSurfacePink]}>
                  <View style={styles.cardInnerFrame} />
                </View>

                <View style={[styles.cardSilhouette, styles.cardCenter, styles.cardSurfaceBlue]}>
                  <View style={styles.cardInnerFrame} />
                </View>

                <View style={[styles.cardSilhouette, styles.cardRight, styles.cardSurfaceLavender]}>
                  <View style={styles.cardInnerFrame} />
                </View>
              </View>

              <View style={[styles.folderShell, styles.folderFront]}>
                <View style={styles.folderTabLarge} />
                <CacheCaseLogo variant="icon" size={42} />
              </View>
            </View>

            <View style={styles.collectionEmptyCopy}>
              <Text style={styles.collectionEmptyTitle}>
                No folders yet
              </Text>

              <Text style={styles.collectionEmptyBody}>
                Create spaces for sets, players, teams, or anything you collect.
              </Text>

              <TouchableOpacity
                style={styles.collectionEmptyButton}
                onPress={() => setShowModal(true)}
                activeOpacity={0.82}>
                <Text style={styles.collectionEmptyButtonText}>
                  Create First Folder
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : (
        <FlatList
          data={folders}
          numColumns={2}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FolderCard
              folder={item}
              itemCount={itemCounts[item.id] ?? 0}
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
    paddingHorizontal: 20,
    paddingVertical: 18,
    backgroundColor: '#fff',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#11181C',
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
  collectionEmptyState: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  collectionEmptyContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -18 }],
  },
  collectionEmptyCopy: {
    alignItems: 'center',
    marginTop: 22,
    paddingHorizontal: 32,
  },
  collectionEmptyTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: '#11181C',
    textAlign: 'center',
  },
  collectionEmptyBody: {
    marginTop: 10,
    maxWidth: 330,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: '#687076',
    textAlign: 'center',
  },
  collectionEmptyButton: {
    marginTop: 24,
    width: 286,
    height: 54,
    paddingHorizontal: 24,
    borderRadius: 27,
    backgroundColor: '#0A8BAD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collectionEmptyButtonText: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  folderDisplay: {
    width: 340,
    height: 230,
    alignItems: 'center',
    justifyContent: 'flex-end',
    position: 'relative',
  },
  folderShelf: {
    position: 'absolute',
    bottom: 0,
    width: 300,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#E4E9F0',
    borderWidth: 1.25,
    borderColor: 'rgba(126, 145, 168, 0.58)',
    shadowColor: '#66788F',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 4,
    zIndex: 5,
  },
  folderShell: {
    position: 'absolute',
    backgroundColor: '#F1F4F8',
    borderWidth: 1.5,
    borderColor: 'rgba(137, 155, 178, 0.72)',
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    shadowColor: '#7E8FA6',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 3,
  },
  folderFront: {
    width: 220,
    height: 142,
    bottom: 18,
    zIndex: 3,
    shadowColor: '#6F8098',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 6,
  },
  folderBackLeft: {
    width: 172,
    height: 116,
    left: 12,
    bottom: 24,
    opacity: 0.88,
    zIndex: 1,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  folderBackRight: {
    width: 172,
    height: 116,
    right: 12,
    bottom: 24,
    opacity: 0.88,
    zIndex: 1,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  cardStack: {
    position: 'absolute',
    width: 170,
    height: 120,
    bottom: 110,
    alignItems: 'center',
    justifyContent: 'flex-end',
    zIndex: 2,
  },
  cardSilhouette: {
    position: 'absolute',
    width: 68,
    height: 96,
    borderRadius: 8,
    borderWidth: 1.25,
    borderColor: 'rgba(145, 165, 192, 0.58)',
    backgroundColor: 'rgba(222, 231, 244, 0.82)',
    padding: 5,
  },
  cardInnerFrame: {
    flex: 1,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.78)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  cardLeft: {
    left: 14,
    bottom: 0,
    transform: [{ rotate: '-7deg' }],
    opacity: 0.68,
  },
  cardCenter: {
    bottom: 10,
    zIndex: 2,
    opacity: 0.84,
  },
  cardRight: {
    right: 14,
    bottom: 1,
    transform: [{ rotate: '7deg' }],
    opacity: 0.72,
  },
  cardSurfacePink: {
    backgroundColor: 'rgba(242, 224, 238, 0.88)',
    borderColor: 'rgba(201, 159, 194, 0.52)',
  },
  cardSurfaceBlue: {
    backgroundColor: 'rgba(222, 233, 247, 0.94)',
    borderColor: 'rgba(145, 174, 210, 0.62)',
  },
  cardSurfaceLavender: {
    backgroundColor: 'rgba(230, 225, 245, 0.90)',
    borderColor: 'rgba(174, 154, 209, 0.54)',
  },
  folderTabLarge: {
    position: 'absolute',
    top: -18,
    left: 18,
    width: 82,
    height: 18,
    backgroundColor: '#F1F4F8',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderColor: 'rgba(137, 155, 178, 0.72)',
  },
  folderTabSmall: {
    position: 'absolute',
    top: -14,
    left: 14,
    width: 64,
    height: 14,
    backgroundColor: '#F1F4F8',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1.25,
    borderBottomWidth: 0,
    borderColor: 'rgba(137, 155, 178, 0.62)',
  },
  grid: {
    padding: 10,
    paddingTop: 14,
    paddingBottom: 104,
  },
  row: {
    justifyContent: 'flex-start',
  },
});

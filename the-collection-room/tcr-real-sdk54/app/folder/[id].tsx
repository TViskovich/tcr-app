import { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { ItemCard } from '@/components/collection/item-card';
import { useItems } from '@/hooks/use-collection';

export default function FolderDetailScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const { items, loading, refresh } = useItems(id);
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: name ?? 'Folder',
          headerRight: () => (
            <TouchableOpacity
              onPress={() =>
                router.push({
                  pathname: '/item/new',
                  params: { folderId: id, folderName: name },
                })
              }
              style={styles.headerButton}>
              <Text style={styles.headerButtonText}>+ Add Item</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🃏</Text>
          <Text style={styles.emptyTitle}>No items yet</Text>
          <Text style={styles.emptyBody}>
            Tap "+ Add Item" to add your first card to this folder.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          numColumns={2}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ItemCard
              item={item}
              onPress={() =>
                router.push({
                  pathname: '/item/[id]',
                  params: { id: item.id },
                })
              }
            />
          )}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: {
    paddingHorizontal: 4,
  },
  headerButtonText: {
    color: '#0a7ea4',
    fontSize: 15,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#f8f9fa',
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
  },
  grid: {
    padding: 10,
    backgroundColor: '#f8f9fa',
  },
  row: {
    justifyContent: 'flex-start',
  },
});

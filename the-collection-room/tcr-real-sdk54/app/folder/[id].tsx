import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ItemCard } from '@/components/collection/item-card';
import { useItems } from '@/hooks/use-collection';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Folder } from '@/types';

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export default function FolderDetailScreen() {
  const { id, name: paramName } = useLocalSearchParams<{ id: string; name?: string }>();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();

  const [folder, setFolder] = useState<Folder | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);

  // Edit folder modal state
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  const [editSaving, setEditSaving] = useState(false);

  const { items, loading: itemsLoading, refresh: refreshItems } = useItems(id);

  const isOwner = !!currentUserId && folder?.user_id === currentUserId;
  const isPrivate = folder !== null && !folder.is_public && !isOwner;

  useEffect(() => {
    async function load() {
      setFolderLoading(true);
      const { data } = await supabase
        .from('folders')
        .select('*')
        .eq('id', id)
        .single();

      if (data) {
        setFolder(data as Folder);
        if (data.user_id !== currentUserId) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, display_name, avatar_url')
            .eq('id', data.user_id)
            .single();
          if (profile) setOwnerProfile(profile as OwnerProfile);
        }
      }
      setFolderLoading(false);
    }
    load();
  }, [id, currentUserId]);

  useFocusEffect(useCallback(() => { refreshItems(); }, [refreshItems]));

  function openEditFolder() {
    if (!folder) return;
    setEditName(folder.name);
    setEditIsPublic(folder.is_public);
    setEditVisible(true);
  }

  async function saveEditFolder() {
    if (!folder || !editName.trim()) return;
    setEditSaving(true);
    const { data, error } = await supabase
      .from('folders')
      .update({ name: editName.trim(), is_public: editIsPublic })
      .eq('id', folder.id)
      .select()
      .single();
    if (!error && data) setFolder(data as Folder);
    setEditSaving(false);
    setEditVisible(false);
  }

  async function handleShare() {
    if (!folder) return;
    const handle = isOwner
      ? (session?.user?.email?.split('@')[0] ?? 'me')
      : (ownerProfile?.username ?? 'user');
    try {
      await Share.share({
        title: folder.name,
        message: `Check out "${folder.name}" by @${handle} on The Collection Room\nthecollectionroom://folder/${id}`,
      });
    } catch {
      // user dismissed share sheet — no-op
    }
  }

  const folderTitle = folder?.name ?? paramName ?? 'Collection';

  // ── Loading ──────────────────────────────────────────────────
  if (folderLoading) {
    return (
      <>
        <Stack.Screen options={{ title: paramName ?? 'Collection' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </>
    );
  }

  if (!folder) {
    return (
      <>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Collection not found.</Text>
        </View>
      </>
    );
  }

  // ── Private wall ─────────────────────────────────────────────
  if (isPrivate) {
    return (
      <>
        <Stack.Screen options={{ title: folderTitle }} />
        <View style={styles.center}>
          <Text style={styles.privateIcon}>🔒</Text>
          <Text style={styles.privateTitle}>This collection is private</Text>
          <Text style={styles.privateBody}>Only the owner can view this collection.</Text>
        </View>
      </>
    );
  }

  // ── List header (shared between owner and non-owner) ─────────
  function ListHeader() {
    return (
      <View>
        {/* Cover image banner */}
        {folder!.cover_image_url ? (
          <Image
            source={{ uri: folder!.cover_image_url }}
            style={styles.coverBanner}
            contentFit="cover"
          />
        ) : null}

        {/* Folder title + count + privacy badge */}
        <View style={styles.folderMeta}>
          <View style={styles.folderMetaLeft}>
            <Text style={styles.folderName}>{folder!.name}</Text>
            <Text style={styles.itemCount}>
              {itemsLoading ? '—' : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}
            </Text>
          </View>
          {isOwner && (
            <View style={[styles.badge, folder!.is_public ? styles.badgePublic : styles.badgePrivate]}>
              <Text style={styles.badgeText}>{folder!.is_public ? 'Public' : 'Private'}</Text>
            </View>
          )}
        </View>

        {/* Owner row — non-owner only */}
        {!isOwner && ownerProfile && (
          <TouchableOpacity
            style={styles.ownerCard}
            onPress={() =>
              router.push({ pathname: '/user/[username]', params: { username: ownerProfile!.username } })
            }
            activeOpacity={0.7}>
            <View style={styles.ownerAvatar}>
              {ownerProfile.avatar_url ? (
                <Image
                  source={{ uri: ownerProfile.avatar_url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, styles.ownerAvatarPlaceholder]}>
                  <Text style={styles.ownerAvatarInitial}>
                    {(ownerProfile.display_name || ownerProfile.username).charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.ownerInfo}>
              <Text style={styles.ownerName}>{ownerProfile.display_name || ownerProfile.username}</Text>
              <Text style={styles.ownerUsername}>@{ownerProfile.username}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}

        {/* Action buttons row */}
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
            <Text style={styles.actionBtnText}>Share</Text>
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity style={styles.actionBtn} onPress={openEditFolder}>
              <Text style={styles.actionBtnText}>Edit Folder</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.gridDivider} />
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────
  return (
    <>
      <Stack.Screen
        options={{
          title: folderTitle,
          headerRight: isOwner
            ? () => (
                <TouchableOpacity
                  style={styles.headerButton}
                  onPress={() =>
                    router.push({ pathname: '/item/new', params: { folderId: id, folderName: folder!.name } })
                  }>
                  <Text style={styles.headerButtonText}>+ Add Item</Text>
                </TouchableOpacity>
              )
            : undefined,
        }}
      />

      {itemsLoading && items.length === 0 ? (
        // Show header while items load so the page doesn't feel blank
        <>
          <ListHeader />
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#0a7ea4" />
          </View>
        </>
      ) : (
        <FlatList
          data={items}
          numColumns={2}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ListHeader />}
          renderItem={({ item }) => (
            <ItemCard
              item={item}
              onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyContent}>
              <Text style={styles.emptyIcon}>🃏</Text>
              <Text style={styles.emptyTitle}>No items yet</Text>
              {isOwner && (
                <Text style={styles.emptyBody}>Tap "+ Add Item" to add your first card.</Text>
              )}
            </View>
          }
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.columnWrapper}
        />
      )}

      {/* Edit Folder modal — owner only */}
      <Modal
        visible={editVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditVisible(false)}>
        <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
          {/* Modal header */}
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setEditVisible(false)} hitSlop={8}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Edit Folder</Text>
            <TouchableOpacity onPress={saveEditFolder} disabled={editSaving || !editName.trim()} hitSlop={8}>
              {editSaving
                ? <ActivityIndicator size="small" color="#0a7ea4" />
                : <Text style={[styles.modalSave, !editName.trim() && styles.modalSaveDisabled]}>Save</Text>
              }
            </TouchableOpacity>
          </View>

          <View style={styles.modalBody}>
            {/* Name field */}
            <Text style={styles.modalLabel}>Folder Name</Text>
            <TextInput
              style={styles.modalInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Folder name"
              placeholderTextColor="#999"
              autoFocus
              maxLength={80}
            />

            {/* Public toggle */}
            <View style={styles.modalToggleRow}>
              <View style={styles.modalToggleLabel}>
                <Text style={styles.modalLabel}>Public Collection</Text>
                <Text style={styles.modalHint}>
                  {editIsPublic
                    ? 'Anyone can discover and view this collection.'
                    : 'Only you can see this collection.'}
                </Text>
              </View>
              <Switch
                value={editIsPublic}
                onValueChange={setEditIsPublic}
                trackColor={{ true: '#0a7ea4' }}
              />
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#f8f9fa',
  },
  errorText: {
    fontSize: 16,
    color: '#687076',
  },
  // Private wall
  privateIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  privateTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#11181C',
    marginBottom: 8,
  },
  privateBody: {
    fontSize: 14,
    color: '#687076',
    textAlign: 'center',
  },
  // Header button (+ Add Item)
  headerButton: {
    paddingHorizontal: 4,
  },
  headerButtonText: {
    color: '#0a7ea4',
    fontSize: 15,
    fontWeight: '600',
  },
  // Cover banner
  coverBanner: {
    width: '100%',
    height: 160,
    backgroundColor: '#e9ecef',
  },
  // Folder meta row
  folderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  folderMetaLeft: {
    flex: 1,
    gap: 2,
  },
  folderName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#11181C',
  },
  itemCount: {
    fontSize: 13,
    color: '#687076',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 12,
  },
  badgePublic: {
    backgroundColor: '#E8F5E9',
  },
  badgePrivate: {
    backgroundColor: '#FFF3E0',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#687076',
  },
  // Owner card
  ownerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e0e0e0',
    gap: 12,
  },
  ownerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#E3F2FD',
    flexShrink: 0,
  },
  ownerAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerAvatarInitial: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1565C0',
  },
  ownerInfo: {
    flex: 1,
    gap: 2,
  },
  ownerName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#11181C',
  },
  ownerUsername: {
    fontSize: 12,
    color: '#687076',
  },
  chevron: {
    fontSize: 22,
    color: '#ccc',
    flexShrink: 0,
  },
  // Action buttons
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  actionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d0d0d0',
    backgroundColor: '#fff',
  },
  actionBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
  gridDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e0e0e0',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 2,
  },
  // Grid
  grid: {
    paddingBottom: 24,
    backgroundColor: '#f8f9fa',
  },
  columnWrapper: {
    paddingHorizontal: 4,
  },
  // Empty states
  emptyContent: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#11181C',
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 14,
    color: '#687076',
    textAlign: 'center',
  },
  // Edit folder modal
  modal: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#11181C',
  },
  modalCancel: {
    fontSize: 16,
    color: '#687076',
  },
  modalSave: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  modalSaveDisabled: {
    color: '#ccc',
  },
  modalBody: {
    padding: 16,
    gap: 20,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#687076',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  modalInput: {
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#11181C',
  },
  modalToggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  modalToggleLabel: {
    flex: 1,
  },
  modalHint: {
    fontSize: 13,
    color: '#687076',
    lineHeight: 18,
    marginTop: 4,
  },
});

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  G,
  Rect,
  Line,
  Ellipse,
} from 'react-native-svg';

import { CacheCaseLogo } from '@/components/brand/cachecase-logo';
import { FOLDER_COLOR_KEYS, type FolderColorKey } from '@/components/collection/folder-card';
import { FolderColorPicker } from '@/components/collection/folder-color-picker';
import { ItemCard } from '@/components/collection/item-card';
import { BookmarkButton } from '@/components/ui/bookmark-button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useItems } from '@/hooks/use-collection';
import { useSavedFolder } from '@/hooks/use-saved';
import { useAuth } from '@/lib/auth';
import { uploadFolderCover } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Folder } from '@/types';

type OwnerProfile = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// The colorful CacheCase logo overlaid on the front card, matching the
// Collection tab's empty-state front folder. Sized/centered against the
// front card's SVG bounds (x112 y50 w116 h178, so its true center is
// (170, 139)) — rendered as a real RN component layered on top of the Svg
// rather than drawn inside it, since react-native-svg's canvas can't host
// arbitrary RN components.
const FRONT_CARD_LOGO_SIZE = 44;
const FRONT_CARD_LOGO_WIDTH = FRONT_CARD_LOGO_SIZE * (454 / 359);
const FRONT_CARD_LOGO_CENTER_X = 170;
const FRONT_CARD_LOGO_CENTER_Y = 140;

// Folder empty-state illustration — three collectible-card silhouettes, the
// CacheCase logo on the front card, and a silver shelf, built from
// react-native-svg (no PNG asset) plus one real logo overlay. Same light/
// premium visual language as the Collection tab's empty state: white/silver
// surfaces, pale pink/blue-ish/lavender accents, restrained iridescent edge
// highlights. No gold, no dark background, no particles. Layer order
// matters: ground shadow, rear-left card, rear-right card, front-center
// card, logo, shelf, then a handful of restrained iridescent highlights.
function EmptyCardDisplayArtwork() {
  return (
    <View style={styles.emptyCardArtwork}>
      <Svg width={340} height={270} viewBox="0 0 340 270">
        <Defs>
          <LinearGradient id="frontCardFill" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" />
            <Stop offset="0.4" stopColor="#F6F8FC" />
            <Stop offset="0.75" stopColor="#E8EDF5" />
            <Stop offset="1" stopColor="#FCFDFE" />
          </LinearGradient>
          <LinearGradient id="rearPinkFill" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#FBF1F7" />
            <Stop offset="1" stopColor="#EDD9E8" />
          </LinearGradient>
          <LinearGradient id="rearLavenderFill" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#F4F1FB" />
            <Stop offset="1" stopColor="#E0D8F1" />
          </LinearGradient>
          <LinearGradient id="shelfFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#F7F9FC" />
            <Stop offset="0.55" stopColor="#E7ECF2" />
            <Stop offset="1" stopColor="#D7DEE8" />
          </LinearGradient>
          <LinearGradient id="folderCardIridescent" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#75D7EE" stopOpacity="0.5" />
            <Stop offset="0.5" stopColor="#C8B5F4" stopOpacity="0.42" />
            <Stop offset="1" stopColor="#F0AFCB" stopOpacity="0.48" />
          </LinearGradient>
          <RadialGradient id="frontCardSheen" cx="0.26" cy="0.16" r="0.55">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.6" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* 1. Ground shadow */}
        <Ellipse cx="170" cy="244" rx="118" ry="9" fill="rgba(87,103,126,0.09)" />

        {/* 2. Rear-left card — pale pink-silver, no artwork/text */}
        <G transform="rotate(-8 109 155)">
          <Rect x={55} y={78} width={108} height={154} rx={14} fill="url(#rearPinkFill)" stroke="rgba(196,150,186,0.5)" strokeWidth={1.2} />
          <Rect x={64} y={87} width={90} height={136} rx={9} fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth={1} />
          <Rect x={64} y={87} width={90} height={20} rx={9} fill="rgba(255,255,255,0.3)" />
        </G>

        {/* 3. Rear-right card — pale lavender-silver, no artwork/text */}
        <G transform="rotate(8 231 155)">
          <Rect x={177} y={78} width={108} height={154} rx={14} fill="url(#rearLavenderFill)" stroke="rgba(174,154,209,0.5)" strokeWidth={1.2} />
          <Rect x={186} y={87} width={90} height={136} rx={9} fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth={1} />
          <Rect x={186} y={87} width={90} height={20} rx={9} fill="rgba(255,255,255,0.3)" />
        </G>

        {/* 4. Front-center card — dominant, metallic white-silver */}
        <Rect x={112} y={50} width={116} height={178} rx={16} fill="url(#frontCardFill)" stroke="rgba(118,140,170,0.65)" strokeWidth={1.4} />
        <Rect x={112} y={50} width={116} height={178} rx={16} fill="url(#frontCardSheen)" />
        <Rect x={121} y={59} width={98} height={160} rx={10} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1} />

        {/* 5. Metallic shelf */}
        <Rect x={42} y={225} width={256} height={15} rx={7.5} fill="url(#shelfFill)" stroke="rgba(120,140,165,0.5)" strokeWidth={1.1} />
        <Line x1={48} y1={227.5} x2={292} y2={227.5} stroke="rgba(255,255,255,0.7)" strokeWidth={1} />
        <Line x1={48} y1={229.5} x2={292} y2={229.5} stroke="url(#folderCardIridescent)" strokeWidth={1} strokeOpacity={0.55} />

        {/* 6. Restrained iridescent highlights — a few short strokes, not an
            outline around every edge. */}
        <Line x1={112} y1={70} x2={112} y2={160} stroke="#75D7EE" strokeOpacity={0.42} strokeWidth={1.2} />
        <Line x1={210} y1={52} x2={226} y2={52} stroke="#F0AFCB" strokeOpacity={0.4} strokeWidth={1.2} />
        <Line x1={226} y1={52} x2={226} y2={68} stroke="#F0AFCB" strokeOpacity={0.4} strokeWidth={1.2} />
        <Line x1={281} y1={100} x2={281} y2={180} stroke="#C8B5F4" strokeOpacity={0.38} strokeWidth={1.2} />
      </Svg>

      {/* 7. CacheCase logo, layered on top of the SVG, centered on the front card */}
      <View
        style={[
          styles.emptyCardLogo,
          {
            top: FRONT_CARD_LOGO_CENTER_Y - FRONT_CARD_LOGO_SIZE / 2,
            left: FRONT_CARD_LOGO_CENTER_X - FRONT_CARD_LOGO_WIDTH / 2,
          },
        ]}
        pointerEvents="none">
        <CacheCaseLogo variant="icon" size={FRONT_CARD_LOGO_SIZE} />
      </View>
    </View>
  );
}

export default function FolderDetailScreen() {
  const { id, name: paramName } = useLocalSearchParams<{ id: string; name?: string }>();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const router = useRouter();

  const [folder, setFolder] = useState<Folder | null>(null);
  const [ownerProfile, setOwnerProfile] = useState<OwnerProfile | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);

  // Edit modal state
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  const [editCoverSource, setEditCoverSource] = useState<string>('upload');
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const [editColor, setEditColor] = useState<FolderColorKey>(FOLDER_COLOR_KEYS[0]);
  const [newCoverUri, setNewCoverUri] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { items, loading: itemsLoading, refresh: refreshItems } = useItems(id);
  const { isSaved, saving: savingBookmark, toggle: toggleSave } = useSavedFolder(id, currentUserId);

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
    setEditCoverSource(folder.cover_source ?? 'upload');
    setEditCoverUrl(folder.cover_image_url);
    // Same name-hash fallback folder-card.tsx's leatherTone() uses, so the
    // picker opens pre-selected on whatever color the card is actually
    // showing right now, even if this folder predates the color column.
    setEditColor(
      (folder.color as FolderColorKey) && FOLDER_COLOR_KEYS.includes(folder.color as FolderColorKey)
        ? (folder.color as FolderColorKey)
        : FOLDER_COLOR_KEYS[folder.name.charCodeAt(0) % FOLDER_COLOR_KEYS.length],
    );
    setNewCoverUri(null);
    setEditVisible(true);
  }

  async function launchCoverCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access in settings.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [3, 2],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) setNewCoverUri(result.assets[0].uri);
  }

  async function launchCoverLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow photo library access in settings.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [3, 2],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) setNewCoverUri(result.assets[0].uri);
  }

  function pickCover() {
    Alert.alert('Cover Photo', undefined, [
      { text: 'Take Photo', onPress: launchCoverCamera },
      { text: 'Choose from Library', onPress: launchCoverLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function removeCover() {
    setNewCoverUri(null);
    setEditCoverUrl(null);
  }

  async function saveEditFolder() {
    if (!folder || !editName.trim()) return;
    setEditSaving(true);
    try {
      // Only modify cover_image_url when in upload mode; first_card leaves it untouched.
      let coverUrl = folder.cover_image_url;
      if (editCoverSource === 'upload') {
        coverUrl = newCoverUri && currentUserId
          ? await uploadFolderCover(newCoverUri, currentUserId)
          : editCoverUrl;
      }
      const { data, error } = await supabase
        .from('folders')
        .update({
          name: editName.trim(),
          is_public: editIsPublic,
          cover_image_url: coverUrl,
          cover_source: editCoverSource,
          color: editColor,
        })
        .eq('id', folder.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      if (data) setFolder(data as Folder);
      setEditVisible(false);
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setEditSaving(false);
    }
  }

  function confirmDeleteFolder() {
    if (!folder) return;
    Alert.alert(
      'Delete Folder',
      `Delete "${folder.name}"? This will permanently remove the folder and everything inside it. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: deleteFolder },
      ],
    );
  }

  async function deleteFolder() {
    if (!folder) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('folders').delete().eq('id', folder.id);
      if (error) throw new Error(error.message);
      setEditVisible(false);
      router.back();
    } catch (e) {
      Alert.alert('Delete failed', e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setDeleting(false);
    }
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
  const coverPreviewUri = newCoverUri ?? editCoverUrl;
  const hasCover = !!coverPreviewUri;

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

  // ── Banner URL resolution ─────────────────────────────────────
  // items is ordered newest-first (DESC); first element is the latest card.
  const bannerUrl = folder.cover_source === 'first_card'
    ? (items[0]?.image_url ?? null)
    : folder.cover_image_url;

  // ── List header (shared between owner and non-owner) ─────────
  function ListHeader() {
    return (
      <View>
        {/* Cover image banner */}
        {bannerUrl ? (
          <Image
            source={{ uri: bannerUrl }}
            style={styles.coverBanner}
            contentFit="cover"
            contentPosition="top"
            transition={200}
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
              router.push({ pathname: '/user/[username]', params: { username: ownerProfile?.username ?? '' } })
            }
            activeOpacity={0.7}>
            <View style={styles.ownerAvatar}>
              {ownerProfile.avatar_url ? (
                <Image
                  source={{ uri: ownerProfile.avatar_url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={200}
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

  const showBookmarkHeader = !isOwner && folder !== null && folder.is_public && !!currentUserId;

  // ── Main render ───────────────────────────────────────────────
  return (
    <>
      <Stack.Screen
        options={showBookmarkHeader ? {
          header: () => (
            <ScreenHeader
              title={folderTitle}
              onBack={() => router.back()}
              rightContent={<BookmarkButton isSaved={isSaved} onPress={toggleSave} disabled={savingBookmark} />}
            />
          ),
        } : {
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
            <View style={styles.folderEmptyState}>
              <EmptyCardDisplayArtwork />

              <Text style={styles.folderEmptyTitle}>
                No items yet
              </Text>

              {isOwner && (
                <>
                  <Text style={styles.folderEmptyBody}>
                    Add the first card to your {folder!.name} collection.
                  </Text>

                  <TouchableOpacity
                    style={styles.folderEmptyButton}
                    onPress={() =>
                      router.push({ pathname: '/item/new', params: { folderId: id, folderName: folder!.name } })
                    }
                    activeOpacity={0.82}>
                    <Text style={styles.folderEmptyButtonText}>
                      Add First Card
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          }
          style={styles.flatList}
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
            {/* Cover source toggle */}
            <View>
              <Text style={styles.modalLabel}>Cover</Text>
              <View style={styles.coverSourceRow}>
                {(['upload', 'first_card'] as const).map(src => (
                  <TouchableOpacity
                    key={src}
                    style={[styles.coverSourceBtn, editCoverSource === src && styles.coverSourceBtnActive]}
                    onPress={() => setEditCoverSource(src)}>
                    <Text style={[styles.coverSourceText, editCoverSource === src && styles.coverSourceTextActive]}>
                      {src === 'upload' ? 'Uploaded Image' : 'Latest Card'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Upload controls — only when upload mode */}
            {editCoverSource === 'upload' && (
              <View style={styles.coverSection}>
                {hasCover && (
                  <Image
                    source={{ uri: coverPreviewUri! }}
                    style={styles.coverPreview}
                    contentFit="cover"
                    transition={200}
                  />
                )}
                <View style={styles.coverActions}>
                  <TouchableOpacity style={styles.coverBtn} onPress={pickCover}>
                    <Text style={styles.coverBtnText}>
                      {hasCover ? 'Change Cover' : 'Add Cover'}
                    </Text>
                  </TouchableOpacity>
                  {hasCover && (
                    <TouchableOpacity style={styles.coverBtn} onPress={removeCover}>
                      <Text style={[styles.coverBtnText, styles.coverBtnDestructive]}>Remove Cover</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {/* First card hint */}
            {editCoverSource === 'first_card' && (
              <Text style={styles.modalHint}>
                The latest card added to this folder will be used as the cover. If the folder is empty, the letter initial is shown instead.
              </Text>
            )}

            {/* Folder name */}
            <View>
              <Text style={styles.modalLabel}>Folder Name</Text>
              <TextInput
                style={styles.modalInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Folder name"
                placeholderTextColor="#999"
                autoFocus={!hasCover}
                maxLength={80}
              />
            </View>

            {/* Binder color */}
            <View>
              <Text style={styles.modalLabel}>Binder Color</Text>
              <FolderColorPicker value={editColor} onChange={setEditColor} />
            </View>

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

            {/* Delete folder — destructive, kept separate at the bottom */}
            <View style={styles.modalDangerZone}>
              <TouchableOpacity
                style={styles.modalDeleteButton}
                onPress={confirmDeleteFolder}
                disabled={deleting}>
                {deleting
                  ? <ActivityIndicator size="small" color="#e53935" />
                  : <Text style={styles.modalDeleteButtonText}>Delete Folder</Text>
                }
              </TouchableOpacity>
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
  flatList: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  // Grid
  grid: {
    padding: 10,
    paddingTop: 10,
    paddingBottom: 24,
  },
  columnWrapper: {
    justifyContent: 'flex-start',
  },
  // Empty states
  emptyContent: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 32,
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
  // Folder empty-state artwork (react-native-svg) — see EmptyCardDisplayArtwork
  folderEmptyState: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 34,
    paddingHorizontal: 24,
  },
  emptyCardArtwork: {
    width: 340,
    height: 270,
    alignSelf: 'center',
  },
  emptyCardLogo: {
    position: 'absolute',
  },
  folderEmptyTitle: {
    marginTop: 20,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: '#11181C',
    textAlign: 'center',
  },
  folderEmptyBody: {
    marginTop: 10,
    maxWidth: 330,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: '#687076',
    textAlign: 'center',
  },
  folderEmptyButton: {
    marginTop: 24,
    width: 250,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#0A8BAD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderEmptyButtonText: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '700',
    color: '#FFFFFF',
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
  // Cover source toggle (inside modal)
  coverSourceRow: {
    flexDirection: 'row',
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 3,
  },
  coverSourceBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  coverSourceBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  coverSourceText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#687076',
  },
  coverSourceTextActive: {
    fontSize: 13,
    fontWeight: '600',
    color: '#11181C',
  },
  // Cover photo section (inside modal)
  coverSection: {
    gap: 10,
  },
  coverPreview: {
    width: '100%',
    aspectRatio: 3 / 2,
    borderRadius: 10,
    backgroundColor: '#e9ecef',
  },
  coverActions: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  coverBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d0d0d0',
    backgroundColor: '#fff',
  },
  coverBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#11181C',
  },
  coverBtnDestructive: {
    color: '#e53935',
  },
  // Delete folder (bottom of edit modal)
  modalDangerZone: {
    paddingTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  modalDeleteButton: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e53935',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDeleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e53935',
  },
});

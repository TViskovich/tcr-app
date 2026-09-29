import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useProfile } from '@/hooks/use-profile';
import { useSignedFolderCovers } from '@/hooks/use-signed-folder-covers';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useAuth } from '@/lib/auth';
import { createFolderSharePost, fetchShareableFolderItems, type FolderShareItem } from '@/lib/folder-share-post';
import { DETAIL_IMAGE_TIER } from '@/lib/image-tiers';
import { attachPrimaryImageIds } from '@/lib/item-images';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { supabase } from '@/lib/supabase';
import { TAB_BAR_HEIGHT } from '@/lib/tab-visibility-context';

const MAX_CHARS = 280;

type OwnedFolder = {
  id: string;
  name: string;
  is_public: boolean;
  parent_folder_id: string | null;
  cover_source: string;
  cover_item_id: string | null;
};

// What the post will use as its cover (mirrors create-snapshot-post):
// 'upload' = the folder's uploaded cover; 'item' = a specific item's primary
// photo (picked cover item, or — for the automatic cover — the newest eligible
// item); 'none' = no cover, the collage is shown.
type CoverPlan = { kind: 'upload' } | { kind: 'item'; imageId: string } | { kind: 'none' };

// Create menu -> Share Folder. Step 1: pick one of your own folders (only
// effectively-public ones can be posted to the feed — the create_folder_share_post
// RPC re-checks this server-side). Step 2: optional caption plus a preview
// that is the real feed PostCard, then Post publishes a 'folder_share' post
// (snapshot of the folder name/count and its first items in order — see
// lib/folder-share-post.ts). Not external sharing: nothing here opens the
// native share sheet.
export default function ShareFolderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { profile: currentProfile } = useProfile(currentUserId);
  useScrollResponsiveNavbar({ enabled: false });

  const [folders, setFolders] = useState<OwnedFolder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [foldersError, setFoldersError] = useState(false);
  const [selected, setSelected] = useState<OwnedFolder | null>(null);
  const [preview, setPreview] = useState<{ items: FolderShareItem[]; total: number } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  // null = still resolving.
  const [coverPlan, setCoverPlan] = useState<CoverPlan | null>(null);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  const [createdAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    supabase
      .from('folders')
      .select('id, name, is_public, parent_folder_id, cover_source, cover_item_id')
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[share-folder] folders query failed:', error.message);
          setFoldersError(true);
        } else {
          setFolders((data ?? []) as OwnedFolder[]);
        }
        setLoadingFolders(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUserId]);

  // Effectively public = the folder and every ancestor is public (all of a
  // user's ancestors are their own folders, so the owned list has them).
  function isEffectivelyPublic(folder: OwnedFolder): boolean {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const seen = new Set<string>();
    let current: OwnedFolder | undefined = folder;
    while (current) {
      if (!current.is_public || seen.has(current.id)) return false;
      seen.add(current.id);
      if (!current.parent_folder_id) return true;
      current = byId.get(current.parent_folder_id);
    }
    return false;
  }

  async function resolveCoverPlan(folder: OwnedFolder): Promise<CoverPlan> {
    if (folder.cover_source === 'upload') return { kind: 'upload' };
    // Eligible = public, active, has a primary photo (what the server allows).
    let query = supabase
      .from('collection_items')
      .select('id')
      .eq('folder_id', folder.id)
      .eq('collection_status', 'active')
      .eq('is_public', true);
    if (folder.cover_source === 'item') {
      if (!folder.cover_item_id) return { kind: 'none' };
      query = query.eq('id', folder.cover_item_id);
    } else {
      query = query.order('created_at', { ascending: false });
    }
    const { data } = await query.limit(50);
    const withImages = await attachPrimaryImageIds((data ?? []) as { id: string }[]);
    const first = withImages.find((i) => !!i.primary_image_id);
    return first?.primary_image_id ? { kind: 'item', imageId: first.primary_image_id } : { kind: 'none' };
  }

  function selectFolder(folder: OwnedFolder) {
    setSelected(folder);
    setPreview(null);
    setPreviewError(false);
    setCoverPlan(null);
    resolveCoverPlan(folder).then(setCoverPlan);
    fetchShareableFolderItems(folder.id)
      .then(setPreview)
      .catch((e) => {
        console.error('[share-folder] preview items failed:', e);
        setPreviewError(true);
      });
  }

  function leaveScreen() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  const { urls: coverUrls } = useSignedFolderCovers(selected && coverPlan?.kind === 'upload' ? [selected.id] : []);
  const { urls: coverItemUrls } = useSignedItemImages(
    [coverPlan?.kind === 'item' ? coverPlan.imageId : null],
    DETAIL_IMAGE_TIER,
  );
  const liveCoverUri =
    selected && coverPlan
      ? coverPlan.kind === 'upload'
        ? (coverUrls.get(selected.id) ?? null)
        : coverPlan.kind === 'item'
          ? (coverItemUrls.get(coverPlan.imageId) ?? null)
          : null
      : null;
  const hasCover = coverPlan ? coverPlan.kind !== 'none' : null;
  // Wait for the cover (if there is one) so the preview never flashes the
  // collage before switching to the cover the post will actually show.
  const previewReady = !!preview && hasCover !== null && (!hasCover || !!liveCoverUri);

  const canPost = !!selected && !!preview && preview.total > 0 && !posting;

  async function handlePost() {
    if (!canPost || !selected) return;
    setPosting(true);
    const result = await createFolderSharePost(selected.id, caption.trim() || null);
    if (!result.ok) {
      console.error('[share-folder] post failed:', result.message);
      Alert.alert('Post failed', 'Could not share this folder. Please try again.');
      setPosting(false);
      return;
    }
    // Mark the own-profile cache stale — this post now shows on Profile's
    // Posts tab. See lib/own-profile-cache.ts's own invalidateOwnProfileCache
    // comment.
    if (currentUserId) invalidateOwnProfileCache(currentUserId);
    leaveScreen();
  }

  const previewPost: FeedPost | null =
    selected && preview && previewReady
      ? {
          id: 'preview',
          user_id: '',
          post_type: 'folder_share',
          image_url: null,
          content: null,
          caption: caption.trim() || null,
          created_at: createdAt,
          item_name: null,
          username: currentProfile?.username ?? '',
          display_name: currentProfile?.display_name || currentProfile?.username || null,
          avatar_url: currentProfile?.avatar_url ?? null,
          likeCount: 0,
          liked: false,
          commentCount: 0,
          isFollowing: false,
          grailCards: [],
          avgRating: null,
          ratingCount: 0,
          myRating: null,
          cardShareItems: [],
          images: [],
          folderShare: {
            folderId: selected.id,
            folderName: selected.name,
            itemCount: preview.total,
            items: preview.items,
            liveCoverUri: hasCover ? liveCoverUri : null,
          },
        }
      : null;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Share Folder',
          headerLeft: () => (
            <TouchableOpacity onPress={leaveScreen} hitSlop={8}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ),
          headerRight: () =>
            selected ? (
              <TouchableOpacity onPress={handlePost} disabled={!canPost} hitSlop={8}>
                {posting ? (
                  <ActivityIndicator size="small" color={PV2.link} />
                ) : (
                  <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>Post</Text>
                )}
              </TouchableOpacity>
            ) : null,
        }}
      />

      {!selected ? (
        loadingFolders ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={PV2.link} />
          </View>
        ) : foldersError ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn&apos;t load your folders</Text>
            <Text style={styles.emptyBody}>Something went wrong. Please try again.</Text>
          </View>
        ) : folders.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No folders yet</Text>
            <Text style={styles.emptyBody}>Create a folder in your collection to share it.</Text>
          </View>
        ) : (
          <FlatList
            style={styles.container}
            data={folders}
            keyExtractor={(f) => f.id}
            contentContainerStyle={{ padding: 16, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }}
            ListHeaderComponent={<Text style={styles.sectionLabel}>Choose a folder to share</Text>}
            ItemSeparatorComponent={() => <View style={styles.divider} />}
            renderItem={({ item }) => {
              const shareable = isEffectivelyPublic(item);
              return (
                <TouchableOpacity
                  style={[styles.row, !shareable && styles.rowDisabled]}
                  onPress={() => selectFolder(item)}
                  disabled={!shareable}
                  activeOpacity={0.7}>
                  <View style={styles.rowIcon}>
                    <IconSymbol name="folder.fill" size={18} color="#FFFFFF" />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {!shareable && <Text style={styles.rowSub}>Private — only public folders can be shared</Text>}
                  </View>
                  {shareable && <IconSymbol name="chevron.right" size={14} color="rgba(255,255,255,0.28)" />}
                </TouchableOpacity>
              );
            }}
          />
        )
      ) : (
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            contentContainerStyle={[styles.scroll, { paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
            <View style={styles.selectRow}>
              <Text style={styles.sectionLabel} numberOfLines={1}>
                {selected.name}
              </Text>
              <TouchableOpacity onPress={() => setSelected(null)} hitSlop={8} disabled={posting}>
                <Text style={styles.changeText}>Change</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Add a caption (optional)"
              placeholderTextColor={PV2.textTertiary}
              multiline
              value={caption}
              onChangeText={setCaption}
              maxLength={MAX_CHARS}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>
              {caption.length}/{MAX_CHARS}
            </Text>

            <Text style={styles.sectionLabel}>Preview</Text>
            {previewError ? (
              <Text style={styles.emptyBody}>Couldn&apos;t load this folder&apos;s items. Go back and try again.</Text>
            ) : !previewReady && !(preview && preview.total === 0) ? (
              <ActivityIndicator color={PV2.link} style={styles.previewSpinner} />
            ) : preview.total === 0 ? (
              <Text style={styles.emptyBody}>
                This folder has no public items with photos yet, so there is nothing to show in a post.
              </Text>
            ) : previewPost ? (
              <View style={styles.bleed} pointerEvents="none">
                <PostCard
                  post={previewPost}
                  currentUserId={undefined}
                  onUserPress={noop}
                  onPostPress={noop}
                  onCommentPress={noop}
                  onLike={noop}
                />
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </>
  );
}

function noop() {}

const styles = StyleSheet.create({
  headerCancel: { fontSize: 16, color: PV2.textSecondary },
  headerPost: { fontSize: 16, fontWeight: '600', color: PV2.link },
  headerPostDisabled: { color: PV2.textTertiary },
  container: { flex: 1, backgroundColor: PV2.bg },
  scroll: { padding: 16, gap: 12 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
    flexShrink: 1,
  },
  selectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  changeText: { fontSize: 14, fontWeight: '600', color: PV2.link },
  input: {
    fontSize: 16,
    color: PV2.textPrimary,
    minHeight: 80,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    padding: 12,
  },
  counter: { fontSize: 13, color: PV2.textTertiary, textAlign: 'right' },
  previewSpinner: { marginVertical: 24 },
  // The Feed card is full screen width; cancel this screen's 16px scroll
  // inset so the preview gets the same width as the published post.
  bleed: { marginHorizontal: -16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: PV2.textPrimary, marginBottom: 8, textAlign: 'center' },
  emptyBody: { fontSize: 15, color: PV2.textSecondary, textAlign: 'center', lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 14 },
  rowDisabled: { opacity: 0.5 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: PV2.textPrimary },
  rowSub: { fontSize: 12, color: PV2.textSecondary },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: PV2.dividerColor },
});

import { attachPrimaryImageIds } from '@/lib/item-images';
import { supabase } from '@/lib/supabase';

// "Share Folder" feed post (post_type 'folder_share') — see
// supabase/migrations/20260927120000_add_folder_share_posts.sql. Same durable
// snapshot model as Share Card: at posting time the create-snapshot-post Edge
// Function copies up to FOLDER_SHARE_MAX_ITEMS of the folder's items' photos
// into share-snapshots and records their title/subtitle, plus the folder's
// name and eligible-item count on the post. A published post therefore keeps
// looking the same after the folder or its items change.
export const FOLDER_SHARE_MAX_ITEMS = 4;

export type FolderShareItem = {
  id: string;
  title: string | null;
  subtitle: string | null;
  // Durable share-snapshots URL — set on every published post's items.
  imageUrl: string | null;
  // Live item photo id, used ONLY by the composer preview (before any
  // snapshot exists) — rendered through the normal signed-image path.
  primary_image_id: string | null;
};

export type FolderShareData = {
  folderId: string | null;
  folderName: string;
  // Number of ELIGIBLE (public, active, photographed) items in the folder
  // when it was shared — not the folder's total item count.
  itemCount: number;
  // Up to FOLDER_SHARE_MAX_ITEMS, in display order.
  items: FolderShareItem[];
  // The folder's explicit cover as snapshotted at posting time (a durable
  // share-snapshots URL), or null when it had none — the post then shows the
  // item collage. Rendered in full (never cropped).
  coverUrl?: string | null;
  // Composer preview only: the live signed cover URL before any snapshot exists.
  liveCoverUri?: string | null;
};

// Batch-fetches the snapshot rows for a set of folder_share posts. Throws on a
// query failure (same convention as fetchCardShareItems) so a failed lookup
// fails the feed load loudly instead of rendering empty collages.
export async function fetchFolderShareItems(
  postIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, FolderShareItem[]>> {
  const result = new Map<string, FolderShareItem[]>();
  if (postIds.length === 0) return result;

  const query = supabase
    .from('folder_share_items')
    .select('id, post_id, snapshot_image_url, snapshot_title, snapshot_subtitle, display_order')
    .in('post_id', postIds)
    .order('display_order', { ascending: true });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;

  for (const row of data ?? []) {
    const list = result.get(row.post_id as string) ?? [];
    list.push({
      id: row.id as string,
      title: (row.snapshot_title as string | null) ?? null,
      subtitle: (row.snapshot_subtitle as string | null) ?? null,
      imageUrl: (row.snapshot_image_url as string | null) ?? null,
      primary_image_id: null,
    });
    result.set(row.post_id as string, list);
  }
  return result;
}

// Live owner of each shared folder (folders.user_id), for repost attribution
// on folder_share posts — same live-join model as an 'item' post's source
// owner (see FeedPost.sourceOwner): a post whose author differs from the
// folder's owner is a repost of someone else's folder. Read through RLS, so a
// folder the viewer can no longer see (made private, or deleted —
// posts.folder_id goes NULL) simply has no entry and the post renders
// without the repost header. Best-effort: logs and returns what it has.
export async function fetchFolderOwnerIds(
  folderIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const ids = [...new Set(folderIds)];
  if (ids.length === 0) return result;
  const query = supabase.from('folders').select('id, user_id').in('id', ids);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) {
    console.error('[fetchFolderOwnerIds] folders query failed:', error.message, error);
    return result;
  }
  for (const row of data ?? []) result.set(row.id as string, row.user_id as string);
  return result;
}

// Picker/preview helper — a folder's shareable items, using the same
// eligibility the create_folder_share_post RPC enforces server-side (the RPC
// is the authority; this only mirrors it for UI).
export async function fetchShareableFolderItems(
  folderId: string,
): Promise<{ items: FolderShareItem[]; total: number }> {
  const { data, error } = await supabase
    .from('collection_items')
    .select('id, title')
    .eq('folder_id', folderId)
    .eq('collection_status', 'active')
    .eq('is_public', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  const withImages = await attachPrimaryImageIds((data ?? []) as { id: string; title: string | null }[]);
  const photographed = withImages.filter((i) => !!i.primary_image_id);
  return {
    total: photographed.length,
    items: photographed.slice(0, FOLDER_SHARE_MAX_ITEMS).map((i) => ({
      id: i.id,
      title: i.title,
      subtitle: null,
      imageUrl: null,
      primary_image_id: i.primary_image_id,
    })),
  };
}

// All-or-nothing creation via the create-snapshot-post Edge Function (image
// copies + post + snapshot rows happen server-side as one unit; the server
// also enforces folder/item privacy). The caller may be the folder's owner or
// anyone sharing another collector's effectively-public folder (a repost).
export async function createFolderSharePost(
  folderId: string,
  caption: string | null,
): Promise<{ ok: true; postId: string } | { ok: false; message: string }> {
  const { data, error } = await supabase.functions.invoke('create-snapshot-post', {
    body: { post_type: 'folder_share', folder_id: folderId, caption },
  });
  if (error || data?.status !== 'ok' || typeof data?.post_id !== 'string') {
    const reason = typeof data?.reason === 'string' ? data.reason : (error ? 'request_failed' : 'unknown');
    return { ok: false, message: reason };
  }
  return { ok: true, postId: data.post_id };
}

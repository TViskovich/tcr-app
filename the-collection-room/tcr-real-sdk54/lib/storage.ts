import { File } from 'expo-file-system';

import { supabase } from './supabase';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

export async function uploadItemImage(uri: string, userId: string): Promise<string> {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/${Date.now()}.${ext}`;

  // expo-file-system v19 File class reads the local file:// URI correctly.
  // fetch(uri).blob() and the old readAsStringAsync are both broken in this version.
  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage
    .from('item-images')
    .upload(path, buffer, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('item-images').getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadAvatar(uri: string, userId: string): Promise<string> {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/${Date.now()}.${ext}`;

  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, buffer, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadHeroImage(uri: string, userId: string): Promise<string> {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/hero/${Date.now()}.${ext}`;

  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, buffer, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadBadgeImage(uri: string, userId: string): Promise<string> {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/badge/${Date.now()}.${ext}`;

  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, buffer, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

export type ProfileImageKind = 'avatar' | 'hero' | 'badge';

const AVATARS_BUCKET = 'avatars';

// Matches uploadAvatar/uploadHeroImage/uploadBadgeImage's exact path
// shapes above, by hand: avatar has no subfolder ({userId}/{filename}),
// hero/badge each live in their own subfolder ({userId}/hero/{filename},
// {userId}/badge/{filename}). Also enforces ownership — segments[0] must
// equal the given userId — so this can never be used to target another
// user's object even if a mismatched url/userId/kind were passed in.
function pathMatchesOwnedKind(path: string, userId: string, kind: ProfileImageKind): boolean {
  const segments = path.split('/');
  if (segments[0] !== userId) return false;
  if (kind === 'avatar') {
    return segments.length === 2 && segments[1].length > 0;
  }
  return segments.length === 3 && segments[1] === kind && segments[2].length > 0;
}

// Recovers the Storage object path from a getPublicUrl()-produced URL —
// same "/object/public/<bucket>/<path>" shape lib/item-images.ts's
// deriveStoragePathFromPublicUrl parses, but not reused directly: this
// hardcodes the 'avatars' bucket (a caller can never pass in a different
// bucket name) and requires the decoded path to match both `userId` and
// `kind`'s expected shape before ever being returned — ownership/kind
// scoping that a generic bucket-only path parser doesn't provide. Any
// query string or fragment is stripped from the still-encoded remainder
// BEFORE decoding, so a "?token=..." or "#..." suffix (not something
// getPublicUrl() itself ever appends, but not assumed of every caller
// either) can never end up embedded in the path handed to storage.remove().
function deriveOwnedAvatarPath(url: string, userId: string, kind: ProfileImageKind): string | null {
  const marker = `/object/public/${AVATARS_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;

  const encodedRemainder = url.slice(idx + marker.length).split(/[?#]/)[0];
  if (!encodedRemainder) return null;

  let path: string;
  try {
    path = decodeURIComponent(encodedRemainder);
  } catch {
    return null;
  }
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) return null;

  return pathMatchesOwnedKind(path, userId, kind) ? path : null;
}

// Best-effort Storage cleanup for a replaced/removed avatar, banner, or
// badge image — never throws, never reports a result back to the caller.
// Intended to be called only AFTER the profiles row has already been
// updated/saved successfully (see components/profile-v2/profile-v2-screen.tsx's
// handleSave), so its only two possible outcomes are "the old file is now
// gone" or "the old file is merely orphaned" — never a reason to treat the
// save itself as failed. Silently does nothing (no delete attempted) for
// a null/empty/malformed/wrong-bucket/wrong-owner/wrong-kind URL, so
// callers never need to pre-validate — it's always safe to pass in
// whatever the previous avatar_url/hero_image_url/showcase_badge_url was.
export async function deleteProfileImage(
  url: string | null | undefined,
  userId: string,
  kind: ProfileImageKind,
): Promise<void> {
  if (!url) return;
  const path = deriveOwnedAvatarPath(url, userId, kind);
  if (!path) return;

  try {
    const { error } = await supabase.storage.from(AVATARS_BUCKET).remove([path]);
    if (error && __DEV__) {
      console.warn(`[deleteProfileImage] failed to remove ${kind} object:`, error.message);
    }
  } catch (e) {
    if (__DEV__) {
      console.warn(`[deleteProfileImage] unexpected error removing ${kind} object:`, e);
    }
  }
}

// Reuses item-images bucket — same RLS policy (first path segment = userId).
// Path: {userId}/covers/{timestamp}.{ext} keeps covers logically separate from card photos.
export async function uploadFolderCover(uri: string, userId: string): Promise<string> {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/covers/${Date.now()}.${ext}`;

  const buffer = await new File(uri).arrayBuffer();

  const { error } = await supabase.storage
    .from('item-images')
    .upload(path, buffer, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('item-images').getPublicUrl(path);
  return data.publicUrl;
}

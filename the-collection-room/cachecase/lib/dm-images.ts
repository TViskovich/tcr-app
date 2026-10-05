import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { supabase } from '@/lib/supabase';

// DM photo attachments (supabase/migrations/
// 20261005120000_add_message_image_attachments.sql). Private bucket, Storage
// RLS limits every read/upload to conversation participants; the message row
// stores only the object path + pixel size — never bytes or signed URLs.

export const DM_ATTACHMENTS_BUCKET = 'dm-attachments';

// Messaging-specific limits (deliberately not the item/feed upload
// settings): long edge capped at 2048px, JPEG at 0.85.
const MAX_LONG_EDGE = 2048;
const JPEG_QUALITY = 0.85;

export type PreparedDmImage = {
  uri: string;
  width: number;
  height: number;
};

// Deterministic per message — the same message id ALWAYS maps to the same
// object (also enforced by the upload policy and the messages trigger). A
// retry of one logical send reuses its message id, so it re-targets this
// exact object: no retry orphans, and reconciling by message id also
// identifies the media.
export function dmImagePath(conversationId: string, messageId: string) {
  return `${conversationId}/${messageId}/image.jpg`;
}

// Re-encodes to JPEG (which also bakes in EXIF orientation), downscaling only
// when the long edge exceeds MAX_LONG_EDGE. Picker-reported dimensions are
// used when available to decide on the resize; the returned size is always
// the actual output's.
export async function prepareDmImage(
  uri: string,
  sourceWidth?: number | null,
  sourceHeight?: number | null,
): Promise<PreparedDmImage> {
  let width = sourceWidth ?? 0;
  let height = sourceHeight ?? 0;
  let workingUri = uri;

  if (!width || !height) {
    // Unknown size — normalize first to learn it.
    const probe = await manipulateAsync(uri, [], { compress: 1, format: SaveFormat.JPEG });
    workingUri = probe.uri;
    width = probe.width;
    height = probe.height;
  }

  const longEdge = Math.max(width, height);
  const actions =
    longEdge > MAX_LONG_EDGE
      ? [
          {
            resize:
              width >= height
                ? { width: MAX_LONG_EDGE, height: Math.round((height / width) * MAX_LONG_EDGE) }
                : { width: Math.round((width / height) * MAX_LONG_EDGE), height: MAX_LONG_EDGE },
          },
        ]
      : [];

  const result = await manipulateAsync(workingUri, actions, {
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
  });
  return { uri: result.uri, width: result.width, height: result.height };
}

// Idempotent upload to the message's deterministic path. An "already exists"
// response means a previous attempt of this SAME logical send already
// uploaded it (the path embeds the message id), so it counts as success.
// Throws on any other failure.
export async function uploadDmImage(path: string, localUri: string): Promise<void> {
  const buffer = await new File(localUri).arrayBuffer();
  const { error } = await supabase.storage
    .from(DM_ATTACHMENTS_BUCKET)
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: false });
  if (!error) return;
  const statusCode = String((error as { statusCode?: string | number }).statusCode ?? '');
  if (statusCode === '409' || /already exists|duplicate/i.test(error.message)) return;
  throw new Error(error.message);
}

// Best-effort cleanup after a DEFINITIVELY failed send only. The delete
// policy additionally refuses any object a message references, so this can
// never remove a committed message's photo even if called by mistake.
export async function removeDmImage(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(DM_ATTACHMENTS_BUCKET).remove([path]);
    if (error && __DEV__) console.warn('[dm-images] orphan cleanup failed:', path, error.message);
  } catch (e) {
    if (__DEV__) console.warn('[dm-images] orphan cleanup threw:', path, e);
  }
}

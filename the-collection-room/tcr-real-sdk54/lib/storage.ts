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

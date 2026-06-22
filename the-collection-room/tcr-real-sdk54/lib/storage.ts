import { supabase } from './supabase';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

export async function uploadItemImage(uri: string, userId: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.blob();

  const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = MIME[ext] ?? 'image/jpeg';
  const path = `${userId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('item-images')
    .upload(path, blob, { contentType });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('item-images').getPublicUrl(path);
  return data.publicUrl;
}

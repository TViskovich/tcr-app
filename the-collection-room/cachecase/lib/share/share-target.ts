import { Share } from 'react-native';

// What a CacheCase Share action is pointed at — the minimum each Share sheet
// action needs (ids for routing/links, display strings for share text).
// Only the content types that are actually shareable in the app today. Never
// carries image URLs: signed/private storage URLs must not leave the app, so
// external share TEXT is the title + the app's own deep link only. An image
// travels separately, as a local file attachment (see shareElsewhere).
export type ShareTarget =
  | { type: 'item'; id: string; title: string; ownerUsername: string | null }
  | { type: 'folder'; id: string; title: string; ownerUsername: string | null }
  | { type: 'profile'; username: string; title: string };

// app.json's registered scheme. Each path is an existing Expo Router route:
// app/item/[id].tsx, app/collection/[folderId].tsx, app/user/[username].tsx.
// Opening a link never bypasses visibility — the destination screen loads
// through RLS like any other navigation.
export function shareTargetLink(target: ShareTarget): string {
  switch (target.type) {
    case 'item':
      return `cachecase://item/${target.id}`;
    case 'folder':
      return `cachecase://collection/${target.id}`;
    case 'profile':
      return `cachecase://user/${target.username}`;
  }
}

function shareTargetMessage(target: ShareTarget): string {
  const link = shareTargetLink(target);
  if (target.type === 'profile') return `Check out @${target.username} on CacheCase\n${link}`;
  const by = target.type === 'item' ? ` by @${target.ownerUsername ?? 'user'}` : target.ownerUsername ? ` by @${target.ownerUsername}` : '';
  return `Check out "${target.title}"${by} on CacheCase\n${link}`;
}

// Longest a share waits for its image before opening text-only instead.
const IMAGE_WAIT_MS = 6_000;

// "Share Elsewhere" — the native iOS/Android share sheet. Called right after
// the CacheCase Share sheet (a RN <Modal>) starts closing; the short delay
// lets that dismiss finish first, since presenting the native share
// controller mid-dismiss is a known iOS "already presenting" conflict.
//
// `image` (optional): a local JPEG being prepared by lib/share/share-image.ts
// — started by the caller at tap time, so it runs during that same delay.
// When it's ready in time (iOS only), the sheet gets the image file AND the
// usual text: UIActivityViewController receives them as two separate items
// and each destination takes what it supports — Messages sends both (photo
// plus the text with the link), Save Image saves just the photo, and some
// apps keep only one of the two. Missing/failed/slow image -> the same
// text-only share as before. Only a file:// path is ever handed over, never
// a signed URL.
export async function shareElsewhere(target: ShareTarget, image?: Promise<string | null>): Promise<void> {
  const [, imageUri] = await Promise.all([
    new Promise((resolve) => setTimeout(resolve, 350)),
    image ? withTimeout(image, IMAGE_WAIT_MS) : Promise.resolve(null),
  ]);
  const message = shareTargetMessage(target);
  try {
    await Share.share(
      imageUri ? { title: target.title, message, url: imageUri } : { title: target.title, message },
    );
  } catch {
    // user dismissed share sheet — no-op
  }
}

function withTimeout(promise: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

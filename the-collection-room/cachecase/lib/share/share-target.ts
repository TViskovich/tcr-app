import { Share } from 'react-native';

// What a CacheCase Share action is pointed at — the minimum each Share sheet
// action needs (ids for routing/links, display strings for share text).
// Only the content types that are actually shareable in the app today. Never
// carries image URLs: signed/private storage URLs must not leave the app, so
// external shares are text + the app's own deep link only.
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

// "Share Elsewhere" — the native iOS/Android share sheet. Called right after
// the CacheCase Share sheet (a RN <Modal>) starts closing; the short delay
// lets that dismiss finish first, since presenting the native share
// controller mid-dismiss is a known iOS "already presenting" conflict.
export async function shareElsewhere(target: ShareTarget): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    await Share.share({ title: target.title, message: shareTargetMessage(target) });
  } catch {
    // user dismissed share sheet — no-op
  }
}

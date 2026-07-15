import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Image } from 'expo-image';

import type { Folder } from '@/types';

// Premium leather binder tones — kept as a color registry even though the
// card itself now renders a photographic box asset instead of a flat-color
// binder. Still the live source for FolderColorPicker's swatches and the
// name-hash fallback used at app/folder/[id].tsx, so folder.color keeps
// meaning something even while most cards render the same graphite folder
// art (see folderArtSource() below).
export type FolderColorKey = 'graphite' | 'navy' | 'forest' | 'plum' | 'chestnut' | 'charcoal';

export const LEATHER_TONES: Record<
  FolderColorKey,
  { base: string; spine: string; sheenLight: string; sheenDark: string }
> = {
  graphite: { base: '#2C2C2F', spine: '#131315', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
  navy: { base: '#26374C', spine: '#101B28', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.24)' },
  forest: { base: '#213A2A', spine: '#0D1912', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.25)' },
  plum: { base: '#332543', spine: '#170F20', sheenLight: 'rgba(255,255,255,0.07)', sheenDark: 'rgba(0,0,0,0.25)' },
  chestnut: { base: '#4C3320', spine: '#291A0E', sheenLight: 'rgba(255,255,255,0.075)', sheenDark: 'rgba(0,0,0,0.24)' },
  charcoal: { base: '#2E363D', spine: '#161B1F', sheenLight: 'rgba(255,255,255,0.065)', sheenDark: 'rgba(0,0,0,0.24)' },
};

export const FOLDER_COLOR_KEYS = Object.keys(LEATHER_TONES) as FolderColorKey[];

// Default footprint for callers that don't size this responsively (e.g.
// ProfileV2Collections). app/(tabs)/collection.tsx overrides this via the
// `width` prop with a value computed from the screen's own grid math.
export const CARD_WIDTH = 150;

// Default folder-cover art — the graphite finish, used unless a folder's
// name matches one of the special-cased finishes below. Once there's a real
// per-folder "art"/category field, this should become a proper lookup by
// folder.color the same way LEATHER_TONES already resolves per-folder.
const COLLECTION_FOLDER_SOURCE = require('@/assets/collection-folders/collection-folder-graphite.png');
// A dedicated Pokemon-themed binder — matched by name (case-insensitive)
// until there's a real per-folder "art"/category field to key off of.
const COLLECTION_ICON_POKEBALL_SOURCE = require('@/assets/collection-icons/collection-icon-pokeball.png');
// Forest-green finish, temporarily assigned to the "basketball" folder by
// name match — same stopgap as the Pokemon/pokeball pairing above.
const COLLECTION_FOLDER_FOREST_SOURCE = require('@/assets/collection-folders/collection-folder-forest.png');
// Red finish, temporarily assigned to the "football" folder by name match.
const COLLECTION_FOLDER_RED_SOURCE = require('@/assets/collection-folders/collection-folder-red.png');
// Navy finish, temporarily assigned to the "hockey" folder by name match.
const COLLECTION_FOLDER_NAVY_SOURCE = require('@/assets/collection-folders/collection-folder-navy.png');
// A dedicated One Piece-themed binder — matched by name (case-insensitive),
// same stopgap as the Pokemon/pokeball pairing above.
const COLLECTION_ICON_ONEPIECE_SOURCE = require('@/assets/collection-icons/collection-icon-onepiece.png');

function folderArtSource(folder: Folder) {
  const name = folder.name.trim().toLowerCase();
  if (name === 'pokemon') {
    return COLLECTION_ICON_POKEBALL_SOURCE;
  }
  if (name === 'basketball') {
    return COLLECTION_FOLDER_FOREST_SOURCE;
  }
  if (name === 'football') {
    return COLLECTION_FOLDER_RED_SOURCE;
  }
  if (name === 'hockey') {
    return COLLECTION_FOLDER_NAVY_SOURCE;
  }
  if (name === 'one piece') {
    return COLLECTION_ICON_ONEPIECE_SOURCE;
  }
  return COLLECTION_FOLDER_SOURCE;
}

// Real PNG dimensions (1024x1536) — the box container is given this exact
// ratio so contentFit="contain" fills it edge-to-edge with no letterboxing,
// while BOX_MAX_WIDTH keeps the rendered art itself in the ~125-145px range
// regardless of how wide the surrounding grid cell is. Exported so callers
// (e.g. the carousel) can derive their own layout math from the same ratio
// instead of duplicating the magic number.
export const BOX_ASPECT_RATIO = 1024 / 1536;
const BOX_MAX_WIDTH = 138;

type Props = {
  folder: Folder;
  onPress: () => void;
  // Real, batch-fetched count from hooks/use-collection.ts's useFolders().
  // Optional because not every FolderCard call site has this data today
  // (e.g. the Profile page's own Collections tab) — omit it there rather
  // than showing a stale or fabricated number.
  itemCount?: number;
  // Grid-cell width, provided by the caller's own column math. Defaults to
  // CARD_WIDTH for callers that don't compute a responsive column width.
  width?: number;
  // Overrides BOX_MAX_WIDTH for callers (like the carousel) that want the
  // art rendered larger than the default grid cap.
  maxBoxWidth?: number;
};

export function FolderCard({
  folder,
  onPress,
  itemCount,
  width = CARD_WIDTH,
  maxBoxWidth = BOX_MAX_WIDTH,
}: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.item, { width }, pressed && styles.itemPressed]}
      onPress={onPress}>
      <View style={[styles.boxWrap, { maxWidth: maxBoxWidth }]}>
        <Image
          source={folderArtSource(folder)}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
        />
      </View>

      <Text style={styles.folderName} numberOfLines={1}>
        {folder.name}
      </Text>
      {itemCount !== undefined && (
        <Text style={styles.folderCount} numberOfLines={1}>
          {itemCount} {itemCount === 1 ? 'card' : 'cards'}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // No fixed dimensions baked in beyond the `width` prop — height follows
  // naturally from the box's aspect ratio plus the text below it, so the
  // touch target already covers all three (box, name, count) without any
  // extra hitSlop.
  item: {
    alignItems: 'center',
  },
  itemPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.97 }],
  },
  boxWrap: {
    width: '100%',
    aspectRatio: BOX_ASPECT_RATIO,
    alignSelf: 'center',
  },
  folderName: {
    marginTop: -53,
    maxWidth: '100%',
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  folderCount: {
    marginTop: 1,
    maxWidth: '100%',
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    textAlign: 'center',
  },
});

import { memo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { Image } from 'expo-image';

import { FOLDER_COVER_ASPECT_RATIO } from '@/constants/folder-cover';
import { resolveFolderCoverTransform } from '@/lib/folder-cover-crop';
import type { FolderCoverCrop } from '@/types';

type Props = {
  uri: string;
  // null for 'first_card' covers, and for 'item'/'upload' covers picked
  // before FolderCoverAdjuster applied to their source — those render
  // exactly as they always have (plain centered contentFit="cover").
  // Non-null for both 'item' and 'upload' covers framed via
  // FolderCoverAdjuster (app/collection/[folderId].tsx), which is what
  // lets "Choose from Library" reuse the exact same crop/zoom/reposition
  // UI as "Choose from Folder" instead of a second cropper.
  crop: FolderCoverCrop | null;
  // Stable expo-image cacheKey (lib/private-image-cache-key.ts), built by
  // the caller from the folder's own cover_source/cover_storage_path/
  // cover_item_id — decouples the byte-cache entry from `uri` itself,
  // which rotates on every signed-URL re-sign even when the underlying
  // cover hasn't changed. Omitted for a 'first_card' cover (no stable
  // identity available — see that helper's own comment), in which case
  // expo-image falls back to keying on `uri`, same as before Phase 2.
  cacheKey?: string;
};

// Renders the folder-hero cover image, filling its parent (the coverHero
// View in app/collection/[folderId].tsx). With crop metadata, reconstructs
// the exact pan/zoom framing the owner composed in FolderCoverAdjuster —
// see lib/folder-cover-crop.ts for the shared math both sides use.
//
// Wrapped in memo() as defense-in-depth against exactly the flicker class
// diagnosed in app/collection/[folderId].tsx's own render path (that
// screen re-renders constantly during Reorder mode's tap-to-rank —
// unrelated to this component's own props): with a stable `uri`/`crop`,
// this now skips re-rendering entirely on an unrelated parent re-render,
// on top of that screen no longer remounting it in the first place.
export const FolderCoverImage = memo(function FolderCoverImage({ uri, crop, cacheKey }: Props) {
  const { width: windowWidth } = useWindowDimensions();

  if (!crop) {
    return (
      <Image
        source={{ uri, cacheKey }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={200}
        cachePolicy="memory-disk"
      />
    );
  }

  return (
    <CroppedFolderCoverImage
      uri={uri}
      crop={crop}
      cacheKey={cacheKey}
      containerW={windowWidth}
      containerH={windowWidth / FOLDER_COVER_ASPECT_RATIO}
    />
  );
});

function CroppedFolderCoverImage({
  uri,
  crop,
  cacheKey,
  containerW,
  containerH,
}: {
  uri: string;
  crop: FolderCoverCrop;
  cacheKey?: string;
  containerW: number;
  containerH: number;
}) {
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const transform = naturalSize
    ? resolveFolderCoverTransform({ crop, containerW, containerH, imageW: naturalSize.width, imageH: naturalSize.height })
    : null;

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        transform
          ? { transform: [{ translateX: transform.tx }, { translateY: transform.ty }, { scale: transform.scale }] }
          : styles.hidden,
      ]}>
      <Image
        source={{ uri, cacheKey }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={200}
        cachePolicy="memory-disk"
        onLoad={(e) => setNaturalSize({ width: e.source.width, height: e.source.height })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Kept mounted (so onLoad still fires) but invisible until the natural
  // size is known and the real transform can be computed — avoids a flash
  // of un-positioned (scale 1, untransformed contain-fit) image before
  // then, same "resolving" convention as the rest of this screen's own
  // placeholders.
  hidden: {
    opacity: 0,
  },
});

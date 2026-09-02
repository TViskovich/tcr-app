import { useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { Image } from 'expo-image';

import { FOLDER_COVER_ASPECT_RATIO } from '@/constants/folder-cover';
import { resolveFolderCoverTransform } from '@/lib/folder-cover-crop';
import type { FolderCoverCrop } from '@/types';

type Props = {
  uri: string;
  // null for 'upload'/'first_card' covers, and for 'item' covers picked
  // before this feature existed — both render exactly as they always have
  // (plain centered contentFit="cover"), unchanged.
  crop: FolderCoverCrop | null;
};

// Renders the folder-hero cover image, filling its parent (the coverHero
// View in app/collection/[folderId].tsx). With crop metadata, reconstructs
// the exact pan/zoom framing the owner composed in FolderCoverAdjuster —
// see lib/folder-cover-crop.ts for the shared math both sides use.
export function FolderCoverImage({ uri, crop }: Props) {
  const { width: windowWidth } = useWindowDimensions();

  if (!crop) {
    return <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />;
  }

  return (
    <CroppedFolderCoverImage
      uri={uri}
      crop={crop}
      containerW={windowWidth}
      containerH={windowWidth / FOLDER_COVER_ASPECT_RATIO}
    />
  );
}

function CroppedFolderCoverImage({
  uri,
  crop,
  containerW,
  containerH,
}: {
  uri: string;
  crop: FolderCoverCrop;
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
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={200}
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

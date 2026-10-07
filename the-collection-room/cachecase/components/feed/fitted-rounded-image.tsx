import { useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';

import { Image } from 'expo-image';

import { rememberMediaSize, useMediaSize } from '@/lib/feed-media-dimensions';

type Props = {
  uri: string;
  radius: number;
  transition?: number;
};

// Text-post photo that is rounded AT THE PHOTO'S OWN EDGES, not just at its
// frame's. With contentFit="contain" an expo-image view is the size of its
// frame, but the picture is drawn letterboxed inside it — so a radius or
// overflow clip on the frame (or on the Image view, which clips its own
// bounds, not the letterboxed content) rounds empty space while the photo's
// real corners stay square. Here the clipping View (radius + overflow:
// 'hidden') is sized to exactly the rectangle the photo occupies — the
// natural aspect ratio fit inside the available box, centered — and the
// Image fills that View, so the clip and the photo's edges are the same
// rectangle.
//
// The natural size comes from the shared feed media-size cache
// (lib/feed-media-dimensions.ts) BEFORE the image renders: the rounded
// rectangle is created at its final fitted size, and the Image only fades in
// inside it — it is never drawn at a temporary geometry. Until that size and
// this box's own layout are both known, nothing is drawn here (the caller's
// frame background shows). If the size can't be measured, it falls back to
// the original behavior: fill the box, then fit once the Image's own onLoad
// reports its size.
//
// Fills its parent (which must have a definite size). Frame size/aspect-
// ratio logic stays entirely with the caller.
export function FittedRoundedImage({ uri, radius, transition = 200 }: Props) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const media = useMediaSize(uri);
  // Fallback-only: the size the Image reported itself, for a uri whose
  // measurement failed. Keyed by uri so a reused instance never applies a
  // previous image's size.
  const [loaded, setLoaded] = useState<{ uri: string; width: number; height: number } | null>(null);
  const natural = media.size ?? (loaded?.uri === uri ? loaded : null);

  function handleLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  }

  let fitted: { width: number; height: number } | null = null;
  if (natural && box.width > 0 && box.height > 0) {
    const scale = Math.min(box.width / natural.width, box.height / natural.height);
    fitted = { width: natural.width * scale, height: natural.height * scale };
  }

  // Known size: wait for the fitted rectangle. Failed measurement: render
  // with the fill fallback.
  const ready = media.settled && (natural == null || fitted != null);

  return (
    <View style={styles.box} onLayout={handleLayout}>
      {ready ? (
        <View
          collapsable={false}
          style={[fitted ?? styles.fill, { borderRadius: radius, overflow: 'hidden' }]}>
          <Image
            source={{ uri }}
            style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
            contentFit="contain"
            transition={transition}
            onLoad={(e) => {
              const { width, height } = e.source;
              if (width > 0 && height > 0) {
                rememberMediaSize(uri, width, height);
                if (!media.size) setLoaded({ uri, width, height });
              }
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {
    width: '100%',
    height: '100%',
  },
});

import { useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';

import { Image } from 'expo-image';

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
// natural aspect ratio (from the Image's own onLoad) fit inside the
// available box, centered — and the Image fills that View, so the clip and
// the photo's edges are the same rectangle.
//
// Fills its parent (which must have a definite size). Until the image has
// loaded, the clipping View fills the whole box — identical to the previous
// plain-Image behavior — then snaps to the fitted rectangle. Frame
// size/aspect-ratio logic stays entirely with the caller.
export function FittedRoundedImage({ uri, radius, transition = 200 }: Props) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  function handleLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  }

  let fitted: { width: number; height: number } | null = null;
  if (natural && box.width > 0 && box.height > 0) {
    const scale = Math.min(box.width / natural.width, box.height / natural.height);
    fitted = { width: natural.width * scale, height: natural.height * scale };
  }

  return (
    <View style={styles.box} onLayout={handleLayout}>
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
            if (width > 0 && height > 0) setNatural({ width, height });
          }}
        />
      </View>
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

import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import type { HeroCanvasImageAsset } from './hero-canvas-themes';

type Props = {
  asset: HeroCanvasImageAsset;
};

// Generic renderer for any 'image'-kind hero canvas theme: a bundled artwork
// PNG, full-bleed and opaque (the display surface itself, same role as
// Spectra's procedural material), plus that theme's own subtle vignette.
// contentFit="cover" crops to fill without stretching; no blurRadius/tint is
// applied so the source art stays pixel-sharp and fully saturated.
export function HeroCanvasImage({ asset }: Props) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image
        source={asset.source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        contentPosition={asset.focalPoint}
        cachePolicy="memory-disk"
      />
      {asset.vignetteOpacity ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: `rgba(0,0,0,${asset.vignetteOpacity})` },
          ]}
        />
      ) : null}
    </View>
  );
}

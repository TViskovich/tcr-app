import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient as SvgRadialGradient, Rect, Stop } from 'react-native-svg';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { PV2 } from './profile-v2-theme';

// Matches the Figma reference's HoloHero: full-bleed (no card margin/
// radius — the rounded corners in the mockup screenshots are the *phone
// mockup bezel* around the whole demo, not the hero itself), fixed height,
// with a portrait circle sized to the full hero width (not a small fixed
// avatar) per the reference's `width: "100%", aspectRatio: "1/1"`.
export const HERO_HEIGHT_V2 = 548;

type Props = {
  avatarUri: string | null;
  heroImageUri: string | null;
  // Swatch colors from the profile's own hero_theme, used as a gradient
  // fallback when there's no avatar or hero image at all — ties the empty
  // state back to a real profile field instead of a generic gray box.
  themeFallbackSwatch: [string, string];
  displayName: string;
  username: string;
  editMode: boolean;
  saving: boolean;
  onAvatarPress?: () => void;
  onHeroPress?: () => void;
  onSettingsPress: () => void;
  onSavedPress: () => void;
  onCancelPress: () => void;
  onSavePress: () => void;
};

export function ProfileV2Hero({
  avatarUri,
  heroImageUri,
  themeFallbackSwatch,
  displayName,
  username,
  editMode,
  saving,
  onAvatarPress,
  onHeroPress,
  onSettingsPress,
  onSavedPress,
  onCancelPress,
  onSavePress,
}: Props) {
  const bgSource = heroImageUri ?? avatarUri;
  // Full hero width — the reference's portrait circle is width:"100%" of
  // its (full-bleed) container, not a small fixed avatar.
  const { width: heroWidth } = useWindowDimensions();

  return (
    <View style={[styles.card, { height: HERO_HEIGHT_V2 }]}>
      {/* Background — the profile's own hero image, falling back to the
          avatar, falling back to a gradient made from the profile's own
          selected hero theme swatch (never a generic placeholder).
          scale/blur/saturate/brightness match the reference exactly. */}
      {bgSource ? (
        <Image source={{ uri: bgSource }} style={styles.bgImage} contentFit="cover" />
      ) : (
        <LinearGradient
          colors={themeFallbackSwatch}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
      )}

      {/* Elliptical dark vignette across the whole hero — transparent to
          30% of the ellipse, fading to 55% black at its edge. */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <Defs>
          <SvgRadialGradient id="heroVignette" cx="50%" cy="50%" rx="80%" ry="70%">
            <Stop offset="30%" stopColor="#000000" stopOpacity={0} />
            <Stop offset="100%" stopColor="#000000" stopOpacity={0.55} />
          </SvgRadialGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#heroVignette)" />
      </Svg>

      {/* Tap target for changing the banner in edit mode — sits under the
          avatar/text layers so it doesn't block the avatar's own tap. */}
      {editMode && onHeroPress && (
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onHeroPress} />
      )}

      {/* Top actions — settings/saved in view mode, cancel/save in edit mode.
          Same navigation targets/handlers as before, just relocated. */}
      <View style={styles.topRow} pointerEvents="box-none">
        {editMode ? (
          <>
            <TouchableOpacity onPress={onCancelPress} hitSlop={10} style={styles.textBtn}>
              <Text style={styles.textBtnLabel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSavePress} disabled={saving} hitSlop={10} style={styles.textBtn}>
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[styles.textBtnLabel, styles.saveLabel]}>Save</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity onPress={onSettingsPress} hitSlop={10} style={styles.iconBtn} activeOpacity={0.75}>
              <IconSymbol name="gearshape.fill" size={18} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onSavedPress} hitSlop={10} style={styles.iconBtn} activeOpacity={0.75}>
              <IconSymbol name="bookmark" size={18} color="#fff" />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Portrait — full hero width, ~88px above the hero's bottom edge */}
      <View style={styles.avatarWrap} pointerEvents="box-none">
        <Pressable
          style={[styles.avatarRing, { width: heroWidth, height: heroWidth, borderRadius: heroWidth / 2 }]}
          onPress={onAvatarPress}
          disabled={!onAvatarPress}>
          {avatarUri ? (
            <Image
              source={{ uri: avatarUri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              contentPosition="top"
              transition={200}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
              <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          {editMode && (
            <View style={styles.avatarOverlay} pointerEvents="none">
              <Text style={styles.avatarOverlayText}>Change</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Bottom fade — flat 2-stop transparent-to-page-bg, bottom 30%. */}
      <LinearGradient
        colors={['transparent', PV2.bg]}
        style={styles.bottomFade}
        pointerEvents="none"
      />

      {/* Name + username overlay, bottom-anchored on the hero itself. */}
      <View style={styles.nameOverlay} pointerEvents="none">
        <Text style={styles.nameText} numberOfLines={1}>{displayName.toUpperCase()}</Text>
        <Text style={styles.usernameText}>@{username}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: PV2.panel,
  },
  bgImage: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.08 }],
    // Real RN 0.81 style.filter (New Architecture) — one mechanism for all
    // three, rather than mixing this with expo-image's separate blurRadius prop.
    filter: [{ blur: 5 }, { saturate: 2.0 }, { brightness: 0.75 }],
  },
  topRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  textBtnLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
    fontWeight: '600',
  },
  saveLabel: {
    color: '#fff',
  },
  avatarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 88,
    alignItems: 'center',
  },
  avatarRing: {
    overflow: 'hidden',
    backgroundColor: '#2A2A2A',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 64,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.50)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOverlayText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '30%',
  },
  nameOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: 'center',
    gap: 2,
  },
  nameText: {
    color: '#fff',
    fontSize: 42,
    fontWeight: '700',
    letterSpacing: 1.6,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 24,
  },
  usernameText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 12,
  },
});

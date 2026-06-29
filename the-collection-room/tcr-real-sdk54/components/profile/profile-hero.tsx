import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Profile } from '@/types';
import { HERO_HEIGHT } from './hero-constants';
import { HeroBackground } from './hero-background';
import { HeroAvatar } from './hero-avatar';
import { HeroBrand } from './hero-brand';
import { HeroInfo } from './hero-info';
import { HeroShowcaseRail } from './hero-showcase-rail';

export { HERO_HEIGHT } from './hero-constants';

// Background source resolution order:
//   1. heroImageUri — dedicated banner image (DB field: hero_image_url)
//   2. avatarUri    — fallback: blurred avatar fills the hero
//   3. null         — solid dark base (#0D0D0D), no image rendered
type Props = {
  profile: Profile;
  avatarUri: string | null;
  heroImageUri?: string | null;
  showcaseBadgeUri?: string | null;
  onAvatarPress?: () => void;
  onHeroPress?: () => void;
  onBadgePress?: () => void;
  editMode?: boolean;
  actionRow?: ReactNode;
  brandLabel?: string;
  scrollY?: Animated.Value;
};

export function ProfileHero({
  profile,
  avatarUri,
  heroImageUri = null,
  showcaseBadgeUri,
  onAvatarPress,
  onHeroPress,
  onBadgePress,
  editMode = false,
  actionRow,
  brandLabel,
  scrollY,
}: Props) {
  const displayName = profile.hero_display_name || profile.display_name || profile.username;
  const bgSource = heroImageUri ?? avatarUri;
  const isHeroImage = !!heroImageUri;

  // Entrance animation for the identity block
  const identityOpacity = useRef(new Animated.Value(0)).current;
  const identitySlide = useRef(new Animated.Value(5)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(identityOpacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(identitySlide, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll-driven SHOWCASE collapse — falls back to static 0 when no scrollY is provided
  const _defaultScrollY = useRef(new Animated.Value(0)).current;
  const _scrollY = scrollY ?? _defaultScrollY;
  const showcaseOpacity = _scrollY.interpolate({
    inputRange: [0, 65],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const showcaseTranslate = _scrollY.interpolate({
    inputRange: [0, 65],
    outputRange: [0, -18],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        {/*
          Layer 1 — background, clipped to hero bounds.
          Has its own overflow:hidden so the -100px inset image and gradients
          stay contained, while the avatar in layer 2 can overflow horizontally.
        */}
        <View style={styles.heroBgClip}>
          <HeroBackground
            bgSource={bgSource}
            isHeroImage={isHeroImage}
            editMode={editMode}
            onHeroPress={onHeroPress}
          />
        </View>

        {/*
          Layer 2 — avatar + identity text.
          box-none: the View itself doesn't intercept touches, so taps on the
          "Change Banner" button (rendered in layer 1 below) pass through the
          transparent areas here and reach the button.
        */}
        <View style={styles.heroContent} pointerEvents="box-none">
          {/* Soft radial vignette behind the identity cluster — ~10% darkness, aids legibility */}
          <View style={styles.identityVignette} pointerEvents="none" />

          <HeroAvatar
            avatarUri={avatarUri}
            displayName={displayName}
            onPress={onAvatarPress}
            editMode={editMode}
          />
          {/* Badge + name + handle + bio animate together as one identity unit */}
          <Animated.View
            style={[
              styles.identityBlock,
              { opacity: identityOpacity, transform: [{ translateY: identitySlide }] },
            ]}
            pointerEvents="box-none">
            <HeroShowcaseRail
              avatarUri={avatarUri}
              showcaseBadgeUri={showcaseBadgeUri}
              displayName={displayName}
              editMode={editMode}
              onBadgePress={onBadgePress}
            />
            <HeroInfo
              displayName={displayName}
              username={profile.username}
              bio={profile.bio}
              actionRow={actionRow}
            />
          </Animated.View>
        </View>

        {/*
          Layer 3 — wordmark. Animated.View wraps HeroBrand so scroll can
          fade + slide it upward as the user scrolls into the content below.
        */}
        {brandLabel ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { opacity: showcaseOpacity, transform: [{ translateY: showcaseTranslate }] },
            ]}>
            <HeroBrand label={brandLabel} />
          </Animated.View>
        ) : null}
      </View>

      {/* Seamless bridge: hero dark → page background.
          Renders immediately below the hero so the canvas dissolves
          rather than cutting off at a hard edge. */}
      <LinearGradient
        colors={['#0D0D0D', '#f8f9fa']}
        style={styles.heroExtension}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#0D0D0D',
  },
  hero: {
    height: HERO_HEIGHT,
    backgroundColor: '#0D0D0D',
    // No overflow:hidden here — avatar is allowed to bleed off the left/right edges.
    // Background clipping is handled by heroBgClip below.
  },
  // Clips background layers (image + gradients) to hero bounds without clipping the avatar.
  heroBgClip: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  heroContent: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 48,
    paddingBottom: 24,
  },
  identityBlock: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  heroExtension: {
    height: 72,
  },
  // Faked radial vignette — dark oval centered behind badge + name + handle
  identityVignette: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    width: 340,
    height: 210,
    borderRadius: 170,
    backgroundColor: 'rgba(0,0,0,0.10)',
  },
});

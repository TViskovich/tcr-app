import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Profile } from '@/types';
import { HERO_HEIGHT, AVATAR_SIZE, IDENTITY_TOP_PADDING } from './hero-constants';
import { HeroBackground } from './hero-background';
import type { HeroCanvasThemeId } from './hero-canvas-themes';
import { HeroAvatar } from './hero-avatar';
import { HeroBrand } from './hero-brand';
import { HeroInfo } from './hero-info';
import { HeroShowcaseRail } from './hero-showcase-rail';

export { HERO_HEIGHT } from './hero-constants';

// Phase 2 max travel so @tvisko stays inside the hero canvas on every device.
// Arc rail: 3 slots per side, outer pill bottom = marginTop(41) + PILL_H(72) = 113px row height.
// Derivation: paddingTop(48) + AVATAR_SIZE - identityNudge(10) + railRow(129) + infoBlock(68)
// = AVATAR_SIZE + 235  ← @tvisko bottom in hero-coords at Phase 2 start.
// PHASE2_MAX = HERO_HEIGHT - bottomPad(39) - (AVATAR_SIZE + 235) = 546 - AVATAR_SIZE
const PHASE2_MAX_TRANSLATE = Math.max(0, 546 - AVATAR_SIZE);

// Background source resolution order:
//   1. heroImageUri — dedicated banner image (DB field: hero_image_url)
//   2. avatarUri    — fallback: blurred avatar fills the hero
//   3. null         — solid dark base (#0D0D0D), no image rendered
type Props = {
  profile: Profile;
  avatarUri: string | null;
  heroImageUri?: string | null;
  heroTheme?: HeroCanvasThemeId;
  showcaseBadgeUri?: string | null;
  onAvatarPress?: () => void;
  onHeroPress?: () => void;
  onBadgePress?: () => void;
  editMode?: boolean;
  actionRow?: ReactNode;
  brandLabel?: string;
  scrollY?: Animated.Value;
  onPillPress?: (id: string) => void;
  activePills?: string[];
};

export function ProfileHero({
  profile,
  avatarUri,
  heroImageUri = null,
  heroTheme,
  showcaseBadgeUri,
  onAvatarPress,
  onHeroPress,
  onBadgePress,
  editMode = false,
  actionRow,
  brandLabel,
  scrollY,
  onPillPress,
  activePills,
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

  // Scroll-driven collapse animations.
  // Edit mode bypasses all scroll animation by using the static 0 value,
  // so rail, bio, and identity block stay fully visible while editing.
  const _defaultScrollY = useRef(new Animated.Value(0)).current;
  const _scrollY = editMode ? _defaultScrollY : (scrollY ?? _defaultScrollY);
  // Phase 1 — SHOWCASE descends solo toward the identity block.
  // Ratio 1.5 (540px over 280px scroll) → net +0.5px/scroll downward on screen.
  const showcaseTranslate = _scrollY.interpolate({
    inputRange: [0, 280],
    outputRange: [0, 510],
    extrapolate: 'clamp',
  });
  // Phase 2 — SHOWCASE and identity stack travel together to the bottom of the hero.
  // Starts exactly where Phase 1 ends (280) so the handoff is seamless.
  // outputRange clamped to PHASE2_MAX_TRANSLATE so @tvisko never exits the hero canvas.
  const sharedTranslateY = _scrollY.interpolate({
    inputRange: [280, 410],
    outputRange: [0, PHASE2_MAX_TRANSLATE],
    extrapolate: 'clamp',
  });

  const bioOpacity = _scrollY.interpolate({
    inputRange: [280, 360],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const identityNudge = _scrollY.interpolate({
    inputRange: [0, 140],
    outputRange: [0, -10],
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
            // TEMP(M2): Spectra v2 visual test. Hardcoded to force the Spectra
            // test render. Revert to `theme={heroTheme}` in Milestone 3.
            theme={('spectra' as unknown) as HeroCanvasThemeId}
            // Read-only: drives Spectra's restrained lighting parallax. Does not
            // change what scrollY does to the rail/identity animations above.
            scrollY={_scrollY}
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
              {
                opacity: identityOpacity,
                transform: [
                  { translateY: identitySlide },
                  { translateY: identityNudge },
                ],
              },
            ]}
            pointerEvents="box-none">
            <View pointerEvents="box-none">
              <HeroShowcaseRail
                avatarUri={avatarUri}
                showcaseBadgeUri={showcaseBadgeUri}
                displayName={displayName}
                editMode={editMode}
                onBadgePress={onBadgePress}
                onPillPress={onPillPress}
                activePills={activePills}
              />
            </View>
            <Animated.View
              style={{ transform: [{ translateY: sharedTranslateY }] }}
              pointerEvents="box-none"
            >
              <HeroInfo
                displayName={displayName}
                username={profile.username}
                bio={profile.bio}
                actionRow={actionRow}
                animatedBioOpacity={bioOpacity}
              />
            </Animated.View>
          </Animated.View>
        </View>

        {/*
          Layer 3 — wordmark.
          Phase 1: showcaseTranslate brings SHOWCASE down to meet the name block.
          Phase 2: sharedTranslateY moves both SHOWCASE and identity together
          toward the bottom of the hero canvas.
        */}
        {brandLabel ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                transform: [
                  { translateY: showcaseTranslate },
                  { translateY: sharedTranslateY },
                ],
              },
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
    paddingTop: IDENTITY_TOP_PADDING,
    paddingBottom: 24,
  },
  identityBlock: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  heroExtension: {
    height: 72,
  },
  // Layout-only — kept for its size/position/clipping in case something
  // depends on it, but made fully invisible (no fill) per request. Was a
  // faint dark oval "ghost" showing through behind the badge rail/identity
  // stack; neutralized here rather than removing the View.
  identityVignette: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    width: 340,
    height: 210,
    borderRadius: 170,
    backgroundColor: 'transparent',
  },
});

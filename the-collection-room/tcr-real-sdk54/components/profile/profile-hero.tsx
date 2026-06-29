import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
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
}: Props) {
  const displayName = profile.display_name || profile.username;
  const bgSource = heroImageUri ?? avatarUri;
  const isHeroImage = !!heroImageUri;

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
          <HeroAvatar
            avatarUri={avatarUri}
            displayName={displayName}
            onPress={onAvatarPress}
            editMode={editMode}
          />
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
        </View>

        {/*
          Layer 3 — wordmark, rendered last so it sits above the avatar artwork.
          pointerEvents="none" — fully touch-transparent, never blocks avatar tap
          or Change Banner button. In a later phase this becomes Animated.View
          and collapses downward toward the identity block on scroll.
        */}
        {brandLabel ? <HeroBrand label={brandLabel} /> : null}
      </View>
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
});

import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Profile } from '@/types';
import { HERO_HEIGHT } from './hero-constants';
import { HeroBackground } from './hero-background';
import { HeroAvatar } from './hero-avatar';
import { HeroInfo } from './hero-info';

export { HERO_HEIGHT } from './hero-constants';

// Background source resolution order:
//   1. heroImageUri — dedicated banner image (DB field: hero_image_url)
//   2. avatarUri    — fallback: blurred avatar fills the hero
//   3. null         — solid dark base (#0D0D0D), no image rendered
type Props = {
  profile: Profile;
  avatarUri: string | null;
  heroImageUri?: string | null;
  onAvatarPress?: () => void;
  onHeroPress?: () => void;
  editMode?: boolean;
  actionRow?: ReactNode;
};

export function ProfileHero({
  profile,
  avatarUri,
  heroImageUri = null,
  onAvatarPress,
  onHeroPress,
  editMode = false,
  actionRow,
}: Props) {
  const displayName = profile.display_name || profile.username;
  const bgSource = heroImageUri ?? avatarUri;

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <HeroBackground bgSource={bgSource} editMode={editMode} onHeroPress={onHeroPress} />

        <View style={styles.heroContent}>
          <HeroAvatar
            avatarUri={avatarUri}
            displayName={displayName}
            onPress={onAvatarPress}
            editMode={editMode}
          />
          <HeroInfo
            displayName={displayName}
            username={profile.username}
            bio={profile.bio}
            actionRow={actionRow}
          />
        </View>
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
    overflow: 'hidden',
  },
  heroContent: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 46,
    paddingBottom: 28,
  },
});

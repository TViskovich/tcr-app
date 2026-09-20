import { useLocalSearchParams } from 'expo-router';

import { FollowListScreen } from '@/components/profile-v2/follow-list-screen';

// Always the profile whose following list is being viewed — the :userId
// route param, never the signed-in session's own id. Reached from
// components/profile-v2/profile-v2-screen.tsx's expanded-details Following
// count (that screen's own `userId` prop, i.e. the profile being viewed).
export default function FollowingScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  if (!userId) return null;
  return <FollowListScreen userId={userId} direction="following" />;
}

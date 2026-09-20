import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams } from 'expo-router';

import { ProfileV2Screen } from '@/components/profile-v2/profile-v2-screen';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { supabase } from '@/lib/supabase';

// Resolves the route's :username to the profile's real id, then hands off
// entirely to the shared redesigned profile screen — the exact same
// component app/(tabs)/profile.tsx uses for the signed-in user's own
// profile. This route's only job is the username -> id lookup and the
// loading/not-found states; ProfileV2Screen owns everything else,
// including deciding (by comparing this id against the signed-in
// session) whether the viewer is looking at their own profile.
export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);

    supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        if (!data) {
          setNotFound(true);
        } else {
          setUserId(data.id);
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: username ? `@${username}` : 'Profile' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.accent} />
        </View>
      </>
    );
  }

  if (notFound || !userId) {
    return (
      <>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Text style={styles.errorText}>User not found.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      {/* ProfileV2Screen is full-bleed from the very top (same as the
          profile tab) and supplies its own standalone back chevron,
          top-left above the identity card, when it renders someone else's
          profile — no native header on top of it. */}
      <Stack.Screen options={{ headerShown: false }} />
      <ProfileV2Screen userId={userId} />
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.bg,
  },
  errorText: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
});

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams } from 'expo-router';

import { ProfileV2Screen } from '@/components/profile-v2/profile-v2-screen';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { supabase } from '@/lib/supabase';
import { peekProfileUserId, rememberProfileUserId } from '@/lib/visited-profile-cache';

// Resolves the route's :username to the profile's real id, then hands off
// entirely to the shared redesigned profile screen — the exact same
// component app/(tabs)/profile.tsx uses for the signed-in user's own
// profile. This route's only job is the username -> id lookup and the
// loading/not-found states; ProfileV2Screen owns everything else,
// including deciding (by comparing this id against the signed-in
// session) whether the viewer is looking at their own profile.
export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  // Resolved id, tagged with the username it belongs to, so a stale result
  // can never show under a different username. Starts from the session's
  // remembered username -> id (lib/visited-profile-cache.ts) when known, so
  // re-opening a profile renders it immediately (from its own in-memory
  // snapshot, see ProfileV2Screen) instead of waiting on this lookup. The
  // lookup below still always runs and wins if the username now points at a
  // different profile; userId null = not found.
  const [resolved, setResolved] = useState<{ username: string; userId: string | null } | null>(() => {
    const known = username ? peekProfileUserId(username) : undefined;
    return username && known ? { username, userId: known } : null;
  });

  useEffect(() => {
    if (!username) return;
    let cancelled = false;

    supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          rememberProfileUserId(username, data.id);
          setResolved((prev) =>
            prev && prev.username === username && prev.userId === data.id ? prev : { username, userId: data.id },
          );
        } else {
          // A failed lookup never discards an id this username already
          // resolved to; it only reports "not found" when nothing is known.
          setResolved((prev) => (prev && prev.username === username && prev.userId ? prev : { username, userId: null }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  const current = resolved && resolved.username === username ? resolved : null;
  const loading = !current;
  const notFound = current?.userId === null;
  const userId = current?.userId ?? null;

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

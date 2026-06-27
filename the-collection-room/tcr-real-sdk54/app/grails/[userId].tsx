import { useEffect, useRef } from 'react';
import { Animated, ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { BookmarkButton } from '@/components/ui/bookmark-button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { GrailsGrid } from '@/components/profile/grails-grid';
import { useGrails } from '@/hooks/use-grails';
import { useSavedGrails } from '@/hooks/use-saved';
import { useAuth } from '@/lib/auth';

export default function GrailsShowcaseScreen() {
  const { userId, username, displayName } = useLocalSearchParams<{
    userId: string;
    username?: string;
    displayName?: string;
  }>();

  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const isOwnGrails = !!currentUserId && currentUserId === userId;

  const { grails, loading } = useGrails(userId);
  const { isSaved, saving: savingGrails, toggle: toggleGrailsSave } = useSavedGrails(
    !isOwnGrails ? userId : null,
    currentUserId,
  );

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.88)).current;
  const hasAnimated = useRef(false);

  // Run entrance animation when grails become available, not on mount.
  // If useEffect ran on mount with [], it would fire during the loading spinner
  // and fadeAnim would already be 1 by the time the vault mounts.
  useEffect(() => {
    if (!loading && grails.length > 0 && !hasAnimated.current) {
      hasAnimated.current = true;
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 150 }),
      ]).start();
    }
  }, [loading, grails.length]);

  const name = (displayName ?? '').trim();
  const title = name ? `${name}'s Grails` : `@${username ?? ''}'s Grails`;

  return (
    <>
      <Stack.Screen
        options={{
          header: ({ navigation }) => (
            <ScreenHeader
              title={title}
              onBack={() => navigation.goBack()}
              rightContent={!isOwnGrails && !!currentUserId
                ? <BookmarkButton isSaved={isSaved} onPress={toggleGrailsSave} disabled={savingGrails} />
                : undefined}
            />
          ),
        }}
      />
      <View style={styles.container}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#D4A520" />
          </View>
        ) : grails.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No Grails yet.</Text>
          </View>
        ) : (
          <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
            <ScrollView
              contentContainerStyle={styles.scroll}
              showsVerticalScrollIndicator={false}>
              <GrailsGrid
                grails={grails}
                editable={false}
                onItemPress={(g) =>
                  router.push({
                    pathname: '/item/[id]',
                    params: { id: g.item_id, fromGrails: '1' },
                  })
                }
                vaultMargin={8}
              />
            </ScrollView>
          </Animated.View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0806',
  },
  scroll: {
    paddingVertical: 24,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.50)',
  },
});

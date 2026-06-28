import { useEffect, useRef } from 'react';
import { Animated, ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { BookmarkButton } from '@/components/ui/bookmark-button';
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
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!loading && grails.length > 0 && !hasAnimated.current) {
      hasAnimated.current = true;
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    }
  }, [loading, grails.length]);

  const name = (displayName ?? '').trim();
  const title = name ? `${name}'s Grails` : `@${username ?? ''}'s Grails`;

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerBackButtonDisplayMode: 'minimal',
          headerRight: !isOwnGrails && !!currentUserId
            ? () => (
                <BookmarkButton isSaved={isSaved} onPress={toggleGrailsSave} disabled={savingGrails} />
              )
            : undefined,
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
          // pointerEvents="box-none": wrapper itself doesn't absorb taps;
          // children (ScrollView, GrailsGrid cards) receive all touches normally.
          <Animated.View style={{ flex: 1, opacity: fadeAnim }} pointerEvents="box-none">
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

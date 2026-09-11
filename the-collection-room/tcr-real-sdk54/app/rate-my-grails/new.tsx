import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { Stack, useRouter } from 'expo-router';

import { GrailsSlot } from '@/components/profile/grails-slot';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useGrails } from '@/hooks/use-grails';
import { useScrollResponsiveNavbar } from '@/hooks/use-scroll-responsive-navbar';
import { useSignedItemImages } from '@/hooks/use-signed-item-images';
import { useAuth } from '@/lib/auth';
import { createSnapshotPost } from '@/lib/share-snapshots';

const MAX_CHARS = 280;

export default function NewRateMyGrailsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const { grails, loading } = useGrails(currentUserId);
  // One batched call for the whole preview grid — never one signing
  // request per card (item-images beta privacy hardening, Phase 3C).
  const { urls: signedImageUrls } = useSignedItemImages(grails.map((g) => g.item.primary_image_id));
  // A create form, not a scrollable browsing list — no scroll-hide effect,
  // but still resets the shared navbar to visible on focus.
  useScrollResponsiveNavbar({ enabled: false });

  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);

  const canPost = !loading && grails.length > 0 && !posting;

  // No back history when this screen was deep-linked, reloaded directly, or
  // opened during development — fall back to the main feed, where the Create
  // menu that opens this screen always lives and where the new post appears.
  function leaveScreen() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  async function handlePost() {
    if (!canPost || !currentUserId) return;
    setPosting(true);

    // All-or-nothing (Phase 3E) — every showcased card's image is copied
    // into share-snapshots and the post + rate_my_grail_cards rows are
    // created together, server-side, as one unit. Either the whole post
    // exists with every card already durable, or nothing was created at
    // all — never a partially-imaged post, never a raw item-images URL.
    // See create-snapshot-post's own module comment for the full
    // invariant. Showcase order (grails' own order) is preserved via
    // item_ids' array order, which the Edge Function uses directly as
    // display_order.
    const result = await createSnapshotPost(
      'rate_my_grails',
      grails.map((g) => g.item_id),
      caption.trim() || null,
    );

    if (result.status !== 'ok') {
      Alert.alert('Post failed', 'Could not prepare your Grails’ images. Please try again.');
      setPosting(false);
      return;
    }

    leaveScreen();
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Rate My Grails',
          headerLeft: () => (
            <TouchableOpacity onPress={leaveScreen} hitSlop={8}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity onPress={handlePost} disabled={!canPost} hitSlop={8}>
              {posting ? (
                <ActivityIndicator size="small" color={PV2.link} />
              ) : (
                <Text style={[styles.headerPost, !canPost && styles.headerPostDisabled]}>
                  Post
                </Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PV2.link} />
        </View>
      ) : grails.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No Grails yet</Text>
          <Text style={styles.emptyBody}>
            Add items to your profile&apos;s Grails Showcase before sharing a Rate My Grails post.
          </Text>
          <TouchableOpacity
            style={styles.emptyButton}
            onPress={() => router.push('/(tabs)/profile')}>
            <Text style={styles.emptyButtonText}>Go to Profile</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={styles.scroll}>
            <Text style={styles.sectionLabel}>This is what will be shared</Text>
            <View style={styles.grid}>
              {grails.map((g) => (
                <GrailsSlot key={g.id} item={g} signedImageUrls={signedImageUrls} />
              ))}
            </View>

            <TextInput
              style={styles.input}
              placeholder="Add a caption (optional)"
              placeholderTextColor={PV2.textTertiary}
              multiline
              value={caption}
              onChangeText={setCaption}
              maxLength={MAX_CHARS}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>{caption.length}/{MAX_CHARS}</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.link,
  },
  headerPostDisabled: {
    color: PV2.textTertiary,
  },
  container: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  scroll: {
    padding: 16,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: PV2.textSecondary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  input: {
    fontSize: 16,
    color: PV2.textPrimary,
    minHeight: 80,
    borderWidth: 1,
    borderColor: PV2.border,
    borderRadius: 10,
    padding: 12,
  },
  counter: {
    fontSize: 13,
    color: PV2.textTertiary,
    textAlign: 'right',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: PV2.textPrimary,
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: PV2.accent,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

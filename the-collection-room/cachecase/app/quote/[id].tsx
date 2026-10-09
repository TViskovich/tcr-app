import { useEffect, useRef, useState } from 'react';
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

import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FEED_POST_SELECT, hydrateFeedPosts, PostCard, type FeedPost } from '@/components/feed/post-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAuth } from '@/lib/auth';
import { invalidateOwnProfileCache } from '@/lib/own-profile-cache';
import { createQuotePost, QUOTE_MAX_LENGTH } from '@/lib/posts';
import { supabase } from '@/lib/supabase';

// Quote composer — "Quote" in the Repost / Quote menu (components/feed/
// repost-menu.tsx). Shows the post being quoted exactly as it will appear
// embedded (the real PostCard, embedded mode), and publishes the user's
// comment as a new 'quote' post referencing it (createQuotePost). Cancel
// publishes nothing. Same modal presentation and Cancel · title · Post
// header as the reply composer (app/post-reply/[id].tsx).
//
// :id may be a repost — the composer then quotes (and previews) its
// ORIGINAL, matching what the server does for a quote of a repost.
export default function QuoteComposerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [quoted, setQuoted] = useState<FeedPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous double-submit guard (state updates are async).
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: row, error } = await supabase
          .from('posts')
          .select(FEED_POST_SELECT)
          .eq('id', id)
          .abortSignal(controller.signal)
          .maybeSingle();
        if (controller.signal.aborted) return;
        if (error) throw error;
        if (!row) {
          setLoadError('This post is no longer available.');
          return;
        }
        // Same hydration as the feed. A repost hydrates with its original
        // attached — the original is what gets quoted.
        const [post] = await hydrateFeedPosts([row as never], controller.signal, currentUserId);
        if (controller.signal.aborted) return;
        const target = post?.repostOf ?? post;
        if (!target) {
          setLoadError('This post is no longer available.');
          return;
        }
        setQuoted(target);
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error('[QuoteComposer] load failed:', e);
        setLoadError('Something went wrong. Please try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, currentUserId]);

  const trimmed = comment.trim();
  const canSubmit = !!quoted && !!currentUserId && trimmed.length > 0 && trimmed.length <= QUOTE_MAX_LENGTH && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !quoted || !currentUserId || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const result = await createQuotePost(currentUserId, quoted.id, trimmed);
    if (result.status !== 'ok') {
      submittingRef.current = false;
      setSubmitting(false);
      Alert.alert(
        'Couldn’t post quote',
        result.reason === 'not_found' ? 'This post is no longer available.' : 'Please try again.',
      );
      return;
    }
    // The new quote shows on the user's own Profile Posts tab.
    invalidateOwnProfileCache(currentUserId);
    router.back();
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={styles.headerSideBtn}>
            <Text style={styles.headerCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Quote</Text>
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!canSubmit}
            hitSlop={8}
            style={[styles.headerSideBtn, styles.headerSideBtnRight]}>
            {submitting ? (
              <ActivityIndicator size="small" color={PV2.accent} />
            ) : (
              <Text style={[styles.headerPost, !canSubmit && styles.headerPostDisabled]}>Post</Text>
            )}
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centerWrap}>
            <ActivityIndicator size="large" color={PV2.accent} />
          </View>
        ) : loadError || !quoted ? (
          <View style={styles.centerWrap}>
            <Text style={styles.errorText}>{loadError ?? 'This post is no longer available.'}</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            contentContainerStyle={styles.scrollContent}>
            <TextInput
              style={styles.input}
              value={comment}
              onChangeText={setComment}
              placeholder="Add a comment"
              placeholderTextColor={PV2.textTertiary}
              multiline
              autoFocus
              editable={!submitting}
              maxLength={QUOTE_MAX_LENGTH}
              textAlignVertical="top"
            />
            <Text style={styles.counter}>
              {comment.length}/{QUOTE_MAX_LENGTH}
            </Text>

            {/* Exactly how it will appear embedded in the quote. */}
            <View pointerEvents="none">
              <PostCard
                post={quoted}
                embedded
                currentUserId={currentUserId}
                onUserPress={noop}
                onPostPress={noop}
                onCommentPress={noop}
                onLike={noop}
              />
            </View>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function noop() {}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PV2.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  headerSideBtn: {
    minWidth: 60,
    height: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  headerSideBtnRight: {
    alignItems: 'flex-end',
  },
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  headerPost: {
    fontSize: 16,
    fontWeight: '700',
    color: PV2.accent,
  },
  headerPostDisabled: {
    color: PV2.textTertiary,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  errorText: {
    fontSize: 15,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 8,
  },
  input: {
    fontSize: 16,
    lineHeight: 21,
    color: PV2.textPrimary,
    minHeight: 60,
    maxHeight: 220,
  },
  counter: {
    alignSelf: 'flex-end',
    fontSize: 12,
    color: PV2.textTertiary,
    marginBottom: 8,
  },
});

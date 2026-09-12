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

import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchPostImages } from '@/components/feed/post-card';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { PostImage } from '@/types';

// Matches app/post/[id].tsx's own comments.body limit (its TextInput's
// maxLength={500}) — same field, same constraint, just entered here now.
const MAX_REPLY_LENGTH = 500;

// Normalized shape every post_type resolves into — see
// resolvePostPreviewContent below for the only place that's aware of
// post_type at all. Nothing that consumes this (ReplyContextPreview, the
// JSX below it) knows or cares whether the source was text/item/card_share/
// rate_my_grails; it only ever sees these six fields.
type ReplyPostPreview = {
  authorName: string;
  username: string;
  avatarUrl: string | null;
  timestamp: string;
  text: string | null;
  previewImageUrl: string | null;
  additionalImageCount: number;
};

type ReplyTarget = ReplyPostPreview & {
  id: string;
  user_id: string;
};

type SnapshotRow = { snapshot_image_url: string | null; snapshot_title: string | null };

// The ONE place post_type-specific logic lives — a pure function, no
// fetching, no JSX. Every branch returns exactly the same three fields;
// GrailsPostBody/CardSharePostBody are full interactive components meant
// for the feed/detail screen, not a compact reply-context preview —
// duplicating their layout here would be exactly the "entire heavy feed
// card" this screen is meant to avoid, so this only ever resolves one
// representative (text, image, extra-count) triple per post.
function resolvePostPreviewContent(
  postType: string | null,
  post: { content: string | null; caption: string | null; image_url: string | null },
  cardShareFirst: SnapshotRow | undefined,
  grailFirst: SnapshotRow | undefined,
  textImages: PostImage[],
): { text: string | null; previewImageUrl: string | null; additionalImageCount: number } {
  if (postType === 'text') {
    // 1. post_images (already ordered by sort_order by fetchPostImages) —
    //    the current, multi-image (1-4) attachment path every text post
    //    created through this app's actual composer goes through.
    // 2. Only when that's genuinely empty, fall back to the legacy
    //    single-image posts.image_url column — a text post created before
    //    the post_images feature existed (see fetchPostImages's own doc
    //    comment: "A 'text' post created before this feature existed
    //    simply has zero rows here"). additionalImageCount is always 0 on
    //    this path: a legacy post never has more than the one image.
    // 3. Neither present → no thumbnail (both branches already fall
    //    through to null naturally).
    if (textImages.length > 0) {
      return {
        text: post.content ?? null,
        previewImageUrl: textImages[0].image_url,
        additionalImageCount: textImages.length - 1,
      };
    }
    return {
      text: post.content ?? null,
      previewImageUrl: post.image_url ?? null,
      additionalImageCount: 0,
    };
  }

  if (postType === 'card_share') {
    const previewImageUrl = cardShareFirst?.snapshot_image_url ?? null;
    return {
      text: post.caption ?? (previewImageUrl ? null : 'Shared cards'),
      previewImageUrl,
      additionalImageCount: 0,
    };
  }

  if (postType === 'rate_my_grails') {
    const previewImageUrl = grailFirst?.snapshot_image_url ?? null;
    return {
      text: post.caption ?? (previewImageUrl ? null : 'Rate My Grails'),
      previewImageUrl,
      additionalImageCount: 0,
    };
  }

  // 'item' and any future/unrecognized post_type — "any other post type
  // with media" resolves the same generic way, from the post's own
  // top-level caption + image_url. Not an item-specific special case.
  return {
    text: post.caption ?? null,
    previewImageUrl: post.image_url ?? null,
    additionalImageCount: 0,
  };
}

type MyProfile = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// One small avatar-with-initials-fallback renderer — this app has no shared
// Avatar component (app/post/[id].tsx, app/item/[id].tsx, and post-card.tsx
// each already reimplement this same pattern inline), so this follows that
// existing convention rather than introducing a new shared abstraction for
// just this screen.
function Avatar({ uri, name, size }: { uri: string | null; name: string; size: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
          <Text style={[styles.avatarInitial, { fontSize: size * 0.4 }]}>{name.charAt(0).toUpperCase()}</Text>
        </View>
      )}
    </View>
  );
}

// One shared layout for every post_type — takes only the normalized
// ReplyPostPreview shape, never post_type itself. The thumbnail's right-hand
// position is a structural guarantee, not a coincidence of content: the
// text slot (contextTextSlot, flex:1) is ALWAYS rendered, even with no
// text, so the fixed-width thumbnail after it is always pushed to the
// row's trailing edge by that flex sibling. Previously the text Text node
// was only rendered when text existed, so a post with an image but no text
// (common for card_share/rate_my_grails, whose caption — if any — lives on
// GrailsPostBody's own prop, not posts.caption) left the thumbnail as the
// row's only child, collapsing to the row's leading edge under the row's
// default justifyContent: 'flex-start' instead. That's what this fixes.
function ReplyContextPreview({ preview }: { preview: ReplyPostPreview }) {
  return (
    <View style={styles.threadRow}>
      <View style={styles.avatarColumn}>
        <Avatar uri={preview.avatarUrl} name={preview.authorName} size={44} />
        <View style={styles.connector} />
      </View>
      <View style={styles.contextContent}>
        <View style={styles.contextMetaRow}>
          <Text style={styles.contextName} numberOfLines={1}>
            {preview.authorName}
          </Text>
          <Text style={styles.contextUsername} numberOfLines={1}>
            @{preview.username}
          </Text>
          <Text style={styles.contextDot}>·</Text>
          <Text style={styles.contextAge}>{formatAge(preview.timestamp)}</Text>
        </View>

        {(preview.text || preview.previewImageUrl) && (
          <View style={styles.contextBodyRow}>
            <View style={styles.contextTextSlot}>
              {preview.text && (
                <Text style={styles.contextText} numberOfLines={4}>
                  {preview.text}
                </Text>
              )}
            </View>
            {preview.previewImageUrl && (
              <View style={styles.contextImageWrap}>
                <Image
                  source={{ uri: preview.previewImageUrl }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={150}
                />
                {preview.additionalImageCount > 0 && (
                  <View style={styles.contextImageBadge}>
                    <Text style={styles.contextImageBadgeText}>+{preview.additionalImageCount}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

export default function PostReplyScreen() {
  const { id: postId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;

  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const [myProfile, setMyProfile] = useState<MyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!postId) return;
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: row, error: postError } = await supabase
          .from('posts')
          .select('id, user_id, post_type, image_url, content, caption, created_at')
          .eq('id', postId)
          .abortSignal(controller.signal)
          .single();
        if (controller.signal.aborted) return;

        if (postError || !row) {
          throw new Error(postError?.message ?? 'This post could not be found.');
        }

        const profileIds = [...new Set([row.user_id, currentUserId].filter((v): v is string => !!v))];
        const isCardShare = row.post_type === 'card_share';
        const isRateMyGrails = row.post_type === 'rate_my_grails';
        const isText = row.post_type === 'text';

        const [profilesRes, cardShareRes, grailRes, postImagesMap] = await Promise.all([
          supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', profileIds).abortSignal(controller.signal),
          isCardShare
            ? supabase
                .from('card_share_items')
                .select('snapshot_image_url, snapshot_title')
                .eq('post_id', row.id)
                .order('display_order', { ascending: true })
                .limit(1)
                .abortSignal(controller.signal)
            : Promise.resolve({ data: [] as { snapshot_image_url: string | null; snapshot_title: string | null }[] }),
          isRateMyGrails
            ? supabase
                .from('rate_my_grail_cards')
                .select('snapshot_image_url, snapshot_title')
                .eq('post_id', row.id)
                .order('display_order', { ascending: true })
                .limit(1)
                .abortSignal(controller.signal)
            : Promise.resolve({ data: [] as { snapshot_image_url: string | null; snapshot_title: string | null }[] }),
          isText ? fetchPostImages([row.id], controller.signal) : Promise.resolve(new Map()),
        ]);
        if (controller.signal.aborted) return;

        const profileById = new Map((profilesRes.data ?? []).map((p) => [p.id, p]));
        const authorProfile = profileById.get(row.user_id);
        const myProfileRow = currentUserId ? profileById.get(currentUserId) : undefined;

        // The one call site for the one place post_type-specific logic
        // lives — see resolvePostPreviewContent's own comment. Everything
        // from here down (setTarget, ReplyContextPreview) only ever sees
        // the normalized { text, previewImageUrl, additionalImageCount }
        // triple it returns, never row.post_type itself.
        const { text, previewImageUrl, additionalImageCount } = resolvePostPreviewContent(
          row.post_type,
          { content: row.content ?? null, caption: row.caption ?? null, image_url: row.image_url ?? null },
          cardShareRes.data?.[0],
          grailRes.data?.[0],
          postImagesMap.get(row.id) ?? [],
        );

        setTarget({
          id: row.id,
          user_id: row.user_id,
          timestamp: row.created_at,
          username: authorProfile?.username ?? 'user',
          authorName: authorProfile?.display_name || authorProfile?.username || 'User',
          avatarUrl: authorProfile?.avatar_url ?? null,
          text,
          previewImageUrl,
          additionalImageCount,
        });
        setMyProfile(
          myProfileRow
            ? {
                username: myProfileRow.username,
                displayName: myProfileRow.display_name || myProfileRow.username,
                avatarUrl: myProfileRow.avatar_url ?? null,
              }
            : null,
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error('[PostReply] load failed:', e);
        setLoadError(e instanceof Error ? e.message : 'Something went wrong.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [postId, currentUserId]);

  const trimmed = body.trim();
  const hasUnsavedText = trimmed.length > 0;

  // Guards every dismissal path uniformly — Cancel button, hardware back,
  // AND the modal's own swipe-to-dismiss gesture all funnel through
  // React Navigation's beforeRemove event, so there's exactly one place
  // that decides whether unsaved text needs a confirmation, not three.
  // Not fired by a successful submit's own router.back() below, since that
  // call is preceded by clearing `body` first (see handleSubmit).
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (!hasUnsavedText) return;
      e.preventDefault();
      Alert.alert('Discard reply?', 'Your reply hasn’t been posted yet.', [
        { text: 'Keep Editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => navigation.dispatch(e.data.action),
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, hasUnsavedText]);

  async function handleSubmit() {
    if (!currentUserId || !trimmed || !target || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { data: inserted, error } = await supabase
        .from('comments')
        .insert({ user_id: currentUserId, post_id: target.id, body: trimmed })
        .select('id')
        .single();

      if (error || !inserted) {
        throw new Error(error?.message ?? 'Could not post your reply. Please try again.');
      }

      if (target.user_id !== currentUserId) {
        // Same fire-and-forget, server-verified notification RPC as the
        // previous inline composer in app/post/[id].tsx — unchanged.
        supabase.rpc('create_comment_notification', { p_post_id: target.id, p_comment_id: inserted.id }).then(({ error: e }) => {
          if (e) console.error('[PostReply] comment notification failed:', e.message);
        });
      }

      // Cleared before navigating back so the beforeRemove guard above
      // (which only fires on hasUnsavedText) never intercepts this,
      // deliberate, already-confirmed dismissal.
      setBody('');
      router.back();
    } catch (e) {
      // Composer stays open, typed text is untouched (body is never
      // cleared on this path) — the user can retry without retyping.
      Alert.alert('Reply failed', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const canSubmit = !!currentUserId && hasUnsavedText && !submitting && !loading && !!target;

  return (
    <>
      {/* headerShown: false for this route is set statically in
          app/_layout.tsx's own Stack.Screen registration, not here — this
          screen renders its own custom Cancel/Reply/Post header below, and
          the native header must never be toggled at runtime for a modal
          (React Navigation remounts the whole modal content to switch
          header configurations, discarding local draft state). No inline
          Stack.Screen options are needed for this route at all. */}
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8} style={styles.headerSideBtn}>
              <Text style={styles.headerCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Reply</Text>
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
          ) : loadError || !target ? (
            <View style={styles.centerWrap}>
              <Text style={styles.errorText}>{loadError ?? 'This post could not be found.'}</Text>
            </View>
          ) : (
            <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
              {/* Original post context — ONE shared layout for every
                  post_type, see ReplyContextPreview's own comment. This is
                  the one piece of the interaction model borrowed from the
                  reference screenshot — a lightweight relationship cue
                  (avatar column + connecting line) between original post
                  and reply, not its icons, spacing, or color. */}
              <ReplyContextPreview preview={target} />

              {/* Reply context label — plain except for the accent-colored
                  @username, per the "do not over-style this" direction. */}
              <Text style={styles.replyingToLabel}>
                Replying to <Text style={styles.replyingToUsername}>@{target.username}</Text>
              </Text>

              {/* Composer — current user's avatar + the actual input. No
                  media/GIF/poll/location controls: comments have no media
                  column today (confirmed against the comments table this
                  reuses unchanged), so Phase 1 stays text-only by design,
                  not by omission. */}
              <View style={styles.composerRow}>
                <Avatar uri={myProfile?.avatarUrl ?? null} name={myProfile?.displayName ?? 'You'} size={40} />
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  value={body}
                  onChangeText={setBody}
                  placeholder="Post your reply"
                  placeholderTextColor={PV2.textTertiary}
                  multiline
                  autoFocus
                  editable={!submitting}
                  maxLength={MAX_REPLY_LENGTH}
                />
              </View>
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
}

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
  // Full 44pt-tall hit targets on both sides, not just the text glyph —
  // matches this app's own "~44pt touch target" convention elsewhere
  // (app/item/[id].tsx's HEADER_ROW_HEIGHT-based header slots).
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
  },
  avatar: {
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  threadRow: {
    flexDirection: 'row',
    gap: 12,
  },
  avatarColumn: {
    alignItems: 'center',
    width: 44,
  },
  // The one "relationship cue" the reference is borrowed for — a plain
  // thin vertical rule between the two avatars, no gradient/taper/exact
  // geometry matched to the reference. flex:1 so it stretches to fill
  // whatever height the context content next to it ends up needing,
  // rather than a fixed guessed height.
  connector: {
    flex: 1,
    width: 2,
    marginTop: 6,
    minHeight: 24,
    borderRadius: 1,
    backgroundColor: PV2.border,
  },
  contextContent: {
    flex: 1,
    paddingBottom: 16,
  },
  contextMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
  },
  contextName: {
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  contextUsername: {
    fontSize: 14,
    color: PV2.textTertiary,
  },
  contextDot: {
    fontSize: 14,
    color: PV2.textTertiary,
  },
  contextAge: {
    fontSize: 14,
    color: PV2.textTertiary,
  },
  contextBodyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 4,
  },
  // Always rendered (even with no text inside it) — see
  // ReplyContextPreview's own comment for why this flex:1 wrapper, not the
  // Text node itself, is what has to be unconditional: it's the sibling
  // that pushes contextImageWrap to the row's trailing edge, and an
  // image-only post (no text) needs that push just as much as a post with
  // both.
  contextTextSlot: {
    flex: 1,
  },
  contextText: {
    fontSize: 15,
    lineHeight: 20,
    color: PV2.textPrimary,
  },
  contextImageWrap: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
  },
  contextImageBadge: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contextImageBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  replyingToLabel: {
    fontSize: 14,
    color: PV2.textTertiary,
    marginBottom: 12,
    // Aligns with contextContent's own left edge (avatarColumn width + gap)
    // rather than the screen edge, keeping it visually part of the same
    // column as the reply composer below it.
    marginLeft: 56,
  },
  replyingToUsername: {
    color: PV2.accent,
    fontWeight: '600',
  },
  composerRow: {
    flexDirection: 'row',
    gap: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    color: PV2.textPrimary,
    paddingTop: 8,
    minHeight: 40,
    maxHeight: 220,
  },
});

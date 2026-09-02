import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { Image } from 'expo-image';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useFolderComments, type FolderComment } from '@/hooks/use-folder-comments';

// Dragging the sheet down past this many px, or flicking it down fast
// enough, dismisses it — otherwise it snaps back to resting position.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
const SHEET_HEIGHT_RATIO = 0.72;

// Standard decelerate-to-a-stop timing curve — no overshoot/bounce, unlike
// the withSpring configs this replaced. Used both for the open animation
// and for the pan gesture's "snap back to resting position" (a partial
// drag that didn't cross DISMISS_DISTANCE) — the same "settle at open
// position" motion either way, so both should feel identical.
const SHEET_OPEN_DURATION = 280;
const SHEET_OPEN_EASING = Easing.out(Easing.cubic);

function formatAge(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function CommentRow({
  comment,
  isOwn,
  onDelete,
}: {
  comment: FolderComment;
  isOwn: boolean;
  onDelete: (id: string) => void;
}) {
  const displayName = comment.display_name || comment.username;
  return (
    <View style={styles.commentRow}>
      <View style={styles.avatar}>
        {comment.avatar_url ? (
          <Image source={{ uri: comment.avatar_url }} style={StyleSheet.absoluteFillObject} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, styles.avatarPlaceholder]}>
            <Text style={styles.avatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.commentBody}>
        <View style={styles.commentMeta}>
          <Text style={styles.commentUsername}>{displayName}</Text>
          <Text style={styles.commentAge}>{formatAge(comment.created_at)}</Text>
        </View>
        <Text style={styles.commentText}>{comment.body}</Text>
      </View>
      {isOwn && (
        <TouchableOpacity onPress={() => onDelete(comment.id)} hitSlop={8} style={styles.deleteBtn}>
          <Text style={styles.deleteText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

type Props = {
  visible: boolean;
  onClose: () => void;
  folderId: string | undefined;
  folderTitle: string;
  currentUserId: string | undefined;
};

// Bottom sheet for discussing one specific folder's cards — opened from the
// chat-bubble icon in app/collection/[folderId].tsx's header. Slides up
// from the bottom on open; a downward swipe (or tapping the backdrop)
// slides it back down and dismisses it. Kept mounted through the close
// animation (parent's `visible` flips to false only once the slide-down
// finishes) so the dismissal is never an abrupt cut.
export function FolderCommentsSheet({ visible, onClose, folderId, folderTitle, currentUserId }: Props) {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetHeight = screenHeight * SHEET_HEIGHT_RATIO;
  const translateY = useSharedValue(sheetHeight);
  const keyboardHeight = useSharedValue(0);
  const [mounted, setMounted] = useState(false);
  const [draft, setDraft] = useState('');

  const { comments, loading, sending, addComment, deleteComment } = useFolderComments(
    mounted ? folderId : undefined,
    currentUserId,
  );

  // Manual keyboard tracking instead of KeyboardAvoidingView — this sheet
  // lives inside a transparent Modal and is positioned via an animated
  // translateY, both of which make KeyboardAvoidingView's automatic on-
  // screen measurement unreliable (a well-known RN/Modal gotcha). Driving
  // the input bar's own bottom padding directly is deterministic on both
  // platforms instead.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      keyboardHeight.value = withTiming(e.endCoordinates.height, {
        duration: Platform.OS === 'ios' ? e.duration || 250 : 200,
      });
    });
    const hideSub = Keyboard.addListener(hideEvent, (e) => {
      keyboardHeight.value = withTiming(0, {
        duration: Platform.OS === 'ios' ? e.duration || 250 : 200,
      });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardHeight]);

  const inputBarStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insets.bottom, 10) + keyboardHeight.value,
  }));

  function handleClosed() {
    setMounted(false);
    onClose();
  }

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = withTiming(0, { duration: SHEET_OPEN_DURATION, easing: SHEET_OPEN_EASING });
    } else {
      translateY.value = withTiming(sheetHeight, { duration: 220 }, (finished) => {
        if (finished) runOnJS(handleClosed)();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function dismiss() {
    translateY.value = withTiming(sheetHeight, { duration: 220 }, (finished) => {
      if (finished) runOnJS(handleClosed)();
    });
  }

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(dismiss)();
      } else {
        translateY.value = withTiming(0, { duration: SHEET_OPEN_DURATION, easing: SHEET_OPEN_EASING });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, translateY.value / sheetHeight),
  }));

  async function handleSend() {
    if (!draft.trim()) return;
    const body = draft;
    setDraft('');
    const ok = await addComment(body);
    if (!ok) {
      setDraft(body);
      Alert.alert('Comment failed', 'Please check your connection and try again.');
    }
  }

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <GestureHandlerRootView style={styles.fill}>
        <View style={styles.fill}>
          <Animated.View style={[StyleSheet.absoluteFillObject, styles.backdrop, backdropStyle]}>
            <Pressable style={StyleSheet.absoluteFillObject} onPress={dismiss} />
          </Animated.View>

          <GestureDetector gesture={pan}>
            <Animated.View style={[styles.sheet, { height: sheetHeight }, sheetStyle]}>
              <View style={styles.handle} />

              <View style={styles.header}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {folderTitle} — Comments
                </Text>
                <Pressable onPress={dismiss} hitSlop={10}>
                  <IconSymbol name="chevron.left" size={20} color={PV2.textSecondary} style={styles.closeIcon} />
                </Pressable>
              </View>

              <View style={styles.fill}>
                {loading ? (
                  <View style={styles.center}>
                    <ActivityIndicator size="large" color={PV2.accent} />
                  </View>
                ) : (
                  <FlatList
                    data={comments}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                      <CommentRow comment={item} isOwn={item.user_id === currentUserId} onDelete={deleteComment} />
                    )}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                      <View style={styles.emptyWrap}>
                        <Text style={styles.emptyText}>No comments yet. Be the first!</Text>
                      </View>
                    }
                  />
                )}

                <Animated.View style={[styles.inputBar, inputBarStyle]}>
                  <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Add a comment..."
                    placeholderTextColor={PV2.textTertiary}
                    returnKeyType="send"
                    onSubmitEditing={handleSend}
                    blurOnSubmit={false}
                    editable={!sending}
                    maxLength={500}
                  />
                  <TouchableOpacity onPress={handleSend} disabled={!draft.trim() || sending} style={styles.sendBtn}>
                    {sending ? (
                      <ActivityIndicator size="small" color={PV2.accent} />
                    ) : (
                      <Text style={[styles.sendText, !draft.trim() && styles.sendTextDisabled]}>Post</Text>
                    )}
                  </TouchableOpacity>
                </Animated.View>
              </View>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: PV2.panel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: PV2.panelBorder,
    overflow: 'hidden',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PV2.dividerColor,
  },
  headerTitle: {
    flex: 1,
    marginRight: 12,
    fontSize: 15,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  // Reuses the chevron-left glyph rotated to point down, rather than adding
  // a new icon mapping just for this close affordance.
  closeIcon: {
    transform: [{ rotate: '-90deg' }],
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    flexGrow: 1,
    paddingVertical: 8,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: PV2.textSecondary,
  },
  commentRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: PV2.emptyCardBg,
    flexShrink: 0,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  commentBody: {
    flex: 1,
    gap: 3,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentUsername: {
    fontSize: 13,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  commentAge: {
    fontSize: 11,
    color: PV2.textTertiary,
  },
  commentText: {
    fontSize: 14,
    color: PV2.textSecondary,
    lineHeight: 20,
  },
  deleteBtn: {
    paddingLeft: 8,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  deleteText: {
    fontSize: 13,
    color: PV2.textTertiary,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PV2.dividerColor,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: PV2.textPrimary,
    backgroundColor: PV2.emptyCardBg,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxHeight: 100,
  },
  sendBtn: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    minWidth: 44,
    alignItems: 'center',
  },
  sendText: {
    fontSize: 15,
    fontWeight: '600',
    color: PV2.accent,
  },
  sendTextDisabled: {
    color: PV2.textTertiary,
  },
});

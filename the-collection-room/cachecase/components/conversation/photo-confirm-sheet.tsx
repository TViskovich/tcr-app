import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';
import type { PreparedDmImage } from '@/lib/dm-images';

type SendOutcome = 'sent' | 'failed' | 'not_shareable' | 'pending' | 'skipped';

export type PhotoSource = 'camera' | 'library';

// Driven by the conversation screen — the native picker/camera runs there,
// this sheet only shows what came back.
export type PhotoFlowState =
  | { status: 'preparing'; source: PhotoSource }
  | { status: 'ready'; source: PhotoSource; image: PreparedDmImage }
  | { status: 'prepare_failed'; source: PhotoSource }
  | { status: 'camera_denied' };

type Props = {
  state: PhotoFlowState | null;
  onClose: () => void;
  onChooseAnother: (source: PhotoSource) => void;
  recipientUsername: string | null;
  draft: string;
  // Upload + insert through the conversation's shared send path. The
  // message id is owned here and reused across retries of this photo.
  onSend: (image: PreparedDmImage, messageId: string) => Promise<SendOutcome>;
};

// Shared confirmation for Camera and Photos: large preview, "Send to @x",
// the composer draft (sent as the message body), Send Photo / Choose
// Another / Cancel. Also hosts the camera-permission-denied and
// preparation-failure states so neither falls back to a generic Alert.
// Same mid-send dismissal guard as the Share Item picker.
export function PhotoConfirmSheet(props: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestClose = () => {
    if (!busyRef.current) props.onClose();
  };
  return (
    <Modal
      visible={!!props.state}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!busy}
      onRequestClose={requestClose}>
      {props.state ? (
        <SheetBody
          {...props}
          state={props.state}
          onBusyChange={(next) => {
            busyRef.current = next;
            setBusy(next);
          }}
        />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  state,
  onClose,
  onChooseAnother,
  recipientUsername,
  draft,
  onSend,
  onBusyChange,
}: Props & { state: PhotoFlowState; onBusyChange: (busy: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // One logical send per prepared image: the id (and so the deterministic
  // storage path) is minted once per image and reused by every retry.
  const messageIdRef = useRef<{ uri: string; id: string } | null>(null);

  async function handleSend(image: PreparedDmImage) {
    if (sendingRef.current) return;
    if (!messageIdRef.current || messageIdRef.current.uri !== image.uri) {
      messageIdRef.current = { uri: image.uri, id: Crypto.randomUUID() };
    }
    sendingRef.current = true;
    setSending(true);
    onBusyChange(true);
    setSendError(null);
    const outcome = await onSend(image, messageIdRef.current.id);
    sendingRef.current = false;
    setSending(false);
    onBusyChange(false);
    if (outcome === 'sent' || outcome === 'pending') {
      onClose();
      return;
    }
    if (outcome === 'failed') setSendError('Couldn’t send. Check your connection and try again.');
  }

  const header = (title: string) => (
    <View style={styles.header}>
      <Pressable
        onPress={onClose}
        disabled={sending}
        hitSlop={10}
        accessibilityRole="button"
        style={styles.headerSide}>
        <Text style={[styles.headerCancel, sending && styles.disabledText]}>Cancel</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSide} />
    </View>
  );

  if (state.status === 'camera_denied') {
    return (
      <View style={styles.screen}>
        {header('Camera')}
        <View style={styles.notice}>
          <View style={styles.noticeIcon}>
            <IconSymbol name="camera" size={24} color={PV2.textSecondary} />
          </View>
          <Text style={styles.noticeTitle}>Camera access is off</Text>
          <Text style={styles.noticeBody}>
            Allow CacheCase to use your camera in Settings to take photos for your messages.
          </Text>
          <Pressable
            onPress={() => Linking.openSettings()}
            style={({ pressed }) => [styles.primaryBtn, styles.noticeBtn, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.primaryText}>Open Settings</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (state.status === 'preparing') {
    return (
      <View style={styles.screen}>
        {header('Send Photo')}
        <View style={styles.notice}>
          <ActivityIndicator color={PV2.textSecondary} />
          <Text style={styles.noticeBody}>Preparing photo…</Text>
        </View>
      </View>
    );
  }

  if (state.status === 'prepare_failed') {
    return (
      <View style={styles.screen}>
        {header('Send Photo')}
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Couldn’t use that photo</Text>
          <Text style={styles.noticeBody}>Try a different one.</Text>
          <Pressable
            onPress={() => onChooseAnother(state.source)}
            style={({ pressed }) => [styles.neutralBtn, styles.noticeBtn, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.neutralText}>Choose Another</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { image, source } = state;
  const previewMaxW = screenWidth - 40;
  const previewMaxH = screenHeight * 0.48;
  const aspect = image.width / image.height;
  let previewW = previewMaxW;
  let previewH = previewW / aspect;
  if (previewH > previewMaxH) {
    previewH = previewMaxH;
    previewW = previewH * aspect;
  }

  return (
    <View style={styles.screen}>
      {header('Send Photo')}
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}>
        <View style={[styles.preview, { width: previewW, height: previewH }]}>
          <Image source={{ uri: image.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        </View>

        {recipientUsername ? <Text style={styles.recipient}>Send to @{recipientUsername}</Text> : null}
        {draft.trim() ? (
          <Text style={styles.draft} numberOfLines={3}>
            With your message: “{draft.trim()}”
          </Text>
        ) : null}

        {sendError ? (
          <Text style={styles.sendError} accessibilityLiveRegion="polite">
            {sendError}
          </Text>
        ) : null}

        <Pressable
          onPress={() => handleSend(image)}
          disabled={sending}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, sending && styles.busy]}
          accessibilityRole="button"
          accessibilityState={{ busy: sending }}>
          {sending ? (
            <ActivityIndicator color={CHAT.onAccent} />
          ) : (
            <Text style={styles.primaryText}>{sendError ? 'Try Again' : 'Send Photo'}</Text>
          )}
        </Pressable>
        <View style={styles.secondaryRow}>
          <Pressable
            onPress={() => onChooseAnother(source)}
            disabled={sending}
            style={({ pressed }) => [styles.neutralBtn, styles.flex, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.neutralText}>Choose Another</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            disabled={sending}
            style={({ pressed }) => [styles.neutralBtn, styles.flex, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.neutralText}>Cancel</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

// Same palette and button shapes as the Share Item / Send Item sheets.
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
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  headerSide: {
    width: 64,
  },
  headerCancel: {
    fontSize: 16,
    color: PV2.textSecondary,
  },
  disabledText: {
    opacity: 0.4,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    alignItems: 'stretch',
  },
  preview: {
    alignSelf: 'center',
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
  },
  recipient: {
    marginTop: 16,
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  draft: {
    marginTop: 8,
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  sendError: {
    marginTop: 12,
    fontSize: 13,
    color: PV2.textPrimary,
    textAlign: 'center',
  },
  primaryBtn: {
    marginTop: 16,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.accent,
  },
  primaryText: {
    fontSize: 16,
    fontWeight: '700',
    color: CHAT.onAccent,
  },
  busy: {
    opacity: 0.7,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  neutralBtn: {
    marginTop: 10,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: PV2.collectorPanelBg,
  },
  neutralText: {
    fontSize: 16,
    fontWeight: '600',
    color: PV2.textPrimary,
  },
  pressed: {
    opacity: 0.8,
  },
  notice: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  noticeIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PV2.collectorPanelBg,
    borderWidth: 1,
    borderColor: PV2.panelBorder,
    marginBottom: 8,
  },
  noticeTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PV2.textPrimary,
  },
  noticeBody: {
    fontSize: 14,
    color: PV2.textSecondary,
    textAlign: 'center',
  },
  noticeBtn: {
    alignSelf: 'stretch',
  },
});

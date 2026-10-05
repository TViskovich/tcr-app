import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { CHAT } from '@/components/conversation/conversation-theme';
import { PV2 } from '@/components/profile-v2/profile-v2-theme';
import { IconSymbol } from '@/components/ui/icon-symbol';

const CONTROL_SIZE = 44;

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  // Input locked (sending, or an unresolved pending send awaiting Retry).
  locked: boolean;
  bottomPadding: number;
  // Optional — when omitted the paperclip stays a visual-only placeholder.
  onAttachPress?: () => void;
  // Attachment sheet currently open — paperclip shows an accent ring.
  attachActive?: boolean;
  onInputFocus?: () => void;
};

// Presentation-only composer shell — all send semantics (trim, sendId,
// pending-send blocking) stay in app/conversation/[id].tsx's handleSend.
export function ConversationComposer({
  value,
  onChangeText,
  onSend,
  sending,
  locked,
  bottomPadding,
  onAttachPress,
  attachActive,
  onInputFocus,
}: Props) {
  const canSend = value.trim().length > 0 && !locked;

  return (
    <View style={[styles.outer, { paddingBottom: bottomPadding }]}>
      <View style={styles.capsule}>
        {/* Visual placeholder unless onAttachPress is provided — not a
            Pressable in that case so it can't imply a broken action. */}
        {onAttachPress ? (
          <Pressable
            onPress={onAttachPress}
            disabled={locked}
            style={({ pressed }) => [
              styles.attachBtn,
              attachActive && styles.attachBtnActive,
              pressed && styles.sendBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Attach"
            accessibilityState={{ expanded: !!attachActive }}>
            <IconSymbol name="paperclip" size={20} color={PV2.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.attachBtn} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <IconSymbol name="paperclip" size={20} color={PV2.textSecondary} />
          </View>
        )}

        <View style={styles.field}>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={onChangeText}
            placeholder="Message..."
            placeholderTextColor={PV2.textTertiary}
            selectionColor={CHAT.accent}
            returnKeyType="send"
            onSubmitEditing={onSend}
            onFocus={onInputFocus}
            submitBehavior="submit"
            editable={!locked}
            maxLength={1000}
          />
        </View>

        <Pressable
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && !sending && styles.sendBtnDisabled,
            pressed && styles.sendBtnPressed,
          ]}>
          {sending ? (
            <ActivityIndicator size="small" color={CHAT.onAccent} />
          ) : (
            <IconSymbol
              name="paperplane.fill"
              size={19}
              color={canSend ? CHAT.onAccent : PV2.textTertiary}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 7,
    borderRadius: 32,
    backgroundColor: CHAT.glassBg,
    borderWidth: 1,
    borderColor: CHAT.glassBorder,
    borderTopColor: CHAT.accentBorder,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  attachBtn: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.controlBg,
    borderWidth: 1,
    borderColor: CHAT.controlBorder,
  },
  attachBtnActive: {
    borderColor: CHAT.accentBorder,
    backgroundColor: CHAT.accentSoft,
  },
  field: {
    flex: 1,
    minHeight: CONTROL_SIZE,
    justifyContent: 'center',
    borderRadius: CONTROL_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: CHAT.controlBorder,
    paddingHorizontal: 16,
  },
  input: {
    fontSize: 16,
    color: PV2.textPrimary,
    paddingVertical: 10,
  },
  sendBtn: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHAT.accent,
    shadowColor: CHAT.accentGlow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 4,
  },
  sendBtnDisabled: {
    backgroundColor: CHAT.sendDisabledBg,
    shadowOpacity: 0,
    elevation: 0,
  },
  sendBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
});

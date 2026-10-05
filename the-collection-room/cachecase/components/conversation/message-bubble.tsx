import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { ChatAvatar } from '@/components/conversation/chat-avatar';
import { CHAT } from '@/components/conversation/conversation-theme';

const INCOMING_AVATAR_SIZE = 30;
const BUBBLE_RADIUS = 22;
const TAIL_RADIUS = 6;

type Props = {
  // Null for an attachment-only message.
  body: string | null;
  // Rendered under the text bubble (or alone), aligned with the sender's
  // side — e.g. DmItemAttachmentCard. Keeps its own neutral surface.
  attachment?: ReactNode;
  time: string;
  isOwn: boolean;
  // Outgoing only: delivery/read label appended to the timestamp line
  // ("1:31 PM · Read"). Omitted on every bubble but the newest outgoing one.
  status?: string;
  statusRead?: boolean;
  // Incoming only: render the sender avatar beside this bubble (last bubble
  // of a consecutive incoming run). Otherwise an equal-width spacer keeps the
  // run's bubbles aligned.
  showAvatar: boolean;
  // Tighter top spacing when this bubble continues a run from the same sender.
  continuesRun: boolean;
  avatarUrl: string | null | undefined;
  avatarName: string;
};

export const MessageBubble = memo(function MessageBubble({
  body,
  attachment,
  time,
  isOwn,
  status,
  statusRead,
  showAvatar,
  continuesRun,
  avatarUrl,
  avatarName,
}: Props) {
  if (isOwn) {
    return (
      <View style={[styles.row, styles.rowOwn, continuesRun && styles.rowContinued]}>
        <View style={styles.columnOwn}>
          {body ? (
            <View style={styles.ownShadow}>
              <LinearGradient
                colors={CHAT.accentGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.bubble, styles.bubbleOwn]}>
                <Text style={[styles.text, styles.textOwn]}>{body}</Text>
              </LinearGradient>
            </View>
          ) : null}
          {attachment ? <View style={body ? styles.attachmentGap : null}>{attachment}</View> : null}
          <Text style={[styles.time, styles.timeOwn]}>
            {time}
            {status ? (
              <Text style={statusRead ? styles.statusRead : undefined}>{` · ${status}`}</Text>
            ) : null}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, continuesRun && styles.rowContinued]}>
      <View style={styles.avatarSlot}>
        {showAvatar ? <ChatAvatar uri={avatarUrl} name={avatarName} size={INCOMING_AVATAR_SIZE} /> : null}
      </View>
      <View style={styles.columnOther}>
        {body ? (
          <View style={[styles.bubble, styles.bubbleOther]}>
            <Text style={styles.text}>{body}</Text>
          </View>
        ) : null}
        {attachment ? <View style={body ? styles.attachmentGap : null}>{attachment}</View> : null}
        <Text style={styles.time}>{time}</Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 14,
    marginTop: 12,
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  rowContinued: {
    marginTop: 4,
  },
  // Timestamp sits under the bubble, so the avatar bottom-aligns against the
  // bubble itself rather than the timestamp line.
  avatarSlot: {
    width: INCOMING_AVATAR_SIZE,
    marginRight: 8,
    marginBottom: 18,
  },
  columnOwn: {
    maxWidth: '76%',
    alignItems: 'flex-end',
  },
  columnOther: {
    maxWidth: '76%',
    alignItems: 'flex-start',
  },
  attachmentGap: {
    marginTop: 4,
  },
  bubble: {
    borderRadius: BUBBLE_RADIUS,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ownShadow: {
    borderRadius: BUBBLE_RADIUS,
    shadowColor: CHAT.accentGlow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 4,
  },
  bubbleOwn: {
    borderBottomRightRadius: TAIL_RADIUS,
  },
  bubbleOther: {
    backgroundColor: CHAT.incomingBg,
    borderWidth: 1,
    borderColor: CHAT.incomingBorder,
    borderBottomLeftRadius: TAIL_RADIUS,
  },
  text: {
    fontSize: 16,
    lineHeight: 21,
    color: '#fff',
  },
  textOwn: {
    color: CHAT.onAccent,
  },
  time: {
    fontSize: 11,
    color: CHAT.timestamp,
    marginTop: 4,
    marginHorizontal: 6,
    fontVariant: ['tabular-nums'],
  },
  timeOwn: {
    textAlign: 'right',
  },
  statusRead: {
    color: CHAT.statusRead,
  },
});

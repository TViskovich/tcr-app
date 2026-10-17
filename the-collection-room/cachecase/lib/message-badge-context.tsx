import { createContext, useContext } from 'react';

type MessageBadgeContextValue = {
  unreadCount: number;
  // Newest last_message_at among unread conversations, or null (see
  // hooks/use-unread-messages.ts).
  latestUnreadAt: string | null;
  refreshMessageBadge: () => void;
};

export const MessageBadgeContext = createContext<MessageBadgeContextValue>({
  unreadCount: 0,
  latestUnreadAt: null,
  refreshMessageBadge: () => {},
});

// Preserves the pre-existing call signature (`const refreshMessageBadge =
// useMessageBadgeRefresh(); ... refreshMessageBadge();`) used by
// conversation/[id].tsx and messages.tsx, so consolidating onto the shared
// context requires no changes in either file.
export const useMessageBadgeRefresh = () => useContext(MessageBadgeContext).refreshMessageBadge;

export const useMessageBadgeCount = () => useContext(MessageBadgeContext).unreadCount;

export const useLatestUnreadMessageAt = () => useContext(MessageBadgeContext).latestUnreadAt;

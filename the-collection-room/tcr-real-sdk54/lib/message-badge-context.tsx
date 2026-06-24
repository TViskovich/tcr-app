import { createContext, useContext } from 'react';

export const MessageBadgeRefreshContext = createContext<() => void>(() => {});
export const useMessageBadgeRefresh = () => useContext(MessageBadgeRefreshContext);

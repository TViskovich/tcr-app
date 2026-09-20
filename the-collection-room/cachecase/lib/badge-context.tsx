import { createContext, useContext } from 'react';

type BadgeContextValue = { count: number; refresh: () => void };

export const BadgeRefreshContext = createContext<BadgeContextValue>({ count: 0, refresh: () => {} });
export const useBadgeRefresh = () => useContext(BadgeRefreshContext);

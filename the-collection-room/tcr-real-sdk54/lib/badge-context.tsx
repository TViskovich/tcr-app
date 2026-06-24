import { createContext, useContext } from 'react';

export const BadgeRefreshContext = createContext<() => void>(() => {});
export const useBadgeRefresh = () => useContext(BadgeRefreshContext);

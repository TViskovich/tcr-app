import { createContext, useContext, useState, type ReactNode } from 'react';

// The invite code entered on the "You're invited" screen, held in memory
// only for the redeem call on the sign-up screen — never in route params,
// AsyncStorage, or logs. Provided by app/(auth)/_layout.tsx, so it lives as
// long as the (auth) stack; if it's lost, the user re-enters the code. A
// 'valid' check is informational only — the server re-validates and
// consumes the invite atomically at account creation.
export type PendingInvite = {
  code: string;
  name: string | null;
  reservedUsername: string | null;
};

type PendingInviteContextValue = {
  invite: PendingInvite | null;
  setInvite: (invite: PendingInvite | null) => void;
};

const PendingInviteContext = createContext<PendingInviteContextValue>({
  invite: null,
  setInvite: () => {},
});

export function PendingInviteProvider({ children }: { children: ReactNode }) {
  const [invite, setInvite] = useState<PendingInvite | null>(null);
  return (
    <PendingInviteContext.Provider value={{ invite, setInvite }}>{children}</PendingInviteContext.Provider>
  );
}

export const usePendingInvite = () => useContext(PendingInviteContext);

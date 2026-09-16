import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { type Session } from '@supabase/supabase-js';

import {
  FOLDER_COVERS_CACHE_DOMAIN,
  ITEM_IMAGES_CACHE_DOMAIN,
  purgePersistedSignedUrlCache,
} from './persisted-signed-url-cache';
import { supabase } from './supabase';

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // The identity string (session.user.id, or 'anon' with no session) the
  // private-image hooks' persisted signed-URL caches key on
  // (hooks/use-signed-item-images.ts, hooks/use-signed-folder-covers.ts) —
  // `undefined` until the very first session state has actually been
  // observed (from whichever of getSession()/onAuthStateChange's own
  // initial delivery settles first), so that first observation is only
  // ever recorded, never treated as an "outgoing" identity to purge.
  const identityRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Purges both private-image persisted signed-URL caches (Phase 1 of
    // the private-image caching upgrade — see
    // lib/persisted-signed-url-cache.ts) for whichever identity this app
    // was JUST acting as, the moment a DIFFERENT identity takes over:
    // sign-out (session -> null, identity -> 'anon'), sign-in, or a direct
    // account switch all funnel through this one check. Imports the shared
    // cache helper directly (never hooks/use-signed-item-images.ts or
    // hooks/use-signed-folder-covers.ts themselves) — both of those hooks
    // already import useAuth from this file, so importing anything back
    // from them here would create a circular module dependency; see
    // ITEM_IMAGES_CACHE_DOMAIN's own comment in
    // lib/persisted-signed-url-cache.ts for the same reasoning.
    //
    // This is defense-in-depth, not the only thing preventing cross-user
    // exposure: every persisted (and in-memory) entry is already keyed by
    // identity, so a lookup under a NEW identity could never read a
    // different identity's entry even without this. What this adds is
    // bounded storage growth and prompt removal of a departed identity's
    // signed-URL metadata on a shared device, rather than letting it
    // accumulate indefinitely across however many accounts sign in over
    // time.
    function handleIdentityChange(newSession: Session | null) {
      const nextIdentity = newSession?.user?.id ?? 'anon';
      const previousIdentity = identityRef.current;
      identityRef.current = nextIdentity;
      if (previousIdentity === undefined || previousIdentity === nextIdentity) return;
      purgePersistedSignedUrlCache(ITEM_IMAGES_CACHE_DOMAIN, previousIdentity).catch(() => {});
      purgePersistedSignedUrlCache(FOLDER_COVERS_CACHE_DOMAIN, previousIdentity).catch(() => {});
    }

    supabase.auth.getSession().then(({ data }) => {
      handleIdentityChange(data.session);
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      handleIdentityChange(newSession);
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
  }

  return (
    <AuthContext.Provider value={{ session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

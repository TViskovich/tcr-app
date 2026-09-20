import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { supabase } from '@/lib/supabase';

const POLL_INTERVAL_MS = 30000;

export function useUnreadMessages(userId: string | undefined) {
  const [unreadCount, setUnreadCount] = useState(0);

  // Updated synchronously in the render body (not inside a useEffect) so
  // that a query response resolving between render and effect commit still
  // sees the latest identity — closing the render→effect race the caller
  // flagged for this hook once it becomes the single instance mounted for
  // the whole authenticated session.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // Single concurrency authority for this hook's one shared refresh(): no
  // two query flows may be in flight at once, and at most one trailing
  // "run again" request can be coalesced behind the current one.
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    // Captured once per invocation; every check below compares against
    // userIdRef.current (the live identity) rather than this constant, so
    // a response that resolves after a logout/user-switch can detect it
    // belongs to a superseded identity and discard itself instead of
    // committing state for the wrong user.
    const requestUserId = userIdRef.current;

    try {
      if (!requestUserId) {
        setUnreadCount((prev) => (prev === 0 ? prev : 0));
        return;
      }

      const { data: participations, error: participationsError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, last_read_at')
        .eq('user_id', requestUserId)
        // Hidden (swipe-deleted) conversations don't appear in the inbox
        // and the user has no way to open one and clear its last_read_at,
        // so any pre-existing unread state on it must not keep inflating
        // the badge until a new message un-hides it (messages.tsx's own
        // inbox query applies the same filter).
        .is('hidden_at', null);

      if (userIdRef.current !== requestUserId) return;

      if (participationsError) {
        console.error('[useUnreadMessages] participants query failed:', participationsError.message, participationsError);
        return;
      }

      if (!participations?.length) {
        setUnreadCount((prev) => (prev === 0 ? prev : 0));
        return;
      }

      const convIds = (participations as any[]).map((r) => r.conversation_id as string);

      const { data: conversations, error: conversationsError } = await supabase
        .from('conversations')
        .select('id, last_message_at')
        .in('id', convIds);

      if (userIdRef.current !== requestUserId) return;

      if (conversationsError) {
        console.error('[useUnreadMessages] conversations query failed:', conversationsError.message, conversationsError);
        return;
      }

      const lastReadMap = new Map(
        (participations as any[]).map((r) => [r.conversation_id as string, r.last_read_at as string | null]),
      );

      let count = 0;
      for (const conv of (conversations ?? []) as any[]) {
        if (!conv.last_message_at) continue;
        const lastRead = lastReadMap.get(conv.id);
        if (!lastRead || new Date(conv.last_message_at) > new Date(lastRead)) {
          count++;
        }
      }

      setUnreadCount((prev) => (prev === count ? prev : count));
    } catch (e) {
      // Thrown/network failure — never zero a real badge over a transient
      // error; last known-good unreadCount is left untouched and the next
      // poll tick or explicit refresh naturally recovers it.
      console.error('[useUnreadMessages] refresh threw:', e);
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        // No owner id is stored on the pending slot: the trailing call
        // below re-reads userIdRef.current at its own execution time (via
        // the requestUserId capture above), so it always resolves against
        // whichever identity is current *then* — not whichever identity
        // requested the coalesce. That's what makes a bare boolean safe
        // across a user switch (e.g. A in flight, B's request coalesces
        // behind it): A's own result is discarded by the identity check
        // above, and this trailing run executes as B, never as A.
        refresh();
      }
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      // Logout / unauthenticated — reset immediately and never poll.
      setUnreadCount((prev) => (prev === 0 ? prev : 0));
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startInterval() {
      if (intervalId) return;
      intervalId = setInterval(() => { refresh(); }, POLL_INTERVAL_MS);
    }
    function stopInterval() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    // 'active' starts polling outright. A null/undefined initial read
    // (AppState.currentState can be transiently unpopulated on some
    // platforms/dev runtimes at mount) is the one narrow allowance —
    // starting provisionally there avoids a lifecycle that silently never
    // starts polling just because the first read wasn't populated yet.
    // 'inactive' and 'background' are both real, known non-active states
    // and must not start polling.
    const initialState = AppState.currentState;
    if (initialState === 'active' || initialState == null) {
      refresh();
      startInterval();
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refresh();
        startInterval();
      } else {
        // Both 'inactive' and 'background' stop polling — only a real
        // 'active' event may (re)start it.
        stopInterval();
      }
    });

    return () => {
      stopInterval();
      subscription.remove();
    };
  }, [userId, refresh]);

  return { unreadCount, refresh };
}

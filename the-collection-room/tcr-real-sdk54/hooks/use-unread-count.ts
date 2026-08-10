import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export function useUnreadCount(userId: string | undefined) {
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!userId) { setUnreadCount(0); return; }
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('read', false);

      if (error) {
        // A failed count query must never turn a real unread badge into
        // 0 — log it and leave the last known-good `unreadCount` as-is.
        console.error('[useUnreadCount] query failed:', error.message, error);
        return;
      }

      setUnreadCount(count ?? 0);
    } catch (e) {
      // A thrown exception (as opposed to a {count, error}-shaped result) —
      // same reasoning as above, never zeroes the badge.
      console.error('[useUnreadCount] refresh failed:', e);
    }
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { unreadCount, refresh };
}

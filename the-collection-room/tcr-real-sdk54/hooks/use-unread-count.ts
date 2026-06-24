import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export function useUnreadCount(userId: string | undefined) {
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!userId) { setUnreadCount(0); return; }
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    setUnreadCount(count ?? 0);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { unreadCount, refresh };
}

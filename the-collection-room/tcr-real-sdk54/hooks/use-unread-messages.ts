import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export function useUnreadMessages(userId: string | undefined) {
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!userId) { setUnreadCount(0); return; }

    const { data: participations } = await supabase
      .from('conversation_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    if (!participations?.length) { setUnreadCount(0); return; }

    const convIds = (participations as any[]).map((r) => r.conversation_id as string);

    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, last_message_at')
      .in('id', convIds);

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
    setUnreadCount(count);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { unreadCount, refresh };
}

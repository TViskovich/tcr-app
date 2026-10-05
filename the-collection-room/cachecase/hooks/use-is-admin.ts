import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// UI gate only — whether the signed-in user has a row in public.admin_users.
// RLS (admin_users_select_own) lets a user see their OWN row and nothing
// else, so this can't enumerate admins. The server re-checks membership on
// every admin action (supabase/functions/_shared/admin-auth.ts); this hook
// only decides what to render.
//
// null = not known yet (still loading). Any error resolves to false.
export function useIsAdmin(): boolean | null {
  const { session } = useAuth();
  const userId = session?.user?.id;
  // The answer is stored with the identity it belongs to, so a previous
  // identity's answer is never reported for the current one.
  const [result, setResult] = useState<{ userId: string; isAdmin: boolean } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from('admin_users')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!cancelled) setResult({ userId, isAdmin: !error && !!data });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return false;
  return result?.userId === userId ? result.isAdmin : null;
}

import { useEffect, useState } from 'react';

import { checkTaggingAvailable, taggingAvailable } from '@/lib/content-tags';

// Whether this database has collector tagging (lib/content-tags.ts). False
// until confirmed — the Tag actions stay hidden on a database without the
// migration, and appear once a check (at most one per session) succeeds.
export function useTaggingAvailable(): boolean {
  const [available, setAvailable] = useState(taggingAvailable);
  useEffect(() => {
    if (available) return;
    let cancelled = false;
    void checkTaggingAvailable().then((next) => {
      if (!cancelled && next) setAvailable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);
  return available;
}

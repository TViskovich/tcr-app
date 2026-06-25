import { useCallback, useEffect, useState } from 'react';

import { Alert } from 'react-native';

import { supabase } from '@/lib/supabase';
import type { ShowcaseItem } from '@/types';

export function useGrails(userId: string | undefined) {
  const [grails, setGrails] = useState<ShowcaseItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) {
      setGrails([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('profile_showcase_items')
      .select('*, item:collection_items(*)')
      .eq('user_id', userId)
      .order('display_order', { ascending: true });

    setGrails((data ?? []) as ShowcaseItem[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const isFull = grails.length >= 9;

  function isInGrails(itemId: string): boolean {
    return grails.some((g) => g.item_id === itemId);
  }

  async function addToGrails(itemId: string): Promise<void> {
    if (!userId) return;
    const { error } = await supabase
      .from('profile_showcase_items')
      .insert({ user_id: userId, item_id: itemId });

    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('showcase_limit_error')) {
        Alert.alert('Grails Full', 'You already have 9 Grails. Remove one to add another.');
      } else if (msg.includes('showcase_ownership_error')) {
        Alert.alert('Error', 'You can only add your own items to Grails.');
      } else if (msg.includes('uq_showcase_user_item')) {
        // Already added — treat as no-op
      } else {
        Alert.alert('Error', 'Could not add to Grails. Please try again.');
      }
      return;
    }
    await load();
  }

  async function removeFromGrails(itemId: string): Promise<void> {
    if (!userId) return;
    const { error } = await supabase
      .from('profile_showcase_items')
      .delete()
      .eq('user_id', userId)
      .eq('item_id', itemId);

    if (error) {
      Alert.alert('Error', 'Could not remove from Grails. Please try again.');
      return;
    }
    await load();
  }

  return { grails, loading, isFull, isInGrails, addToGrails, removeFromGrails, refresh: load };
}

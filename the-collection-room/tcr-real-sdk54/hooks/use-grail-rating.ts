import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

type Args = {
  postId: string;
  postOwnerId: string;
  currentUserId: string | undefined;
  initialAvg: number | null;
  initialCount: number;
  initialMyRating: number | null;
};

// Shared by the feed card and the post detail page — one rating per user per
// post, changing a rating replaces it (never adds a second vote), and the
// post owner can't rate their own post (also enforced by RLS on the insert).
export function useGrailRating({
  postId,
  postOwnerId,
  currentUserId,
  initialAvg,
  initialCount,
  initialMyRating,
}: Args) {
  const [avg, setAvg] = useState(initialAvg);
  const [count, setCount] = useState(initialCount);
  const [myRating, setMyRating] = useState(initialMyRating);
  const [submitting, setSubmitting] = useState(false);

  // The feed already has post data at mount, so this only runs once there —
  // harmless. The post detail screen starts with postId === '' (post loads
  // async) and only gets real initial* values once postId becomes real, so
  // this resync is required there, not just a nicety.
  useEffect(() => {
    setAvg(initialAvg);
    setCount(initialCount);
    setMyRating(initialMyRating);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  const isOwner = !!currentUserId && currentUserId === postOwnerId;

  const submitRating = useCallback(
    async (score: number) => {
      if (!currentUserId || isOwner || submitting) return;
      setSubmitting(true);

      const wasRated = myRating !== null;
      const prevAvg = avg;
      const prevCount = count;
      const prevMyRating = myRating;

      // Optimistic update first, same pattern as the feed's handleLike.
      const priorTotal = (prevAvg ?? 0) * prevCount;
      const nextCount = wasRated ? prevCount : prevCount + 1;
      const nextTotal = wasRated ? priorTotal - (prevMyRating ?? 0) + score : priorTotal + score;
      setAvg(nextTotal / nextCount);
      setCount(nextCount);
      setMyRating(score);

      try {
        const { error } = await supabase.from('grail_ratings').upsert(
          {
            post_id: postId,
            rater_user_id: currentUserId,
            score,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'post_id,rater_user_id' },
        );

        if (error) {
          console.error('Rating failed:', error.message);
          setAvg(prevAvg);
          setCount(prevCount);
          setMyRating(prevMyRating);
          return;
        }

        // Every submit/change gets its own notification — the score is frozen
        // onto the row since a later rating change must not rewrite it.
        supabase
          .from('notifications')
          .insert({
            user_id: postOwnerId,
            actor_id: currentUserId,
            type: 'grail_rating',
            post_id: postId,
            rating_score: score,
          })
          .then(({ error: e }) => {
            if (e) console.error('Rating notif failed:', e.message);
          });
      } catch (e) {
        console.error('Rating threw:', e);
        setAvg(prevAvg);
        setCount(prevCount);
        setMyRating(prevMyRating);
      } finally {
        setSubmitting(false);
      }
    },
    [postId, postOwnerId, currentUserId, isOwner, submitting, avg, count, myRating],
  );

  return { avg, count, myRating, isOwner, submitting, submitRating };
}

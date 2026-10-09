import { supabase } from './supabase';

export type DeletePostResult = { status: 'ok' } | { status: 'failed'; reason: string };

// Owner-only post deletion (POST DELETION beta blocker) — delegates
// entirely to the delete-post Edge Function, which runs under service
// role so it can clean up comments/notifications regardless of who
// authored them, and clears this post's own share-snapshots storage
// objects. See that function's own module comment for the full
// ordering/safety rationale; this client wrapper does no cleanup of its
// own and never bypasses it.
//
// Authenticated-only — same rationale as copyShareSnapshotImage/
// createSnapshotPost (lib/share-snapshots.ts): no legitimate anonymous
// caller for "delete my own post", so supabase.functions.invoke() is safe
// to use directly here.
export async function deletePost(postId: string): Promise<DeletePostResult> {
  const { data, error } = await supabase.functions.invoke('delete-post', {
    body: { post_id: postId },
  });
  if (error || data?.status !== 'ok') {
    const reason = typeof data?.reason === 'string' ? data.reason : (error ? 'request_failed' : 'unknown');
    if (__DEV__) console.warn('[deletePost] failed:', reason, error ?? data);
    return { status: 'failed', reason };
  }
  return { status: 'ok' };
}

export type RepostResult = { status: 'ok' } | { status: 'failed'; reason: 'not_found' | 'request_failed' };

// Repost (universal feed reposts — supabase/migrations/
// 20261014120000_add_post_reposts.sql). Inserts the caller's own 'repost'
// row referencing `originalPostId`; posts_repost_guard (server side) points
// it at the ORIGINAL if this is itself a repost and strips any content
// columns. Your own posts can be reposted too (20261016120000). Idempotent:
// one repost per user per original (unique index), so a double tap or retry
// that hits the unique violation is reported as success — it IS reposted.
export async function repostPost(userId: string, originalPostId: string): Promise<RepostResult> {
  const { error } = await supabase
    .from('posts')
    .insert({ user_id: userId, post_type: 'repost', repost_of_post_id: originalPostId });
  if (!error) return { status: 'ok' };
  if (error.code === '23505') return { status: 'ok' };
  if (__DEV__) console.warn('[repostPost] failed:', error.code, error.message);
  if (error.code === '23503') return { status: 'failed', reason: 'not_found' };
  return { status: 'failed', reason: 'request_failed' };
}

// Undo: deletes the caller's own repost row of `originalPostId`
// (posts_delete_own; its likes/comments/notifications cascade, and a repost
// owns no share-snapshots objects, so the delete-post Edge Function's
// storage cleanup isn't needed). Idempotent — nothing to delete is success.
export async function undoRepost(userId: string, originalPostId: string): Promise<RepostResult> {
  const { error } = await supabase
    .from('posts')
    .delete()
    .eq('user_id', userId)
    .eq('repost_of_post_id', originalPostId);
  if (!error) return { status: 'ok' };
  if (__DEV__) console.warn('[undoRepost] failed:', error.code, error.message);
  return { status: 'failed', reason: 'request_failed' };
}

// Maximum quote comment length — also enforced by posts_quote_content_check.
export const QUOTE_MAX_LENGTH = 280;

export type QuoteResult = { status: 'ok' } | { status: 'failed'; reason: 'not_found' | 'invalid' | 'request_failed' };

// Quote (supabase/migrations/20261015120000_add_quote_posts.sql): the
// caller's own 'quote' post — their comment plus a reference to
// `quotedPostId`. posts_repost_guard (server side) points a quote of a
// repost at its original, trims and length-checks the comment, and clears
// every other content column. Unlike a repost, any number of quotes of the
// same post are allowed, so this is never deduplicated — the composer
// guards against a double submit.
export async function createQuotePost(userId: string, quotedPostId: string, comment: string): Promise<QuoteResult> {
  const content = comment.trim();
  if (!content || content.length > QUOTE_MAX_LENGTH) return { status: 'failed', reason: 'invalid' };
  const { error } = await supabase
    .from('posts')
    .insert({ user_id: userId, post_type: 'quote', quote_of_post_id: quotedPostId, content });
  if (!error) return { status: 'ok' };
  if (__DEV__) console.warn('[createQuotePost] failed:', error.code, error.message);
  if (error.code === '23503') return { status: 'failed', reason: 'not_found' };
  if (error.code === '23514') return { status: 'failed', reason: 'invalid' };
  return { status: 'failed', reason: 'request_failed' };
}

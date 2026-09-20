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

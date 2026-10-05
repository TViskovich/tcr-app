import { messagePreviewText } from '@/lib/dm-attachments';
import { supabase } from '@/lib/supabase';

// The signed-in user's visible (non-hidden) 1:1 conversations, newest first,
// with the other participant's profile and a one-line last-message preview.
// Moved verbatim from app/(tabs)/messages.tsx so the inbox and Item Detail →
// Send in DM's recent-conversations list (components/share/send-item-dm-
// sheet.tsx) share one query.

export type ConversationItem = {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessageBody: string | null;
  lastMessageAt: string;
  // Whether the latest message was sent by the signed-in user (inbox "You:"
  // prefix). False when the latest message isn't in the fetched window.
  lastMessageFromMe: boolean;
  // Same rule as the global badge (hooks/use-unread-messages.ts):
  // conversations.last_message_at > my last_read_at (or never read). Boolean
  // only — no per-conversation count exists.
  unread: boolean;
};

export async function loadInbox(currentUserId: string, signal: AbortSignal): Promise<ConversationItem[]> {
  const { data: myRows, error: myRowsError } = await supabase
    .from('conversation_participants')
    .select('conversation_id, last_read_at')
    .eq('user_id', currentUserId)
    // Conversations this user swipe-deleted from their own inbox — hidden
    // here only; the other participant's own row/inbox is untouched, and a
    // DB trigger clears this back to NULL the moment a new message lands.
    .is('hidden_at', null)
    .abortSignal(signal);

  // Checked after every awaited phase below (not just the final one) so an
  // aborted lifecycle (blur/unmount/foreground-superseded) stops issuing
  // further queries instead of paying for phases whose result can never be
  // applied — the caller (load/onRefresh/refreshInbox) independently checks
  // signal.aborted again before touching state either way.
  if (signal.aborted) return [];
  // Thrown (not swallowed into []) so callers can tell "load failed" apart
  // from "no conversations".
  if (myRowsError) throw new Error(myRowsError.message);
  if (!myRows?.length) return [];

  const myLastReadMap = new Map<string, string | null>(
    (myRows as any[]).map((r) => [r.conversation_id as string, (r.last_read_at as string | null) ?? null]),
  );

  const convIds = (myRows as any[]).map((r) => r.conversation_id as string);

  const [allParticipantsRes, conversationsRes, messagesRes] = await Promise.all([
    supabase
      .from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds)
      .abortSignal(signal),
    supabase
      .from('conversations')
      .select('id, last_message_at')
      .in('id', convIds)
      .abortSignal(signal),
    supabase
      .from('messages')
      .select('conversation_id, sender_id, body, created_at, attachment_type')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(200)
      .abortSignal(signal),
  ]);

  if (signal.aborted) return [];

  // Map: conversation_id → other user_id
  const convOtherUserMap = new Map<string, string>();
  for (const row of (allParticipantsRes.data ?? []) as any[]) {
    if (row.user_id !== currentUserId) {
      convOtherUserMap.set(row.conversation_id, row.user_id);
    }
  }

  const otherUserIds = [...new Set([...convOtherUserMap.values()])];
  const { data: profilesData } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', otherUserIds)
    .abortSignal(signal);

  if (signal.aborted) return [];

  const profileMap = new Map((profilesData ?? []).map((p: any) => [p.id, p]));

  // Messages are DESC — first seen per conversation_id is the latest
  const latestMsgMap = new Map<string, any>();
  for (const msg of (messagesRes.data ?? []) as any[]) {
    if (!latestMsgMap.has(msg.conversation_id)) {
      latestMsgMap.set(msg.conversation_id, msg);
    }
  }

  const convLastAtMap = new Map<string, string>(
    (conversationsRes.data ?? []).map((c: any) => [c.id, c.last_message_at]),
  );

  return convIds
    .map((convId) => {
      const otherUserId = convOtherUserMap.get(convId) ?? '';
      const p = profileMap.get(otherUserId) ?? {};
      const lastMsg = latestMsgMap.get(convId);
      const lastMessageAtServer = convLastAtMap.get(convId) ?? null;
      const lastRead = myLastReadMap.get(convId) ?? null;
      return {
        id: convId,
        otherUserId,
        otherUsername: p.username ?? 'user',
        otherDisplayName: p.display_name ?? null,
        otherAvatarUrl: p.avatar_url ?? null,
        // Attachment-only messages have a NULL body (see lib/dm-attachments.ts).
        lastMessageBody: lastMsg ? messagePreviewText(lastMsg) : null,
        lastMessageAt: lastMsg?.created_at ?? convLastAtMap.get(convId) ?? new Date().toISOString(),
        lastMessageFromMe: !!lastMsg && lastMsg.sender_id === currentUserId,
        unread: !!lastMessageAtServer && (!lastRead || new Date(lastMessageAtServer) > new Date(lastRead)),
      };
    })
    .sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    );
}

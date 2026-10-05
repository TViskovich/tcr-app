import { MESSAGE_COLUMNS, isItemNotShareableError, type MessageAttachmentType } from '@/lib/dm-attachments';
import { supabase } from '@/lib/supabase';

// The one DM message write path — used by the conversation screen
// (app/conversation/[id].tsx performSend: text, and in-conversation Share
// Item) and by Item Detail → Send in DM (components/share/send-item-dm-
// sheet.tsx). Owns the insert, the ambiguous-outcome reconciliation, and
// the error classification, so every entry point agrees on what "sent",
// "not shareable" and "unknown" mean.

export type DmMessage = {
  id: string;
  sender_id: string;
  // Null only for an attachment-only message (DB-enforced by
  // messages_body_check).
  body: string | null;
  created_at: string;
  attachment_type: MessageAttachmentType | null;
  // Null with attachment_type 'item' once the source item is deleted (ON
  // DELETE SET NULL) — renders "Item unavailable".
  attachment_item_id: string | null;
  // 'image' only: deterministic dm-attachments object path
  // (<conversation>/<message>/image.jpg — see lib/dm-images.ts) and the
  // uploaded JPEG's pixel size.
  attachment_storage_path: string | null;
  attachment_width: number | null;
  attachment_height: number | null;
};

// What a send attaches. Item: a live item reference. Image: an object
// ALREADY uploaded to this message's deterministic path.
export type DmAttachmentInput =
  | { type: 'item'; itemId: string }
  | { type: 'image'; storagePath: string; width: number; height: number };

export function attachmentColumns(attachment: DmAttachmentInput | null) {
  return {
    attachment_type: attachment?.type ?? null,
    attachment_item_id: attachment?.type === 'item' ? attachment.itemId : null,
    attachment_storage_path: attachment?.type === 'image' ? attachment.storagePath : null,
    attachment_width: attachment?.type === 'image' ? attachment.width : null,
    attachment_height: attachment?.type === 'image' ? attachment.height : null,
  };
}

export type DmWriteResult =
  // The row durably exists (clean insert, or found by reconciliation).
  | { kind: 'committed'; message: DmMessage }
  // Definitively NOT committed — safe to let the user resend under a new id.
  | { kind: 'absent' }
  // Server's enforce_message_attachment_visibility rejected the item.
  | { kind: 'not_shareable' }
  // Any other definitive 4xx (RLS, constraint, malformed) — not committed.
  | { kind: 'rejected' }
  // Ambiguous write AND reconciliation couldn't prove it either way. The
  // caller must retry with the SAME id (a prior commit then surfaces as a
  // 23505 → reconciled, never a duplicate row).
  | { kind: 'unknown' };

type WriteArgs = {
  // Client-generated, reused verbatim across retries of one logical send.
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  attachment?: DmAttachmentInput | null;
};

// Authoritative check for one logical send: did `id` actually commit? The
// live messages_select policy is participant-gated, so this read is
// trustworthy for the sender's own row. A read error or thrown exception
// leaves the outcome unknown — never reported as absent, which would wrongly
// tell the caller it's safe to resend under a fresh id.
async function reconcile(
  id: string,
  conversationId: string,
  senderId: string,
): Promise<DmWriteResult> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('id', id)
      .eq('conversation_id', conversationId)
      .eq('sender_id', senderId)
      .maybeSingle();
    if (error) return { kind: 'unknown' };
    return data ? { kind: 'committed', message: data as DmMessage } : { kind: 'absent' };
  } catch {
    return { kind: 'unknown' };
  }
}

// One durable-write attempt. Never throws.
export async function writeDmMessage({
  id,
  conversationId,
  senderId,
  body,
  attachment = null,
}: WriteArgs): Promise<DmWriteResult> {
  try {
    const { data, error, status } = await supabase
      .from('messages')
      .insert({
        id,
        conversation_id: conversationId,
        sender_id: senderId,
        body,
        ...attachmentColumns(attachment),
      })
      .select(MESSAGE_COLUMNS)
      .single();

    // A. Clean success.
    if (!error) return { kind: 'committed', message: data as DmMessage };

    // B. Duplicate-key conflict on messages_pkey — a prior attempt under
    // this exact id may already have committed.
    // C. status 0: lost/network-origin response — may have committed before
    // the response leg failed.
    // D. 5xx: same ambiguity as status 0.
    if (error.code === '23505' || status === 0 || status >= 500) {
      return await reconcile(id, conversationId, senderId);
    }

    // E. A definitive 4xx that isn't a duplicate-key conflict — the INSERT
    // did not commit.
    if (isItemNotShareableError(error)) return { kind: 'not_shareable' };
    console.error('Send failed:', error.message, { code: error.code, status });
    return { kind: 'rejected' };
  } catch (e) {
    // F. Thrown after the request may have already left the device — never
    // treat a throw as proof of non-commit.
    console.error('Send threw (outcome unknown), reconciling:', e);
    return await reconcile(id, conversationId, senderId);
  }
}

// Keep the sender's own last_read_at current so their send doesn't show as
// unread to themselves — stamped with the row's server created_at, not the
// device clock (see readCursorFor in app/conversation/[id].tsx).
// Fire-and-forget.
export function stampSenderReadCursor(conversationId: string, senderId: string, createdAt: string) {
  supabase
    .from('conversation_participants')
    .update({ last_read_at: createdAt })
    .eq('conversation_id', conversationId)
    .eq('user_id', senderId)
    .then(({ error }) => {
      if (error) console.error('last_read_at send-stamp failed:', error.message);
    });
}

// Item attachment send for callers outside the conversation screen (which
// has its own local rendering/pending state around writeDmMessage). Same
// write path, same classification; stamps the sender's read cursor on
// commit exactly like the conversation screen's finalizeSentMessage.
export async function sendItemAttachment(args: {
  id: string;
  conversationId: string;
  senderId: string;
  itemId: string;
  body: string | null;
}): Promise<DmWriteResult> {
  const result = await writeDmMessage({
    id: args.id,
    conversationId: args.conversationId,
    senderId: args.senderId,
    body: args.body,
    attachment: { type: 'item', itemId: args.itemId },
  });
  if (result.kind === 'committed') {
    stampSenderReadCursor(args.conversationId, args.senderId, result.message.created_at);
  }
  return result;
}

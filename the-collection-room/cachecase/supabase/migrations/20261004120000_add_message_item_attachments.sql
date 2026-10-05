-- ============================================================================
-- DM item attachments (DM redesign pass 4).
--
-- A message may carry text, an item attachment, or both. The attachment is a
-- LIVE reference (attachment_item_id → collection_items.id) — deliberately no
-- copied title/image/snapshot: the recipient resolves the item under their
-- own items_select_public RLS on every render, so a later privacy change or
-- deletion takes effect immediately ("Item unavailable") instead of leaving
-- stale private details readable in old messages, and the sender can't forge
-- display text. Nothing is copied into anyone's collection; ownership is
-- untouched.
--
-- Confirmed live before this change (read-only catalog inspection via
-- `supabase db query --linked`, Postgres 17.6):
--   - columns: id uuid NOT NULL default gen_random_uuid(), conversation_id
--     uuid, sender_id uuid, body text NOT NULL, created_at timestamptz NOT
--     NULL default now()
--   - messages_body_check: CHECK (char_length(body) > 0)
--   - policies: messages_insert (WITH CHECK sender_id = auth.uid() AND
--     is_conversation_participant(...)), messages_select (participant-gated).
--     No UPDATE or DELETE policy — clients cannot update messages at all.
--   - table-level grants to authenticated (new columns inherit them; RLS
--     still gates rows)
--   - 0 rows with NULL/blank body; messages is not in any publication
--
-- Integrity rules:
--   1. attachment_type is NULL or 'item'                       (CHECK)
--   2. attachment_type = 'item' requires attachment_item_id     (trigger, on
--      INSERT and any client UPDATE). Not a CHECK: ON DELETE SET NULL below
--      must be able to null attachment_item_id when the source item is
--      deleted — a CHECK would make that FK action fail and block the item
--      delete itself. The nulled state (type 'item', id NULL) is exactly the
--      durable "Item unavailable" state.
--   3. attachment_type NULL ⇒ attachment_item_id NULL           (CHECK)
--   4. body NULL only when an attachment exists                 (CHECK)
--   5. plain text unchanged: a non-NULL body still needs char_length > 0,
--      exactly the old messages_body_check rule
-- ============================================================================

-- --- 1. Columns ---
-- ON DELETE SET NULL, never CASCADE: deleting an item must not delete
-- anyone's conversation history.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_type text NULL,
  ADD COLUMN IF NOT EXISTS attachment_item_id uuid NULL
    REFERENCES public.collection_items(id) ON DELETE SET NULL;

-- Attachment-only messages have no text. Rule 4 below keeps this from
-- admitting textless, attachmentless rows.
ALTER TABLE public.messages ALTER COLUMN body DROP NOT NULL;

-- --- 2. Constraints ---
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_body_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_attachment_type_check
    CHECK (attachment_type IS NULL OR attachment_type = 'item'),
  ADD CONSTRAINT messages_attachment_item_requires_type_check
    CHECK (attachment_type IS NOT NULL OR attachment_item_id IS NULL),
  -- Replaces messages_body_check. Written without bare char_length(body) at
  -- the top level so a NULL body can't slip through as CHECK-unknown.
  ADD CONSTRAINT messages_body_check
    CHECK (
      (body IS NOT NULL AND char_length(body) > 0)
      OR (body IS NULL AND attachment_type IS NOT NULL)
    );

-- Supports the FK's ON DELETE SET NULL lookup when an item is deleted.
CREATE INDEX IF NOT EXISTS messages_attachment_item_id_idx
  ON public.messages (attachment_item_id)
  WHERE attachment_item_id IS NOT NULL;

-- --- 3. Visibility helper ---
-- items_select_public (20260910120000_grail_slot_visibility_exception.sql),
-- evaluated for an explicit viewer instead of auth.uid(). Internal only —
-- no grant to any client role (same reasoning as
-- _folder_is_effectively_visible_for, which it calls), so it can never be
-- used as an RPC to probe another user's item visibility. Must be kept in
-- sync if items_select_public changes.
CREATE OR REPLACE FUNCTION public._item_visible_to(p_item_id uuid, p_viewer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_item_id
      AND (
        (
          public._folder_is_effectively_visible_for(ci.folder_id, p_viewer)
          AND (ci.is_public = true OR ci.user_id = p_viewer)
        )
        OR EXISTS (
          SELECT 1 FROM public.profile_grail_slots gs
          WHERE gs.entry_type = 'item'
            AND gs.item_id = ci.id
            AND gs.user_id = ci.user_id
        )
      )
  );
$$;

-- --- 4. Server-side share validation ---
-- An item may be attached only if the sender AND every other participant
-- could already view it under items_select_public. Without this, a sender
-- could hand a recipient the id of an item the recipient can't see — and
-- the sender-visibility half stops the insert being used as an existence
-- oracle for someone else's private item ids. SECURITY DEFINER because it
-- must evaluate visibility for the recipient, not the inserting caller.
-- Also fires on UPDATE of the attachment columns: no client UPDATE policy
-- exists today, but this keeps the rule from depending on that.
CREATE OR REPLACE FUNCTION public.enforce_message_attachment_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.attachment_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.attachment_item_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'item_attachment_missing' USING ERRCODE = '23514';
    END IF;
    -- UPDATE to NULL: the FK's ON DELETE SET NULL after the source item was
    -- deleted (rule 2's one exception — see header).
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.attachment_item_id IS NOT DISTINCT FROM OLD.attachment_item_id THEN
    RETURN NEW;
  END IF;

  IF NOT public._item_visible_to(NEW.attachment_item_id, NEW.sender_id)
     OR EXISTS (
       SELECT 1 FROM public.conversation_participants cp
       WHERE cp.conversation_id = NEW.conversation_id
         AND cp.user_id IS DISTINCT FROM NEW.sender_id
         AND NOT public._item_visible_to(NEW.attachment_item_id, cp.user_id)
     ) THEN
    RAISE EXCEPTION 'item_not_shareable' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_enforce_attachment_visibility ON public.messages;
CREATE TRIGGER messages_enforce_attachment_visibility
  BEFORE INSERT OR UPDATE OF attachment_type, attachment_item_id ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_message_attachment_visibility();

-- Neither function is ever called directly by a client.
REVOKE EXECUTE ON FUNCTION public._item_visible_to(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._item_visible_to(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public._item_visible_to(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM authenticated;

NOTIFY pgrst, 'reload schema';

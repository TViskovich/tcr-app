-- ============================================================================
-- DM image attachments (DM redesign pass 8).
--
-- Adds attachment_type = 'image' alongside the existing 'item' attachment
-- (20261004120000_add_message_item_attachments.sql), backed by a dedicated
-- PRIVATE Storage bucket `dm-attachments`.
--
-- Object path is DETERMINISTIC per message:
--   <conversation_id>/<message_id>/image.jpg
-- The same message id always maps to the same object, so a retry of one
-- logical send (which reuses its message id — see lib/dm-send.ts) re-targets
-- the identical object: no retry-orphans, reconciliation by message id also
-- identifies the media, and the cache identity is stable.
-- Authorization is enforced directly by Storage RLS — every DM viewer is an
-- authenticated participant (no anonymous/public access case, unlike
-- item-images, which is why that path needed a service-role Edge Function).
-- Clients mint short-lived signed URLs with createSignedUrl(s), which
-- Storage only issues when the caller passes the SELECT policy below.
-- ============================================================================

-- --- 1. Bucket ---
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dm-attachments', 'dm-attachments', false, 10485760, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;

-- --- 2. messages columns ---
-- (Before the Storage policies: the delete policy references
-- messages.attachment_storage_path.)
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_storage_path text NULL,
  -- Pixel dimensions of the uploaded (already-resized) JPEG, so bubbles can
  -- reserve the right aspect ratio before the image loads. Optional.
  ADD COLUMN IF NOT EXISTS attachment_width integer NULL,
  ADD COLUMN IF NOT EXISTS attachment_height integer NULL;

-- --- 3. Storage policies (storage.objects) ---
-- Path segment 1 must be a conversation the caller participates in.
-- `(storage.foldername(name))[1]` is the conversation id; the ::uuid cast is
-- guarded by a regex so a malformed path is simply denied, never an error.

-- Read: any participant of that conversation.
CREATE POLICY "dm_attachments_select_participant" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'dm-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    AND public.is_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid())
  );

-- Upload: a participant, into exactly <conversation_uuid>/<message_uuid>/image.jpg.
-- Storage stamps owner = auth.uid() itself.
CREATE POLICY "dm_attachments_insert_participant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'dm-attachments'
    AND name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/image\.jpg$'
    AND public.is_conversation_participant(((storage.foldername(name))[1])::uuid, auth.uid())
  );

-- Delete: only the uploader, and only while NO message references the object
-- — i.e. orphan cleanup after a definitively failed send. A committed
-- message's photo can't be deleted out from under the other participant.
CREATE POLICY "dm_attachments_delete_own_orphan" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'dm-attachments'
    AND owner = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.messages m WHERE m.attachment_storage_path = storage.objects.name
    )
  );

-- No UPDATE policy: objects are immutable once uploaded (no overwrite/upsert).

-- --- 4. Constraints ---
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_attachment_type_check;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_attachment_item_requires_type_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_attachment_type_check
    CHECK (attachment_type IS NULL OR attachment_type IN ('item', 'image')),
  -- IS NOT DISTINCT FROM (not =) throughout: with attachment_type NULL, a
  -- plain `attachment_type = 'image'` evaluates to NULL and a CHECK passes on
  -- NULL — that would let a text message carry an item id, path or size.
  --
  -- An item id only on 'item' messages (tightened from "type not null").
  ADD CONSTRAINT messages_attachment_item_requires_type_check
    CHECK (attachment_item_id IS NULL OR attachment_type IS NOT DISTINCT FROM 'item'),
  -- 'image' ⇔ a storage path. (No FK-style SET NULL path exists for images,
  -- so this can be a plain CHECK.)
  ADD CONSTRAINT messages_attachment_image_path_check
    CHECK ((attachment_type IS NOT DISTINCT FROM 'image') = (attachment_storage_path IS NOT NULL)),
  ADD CONSTRAINT messages_attachment_dimensions_check
    CHECK (
      (attachment_width IS NULL OR attachment_width > 0)
      AND (attachment_height IS NULL OR attachment_height > 0)
      AND (
        attachment_type IS NOT DISTINCT FROM 'image'
        OR (attachment_width IS NULL AND attachment_height IS NULL)
      )
    );
-- messages_body_check is unchanged: body may be NULL whenever any attachment
-- exists, so image-only messages already satisfy it.

-- One message per object — also backs the delete policy's NOT EXISTS lookup.
CREATE UNIQUE INDEX IF NOT EXISTS messages_attachment_storage_path_key
  ON public.messages (attachment_storage_path)
  WHERE attachment_storage_path IS NOT NULL;

-- --- 5. Server-side attachment validation (replaces the pass-4 function) ---
-- 'item' branch: byte-for-byte the existing behavior.
-- 'image' branch: the path must be exactly this message's own deterministic
-- <conversation_id>/<message_id>/image.jpg, and the object must already exist
-- in dm-attachments, uploaded by the sender. So a message can't point at
-- another conversation's photo, another message's photo, or a file that was
-- never uploaded.
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

  IF NEW.attachment_type = 'image' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.attachment_storage_path IS NOT DISTINCT FROM OLD.attachment_storage_path THEN
      RETURN NEW;
    END IF;
    IF NEW.attachment_storage_path IS NULL
       OR NEW.attachment_storage_path
          <> NEW.conversation_id::text || '/' || NEW.id::text || '/image.jpg'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects o
         WHERE o.bucket_id = 'dm-attachments'
           AND o.name = NEW.attachment_storage_path
           AND o.owner = NEW.sender_id
       ) THEN
      RAISE EXCEPTION 'image_attachment_invalid' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- attachment_type = 'item' (unchanged from 20261004120000)
  IF NEW.attachment_item_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'item_attachment_missing' USING ERRCODE = '23514';
    END IF;
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
  BEFORE INSERT OR UPDATE OF attachment_type, attachment_item_id, attachment_storage_path ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_message_attachment_visibility();

REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_message_attachment_visibility() FROM authenticated;

NOTIFY pgrst, 'reload schema';

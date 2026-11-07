-- ============================================================================
-- Download My Data: the photos a collector SENT in direct messages.
--
-- dm-attachments objects live at <conversation_id>/<message_id>/image.jpg
-- (20261005120000_add_message_image_attachments.sql), so — unlike avatars,
-- item-images and share-snapshots — the path does not say whose photo it is.
-- Ownership comes from the message: a photo is exported only when ALL hold
--   * the message was sent by the collector (messages.sender_id),
--   * it is an image message whose attachment_storage_path is exactly its own
--     <conversation_id>/<message_id>/image.jpg,
--   * that exact object exists in the dm-attachments bucket, and
--   * Storage records the collector as the object's owner.
-- Photos sent by anyone else, orphaned uploads and files merely in a
-- conversation the collector belongs to are never listed.
--
-- Product decision: the collector's own sent photos are included even when
-- the recipient is hidden (pending deletion / being deleted) or deleted —
-- the text of those messages is already in the export. This function runs
-- only as service_role (which bypasses RLS), so the restrictive
-- account_lifecycle_dm_attachment_guard does not apply here; that is
-- deliberate and limited to the sender's own uploads.
--
-- SECURITY INVOKER: the only caller (service_role) can already read both
-- tables, so definer rights would add nothing — and if EXECUTE were ever
-- granted more widely by mistake, the caller's own RLS would still apply.
--
-- Read-only; no table, policy, grant or Storage change. Nothing in account
-- deletion, maintenance or monitoring calls it.
-- ============================================================================

CREATE FUNCTION public.export_sent_message_attachments(
  p_user_id uuid,
  p_after_message_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE (message_id uuid, bucket_id text, name text, size bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT m.id, o.bucket_id, o.name, COALESCE((o.metadata ->> 'size')::bigint, 0)
  FROM public.messages m
  JOIN storage.objects o
    ON o.bucket_id = 'dm-attachments'
   AND o.name = m.attachment_storage_path
  WHERE m.sender_id = p_user_id
    AND m.attachment_type = 'image'
    AND m.attachment_storage_path = m.conversation_id::text || '/' || m.id::text || '/image.jpg'
    AND (o.owner = p_user_id OR o.owner_id = p_user_id::text)
    AND m.id > COALESCE(p_after_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY m.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

COMMENT ON FUNCTION public.export_sent_message_attachments(uuid, uuid, integer) IS
  'Download My Data: dm-attachments photos SENT by p_user_id (sender, exact per-message path, existing object, Storage owner). Paged by message id. service_role only.';

REVOKE ALL ON FUNCTION public.export_sent_message_attachments(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_sent_message_attachments(uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

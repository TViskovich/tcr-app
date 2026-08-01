-- ============================================================================
-- Adds the missing owner-only DELETE policy for the "avatars" Storage
-- bucket. Every supabase.storage.from('avatars').remove(...) call from
-- lib/storage.ts's deleteProfileImage (see components/profile-v2/profile-v2-screen.tsx's
-- handleSave, Profile 2.0 avatar/banner/badge cleanup) has been silently
-- failing until now, since "avatars" had SELECT (public) and INSERT (own)
-- policies but no DELETE policy at all.
--
-- Mirrors item_images_delete_own's exact ownership rule
-- (storage.foldername(name))[1] = auth.uid()::text — the first path
-- segment is always the uploading user's id for every object in this
-- bucket, regardless of which of the three upload helpers wrote it:
--   uploadAvatar:     {userId}/{filename}
--   uploadHeroImage:  {userId}/hero/{filename}
--   uploadBadgeImage: {userId}/badge/{filename}
-- storage.foldername(name)[1] is unaffected by the optional "hero"/"badge"
-- second segment, so one policy — with no per-kind branching — correctly
-- covers all three image kinds.
--
-- Deliberately TO authenticated (not the item_images_delete_own precedent's
-- roles:{public}, which relies solely on auth.uid() being null for
-- anon/unauthenticated requests to fail the USING clause) — explicit role
-- scoping is the tighter, more direct way to guarantee anon can never
-- match this policy, rather than depending on auth.uid() evaluating to
-- null for an anonymous request.
-- ============================================================================

CREATE POLICY "avatars_delete_own"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

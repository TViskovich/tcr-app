-- Waitlist Phase 2 foundation: optional expiry for an issued access code.
--
-- Additive only. No RLS, grant, status-constraint, access_code, join-waitlist
-- or Resend changes. Nothing here sets or enforces expiry automatically — the
-- intended 14-day window is applied when access granting is implemented.

ALTER TABLE public.waitlist_signups
  ADD COLUMN access_code_expires_at timestamptz NULL;

COMMENT ON COLUMN public.waitlist_signups.access_code_expires_at IS
  'When the issued access code stops being valid. Only set once access is granted (intended Phase 2 window: 14 days). NULL = no expiry recorded.';

-- An expiration only makes sense once access has been granted.
ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_access_code_expiry_status_check
  CHECK (
    access_code_expires_at IS NULL
    OR status IN ('access_granted', 'onboarded')
  );

NOTIFY pgrst, 'reload schema';

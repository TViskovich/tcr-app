-- Waitlist Phase 2B: invite validation + atomic redemption.
--
-- No RLS / policy / client-grant change on waitlist_signups. Both functions
-- are service_role-only and called by the validate-/redeem-waitlist-invite
-- Edge Functions. Plaintext codes never reach PostgreSQL — callers pass the
-- SHA-256 hex digest (supabase/functions/_shared/invite-code.ts).

-- 1. Durable link to the account that consumed the invite.
--    ON DELETE SET NULL (not RESTRICT/CASCADE): deleting an account must not
--    be blocked by, or erase, the waitlist record. The invite stays consumed
--    (status 'onboarded' + onboarded_at) even after the link is cleared, so
--    "onboarded requires a user id" is enforced at redemption time (the only
--    writer) rather than by a CHECK that account deletion would violate.
ALTER TABLE public.waitlist_signups
  ADD COLUMN onboarded_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.waitlist_signups.onboarded_user_id IS
  'auth.users id that redeemed this invite. Set only by redeem_waitlist_invite. NULL after that account is deleted (status/onboarded_at keep the invite consumed).';

-- One invite per account, one account per invite.
CREATE UNIQUE INDEX waitlist_signups_onboarded_user_id_key
  ON public.waitlist_signups (onboarded_user_id) WHERE onboarded_user_id IS NOT NULL;

-- Code lookup by hash, and no two live rows can ever share a hash.
CREATE UNIQUE INDEX waitlist_signups_access_code_key
  ON public.waitlist_signups (access_code) WHERE access_code IS NOT NULL;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_onboarded_user_status_check
  CHECK (onboarded_user_id IS NULL OR status = 'onboarded');

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_onboarded_at_status_check
  CHECK ((status = 'onboarded') = (onboarded_at IS NOT NULL));

-- 2. Informational check (UX only — redemption re-checks everything).
--    Non-locking. Only a caller holding the right code can learn anything
--    beyond 'invalid' (100-bit codes make that non-enumerable). p_email is
--    optional: when given, email_matches reports whether it equals the
--    invited address (trim + lowercase) without ever returning that address.
CREATE OR REPLACE FUNCTION public.check_waitlist_invite(p_code_hash text, p_email text DEFAULT NULL)
RETURNS TABLE (
  outcome           text,        -- valid | expired | used | invalid
  name              text,        -- only when valid
  reserved_username text,        -- only when valid
  expires_at        timestamptz, -- only when valid
  email_matches     boolean      -- only when valid AND p_email given
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  r public.waitlist_signups%ROWTYPE;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO r FROM public.waitlist_signups w WHERE w.access_code = p_code_hash;
  IF NOT FOUND THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF r.status = 'onboarded' OR r.onboarded_at IS NOT NULL THEN
    outcome := 'used'; RETURN NEXT; RETURN;
  END IF;
  IF r.status <> 'access_granted' OR r.access_code_expires_at IS NULL THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF r.access_code_expires_at <= now() THEN
    outcome := 'expired'; RETURN NEXT; RETURN;
  END IF;
  outcome := 'valid';
  name := r.name;
  reserved_username := r.reserved_username;
  expires_at := r.access_code_expires_at;
  IF p_email IS NOT NULL THEN
    email_matches := lower(btrim(p_email)) = lower(btrim(r.email));
  END IF;
  RETURN NEXT;
END;
$$;

-- 3. Atomic consume-and-bind. Called AFTER the auth user exists.
--    Row locked FOR UPDATE; every condition re-checked at commit time; the
--    email binding is checked against the ACCOUNT's real email in
--    auth.users, not a caller-supplied string. Idempotent for the same user
--    (a retry after an ambiguous response returns 'already_redeemed').
--    SECURITY DEFINER only so it can read auth.users.email (service_role
--    has no grant there, and granting it table-wide would be broader than
--    this one lookup). EXECUTE is still service_role-only and search_path
--    is empty, so every reference below is schema-qualified.
CREATE OR REPLACE FUNCTION public.redeem_waitlist_invite(p_code_hash text, p_user_id uuid)
RETURNS TABLE (
  outcome text  -- redeemed | already_redeemed | invalid | expired | used | email_mismatch | no_user
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.waitlist_signups%ROWTYPE;
  v_user_email text;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_user_id IS NULL THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO r FROM public.waitlist_signups w WHERE w.access_code = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;

  IF r.status = 'onboarded' THEN
    outcome := CASE WHEN r.onboarded_user_id = p_user_id THEN 'already_redeemed' ELSE 'used' END;
    RETURN NEXT; RETURN;
  END IF;
  IF r.status <> 'access_granted' OR r.access_code_expires_at IS NULL THEN
    outcome := 'invalid'; RETURN NEXT; RETURN;
  END IF;
  IF r.access_code_expires_at <= now() THEN
    outcome := 'expired'; RETURN NEXT; RETURN;
  END IF;

  SELECT u.email INTO v_user_email FROM auth.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    outcome := 'no_user'; RETURN NEXT; RETURN;
  END IF;
  IF lower(btrim(coalesce(v_user_email, ''))) <> lower(btrim(r.email)) THEN
    outcome := 'email_mismatch'; RETURN NEXT; RETURN;
  END IF;

  UPDATE public.waitlist_signups w
     SET status = 'onboarded',
         onboarded_at = now(),
         onboarded_user_id = p_user_id
   WHERE w.id = r.id;

  outcome := 'redeemed';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.check_waitlist_invite(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_waitlist_invite(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_waitlist_invite(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_waitlist_invite(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

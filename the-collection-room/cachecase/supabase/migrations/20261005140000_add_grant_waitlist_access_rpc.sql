-- Waitlist Phase 2A: atomic grant / regenerate of invite-only access.
--
-- Function only — no table, column, constraint, RLS, policy or grant change
-- on waitlist_signups. Called exclusively by the grant-waitlist-access Edge
-- Function's service-role client; EXECUTE is revoked from every client role.
--
-- access_code stores the SHA-256 hex digest of the normalized invite code,
-- never the plaintext. The plaintext exists only in the Edge Function's
-- memory and the invite email, and is never sent to the database, so it
-- cannot appear in statement logs either.
--
-- Concurrency: the row is locked FOR UPDATE, so two simultaneous grants
-- serialize. The second sees status 'access_granted' and returns
-- 'already_granted' without writing, so at most one code is ever issued
-- per grant. Timestamps come from the database clock: now() is fixed for
-- the transaction, so access_code_expires_at = access_granted_at + 14 days
-- exactly.

CREATE OR REPLACE FUNCTION public.grant_waitlist_access(
  p_signup_id  uuid,
  p_code_hash  text,
  p_regenerate boolean DEFAULT false
)
RETURNS TABLE (
  outcome                text,  -- granted | regenerated | not_found | onboarded | already_granted | not_granted
  email                  text,
  name                   text,
  status                 text,
  access_granted_at      timestamptz,
  access_code_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  r public.waitlist_signups%ROWTYPE;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_code_hash' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.waitlist_signups w WHERE w.id = p_signup_id FOR UPDATE;

  IF NOT FOUND THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;

  -- No-write outcomes report the row's current state.
  email := r.email;
  name := r.name;
  status := r.status;
  access_granted_at := r.access_granted_at;
  access_code_expires_at := r.access_code_expires_at;

  IF r.status = 'onboarded' OR r.onboarded_at IS NOT NULL THEN
    outcome := 'onboarded';
    RETURN NEXT;
    RETURN;
  END IF;

  -- Grant and regenerate are deliberately separate actions. A plain grant
  -- never re-issues a code, and regenerate never performs a first grant.
  IF r.status = 'access_granted' AND NOT p_regenerate THEN
    outcome := 'already_granted';
    RETURN NEXT;
    RETURN;
  END IF;
  IF r.status = 'waitlisted' AND p_regenerate THEN
    outcome := 'not_granted';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.waitlist_signups w
     SET status = 'access_granted',
         access_code = p_code_hash,
         access_granted_at = now(),
         access_code_expires_at = now() + interval '14 days'
   WHERE w.id = p_signup_id
  RETURNING w.status, w.access_granted_at, w.access_code_expires_at
       INTO status, access_granted_at, access_code_expires_at;

  outcome := CASE WHEN p_regenerate THEN 'regenerated' ELSE 'granted' END;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_waitlist_access(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_waitlist_access(uuid, text, boolean) TO service_role;

-- Documentation only (no type/constraint change): the column keeps its
-- name but never holds a plaintext code.
COMMENT ON COLUMN public.waitlist_signups.access_code IS
  'SHA-256 hex digest of the normalized invite code (Crockford base32, uppercase, no separators). Never the plaintext — the code exists only in the invite email. NULL until access is granted.';

NOTIFY pgrst, 'reload schema';

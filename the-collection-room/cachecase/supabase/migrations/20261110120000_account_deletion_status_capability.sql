-- ============================================================================
-- Signed-out deletion status — a single-purpose status capability.
--
-- After Delete Now, the collector's Auth account (and with it their
-- session) is deleted, so the app can no longer call account-deletion,
-- which keeps gateway JWT verification on. To still show "Your account has
-- been deleted", account-deletion issues the app a STATUS CAPABILITY while
-- the collector is still signed in:
--   * 32 random bytes from the Edge Function's CSPRNG, base64url — never
--     derived from a job or user id;
--   * only its SHA-256 is stored here (the raw value exists only in the
--     response to the collector's own authenticated request and on their
--     device);
--   * bound to that collector's deletion job; expires after 72 hours; at
--     most 5 live per job (older ones are revoked);
--   * accepted ONLY by account-deletion-status, which answers
--     processing / completed / failed and nothing else. It cannot schedule,
--     cancel, restart or perform anything.
-- Abuse limits (all server-side): one check per capability every 2 seconds,
-- and 20 failed checks per client per 10 minutes, after which that client
-- is refused (even with a valid capability) until the window ends. Clients
-- are identified by a SHA-256 of their address, kept at most a day.
-- ============================================================================

CREATE TABLE private.account_deletion_status_tokens (
  token_hash      bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  job_id          uuid NOT NULL REFERENCES public.account_deletion_jobs (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_checked_at timestamptz,
  checks          integer NOT NULL DEFAULT 0
);
CREATE INDEX account_deletion_status_tokens_job ON private.account_deletion_status_tokens (job_id, created_at DESC);
CREATE INDEX account_deletion_status_tokens_expiry ON private.account_deletion_status_tokens (expires_at);

CREATE TABLE private.account_deletion_status_throttle (
  client_hash  bytea PRIMARY KEY CHECK (octet_length(client_hash) = 32),
  window_start timestamptz NOT NULL,
  failures     integer NOT NULL DEFAULT 0
);

REVOKE ALL ON private.account_deletion_status_tokens, private.account_deletion_status_throttle
  FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE private.account_deletion_status_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.account_deletion_status_throttle ENABLE ROW LEVEL SECURITY;

-- Issues a capability for the collector's latest deletion job (called by
-- account-deletion for the verified caller only). NULL when they have no
-- deletion job.
CREATE FUNCTION public.account_deletion_issue_status_token(p_user_id uuid, p_token_hash bytea)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job uuid;
  v_expires timestamptz := now() + interval '72 hours';
BEGIN
  IF p_user_id IS NULL OR p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid_status_token' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_job FROM public.account_deletion_jobs
  WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 1;
  IF v_job IS NULL THEN
    RETURN NULL;
  END IF;
  DELETE FROM private.account_deletion_status_tokens WHERE expires_at <= now();
  INSERT INTO private.account_deletion_status_tokens (token_hash, job_id, expires_at)
  VALUES (p_token_hash, v_job, v_expires);
  -- At most 5 live capabilities per job: revoke the oldest.
  DELETE FROM private.account_deletion_status_tokens
  WHERE job_id = v_job AND token_hash NOT IN (
    SELECT token_hash FROM private.account_deletion_status_tokens WHERE job_id = v_job ORDER BY created_at DESC, token_hash LIMIT 5);
  RETURN v_expires;
END;
$$;

-- Checks a capability. Returns {result: ok, state: processing|completed|
-- failed}, {result: invalid} (missing, unknown, revoked or expired — never
-- distinguished) or {result: rate_limited, retry_after_seconds}.
CREATE FUNCTION public.account_deletion_status_by_token(p_token_hash bytea, p_client_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_throttle private.account_deletion_status_throttle;
  v_token private.account_deletion_status_tokens;
  v_status text;
BEGIN
  IF p_client_hash IS NULL OR octet_length(p_client_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid_client' USING ERRCODE = '22023';
  END IF;

  -- Client limit: 20 failed checks per 10-minute window.
  DELETE FROM private.account_deletion_status_throttle WHERE window_start < now() - interval '1 day';
  INSERT INTO private.account_deletion_status_throttle (client_hash, window_start) VALUES (p_client_hash, now())
  ON CONFLICT (client_hash) DO NOTHING;
  SELECT * INTO v_throttle FROM private.account_deletion_status_throttle WHERE client_hash = p_client_hash FOR UPDATE;
  IF v_throttle.window_start <= now() - interval '10 minutes' THEN
    UPDATE private.account_deletion_status_throttle SET window_start = now(), failures = 0
    WHERE client_hash = p_client_hash RETURNING * INTO v_throttle;
  END IF;
  IF v_throttle.failures >= 20 THEN
    RETURN jsonb_build_object('result', 'rate_limited',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM v_throttle.window_start + interval '10 minutes' - now()))::int));
  END IF;

  SELECT * INTO v_token FROM private.account_deletion_status_tokens
  WHERE token_hash = p_token_hash AND expires_at > now() FOR UPDATE;
  IF NOT FOUND OR p_token_hash IS NULL THEN
    UPDATE private.account_deletion_status_throttle SET failures = failures + 1 WHERE client_hash = p_client_hash;
    RETURN jsonb_build_object('result', 'invalid');
  END IF;

  -- Capability limit: one check every 2 seconds.
  IF v_token.last_checked_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('result', 'rate_limited', 'retry_after_seconds', 2);
  END IF;
  UPDATE private.account_deletion_status_tokens SET last_checked_at = now(), checks = checks + 1
  WHERE token_hash = p_token_hash;

  SELECT status INTO v_status FROM public.account_deletion_jobs WHERE id = v_token.job_id;
  RETURN jsonb_build_object('result', 'ok', 'state',
    CASE v_status WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'processing' END);
END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_issue_status_token(uuid, bytea) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_status_by_token(bytea, bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_issue_status_token(uuid, bytea) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_status_by_token(bytea, bytea) TO service_role;

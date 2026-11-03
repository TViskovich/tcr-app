-- ============================================================================
-- Account maintenance scheduler — Dashboard Milestone 2, Checkpoint 4.
--
-- Every 10 minutes pg_cron asks the account-maintenance Edge Function (via
-- pg_net) to: start deletions whose 14-day window has ended, advance
-- deletion jobs (Storage cleanup → account deletion), expire Download My
-- Data archives and abandoned exports, and purge old job metadata and
-- expired username reservations.
--
-- The call is authenticated with a dedicated secret, not the service role
-- key. Both values are Vault secrets that must exist before anything runs:
--   project_url                 e.g. https://<project-ref>.supabase.co
--   account_maintenance_secret  same value as the Edge Function secret
--                               ACCOUNT_MAINTENANCE_SECRET
-- Without them the scheduled call does nothing (and says so in the log).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── Worker helpers (service role only) ─────────────────────────────────────

-- Whether permanent deletion can run safely right now.
CREATE FUNCTION public.account_deletion_preflight()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('username_key_configured', private.username_hmac('preflight') IS NOT NULL);
$$;

-- Marks manifest files as removed once they are really gone from Storage
-- (the Storage API removes the object and its metadata row together), and
-- returns how many are still present. Authoritative and idempotent: a file
-- the API reported but that still exists stays pending.
CREATE FUNCTION public.account_deletion_mark_removed(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_remaining integer;
BEGIN
  UPDATE public.account_deletion_storage_queue q
  SET deleted_at = now()
  WHERE q.job_id = p_job_id AND q.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = q.bucket AND o.name = q.path);
  SELECT count(*) INTO v_remaining FROM public.account_deletion_storage_queue WHERE job_id = p_job_id AND deleted_at IS NULL;
  UPDATE public.account_deletion_jobs
  SET objects_deleted = (SELECT count(*) FROM public.account_deletion_storage_queue WHERE job_id = p_job_id AND deleted_at IS NOT NULL),
      updated_at = now()
  WHERE id = p_job_id;
  RETURN v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_preflight() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_mark_removed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_preflight() TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_mark_removed(uuid) TO service_role;

-- ── The scheduled call ─────────────────────────────────────────────────────
CREATE FUNCTION private.run_account_maintenance()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'account_maintenance_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE LOG 'account-maintenance: project_url / account_maintenance_secret not configured in Vault; skipped';
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/account-maintenance',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;
REVOKE ALL ON FUNCTION private.run_account_maintenance() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('account-maintenance', '*/10 * * * *', 'SELECT private.run_account_maintenance()');

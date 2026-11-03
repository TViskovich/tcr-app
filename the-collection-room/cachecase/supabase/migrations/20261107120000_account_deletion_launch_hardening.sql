-- ============================================================================
-- Account deletion launch hardening — Dashboard Milestone 2, Checkpoint 5.
--
-- Fixes from the pre-launch review of Checkpoints 1–4:
--   1. Username reservations fail CLOSED. With active reservations and no
--      usable key, sign-up is refused (username_reservation_unavailable)
--      instead of letting a reserved name through, and the sign-up pre-check
--      raises instead of answering "not reserved". With no active
--      reservation at all nothing can be reserved, so sign-up stays open.
--   2. The scheduler starts INACTIVE. Production collector data never meets
--      a half-configured worker: an operator activates the cron job only
--      after the Edge Functions, their secrets and the Vault secrets are in
--      place and verified (see the deployment runbook). Delete Now is
--      offered only once the scheduler is configured and active too.
--   3. A Download My Data step can't race a deletion: an export step takes
--      its lease through account_export_take_lease, which refuses once the
--      account is deleting, and the deletion worker waits for any export
--      step still holding a lease before it builds the file manifest.
--   4. Late files: after the auth user is deleted the worker rebuilds the
--      manifest once more (anything that landed after the storage stage),
--      and every run re-checks recently completed deletions for files left
--      in the collector's folders.
--   5. Deletion-audit retention: 30 days after completion the job row is
--      deleted outright (with its file manifest), not just anonymised.
-- ============================================================================

-- ── 1. Username reservations fail closed ───────────────────────────────────
CREATE OR REPLACE FUNCTION private.reject_reserved_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hmac bytea;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.username_reservations WHERE reserved_until > now()) THEN
    RETURN NEW; -- nothing is reserved, so nothing to compare against
  END IF;
  v_hmac := private.username_hmac(NEW.username);
  IF v_hmac IS NULL THEN
    RAISE EXCEPTION 'username_reservation_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM private.username_reservations r WHERE r.username_hmac = v_hmac AND r.reserved_until > now()) THEN
    RAISE EXCEPTION 'username_reserved' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.username_is_reserved(p_username text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hmac bytea;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.username_reservations WHERE reserved_until > now()) THEN
    RETURN false;
  END IF;
  v_hmac := private.username_hmac(p_username);
  IF v_hmac IS NULL THEN
    RAISE EXCEPTION 'username_reservation_unavailable' USING ERRCODE = 'P0001';
  END IF;
  RETURN EXISTS (SELECT 1 FROM private.username_reservations r WHERE r.username_hmac = v_hmac AND r.reserved_until > now());
END;
$$;

-- ── 2. The scheduler starts inactive; readiness covers it ──────────────────
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-maintenance';

-- username_key_configured: reservations can be written and checked.
-- scheduler_configured: the Vault values the scheduled call needs exist
--   and the cron job is active.
-- ready: permanent deletion may be offered and processed.
CREATE OR REPLACE FUNCTION public.account_deletion_preflight()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH c AS (
    SELECT private.username_hmac('preflight') IS NOT NULL AS key_ok,
           EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url' AND decrypted_secret LIKE 'http%')
             AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'account_maintenance_secret' AND length(decrypted_secret) >= 32)
             AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'account-maintenance' AND active) AS scheduler_ok
  )
  SELECT jsonb_build_object('username_key_configured', key_ok, 'scheduler_configured', scheduler_ok, 'ready', key_ok AND scheduler_ok)
  FROM c;
$$;

-- ── 3. Export steps vs. deletion ───────────────────────────────────────────
-- Takes the one-step lease on an export in progress. Refuses (NULL) when
-- another step holds it, the export isn't in progress, or the account is
-- deleting. The lifecycle row is read FOR SHARE so this serialises with
-- begin_account_deletion (which locks it FOR UPDATE).
CREATE FUNCTION public.account_export_take_lease(p_export_id uuid, p_lease_seconds integer)
RETURNS SETOF public.account_exports
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_state text;
BEGIN
  SELECT user_id INTO v_user FROM public.account_exports WHERE id = p_export_id;
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  SELECT state INTO v_state FROM public.account_lifecycle WHERE user_id = v_user FOR SHARE;
  IF v_state = 'deleting' THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.account_exports e
  SET lease_until = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 90), 10), 300))
  WHERE e.id = p_export_id AND e.status IN ('queued', 'collecting', 'archiving')
    AND (e.lease_until IS NULL OR e.lease_until < now())
  RETURNING e.*;
END;
$$;

-- True while an export step of the job's collector still holds its lease.
CREATE FUNCTION public.account_deletion_export_busy(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_exports e
    JOIN public.account_deletion_jobs j ON j.user_id = e.user_id
    WHERE j.id = p_job_id AND e.status IN ('queued', 'collecting', 'archiving') AND e.lease_until > now()
  );
$$;

-- ── 4. Late files after completion ─────────────────────────────────────────
-- Completed deletions (identity not yet purged) that still have files in
-- the collector's own folders — e.g. an upload that was in flight while the
-- account was deleted. The worker rebuilds their manifest and removes them.
CREATE FUNCTION public.account_deletion_late_files(p_limit integer DEFAULT 10)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT j.id FROM public.account_deletion_jobs j
  WHERE j.status = 'completed' AND j.user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE (o.bucket_id IN ('avatars', 'item-images', 'share-snapshots', 'account-exports') AND o.name LIKE j.user_id::text || '/%')
         OR (o.bucket_id = 'dm-attachments' AND (o.owner = j.user_id OR o.owner_id = j.user_id::text))
    )
  ORDER BY j.completed_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

-- ── 5. Audit retention: delete, don't just anonymise ───────────────────────
CREATE OR REPLACE FUNCTION public.account_deletion_housekeeping()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jobs integer;
  v_reservations integer;
BEGIN
  -- The file manifest goes with the job (ON DELETE CASCADE).
  DELETE FROM public.account_deletion_jobs WHERE status = 'completed' AND purge_after <= now();
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  DELETE FROM private.username_reservations WHERE reserved_until <= now();
  GET DIAGNOSTICS v_reservations = ROW_COUNT;
  RETURN jsonb_build_object('jobs_purged', v_jobs, 'reservations_expired', v_reservations);
END;
$$;

REVOKE ALL ON FUNCTION public.account_export_take_lease(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_export_busy(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_late_files(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_export_take_lease(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_export_busy(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_late_files(integer) TO service_role;

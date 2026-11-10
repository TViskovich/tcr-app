-- Phase 2B M2.3c — media quarantine and restoration workers (database half).
--
-- The admin-media-quarantine and admin-media-restore Edge Functions perform
-- the Storage work; this migration gives them a narrow, service-role-only
-- contract and makes the database verify every step against Storage itself:
--
--   * claim:     media_quarantine_claim (quarantine work, now including
--                released "retain" jobs and finishing cancelled ones) and
--                media_quarantine_claim_restore (only admin-authorized jobs
--                whose holds have ALL ended with "restore").
--   * inspect:   media_quarantine_inspect — the job, its holds, the owner
--                account, and the CURRENT source and quarantine objects.
--   * advance:   media_quarantine_advance now checks storage.objects before
--                accepting a step: "copied"/"verified" need the private copy
--                to exist with the right size; "quarantined" needs the source
--                to be GONE and the copy present; "restored" needs the source
--                back. A Storage delete or upload response is never enough.
--   * authorize: media_quarantine_authorize — admin re-check (membership and
--                account lifecycle) and, for restoration, per-job eligibility
--                including a second-admin rule for child safety.
--   * failure:   transient errors back off (bounded); permanent validation
--                failures, and jobs out of attempts, are flagged
--                needs_attention and leave the queue until an admin retries.
--   * audit:     every step and admin request records the admin actor.
--
-- Child safety: legal-hold copies are never purged and never restored without
-- an explicit second-admin request. The permanent legal hold itself needs a
-- separate M4 retention-policy review; this gate does not weaken it.

ALTER TABLE private.media_quarantine
  ADD COLUMN needs_attention boolean NOT NULL DEFAULT false,
  ADD COLUMN source_object_id uuid,     -- storage.objects.id at queue time
  ADD COLUMN source_version text;       -- storage.objects.version at queue time (changes on overwrite)
ALTER TABLE private.media_quarantine_events ADD COLUMN actor_id uuid;
-- Every event names its actor: worker steps pass the verified admin; events
-- written by the restriction triggers (queued, hold added/ended, released)
-- run inside the admin's own API call, so they take that caller's id.
CREATE FUNCTION private.media_quarantine_event_actor()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.actor_id := COALESCE(NEW.actor_id, auth.uid());
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.media_quarantine_event_actor() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER media_quarantine_event_actor BEFORE INSERT ON private.media_quarantine_events
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_event_actor();
DROP INDEX private.media_quarantine_work_idx;
CREATE INDEX media_quarantine_work_idx ON private.media_quarantine (state, next_attempt_at)
  WHERE state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring') AND NOT needs_attention;

-- Immutable source identity (copied from 20261119120000, plus the new columns).
CREATE OR REPLACE FUNCTION private.media_quarantine_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_bucket IS DISTINCT FROM OLD.source_bucket
     OR NEW.source_path IS DISTINCT FROM OLD.source_path OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.media_kind IS DISTINCT FROM OLD.media_kind OR NEW.origin_target_type IS DISTINCT FROM OLD.origin_target_type
     OR NEW.origin_target_id IS DISTINCT FROM OLD.origin_target_id OR NEW.quarantine_bucket IS DISTINCT FROM OLD.quarantine_bucket
     OR NEW.quarantine_path IS DISTINCT FROM OLD.quarantine_path OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.child_safety AND NOT NEW.child_safety) OR (OLD.legal_hold AND NOT NEW.legal_hold)
     OR (OLD.source_sha256 IS NOT NULL AND NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256)
     OR (OLD.source_removed_at IS NOT NULL AND NEW.source_removed_at IS DISTINCT FROM OLD.source_removed_at)
     -- 20261120120000: the source identity recorded at queue time is fixed
     OR (OLD.source_object_id IS NOT NULL AND NEW.source_object_id IS DISTINCT FROM OLD.source_object_id)
     OR (OLD.source_version IS NOT NULL AND NEW.source_version IS DISTINCT FROM OLD.source_version)
     OR OLD.state IN ('restored', 'cancelled') THEN
    RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_ok := CASE OLD.state
      WHEN 'pending'         THEN NEW.state IN ('copied', 'source_missing', 'failed', 'cancelled')
      WHEN 'copied'          THEN NEW.state IN ('verified', 'failed', 'cancelled')
      WHEN 'verified'        THEN NEW.state IN ('quarantined', 'failed', 'cancelled')
      WHEN 'quarantined'     THEN NEW.state IN ('restore_pending')
      WHEN 'source_missing'  THEN NEW.state IN ('cancelled')
      WHEN 'restore_pending' THEN NEW.state IN ('restoring', 'quarantined')
      WHEN 'restoring'       THEN NEW.state IN ('restored', 'failed', 'quarantined')
      WHEN 'failed'          THEN NEW.state IN ('pending', 'copied', 'verified', 'restore_pending', 'cancelled')
      ELSE false
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_quarantine_transition' USING ERRCODE = '22023',
        DETAIL = OLD.state || ' -> ' || NEW.state;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Record the exact object a restriction holds (copied from 20261119120000,
-- plus source_object_id / source_version).
CREATE OR REPLACE FUNCTION private.queue_media_hold(
  p_mod uuid, p_field uuid, p_bucket text, p_path text, p_owner uuid, p_kind text,
  p_child_safety boolean, p_target_type text, p_target_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_job private.media_quarantine;
  v_obj storage.objects;
BEGIN
  IF p_path IS NULL THEN RETURN; END IF;
  IF p_owner IS NULL OR p_path !~ '^[^/\\]+(/[^/\\]+)+$' OR p_path LIKE '%..%' THEN
    INSERT INTO private.media_quarantine_events (moderation_id, event, detail)
    VALUES (p_mod, 'skipped', jsonb_build_object('reason', 'invalid_path', 'bucket', p_bucket));
    RETURN;
  END IF;
  -- Ownership: every collector-writable bucket is namespaced by owner id; a DM
  -- photo is namespaced by conversation and comes only from the trusted
  -- messages row (its sender is the owner).
  IF p_bucket <> 'dm-attachments' AND split_part(p_path, '/', 1) <> p_owner::text THEN
    INSERT INTO private.media_quarantine_events (moderation_id, event, detail)
    VALUES (p_mod, 'skipped', jsonb_build_object('reason', 'not_owned', 'bucket', p_bucket));
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('media-quarantine:' || p_bucket || '/' || p_path, 0));

  SELECT * INTO v_job FROM private.media_quarantine q
   WHERE q.source_bucket = p_bucket AND q.source_path = p_path AND q.state NOT IN ('restored', 'cancelled')
   FOR UPDATE;
  IF FOUND THEN
    IF v_job.owner_id <> p_owner THEN
      INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, detail)
      VALUES (v_job.id, p_mod, 'skipped', jsonb_build_object('reason', 'owner_mismatch'));
      RETURN;
    END IF;
    INSERT INTO private.media_quarantine_holds (quarantine_id, moderation_id, profile_field_id)
    VALUES (v_job.id, p_mod, p_field)
    ON CONFLICT (quarantine_id, moderation_id, COALESCE(profile_field_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE ended_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, from_state, to_state)
      VALUES (v_job.id, p_mod, 'hold_added', v_job.state, v_job.state);
    END IF;
    -- A new hold always wants the file out again.
    UPDATE private.media_quarantine
       SET desired = 'quarantine', retain_until = NULL,
           child_safety = child_safety OR p_child_safety, legal_hold = legal_hold OR p_child_safety,
           state = CASE WHEN state = 'restore_pending' THEN 'quarantined' ELSE state END
     WHERE id = v_job.id
       AND (desired <> 'quarantine' OR retain_until IS NOT NULL OR (p_child_safety AND NOT child_safety) OR state = 'restore_pending');
    RETURN;
  END IF;

  SELECT * INTO v_obj FROM storage.objects o WHERE o.bucket_id = p_bucket AND o.name = p_path;
  INSERT INTO private.media_quarantine (source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                        mime_type, size_bytes, source_object_id, source_version,
                                        quarantine_path, state, child_safety, legal_hold)
  VALUES (p_bucket, p_path, p_owner, p_kind, p_target_type, p_target_id,
          v_obj.metadata ->> 'mimetype', (v_obj.metadata ->> 'size')::bigint,
          v_obj.id, v_obj.version, -- 20261120120000: the exact object that was moderated
          'q/' || gen_random_uuid()::text || '/original',
          CASE WHEN v_obj.id IS NULL THEN 'source_missing' ELSE 'pending' END,
          p_child_safety, p_child_safety)
  RETURNING * INTO v_job;
  INSERT INTO private.media_quarantine_holds (quarantine_id, moderation_id, profile_field_id) VALUES (v_job.id, p_mod, p_field);
  INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, to_state, detail)
  VALUES (v_job.id, p_mod, 'queued', v_job.state, jsonb_build_object('kind', p_kind, 'bucket', p_bucket));
END;
$$;


-- Exactly one attempt budget for every job.
CREATE FUNCTION private.media_quarantine_max_attempts()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 5 $$;

-- ── Claim ───────────────────────────────────────────────────────────────────
-- Quarantine work only: files that must leave their source (desired
-- quarantine or retain) and unneeded copies whose holds all ended before the
-- source was removed (finished as cancelled; the copy is retained). Restore
-- work is never claimed here.
CREATE OR REPLACE FUNCTION public.media_quarantine_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, state text, desired text, source_bucket text, source_path text, quarantine_bucket text,
               quarantine_path text, owner_id uuid, size_bytes bigint, source_sha256 text, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT q.id FROM private.media_quarantine q
     WHERE NOT q.needs_attention
       AND (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= clock_timestamp())
       AND ((q.desired IN ('quarantine', 'retain') AND q.state IN ('pending', 'copied', 'verified'))
            OR (q.desired = 'restore' AND q.state IN ('copied', 'verified')))
     ORDER BY q.child_safety DESC, q.created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE private.media_quarantine q
     SET lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         attempts = q.attempts + 1
    FROM c WHERE q.id = c.id
  RETURNING q.id, q.state, q.desired, q.source_bucket, q.source_path, q.quarantine_bucket, q.quarantine_path,
            q.owner_id, q.size_bytes, q.source_sha256, q.lease_token;
END;
$$;

-- Restore work: only the given jobs, only if every hold ended with "restore"
-- (none active, none "retain"), not flagged, and not leased.
CREATE FUNCTION public.media_quarantine_claim_restore(p_job_ids uuid[], p_lease_seconds integer)
RETURNS TABLE (id uuid, state text, desired text, source_bucket text, source_path text, quarantine_bucket text,
               quarantine_path text, owner_id uuid, size_bytes bigint, source_sha256 text, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_job_ids IS NULL OR cardinality(p_job_ids) NOT BETWEEN 1 AND 10 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT q.id FROM private.media_quarantine q
     WHERE q.id = ANY (p_job_ids)
       AND NOT q.needs_attention
       AND q.desired = 'restore' AND q.state IN ('restore_pending', 'restoring')
       AND (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM private.media_quarantine_holds h
                        WHERE h.quarantine_id = q.id AND (h.ended_at IS NULL OR h.end_disposition <> 'restore'))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE private.media_quarantine q
     SET lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         attempts = q.attempts + 1
    FROM c WHERE q.id = c.id
  RETURNING q.id, q.state, q.desired, q.source_bucket, q.source_path, q.quarantine_bucket, q.quarantine_path,
            q.owner_id, q.size_bytes, q.source_sha256, q.lease_token;
END;
$$;

-- ── Inspect ─────────────────────────────────────────────────────────────────
-- Everything a worker step must re-check, read fresh under a valid lease.
-- `path_owned` re-derives the M2.3b ownership rule from the job itself, so a
-- tampered or inconsistent record is caught before any file is touched.
CREATE FUNCTION public.media_quarantine_inspect(p_id uuid, p_lease uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  s storage.objects;
  c storage.objects;
  v_owned boolean;
BEGIN
  SELECT * INTO j FROM private.media_quarantine q WHERE q.id = p_id;
  IF NOT FOUND OR p_lease IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_expires_at < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease');
  END IF;
  SELECT * INTO s FROM storage.objects o WHERE o.bucket_id = j.source_bucket AND o.name = j.source_path;
  SELECT * INTO c FROM storage.objects o WHERE o.bucket_id = j.quarantine_bucket AND o.name = j.quarantine_path;
  v_owned := j.source_path ~ '^[^/\\]+(/[^/\\]+)+$' AND j.source_path NOT LIKE '%..%' AND CASE
    WHEN j.source_bucket = 'dm-attachments' THEN EXISTS (
      SELECT 1 FROM public.messages m WHERE m.sender_id = j.owner_id AND m.attachment_storage_path = j.source_path)
      OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.owner_id) -- sender deleted: path kept as recorded
    ELSE split_part(j.source_path, '/', 1) = j.owner_id::text END;
  RETURN jsonb_build_object(
    'ok', true,
    'state', j.state, 'desired', j.desired, 'child_safety', j.child_safety, 'legal_hold', j.legal_hold,
    'source_bucket', j.source_bucket, 'source_path', j.source_path,
    'quarantine_bucket', j.quarantine_bucket, 'quarantine_path', j.quarantine_path,
    'path_owned', v_owned,
    'active_holds', (SELECT count(*) FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.ended_at IS NULL),
    'retain_holds', (SELECT count(*) FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.end_disposition = 'retain'),
    'owner_exists', EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.owner_id),
    'owner_hidden', private.account_is_hidden(j.owner_id),
    'recorded', jsonb_build_object('size', j.size_bytes, 'mime', j.mime_type, 'object_id', j.source_object_id,
                                   'version', j.source_version, 'source_sha256', j.source_sha256,
                                   'quarantine_sha256', j.quarantine_sha256),
    'source', CASE WHEN s.id IS NULL THEN jsonb_build_object('exists', false) ELSE jsonb_build_object(
      'exists', true, 'object_id', s.id, 'version', s.version, 'size', (s.metadata ->> 'size')::bigint,
      'mime', s.metadata ->> 'mimetype') END,
    'copy', CASE WHEN c.id IS NULL THEN jsonb_build_object('exists', false) ELSE jsonb_build_object(
      'exists', true, 'size', (c.metadata ->> 'size')::bigint, 'mime', c.metadata ->> 'mimetype') END);
END;
$$;

-- ── Advance ─────────────────────────────────────────────────────────────────
-- Records one worker step under its lease, after checking Storage itself.
-- facts: source_sha256, quarantine_sha256, size_bytes, mime_type, error (a
-- code), permanent (true = validation failure: flag for attention now),
-- source_removed, actor (the verified admin running the worker).
CREATE OR REPLACE FUNCTION public.media_quarantine_advance(p_id uuid, p_lease uuid, p_to_state text, p_facts jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  v_err text := NULLIF(p_facts ->> 'error', '');
  v_actor uuid := NULLIF(p_facts ->> 'actor', '')::uuid;
  v_src boolean;
  v_copy_size bigint;
  v_copy boolean;
  v_attention boolean;
  v_reason text;
BEGIN
  SELECT * INTO j FROM private.media_quarantine q WHERE q.id = p_id FOR UPDATE;
  IF NOT FOUND OR p_lease IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_expires_at < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease');
  END IF;
  v_src := EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = j.source_bucket AND o.name = j.source_path);
  SELECT (o.metadata ->> 'size')::bigint INTO v_copy_size FROM storage.objects o
   WHERE o.bucket_id = j.quarantine_bucket AND o.name = j.quarantine_path;
  v_copy := FOUND;

  -- Storage-verified preconditions (never trust the worker's own report).
  v_reason := CASE
    WHEN p_to_state IN ('copied', 'verified') AND NOT v_copy THEN 'copy_missing'
    WHEN p_to_state IN ('copied', 'verified') AND v_copy_size IS DISTINCT FROM COALESCE((p_facts ->> 'size_bytes')::bigint, j.size_bytes) THEN 'copy_size_mismatch'
    WHEN p_to_state = 'quarantined' AND (p_facts ->> 'source_removed') IS DISTINCT FROM 'true' THEN 'source_not_removed'
    WHEN p_to_state = 'quarantined' AND v_src THEN 'source_still_present'
    WHEN p_to_state = 'quarantined' AND NOT v_copy THEN 'copy_missing'
    WHEN p_to_state = 'quarantined' AND j.desired = 'quarantine'
         AND NOT EXISTS (SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.ended_at IS NULL) THEN 'no_active_hold'
    WHEN p_to_state = 'source_missing' AND v_src THEN 'source_still_present'
    WHEN p_to_state = 'cancelled' AND j.state IN ('copied', 'verified') AND j.desired <> 'restore' THEN 'still_held'
    -- Cancelling is only safe while the source is still in place; once it is
    -- gone the verified copy is the file, so it must be recorded quarantined.
    WHEN p_to_state = 'cancelled' AND j.state IN ('copied', 'verified') AND NOT v_src THEN 'source_absent'
    WHEN p_to_state = 'restoring' AND (j.desired <> 'restore' OR EXISTS (
           SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND (h.ended_at IS NULL OR h.end_disposition <> 'restore'))) THEN 'still_held'
    WHEN p_to_state = 'restored' AND NOT v_src THEN 'source_not_restored'
    WHEN p_to_state = 'restored' AND NOT v_copy THEN 'copy_missing'
  END;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  v_attention := v_err IS NOT NULL AND ((p_facts ->> 'permanent') IS NOT DISTINCT FROM 'true'
                                       OR j.attempts >= private.media_quarantine_max_attempts());
  BEGIN
    UPDATE private.media_quarantine
       SET state = p_to_state,
           source_sha256 = COALESCE(source_sha256, p_facts ->> 'source_sha256'),
           quarantine_sha256 = COALESCE(p_facts ->> 'quarantine_sha256', quarantine_sha256),
           size_bytes = COALESCE(size_bytes, (p_facts ->> 'size_bytes')::bigint),
           mime_type = COALESCE(mime_type, p_facts ->> 'mime_type'),
           source_removed_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE source_removed_at END,
           quarantined_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END,
           restored_at = CASE WHEN p_to_state = 'restored' THEN clock_timestamp() ELSE restored_at END,
           -- The private copy is never purged here; a non-legal-hold copy gets a
           -- retention date for M4 once it is no longer needed as evidence.
           retain_until = CASE
             WHEN legal_hold THEN NULL
             WHEN p_to_state = 'quarantined' AND desired = 'retain' THEN COALESCE(retain_until, clock_timestamp() + interval '90 days')
             WHEN p_to_state IN ('restored', 'cancelled') THEN COALESCE(retain_until, clock_timestamp() + interval '90 days')
             ELSE retain_until END,
           last_error = v_err,
           needs_attention = needs_attention OR v_attention,
           next_attempt_at = CASE WHEN v_err IS NOT NULL AND NOT v_attention
                                  THEN clock_timestamp() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7))::integer)) END,
           attempts = CASE WHEN v_err IS NULL AND p_to_state <> state THEN 0 ELSE attempts END,
           lease_token = CASE WHEN v_err IS NOT NULL OR p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_token END,
           lease_expires_at = CASE WHEN v_err IS NOT NULL OR p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_expires_at END
     WHERE id = p_id;
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END;
  INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id, detail)
  VALUES (p_id, CASE WHEN v_attention THEN 'needs_attention' WHEN v_err IS NOT NULL THEN 'worker_retry' ELSE 'worker_step' END,
          j.state, p_to_state, v_actor, jsonb_strip_nulls(jsonb_build_object('error', v_err, 'attempt', j.attempts)));
  -- Every hold ended with "restore" while the worker was removing the source:
  -- the file is now only in quarantine, so it goes straight to restore_pending
  -- (an admin restores it; nothing is lost or left stranded).
  IF p_to_state = 'quarantined' AND j.desired = 'restore' THEN
    UPDATE private.media_quarantine SET state = 'restore_pending' WHERE id = p_id;
    INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id)
    VALUES (p_id, 'released', 'quarantined', 'restore_pending', v_actor);
  END IF;
  RETURN jsonb_build_object('ok', true, 'needs_attention', v_attention,
                            'state', (SELECT q.state FROM private.media_quarantine q WHERE q.id = p_id));
END;
$$;

-- ── Authorize ───────────────────────────────────────────────────────────────
-- Called by both worker functions with the admin id the Edge Function verified
-- from the caller's JWT. Re-checks membership and account lifecycle here (the
-- database is the authority). For 'restore', decides each requested job:
--   restorable only if desired = restore, every hold ended with "restore",
--   the job is restore_pending/restoring and not flagged, and the owner
--   account still exists and is not pending deletion. A child-safety job also
--   needs p_confirm_child_safety and an admin who did not impose any of its
--   restrictions (second-admin review). Requests are audited per job.
CREATE FUNCTION public.media_quarantine_authorize(p_admin uuid, p_action text, p_job_ids uuid[] DEFAULT NULL,
                                                  p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  v_decisions jsonb := '[]'::jsonb;
  v_reason text;
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = p_admin)
     OR private.account_is_hidden(p_admin) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF p_action = 'quarantine' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF p_action <> 'restore' OR p_job_ids IS NULL OR cardinality(p_job_ids) NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_argument');
  END IF;
  FOR j IN SELECT q.* FROM private.media_quarantine q WHERE q.id = ANY (p_job_ids) ORDER BY q.id LOOP
    v_reason := CASE
      WHEN j.desired <> 'restore' OR EXISTS (SELECT 1 FROM private.media_quarantine_holds h
             WHERE h.quarantine_id = j.id AND (h.ended_at IS NULL OR h.end_disposition <> 'restore')) THEN 'not_released'
      WHEN j.state = 'restored' THEN 'already_restored'
      WHEN j.state NOT IN ('restore_pending', 'restoring') THEN 'not_restorable'
      WHEN j.needs_attention THEN 'needs_attention'
      WHEN NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.owner_id) THEN 'owner_deleted'
      WHEN private.account_is_hidden(j.owner_id) THEN 'owner_unavailable'
      WHEN j.child_safety AND NOT COALESCE(p_confirm_child_safety, false) THEN 'child_safety_confirmation_required'
      WHEN j.child_safety AND EXISTS (SELECT 1 FROM private.media_quarantine_holds h JOIN public.moderated_content m ON m.id = h.moderation_id
             WHERE h.quarantine_id = j.id AND m.created_by = p_admin) THEN 'second_admin_required'
    END;
    v_decisions := v_decisions || jsonb_build_object('id', j.id, 'allowed', v_reason IS NULL, 'reason', v_reason);
    INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id, detail)
    VALUES (j.id, CASE WHEN v_reason IS NULL THEN 'restore_requested' ELSE 'restore_refused' END, j.state, j.state, p_admin,
            jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'child_safety_confirmed', CASE WHEN j.child_safety THEN p_confirm_child_safety END)));
  END LOOP;
  -- Unknown ids are reported like any refusal, revealing nothing else.
  SELECT v_decisions || COALESCE(jsonb_agg(jsonb_build_object('id', x, 'allowed', false, 'reason', 'not_restorable')), '[]'::jsonb)
    INTO v_decisions FROM unnest(p_job_ids) x WHERE NOT EXISTS (SELECT 1 FROM private.media_quarantine q WHERE q.id = x);
  RETURN jsonb_build_object('ok', true, 'jobs', v_decisions);
END;
$$;

-- ── Admin operations ────────────────────────────────────────────────────────
-- Queue health for admins: counts and every job needing attention (ids,
-- kinds and error codes only — paths stay in admin_media_quarantine_status).
CREATE FUNCTION public.admin_media_quarantine_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'counts', COALESCE((SELECT jsonb_object_agg(k, n) FROM (
      SELECT state || ':' || desired AS k, count(*) AS n FROM private.media_quarantine GROUP BY 1) s), '{}'::jsonb),
    'oldest_open_at', (SELECT min(created_at) FROM private.media_quarantine
                        WHERE state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring')),
    'needs_attention', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'kind', q.media_kind, 'state', q.state, 'desired', q.desired, 'child_safety', q.child_safety,
        'last_error', q.last_error, 'attempts', q.attempts, 'updated_at', q.updated_at) ORDER BY q.child_safety DESC, q.updated_at)
      FROM private.media_quarantine q WHERE q.needs_attention), '[]'::jsonb));
END;
$$;

-- An admin returns a flagged job to the queue after investigating (audited).
CREATE FUNCTION public.admin_media_quarantine_retry(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  j private.media_quarantine;
BEGIN
  SELECT * INTO j FROM private.media_quarantine q WHERE q.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF NOT j.needs_attention THEN
    RETURN jsonb_build_object('id', j.id, 'changed', false);
  END IF;
  UPDATE private.media_quarantine SET needs_attention = false, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = j.id;
  INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, actor_id, detail)
  VALUES (j.id, 'retry_requested', j.state, j.state, v_admin, jsonb_build_object('previous_error', j.last_error));
  RETURN jsonb_build_object('id', j.id, 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_media_quarantine_status(p_moderation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'moderation_id', p_moderation_id,
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'bucket', q.source_bucket, 'path', q.source_path, 'kind', q.media_kind, 'state', q.state,
               'desired', q.desired, 'child_safety', q.child_safety, 'legal_hold', q.legal_hold,
               'retain_until', q.retain_until, 'last_error', q.last_error, 'attempts', q.attempts,
               'needs_attention', q.needs_attention, -- 20261120120000
               'hold_active', h.ended_at IS NULL, 'hold_ended_at', h.ended_at, 'end_disposition', h.end_disposition,
               'created_at', q.created_at, 'updated_at', q.updated_at) ORDER BY q.created_at)
        FROM private.media_quarantine_holds h JOIN private.media_quarantine q ON q.id = h.quarantine_id
       WHERE h.moderation_id = p_moderation_id), '[]'::jsonb),
    'skipped', COALESCE((
      SELECT jsonb_agg(e.detail ORDER BY e.id) FROM private.media_quarantine_events e
       WHERE e.moderation_id = p_moderation_id AND e.event = 'skipped'), '[]'::jsonb));
END;
$$;


-- ── Privileges ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.media_quarantine_max_attempts() FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.media_quarantine_claim(integer, integer)',
    'public.media_quarantine_claim_restore(uuid[], integer)',
    'public.media_quarantine_inspect(uuid, uuid)',
    'public.media_quarantine_advance(uuid, uuid, text, jsonb)',
    'public.media_quarantine_authorize(uuid, text, uuid[], boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.admin_media_quarantine_overview()', 'public.admin_media_quarantine_retry(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

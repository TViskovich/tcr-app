-- Phase 2B M4 step 4A — retention security hardening (no purge executor).
--
-- Closes the gaps found by the M4 purge design review:
--   G1  content_reports.evidence could be cleared by ANY role with UPDATE (the
--       service role has it) once evidence_purge_after had passed — no hold or
--       child-safety check. Now clearing evidence needs a purge claim made in
--       the SAME transaction, approved by two different admins, and every
--       eligibility rule is re-checked under the legal-hold locks.
--   G2  the service role could DELETE (or TRUNCATE) reports outright. Its
--       write privileges on content_reports are revoked, and DELETE/TRUNCATE
--       are refused for everyone except a database operator acting as
--       themselves (the same narrow exemption the Storage guard already uses).
--   G3  nothing in the database protected objects in the private
--       moderation-quarantine bucket from the service role. A delete there now
--       needs a live, unexpired, single-use claim for that exact path and job,
--       re-checked (child safety, legal holds, job state) inside the Storage
--       API's own delete transaction; after verification a copy can no longer
--       be overwritten, moved or soft-deleted.
--   G6  report evidence whose owner was erased by account deletion is blocked
--       while ANY active account hold names an account that no longer exists
--       (the hold can no longer be matched, so it fails closed).
--
-- Claims (private.retention_purge_claims) have NO API grants and no function
-- in this migration creates one: until the separately approved executor
-- exists, evidence cannot be cleared and quarantine copies cannot be deleted
-- by any API role at all. There is no session flag or setting that unlocks
-- either path.
--
-- Unchanged: report review, reopening and restoring (they never clear
-- evidence), account deletion (it only sets report ids to NULL and never lists
-- the quarantine bucket), the quarantine and restore workers (they create,
-- verify and read copies, and copy back to the source), and data export.

-- ── 1. Report privileges (G2) ───────────────────────────────────────────────
-- Reports are written only through SECURITY DEFINER functions; the service
-- role keeps read access.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.content_reports FROM service_role;

-- ── 2. Purge claims ─────────────────────────────────────────────────────────
-- A claim authorises exactly one purge of exactly one subject, for at most
-- five minutes, and records both admins (prepared_by ≠ approved_by). It is
-- closed when used or once expired, and never reused.
CREATE TABLE private.retention_purge_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind     text NOT NULL CHECK (subject_kind IN ('report_evidence', 'quarantine_copy')),
  subject_id       uuid NOT NULL,
  object_bucket    text CHECK (object_bucket = 'moderation-quarantine'),
  object_path      text CHECK (object_path ~ '^q/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original$'),
  run_id           uuid,                       -- the future approved run
  prepared_by      uuid NOT NULL,
  approved_by      uuid NOT NULL,
  claimed_xact     xid8 NOT NULL DEFAULT pg_current_xact_id(),
  claimed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  closed_at        timestamptz,
  close_reason     text CHECK (close_reason IN ('consumed', 'expired')),
  CONSTRAINT retention_purge_claims_two_admins CHECK (prepared_by <> approved_by),
  CONSTRAINT retention_purge_claims_object_shape CHECK (
    (subject_kind = 'quarantine_copy') = (object_bucket IS NOT NULL AND object_path IS NOT NULL)),
  CONSTRAINT retention_purge_claims_lease_shape CHECK (
    lease_expires_at > claimed_at AND lease_expires_at <= claimed_at + interval '5 minutes'),
  CONSTRAINT retention_purge_claims_close_shape CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
-- One open claim per subject.
CREATE UNIQUE INDEX retention_purge_claims_one_open ON private.retention_purge_claims (subject_kind, subject_id)
  WHERE closed_at IS NULL;
CREATE INDEX retention_purge_claims_object_idx ON private.retention_purge_claims (object_bucket, object_path)
  WHERE closed_at IS NULL;
ALTER TABLE private.retention_purge_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.retention_purge_claims FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Shared eligibility (one source for discovery, claims and guards) ─────
-- G6: an active account hold whose account no longer exists can't be matched
-- to reports whose owner id was erased by that deletion.
CREATE FUNCTION private.orphaned_account_hold_exists()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.moderation_legal_holds h
     WHERE h.subject_kind = 'account' AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = h.subject_id));
$$;

-- Everything that stops this report's evidence from being purged, in a fixed
-- order. Empty + due (evidence_purge_after <= now()) = eligible.
CREATE FUNCTION private.report_evidence_purge_blockers(p_report_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT array_remove(ARRAY[
           CASE WHEN private.report_is_child_safety(r.id) THEN 'child_safety' END,
           CASE WHEN r.status IN ('open', 'reviewing') THEN 'open_report' END,
           CASE WHEN private.legal_hold_active('report', r.id)
                  OR (r.target_owner_id IS NOT NULL AND private.legal_hold_active('account', r.target_owner_id))
                THEN 'legal_hold' END,
           CASE WHEN r.target_owner_id IS NULL AND private.orphaned_account_hold_exists()
                THEN 'deleted_owner_hold_ambiguous' END,
           CASE WHEN EXISTS (SELECT 1 FROM public.moderated_content m
                              WHERE (m.id = r.moderation_id OR m.report_id = r.id) AND m.lifted_at IS NULL)
                THEN 'live_restriction' END,
           CASE WHEN EXISTS (SELECT 1 FROM public.moderated_profile_fields f WHERE f.report_id = r.id AND f.status = 'active')
                THEN 'live_profile_field' END,
           CASE WHEN EXISTS (SELECT 1 FROM public.account_suspensions s WHERE s.report_id = r.id AND s.lifted_at IS NULL
                                AND (s.expires_at IS NULL OR s.expires_at > now()))
                THEN 'live_suspension' END,
           CASE WHEN r.status IN ('actioned', 'dismissed') AND r.evidence_purge_after IS NULL THEN 'no_retention_date' END,
           CASE WHEN (SELECT p.status IN ('proposed', 'unresolved') FROM private.retention_policy p
                       WHERE p.key = 'report_evidence_after_resolution') IS DISTINCT FROM false
                THEN 'policy_pending_legal_review' END
         ], NULL)
    FROM public.content_reports r WHERE r.id = p_report_id;
$$;

-- Everything that stops this quarantine copy from being purged. Phase 1 only
-- terminal jobs (restored / cancelled): a retained 'quarantined' job is still
-- live (a new restriction would reuse it), so it is blocked as not terminal.
CREATE FUNCTION private.quarantine_copy_purge_blockers(p_quarantine_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT array_remove(ARRAY[
           CASE WHEN q.child_safety THEN 'child_safety' END,
           CASE WHEN q.legal_hold THEN 'quarantine_legal_hold' END,
           CASE WHEN private.legal_hold_active('quarantine_copy', q.id) OR private.legal_hold_active('account', q.owner_id)
                THEN 'legal_hold' END,
           CASE WHEN EXISTS (SELECT 1 FROM private.media_quarantine_holds mh WHERE mh.quarantine_id = q.id AND mh.ended_at IS NULL)
                THEN 'live_restriction' END,
           CASE WHEN q.state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring', 'failed')
                  OR q.lease_expires_at > now() OR q.needs_attention THEN 'in_progress' END,
           CASE WHEN q.state = 'quarantined' THEN 'quarantine_not_terminal' END,
           CASE WHEN q.retain_until IS NULL THEN 'no_retention_date' END,
           CASE WHEN (SELECT p.status IN ('proposed', 'unresolved') FROM private.retention_policy p
                       WHERE p.key = 'quarantine_copy_after_release') IS DISTINCT FROM false
                THEN 'policy_pending_legal_review' END
         ], NULL)
    FROM private.media_quarantine q WHERE q.id = p_quarantine_id;
$$;

-- ── 4. Claim guard ──────────────────────────────────────────────────────────
-- Inserting a claim re-validates everything: two current, active admins; an
-- eligible, due subject; for a copy, the exact object of that job; and no
-- drift between the policy and the functions that apply it. Afterwards a
-- claim can only be closed, once.
CREATE FUNCTION private.retention_purge_claims_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.content_reports;
  q private.media_quarantine;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.claimed_xact := pg_current_xact_id();
    NEW.claimed_at := clock_timestamp();
    NEW.closed_at := NULL; NEW.close_reason := NULL;
    IF NEW.lease_expires_at <= NEW.claimed_at OR NEW.lease_expires_at > NEW.claimed_at + interval '5 minutes' THEN
      RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
    END IF;
    IF NEW.prepared_by = NEW.approved_by THEN
      RAISE EXCEPTION 'second_admin_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = NEW.prepared_by)
       OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = NEW.approved_by)
       OR private.account_is_hidden(NEW.prepared_by) OR private.account_is_hidden(NEW.approved_by) THEN
      RAISE EXCEPTION 'claim_admins_invalid' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM private.retention_policy_conformance() c WHERE NOT c.conforms) THEN
      RAISE EXCEPTION 'retention_policy_drift' USING ERRCODE = 'P0001';
    END IF;
    -- Close this subject's expired, unused claim (bookkeeping only).
    UPDATE private.retention_purge_claims c SET closed_at = clock_timestamp(), close_reason = 'expired'
     WHERE c.subject_kind = NEW.subject_kind AND c.subject_id = NEW.subject_id AND c.closed_at IS NULL
       AND c.lease_expires_at <= clock_timestamp();
    IF NEW.subject_kind = 'report_evidence' THEN
      PERFORM private.legal_hold_lock('report', NEW.subject_id);
      SELECT * INTO r FROM public.content_reports x WHERE x.id = NEW.subject_id;
      IF NOT FOUND OR r.evidence IS NULL THEN
        RAISE EXCEPTION 'claim_subject_unavailable' USING ERRCODE = 'PT409';
      END IF;
      IF r.target_owner_id IS NOT NULL THEN
        PERFORM private.legal_hold_lock('account', r.target_owner_id);
      END IF;
      IF cardinality(private.report_evidence_purge_blockers(r.id)) > 0
         OR r.evidence_purge_after IS NULL OR r.evidence_purge_after > now() THEN
        RAISE EXCEPTION 'claim_subject_not_eligible' USING ERRCODE = 'PT409';
      END IF;
    ELSE
      PERFORM private.legal_hold_lock('quarantine_copy', NEW.subject_id);
      SELECT * INTO q FROM private.media_quarantine x WHERE x.id = NEW.subject_id;
      IF NOT FOUND OR q.quarantine_bucket IS DISTINCT FROM NEW.object_bucket OR q.quarantine_path IS DISTINCT FROM NEW.object_path
         OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = q.quarantine_bucket AND o.name = q.quarantine_path) THEN
        RAISE EXCEPTION 'claim_subject_unavailable' USING ERRCODE = 'PT409';
      END IF;
      PERFORM private.legal_hold_lock('account', q.owner_id);
      IF cardinality(private.quarantine_copy_purge_blockers(q.id)) > 0 OR q.retain_until > now() THEN
        RAISE EXCEPTION 'claim_subject_not_eligible' USING ERRCODE = 'PT409';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['closed_at', 'close_reason']) = (to_jsonb(OLD) - ARRAY['closed_at', 'close_reason'])
       AND ((NEW.close_reason = 'consumed' AND OLD.lease_expires_at > clock_timestamp())
            OR (NEW.close_reason = 'expired' AND OLD.lease_expires_at <= clock_timestamp())) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'retention_purge_claims_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER retention_purge_claims_history BEFORE INSERT OR UPDATE OR DELETE ON private.retention_purge_claims
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_claims_guard();
CREATE TRIGGER retention_purge_claims_no_truncate BEFORE TRUNCATE ON private.retention_purge_claims
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_claims_guard();

-- ── 5. Report guard (G1, G2) ────────────────────────────────────────────────
-- Body replaced; the immutable-field checks are unchanged (marked below).
CREATE OR REPLACE FUNCTION private.content_reports_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claim uuid;
BEGIN
  -- 20261124120000: TRUNCATE and DELETE only for a database operator acting
  -- as themselves (no SET ROLE) — never an API role, the service role included.
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF session_user = 'postgres' AND current_setting('role') = 'none' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'content_report_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.reporter_id IS DISTINCT FROM OLD.reporter_id AND NEW.reporter_id IS NOT NULL)
     OR (NEW.target_owner_id IS DISTINCT FROM OLD.target_owner_id AND NEW.target_owner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'content_report_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    IF NEW.evidence IS NOT NULL OR OLD.evidence_purge_after IS NULL OR OLD.evidence_purge_after > now() THEN
      RAISE EXCEPTION 'content_report_evidence_immutable' USING ERRCODE = '42501';
    END IF;
    -- 20261124120000: a claim from THIS transaction, still leased and unused,
    -- and every eligibility rule re-checked under the legal-hold locks.
    PERFORM private.legal_hold_lock('report', OLD.id);
    IF OLD.target_owner_id IS NOT NULL THEN
      PERFORM private.legal_hold_lock('account', OLD.target_owner_id);
    END IF;
    SELECT c.id INTO v_claim FROM private.retention_purge_claims c
     WHERE c.subject_kind = 'report_evidence' AND c.subject_id = OLD.id AND c.closed_at IS NULL
       AND c.claimed_xact = pg_current_xact_id() AND c.lease_expires_at > clock_timestamp()
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence_purge_claim_required' USING ERRCODE = '42501';
    END IF;
    IF private.report_is_child_safety(OLD.id) THEN
      RAISE EXCEPTION 'evidence_child_safety' USING ERRCODE = '42501';
    END IF;
    IF cardinality(private.report_evidence_purge_blockers(OLD.id)) > 0 THEN
      RAISE EXCEPTION 'evidence_not_eligible' USING ERRCODE = '42501',
        DETAIL = array_to_string(private.report_evidence_purge_blockers(OLD.id), ',');
    END IF;
    UPDATE private.retention_purge_claims SET closed_at = clock_timestamp(), close_reason = 'consumed' WHERE id = v_claim;
    NEW.evidence_purged_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER content_reports_no_truncate BEFORE TRUNCATE ON public.content_reports
  FOR EACH STATEMENT EXECUTE FUNCTION private.content_reports_guard_update();

-- ── 6. Storage guard (G3) ───────────────────────────────────────────────────
-- Body replaced; the source-path rules are unchanged (first two blocks).
CREATE OR REPLACE FUNCTION private.storage_held_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_state text;
  q private.media_quarantine;
  v_claim uuid;
BEGIN
  -- Only a database operator acting as themselves (logged in as postgres, no
  -- SET ROLE: SQL editor, migrations) is exempt. This runs as its owner, so
  -- current_user cannot identify the caller; the Storage API logs in as its own
  -- role and switches to the request's role, and every API role is guarded.
  IF session_user = 'postgres' AND current_setting('role') = 'none' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT q2.state INTO v_state FROM private.media_quarantine q2
     WHERE q2.source_bucket = OLD.bucket_id AND q2.source_path = OLD.name AND q2.state NOT IN ('restored', 'cancelled');
    -- The quarantine worker removes a source only once its copy is verified.
    IF FOUND AND NOT (TG_OP = 'DELETE' AND v_state = 'verified') THEN
      RAISE EXCEPTION 'media_held' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT q2.state INTO v_state FROM private.media_quarantine q2
     WHERE q2.source_bucket = NEW.bucket_id AND q2.source_path = NEW.name AND q2.state NOT IN ('restored', 'cancelled');
    -- The restore worker writes the original back only while restoring.
    IF FOUND AND NOT (TG_OP = 'INSERT' AND v_state = 'restoring') THEN
      RAISE EXCEPTION 'media_held' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 20261124120000: the private quarantine bucket.
  IF TG_OP = 'UPDATE' AND (OLD.bucket_id = 'moderation-quarantine' OR NEW.bucket_id = 'moderation-quarantine') THEN
    -- Read bookkeeping (last_accessed_at / updated_at) is always fine.
    -- (path_tokens is generated from name, which is compared separately; it
    -- is not yet computed inside a BEFORE trigger.)
    IF (to_jsonb(NEW) - ARRAY['last_accessed_at', 'updated_at', 'path_tokens'])
       = (to_jsonb(OLD) - ARRAY['last_accessed_at', 'updated_at', 'path_tokens']) THEN
      RETURN NEW;
    END IF;
    -- Overwrite in place only before the copy is verified (worker retries);
    -- never a move, rename, soft delete, or a change to a verified copy.
    IF NEW.bucket_id IS DISTINCT FROM OLD.bucket_id OR NEW.name IS DISTINCT FROM OLD.name
       OR NOT EXISTS (SELECT 1 FROM private.media_quarantine q2
                       WHERE q2.quarantine_bucket = OLD.bucket_id AND q2.quarantine_path = OLD.name
                         AND q2.state IN ('pending', 'copied', 'failed') AND NOT q2.needs_attention) THEN
      RAISE EXCEPTION 'quarantine_object_protected' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.bucket_id = 'moderation-quarantine' THEN
    -- Exactly one object, of exactly one job, under a live single-use claim,
    -- with every rule re-checked now (serialised with legal-hold placement).
    SELECT * INTO q FROM private.media_quarantine q2
     WHERE q2.quarantine_bucket = OLD.bucket_id AND q2.quarantine_path = OLD.name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quarantine_object_protected' USING ERRCODE = '42501';
    END IF;
    PERFORM private.legal_hold_lock('quarantine_copy', q.id);
    PERFORM private.legal_hold_lock('account', q.owner_id);
    SELECT c.id INTO v_claim FROM private.retention_purge_claims c
     WHERE c.subject_kind = 'quarantine_copy' AND c.subject_id = q.id AND c.closed_at IS NULL
       AND c.object_bucket = OLD.bucket_id AND c.object_path = OLD.name AND c.lease_expires_at > clock_timestamp()
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quarantine_object_protected' USING ERRCODE = '42501';
    END IF;
    IF q.child_safety OR q.legal_hold THEN
      RAISE EXCEPTION 'quarantine_child_safety' USING ERRCODE = '42501';
    END IF;
    IF cardinality(private.quarantine_copy_purge_blockers(q.id)) > 0 OR q.retain_until > now() THEN
      RAISE EXCEPTION 'quarantine_copy_not_eligible' USING ERRCODE = '42501',
        DETAIL = array_to_string(private.quarantine_copy_purge_blockers(q.id), ',');
    END IF;
    UPDATE private.retention_purge_claims SET closed_at = clock_timestamp(), close_reason = 'consumed' WHERE id = v_claim;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── 7. Discovery uses the same rules (and G6) ───────────────────────────────
-- Body replaced: the report and quarantine sections now call the shared
-- blocker functions (adding deleted_owner_hold_ambiguous and
-- quarantine_not_terminal); profile fields are unchanged; notes add G6.
CREATE OR REPLACE FUNCTION private.retention_candidates()
RETURNS TABLE (category text, record_id uuid, owner_id uuid, child_safety boolean,
               due_at timestamptz, blockers text[], status text, detail jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH held AS (
    SELECT h.subject_kind, h.subject_id FROM private.moderation_legal_holds h
     WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now())
  ), pol AS (
    SELECT p.key, p.period, p.status IN ('proposed', 'unresolved') AS pending FROM private.retention_policy p
  ), raw AS (
    SELECT 'report_evidence'::text AS category, r.id AS record_id, r.target_owner_id AS owner_id,
           false AS cs, r.evidence_purge_after AS due_at,
           private.report_evidence_purge_blockers(r.id) AS b,
           jsonb_build_object('report_status', r.status, 'reason', r.reason, 'created_at', r.created_at,
                              'resolved_at', r.reviewed_at,
                              'age_days', floor(extract(epoch FROM now() - r.created_at) / 86400)::int) AS detail
      FROM public.content_reports r
     WHERE r.evidence IS NOT NULL
    UNION ALL
    SELECT 'quarantine_copy', q.id, q.owner_id, false, q.retain_until,
           private.quarantine_copy_purge_blockers(q.id),
           jsonb_build_object('state', q.state, 'desired', q.desired, 'media_kind', q.media_kind,
                              'size_bytes', q.size_bytes, 'copy_present', o.present)
      FROM private.media_quarantine q
     CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM storage.objects so
                                         WHERE so.bucket_id = q.quarantine_bucket AND so.name = q.quarantine_path) AS present) o
     WHERE o.present OR q.state IN ('copied', 'verified', 'quarantined', 'restore_pending', 'restoring', 'restored')
    UNION ALL
    SELECT 'profile_field_original', f.id, f.user_id,
           EXISTS (SELECT 1 FROM public.moderated_content m WHERE m.id = f.moderation_id AND m.child_safety),
           f.ended_at + (SELECT period FROM pol WHERE key = 'profile_field_original_after_end'),
           ARRAY[
             CASE WHEN f.status = 'active' THEN 'live_restriction' END,
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'profile_field' AND held.subject_id = f.id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = f.user_id)
                                                     OR (held.subject_kind = 'report' AND held.subject_id = f.report_id))
                  THEN 'legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = f.report_id AND r.status IN ('open', 'reviewing'))
                  THEN 'open_report' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'profile_field_original_after_end') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('field', f.field, 'field_status', f.status, 'ended_at', f.ended_at)
      FROM public.moderated_profile_fields f
    UNION ALL
    SELECT 'moderation_note', a.id, a.target_owner_id,
           a.reason_code = 'child_safety' OR a.reason_code = 'child_safety_review_cleared'
             OR a.metadata->>'child_safety' = 'true' OR a.metadata->>'hold_type' = 'child_safety'
             OR (a.report_id IS NOT NULL AND private.report_is_child_safety(a.report_id)),
           a.created_at + (SELECT period FROM pol WHERE key = 'moderation_note'),
           ARRAY[
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'report' AND held.subject_id = a.report_id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = a.target_owner_id))
                  THEN 'legal_hold' END,
             CASE WHEN a.target_owner_id IS NULL AND private.orphaned_account_hold_exists() THEN 'deleted_owner_hold_ambiguous' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = a.report_id AND r.status IN ('open', 'reviewing'))
                  THEN 'open_report' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'moderation_note') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('source', 'moderation_actions', 'action', a.action, 'created_at', a.created_at)
      FROM public.moderation_actions a
     WHERE a.note IS NOT NULL
    UNION ALL
    SELECT 'moderation_note', s.id, s.user_id, s.child_safety,
           COALESCE(s.lifted_at, s.expires_at, s.created_at) + (SELECT period FROM pol WHERE key = 'moderation_note'),
           ARRAY[
             CASE WHEN s.lifted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) THEN 'live_suspension' END,
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'report' AND held.subject_id = s.report_id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = s.user_id))
                  THEN 'legal_hold' END,
             CASE WHEN s.user_id IS NULL AND private.orphaned_account_hold_exists() THEN 'deleted_owner_hold_ambiguous' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = s.report_id AND r.status IN ('open', 'reviewing'))
                  THEN 'open_report' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'moderation_note') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('source', 'account_suspensions', 'created_at', s.created_at, 'lifted_at', s.lifted_at)
      FROM public.account_suspensions s
     WHERE s.note IS NOT NULL OR s.lift_note IS NOT NULL
  )
  SELECT x.category, x.record_id, x.owner_id,
         x.cs OR 'child_safety' = ANY (z.bc), x.due_at, y.blockers,
         CASE WHEN cardinality(y.blockers) > 0 THEN 'blocked'
              WHEN x.due_at > now() THEN 'not_due'
              ELSE 'eligible' END,
         x.detail || jsonb_build_object('due', x.due_at IS NOT NULL AND x.due_at <= now())
    FROM raw x
   CROSS JOIN LATERAL (SELECT CASE WHEN x.cs AND NOT ('child_safety' = ANY (array_remove(x.b, NULL))) THEN ARRAY['child_safety'] ELSE ARRAY[]::text[] END
                              || array_remove(x.b, NULL) AS bc) z
   CROSS JOIN LATERAL (SELECT CASE WHEN x.due_at IS NULL AND cardinality(z.bc) = 0
                                   THEN ARRAY['no_retention_date'] ELSE z.bc END AS blockers) y;
$$;

-- ── 8. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.orphaned_account_hold_exists(), private.report_evidence_purge_blockers(uuid),
  private.quarantine_copy_purge_blockers(uuid), private.retention_purge_claims_guard(),
  private.retention_candidates() FROM PUBLIC, anon, authenticated, service_role;

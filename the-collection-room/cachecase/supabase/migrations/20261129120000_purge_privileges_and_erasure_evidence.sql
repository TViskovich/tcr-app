-- Phase 2B M4 step 5D: dedicated purge privileges and erasure evidence (LOCAL).
--
-- 1. Purge privileges, separate from being an administrator:
--      retention_purge_preparer — may prepare a run;
--      retention_purge_approver — may approve another administrator's run,
--                                 and execute/settle runs they did not prepare.
--    Every action re-checks, at that moment, that the acting administrator is
--    active (an admin, not suspended, not pending deletion) AND holds the
--    privilege; execution also re-checks the run's preparer and approver.
--    The grant row is locked (FOR SHARE) while it is relied on, so a
--    concurrent revocation either waits for the action or stops it.
--    Grants are made and revoked only by a database operator
--    (private.grant_admin_privilege / revoke_admin_privilege: no API role can
--    call them), on behalf of a DIFFERENT active administrator, with a
--    reason, recorded immutably. Nobody holds a privilege after this
--    migration: purging stays impossible until an operator grants them.
--    Revoking a privilege also withdraws that administrator's live claims.
--    Preparation fails closed unless another active administrator holds the
--    approver privilege.
-- 2. Erasure evidence: a conservative, append-only classification of every
--    purge attempt's outcome (private.retention_purge_erasure_records). The
--    strongest classification recordable is "unavailable_via_api": Supabase
--    Storage gives a project no way to verify physical erasure in the
--    underlying object store, so no such classification exists.
-- 3. A 4-argument admin_retention_confirm_copy for the Edge Function's
--    single-object delete outcome, and admin_retention_purge_reconciliation
--    (read-only) for ambiguous and incomplete items.
--
-- Unchanged: the two-administrator workflow, 30-minute windows, claims,
-- the Storage and legal-hold guards, child-safety exclusion, G6, tombstone
-- contents, account deletion, retention periods.

-- ── 1. Privileges ───────────────────────────────────────────────────────────
CREATE TABLE private.admin_privileges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,          -- no FK: the history outlives the account
  privilege     text NOT NULL CHECK (privilege IN ('retention_purge_preparer', 'retention_purge_approver')),
  granted_by    uuid NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  grant_reason  text NOT NULL CHECK (char_length(btrim(grant_reason)) BETWEEN 3 AND 200),
  granted_via   text NOT NULL DEFAULT session_user,
  revoked_by    uuid,
  revoked_at    timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR char_length(btrim(revoke_reason)) BETWEEN 3 AND 200),
  revoked_via   text,
  CONSTRAINT admin_privileges_no_self_grant CHECK (granted_by <> user_id),
  CONSTRAINT admin_privileges_revocation_shape CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL) AND (revoked_at IS NULL) = (revoked_via IS NULL))
);
CREATE UNIQUE INDEX admin_privileges_one_active ON private.admin_privileges (user_id, privilege) WHERE revoked_at IS NULL;

CREATE TABLE private.admin_privilege_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  event        text NOT NULL CHECK (event IN ('granted', 'revoked')),
  privilege_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  privilege    text NOT NULL,
  actor_id     uuid NOT NULL,           -- the granting / revoking administrator
  reason       text NOT NULL,
  via          text NOT NULL            -- the database role that ran it
);

ALTER TABLE private.admin_privileges ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.admin_privilege_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.admin_privileges, private.admin_privilege_events FROM PUBLIC, anon, authenticated, service_role;

-- A grant is fixed once made; it can only be revoked, once.
CREATE FUNCTION private.admin_privileges_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['revoked_by', 'revoked_at', 'revoke_reason', 'revoked_via'])
       = (to_jsonb(OLD) - ARRAY['revoked_by', 'revoked_at', 'revoke_reason', 'revoked_via']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'admin_privileges_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER admin_privileges_history BEFORE UPDATE OR DELETE ON private.admin_privileges
  FOR EACH ROW EXECUTE FUNCTION private.admin_privileges_guard();

CREATE FUNCTION private.admin_privileges_no_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'admin_privileges_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER admin_privileges_no_truncate BEFORE TRUNCATE ON private.admin_privileges
  FOR EACH STATEMENT EXECUTE FUNCTION private.admin_privileges_no_change();
CREATE TRIGGER admin_privilege_events_append_only BEFORE UPDATE OR DELETE ON private.admin_privilege_events
  FOR EACH ROW EXECUTE FUNCTION private.admin_privileges_no_change();
CREATE TRIGGER admin_privilege_events_no_truncate BEFORE TRUNCATE ON private.admin_privilege_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.admin_privileges_no_change();

-- Every grant and revocation is recorded.
CREATE FUNCTION private.admin_privileges_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO private.admin_privilege_events (event, privilege_id, user_id, privilege, actor_id, reason, via)
    VALUES ('granted', NEW.id, NEW.user_id, NEW.privilege, NEW.granted_by, NEW.grant_reason, NEW.granted_via);
  ELSE
    INSERT INTO private.admin_privilege_events (event, privilege_id, user_id, privilege, actor_id, reason, via)
    VALUES ('revoked', NEW.id, NEW.user_id, NEW.privilege, NEW.revoked_by, NEW.revoke_reason, NEW.revoked_via);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER admin_privileges_recorded AFTER INSERT OR UPDATE ON private.admin_privileges
  FOR EACH ROW EXECUTE FUNCTION private.admin_privileges_record();

-- Holds the privilege right now: an active administrator with a live grant.
CREATE FUNCTION private.has_purge_privilege(p_user uuid, p_privilege text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT private.retention_purge_admin_active(p_user)
     AND EXISTS (SELECT 1 FROM private.admin_privileges g WHERE g.user_id = p_user AND g.privilege = p_privilege AND g.revoked_at IS NULL);
$$;

-- The same, for an action that relies on it: the grant row is locked FOR
-- SHARE until the action's transaction ends, so a concurrent revocation waits
-- for it (or, if it got there first, the action sees the grant gone).
CREATE FUNCTION private.lock_purge_privilege(p_user uuid, p_privilege text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.retention_purge_admin_active(p_user) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM private.admin_privileges g
   WHERE g.user_id = p_user AND g.privilege = p_privilege AND g.revoked_at IS NULL
   FOR SHARE;
  RETURN FOUND;
END;
$$;

-- Operator only: a database session logged in as the operator (SQL editor,
-- psql). No API role can execute these.
CREATE FUNCTION private.require_privilege_operator()
RETURNS void LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin') OR current_setting('role') <> 'none' THEN
    RAISE EXCEPTION 'operator_only' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION private.grant_admin_privilege(p_user uuid, p_privilege text, p_granted_by uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM private.require_privilege_operator();
  IF p_privilege IS NULL OR p_privilege NOT IN ('retention_purge_preparer', 'retention_purge_approver') THEN
    RAISE EXCEPTION 'invalid_privilege' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NULL OR p_granted_by IS NULL OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', HINT = 'Grantee, granting administrator and a reason (3-200 characters) are required.';
  END IF;
  IF p_user = p_granted_by THEN
    RAISE EXCEPTION 'self_grant_refused' USING ERRCODE = '42501';
  END IF;
  IF NOT private.retention_purge_admin_active(p_granted_by) THEN
    RAISE EXCEPTION 'grantor_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT private.retention_purge_admin_active(p_user) THEN
    RAISE EXCEPTION 'grantee_not_active_admin' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_privilege:' || p_user || ':' || p_privilege, 0));
  IF EXISTS (SELECT 1 FROM private.admin_privileges g WHERE g.user_id = p_user AND g.privilege = p_privilege AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'privilege_already_granted' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO private.admin_privileges (user_id, privilege, granted_by, grant_reason)
  VALUES (p_user, p_privilege, p_granted_by, btrim(p_reason))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Revokes the live grant (if any) and withdraws the administrator's live
-- claims in that role, so nothing they authorised can still delete.
CREATE FUNCTION private.revoke_admin_privilege(p_user uuid, p_privilege text, p_revoked_by uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  g private.admin_privileges;
BEGIN
  PERFORM private.require_privilege_operator();
  IF p_privilege IS NULL OR p_privilege NOT IN ('retention_purge_preparer', 'retention_purge_approver') THEN
    RAISE EXCEPTION 'invalid_privilege' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NULL OR p_revoked_by IS NULL OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  -- Any active administrator may stand behind a revocation (including the
  -- holder giving it up); revoking only ever narrows who can purge.
  IF NOT private.retention_purge_admin_active(p_revoked_by) THEN
    RAISE EXCEPTION 'revoker_not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO g FROM private.admin_privileges x WHERE x.user_id = p_user AND x.privilege = p_privilege AND x.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE private.admin_privileges
     SET revoked_by = p_revoked_by, revoked_at = clock_timestamp(), revoke_reason = btrim(p_reason), revoked_via = session_user
   WHERE id = g.id;
  UPDATE private.retention_purge_claims c
     SET closed_at = clock_timestamp(), close_reason = 'withdrawn'
   WHERE c.closed_at IS NULL
     AND ((p_privilege = 'retention_purge_preparer' AND c.prepared_by = p_user)
          OR (p_privilege = 'retention_purge_approver' AND c.approved_by = p_user));
  RETURN true;
END;
$$;

-- ── 2. Erasure evidence ─────────────────────────────────────────────────────
-- classification (strongest first):
--   unavailable_via_api   Storage metadata removed by an authorised delete
--                          (the guard consumed the claim) AND a fresh API read
--                          of the exact object returned not-found
--   metadata_removed      Storage metadata removed by an authorised delete
--   database_cleared      report evidence: the database value was cleared in
--                          the purge transaction (backups are out of scope)
--   api_accepted          the Storage API accepted the delete (not yet settled)
--   api_failed            the Storage API call failed or its outcome is unknown
--   ambiguous_missing_unverified / ambiguous_reappeared / incomplete
--                          could not be settled safely (needs_attention)
-- There is no "physically erased" classification: physical removal from the
-- provider's object store cannot be verified by the project.
CREATE TABLE private.retention_purge_erasure_records (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id           uuid NOT NULL REFERENCES private.retention_purge_items (id) ON DELETE RESTRICT,
  run_id            uuid NOT NULL REFERENCES private.retention_purge_runs (id) ON DELETE RESTRICT,
  recorded_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  classification    text NOT NULL CHECK (classification IN ('unavailable_via_api', 'metadata_removed', 'database_cleared', 'api_accepted',
                                                            'api_failed', 'ambiguous_missing_unverified', 'ambiguous_reappeared', 'incomplete')),
  api_outcome       text NOT NULL CHECK (api_outcome IN ('accepted', 'not_found', 'refused', 'http_error', 'timeout', 'unreachable',
                                                         'unexpected', 'unknown', 'not_applicable')),
  unavailable_check text NOT NULL CHECK (unavailable_check IN ('not_found', 'still_readable', 'error', 'not_checked', 'not_applicable')),
  tombstone_id      uuid REFERENCES private.retention_purge_tombstones (id) ON DELETE RESTRICT,
  actor_id          uuid,
  CONSTRAINT retention_purge_erasure_final_shape CHECK (
    (classification IN ('unavailable_via_api', 'metadata_removed', 'database_cleared')) = (tombstone_id IS NOT NULL))
);
CREATE INDEX retention_purge_erasure_records_item ON private.retention_purge_erasure_records (item_id, id);
ALTER TABLE private.retention_purge_erasure_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.retention_purge_erasure_records FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER retention_purge_erasure_records_history BEFORE UPDATE OR DELETE ON private.retention_purge_erasure_records
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_append_only();
CREATE TRIGGER retention_purge_erasure_records_no_truncate BEFORE TRUNCATE ON private.retention_purge_erasure_records
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_append_only();

-- The API outcome recorded for the item's CURRENT attempt (since its claim).
CREATE FUNCTION private.retention_purge_attempt_record(p_item uuid)
RETURNS private.retention_purge_erasure_records
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.* FROM private.retention_purge_erasure_records e
    JOIN private.retention_purge_items i ON i.id = e.item_id
    LEFT JOIN private.retention_purge_claims c ON c.id = i.claim_id
   WHERE e.item_id = p_item AND e.classification IN ('api_accepted', 'api_failed')
     AND (c.claimed_at IS NULL OR e.recorded_at >= c.claimed_at)
   ORDER BY e.id DESC LIMIT 1;
$$;

-- A tombstone (completed purge) gets its final classification.
CREATE FUNCTION private.retention_purge_record_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  a private.retention_purge_erasure_records;
BEGIN
  IF NEW.subject_kind = 'report_evidence' THEN
    INSERT INTO private.retention_purge_erasure_records (item_id, run_id, classification, api_outcome, unavailable_check, tombstone_id, actor_id)
    VALUES (NEW.item_id, NEW.run_id, 'database_cleared', 'not_applicable', 'not_applicable', NEW.id, NEW.executed_by);
  ELSE
    a := private.retention_purge_attempt_record(NEW.item_id);
    INSERT INTO private.retention_purge_erasure_records (item_id, run_id, classification, api_outcome, unavailable_check, tombstone_id, actor_id)
    VALUES (NEW.item_id, NEW.run_id,
            CASE WHEN a.unavailable_check = 'not_found' THEN 'unavailable_via_api' ELSE 'metadata_removed' END,
            COALESCE(a.api_outcome, 'unknown'), COALESCE(a.unavailable_check, 'not_checked'), NEW.id, NEW.executed_by);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER retention_purge_tombstones_erasure AFTER INSERT ON private.retention_purge_tombstones
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_record_completion();

-- An item that could not be settled safely keeps needs_attention (terminal
-- for the items guard) and gets an ambiguous / incomplete classification.
CREATE FUNCTION private.retention_purge_record_attention()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  a private.retention_purge_erasure_records;
BEGIN
  a := private.retention_purge_attempt_record(NEW.id);
  INSERT INTO private.retention_purge_erasure_records (item_id, run_id, classification, api_outcome, unavailable_check)
  VALUES (NEW.id, NEW.run_id,
          CASE NEW.last_error WHEN 'object_missing_unverified' THEN 'ambiguous_missing_unverified'
                              WHEN 'object_reappeared' THEN 'ambiguous_reappeared' ELSE 'incomplete' END,
          CASE WHEN NEW.subject_kind = 'report_evidence' THEN 'not_applicable' ELSE COALESCE(a.api_outcome, 'unknown') END,
          CASE WHEN NEW.subject_kind = 'report_evidence' THEN 'not_applicable' ELSE COALESCE(a.unavailable_check, 'not_checked') END);
  RETURN NULL;
END;
$$;
CREATE TRIGGER retention_purge_items_attention AFTER UPDATE OF state ON private.retention_purge_items
  FOR EACH ROW WHEN (NEW.state = 'needs_attention' AND OLD.state IS DISTINCT FROM 'needs_attention')
  EXECUTE FUNCTION private.retention_purge_record_attention();

-- ── Prepare (20261125120000 + privilege checks) ───────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retention_prepare_run(p_category text, p_subject_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := private.require_admin();
  p private.retention_policy;
  v_ids uuid[];
  v_id uuid;
  v_bad jsonb := '[]'::jsonb;
  b text[];
  r private.retention_purge_runs;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- 20261129120000: only a holder of the preparer privilege prepares, and only
  -- while at least one OTHER active administrator holds the approver
  -- privilege (fewer than two authorised administrators: fail closed).
  IF NOT private.lock_purge_privilege(v_admin, 'retention_purge_preparer') THEN
    RAISE EXCEPTION 'purge_preparer_privilege_required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.admin_privileges g
                  WHERE g.privilege = 'retention_purge_approver' AND g.revoked_at IS NULL AND g.user_id <> v_admin
                    AND private.retention_purge_admin_active(g.user_id)) THEN
    RAISE EXCEPTION 'insufficient_purge_administrators' USING ERRCODE = 'PT409';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('report_evidence', 'quarantine_copy') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_subject_ids) x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(p_subject_ids) OR cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'invalid_selection' USING ERRCODE = '22023',
      HINT = 'Select between 1 and 50 distinct, non-null ids.';
  END IF;
  PERFORM private.retention_purge_expire_runs();
  p := private.retention_purge_require_policy(p_category);
  -- Serialise preparation per subject (sorted, so concurrent runs can't deadlock).
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('retention_purge:' || p_category || ':' || v_id::text, 0));
  END LOOP;
  FOREACH v_id IN ARRAY v_ids LOOP
    b := private.retention_purge_item_blockers(p_category, v_id);
    IF EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.subject_kind = p_category AND i.subject_id = v_id
                  AND i.state IN ('pending', 'deleting', 'failed')) THEN
      b := b || 'in_open_run'::text;
    END IF;
    IF cardinality(b) > 0 THEN
      v_bad := v_bad || jsonb_build_object('subject_id', v_id, 'blockers', to_jsonb(b));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_bad) > 0 THEN
    RAISE EXCEPTION 'candidate_not_eligible' USING ERRCODE = 'PT409', DETAIL = left(v_bad::text, 900);
  END IF;
  v_now := clock_timestamp();
  INSERT INTO private.retention_purge_runs (category, policy_key, policy_period, item_count, set_digest, prepared_by, prepared_at,
                                            approval_expires_at)
  VALUES (p_category, p.key, p.period, cardinality(v_ids), private.retention_purge_digest(v_ids), v_admin, v_now,
          v_now + interval '30 minutes')
  RETURNING * INTO r;
  INSERT INTO private.retention_purge_items (run_id, subject_kind, subject_id, due_at, size_bytes)
  SELECT r.id, p_category, x,
         CASE WHEN p_category = 'report_evidence' THEN (SELECT c.evidence_purge_after FROM public.content_reports c WHERE c.id = x)
              ELSE (SELECT q.retain_until FROM private.media_quarantine q WHERE q.id = x) END,
         CASE WHEN p_category = 'report_evidence' THEN (SELECT octet_length(c.evidence::text) FROM public.content_reports c WHERE c.id = x)
              ELSE (SELECT q.size_bytes FROM private.media_quarantine q WHERE q.id = x) END
    FROM unnest(v_ids) x;
  PERFORM private.retention_purge_event(r.id, NULL, 'prepared', v_admin, jsonb_build_object('items', r.item_count));
  RETURN private.retention_purge_run_view(r.id);
END;
$function$;

-- ── Approve (20261125120000 + privilege checks) ───────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retention_approve_run(p_run_id uuid, p_set_digest text, p_item_count integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  v_now timestamptz;
BEGIN
  PERFORM private.retention_purge_expire_runs();
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.prepared_by IS NOT DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'self_approval_refused' USING ERRCODE = '42501';
  END IF;
  -- 20261129120000: the approver must hold the approver privilege.
  IF NOT private.lock_purge_privilege(v_admin, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'purge_approver_privilege_required' USING ERRCODE = '42501';
  END IF;
  IF r.status = 'expired' OR (r.status = 'prepared' AND r.approval_expires_at <= now()) THEN
    RAISE EXCEPTION 'run_expired' USING ERRCODE = 'PT409';
  END IF;
  IF r.status <> 'prepared' THEN
    RAISE EXCEPTION 'run_not_pending' USING ERRCODE = 'PT409';
  END IF;
  IF NOT private.retention_purge_admin_active(r.prepared_by) THEN
    RAISE EXCEPTION 'preparer_inactive' USING ERRCODE = '42501';
  END IF;
  -- 20261129120000: …and the preparer must still hold the preparer privilege.
  IF NOT private.lock_purge_privilege(r.prepared_by, 'retention_purge_preparer') THEN
    RAISE EXCEPTION 'preparer_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_set_digest IS DISTINCT FROM r.set_digest OR p_item_count IS DISTINCT FROM r.item_count
     OR r.set_digest IS DISTINCT FROM (SELECT private.retention_purge_digest(array_agg(i.subject_id)) FROM private.retention_purge_items i WHERE i.run_id = r.id)
     OR r.item_count <> (SELECT count(*) FROM private.retention_purge_items i WHERE i.run_id = r.id) THEN
    RAISE EXCEPTION 'run_set_mismatch' USING ERRCODE = 'PT409';
  END IF;
  v_now := clock_timestamp();
  UPDATE private.retention_purge_runs
     SET status = 'approved', approved_by = v_admin, approved_at = v_now, execution_expires_at = v_now + interval '30 minutes'
   WHERE id = r.id;
  PERFORM private.retention_purge_event(r.id, NULL, 'approved', v_admin,
    jsonb_build_object('now_ineligible', (SELECT count(*) FROM private.retention_purge_items i WHERE i.run_id = r.id
                                             AND cardinality(private.retention_purge_item_blockers(i.subject_kind, i.subject_id)) > 0)));
  RETURN private.retention_purge_run_view(r.id);
END;
$function$;

-- ── Execution authorisation (20261125120000 + privilege checks) ───────────
CREATE OR REPLACE FUNCTION private.retention_purge_authorize_execution(p_run_id uuid, p_admin uuid, p_category text)
 RETURNS private.retention_purge_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r private.retention_purge_runs;
BEGIN
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.category <> p_category THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.prepared_by IS NOT DISTINCT FROM p_admin THEN
    RAISE EXCEPTION 'self_execution_refused' USING ERRCODE = '42501';
  END IF;
  IF r.status <> 'approved' THEN
    RAISE EXCEPTION 'run_not_executable' USING ERRCODE = 'PT409';
  END IF;
  IF NOT private.retention_purge_admin_active(r.prepared_by) OR NOT private.retention_purge_admin_active(r.approved_by) THEN
    RAISE EXCEPTION 'run_admins_inactive' USING ERRCODE = '42501';
  END IF;
  -- 20261129120000: re-checked at execution time — the executor holds the
  -- approver privilege (and is not the preparer, above); the run's preparer
  -- and approver still hold theirs. A revocation since approval stops it.
  IF NOT private.lock_purge_privilege(p_admin, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'purge_executor_privilege_required' USING ERRCODE = '42501';
  END IF;
  IF NOT private.lock_purge_privilege(r.prepared_by, 'retention_purge_preparer')
     OR NOT private.lock_purge_privilege(r.approved_by, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'run_admins_not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN r;
END;
$function$;

-- ── Confirm (20261125120000 + privilege check) ────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retention_confirm_copy(p_run_id uuid, p_item_id uuid, p_storage_error text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  v_state text;
BEGIN
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.category <> 'quarantine_copy' THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.prepared_by IS NOT DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'self_execution_refused' USING ERRCODE = '42501';
  END IF;
  -- 20261129120000: settling and recording completion is execution.
  IF NOT private.lock_purge_privilege(v_admin, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'purge_executor_privilege_required' USING ERRCODE = '42501';
  END IF;
  IF p_storage_error IS NOT NULL THEN
    UPDATE private.retention_purge_items SET last_error = private.retention_purge_error_code(lower(p_storage_error), 'storage')
     WHERE id = p_item_id AND run_id = r.id AND state = 'deleting';
  END IF;
  v_state := private.retention_purge_settle_copy(r, p_item_id, v_admin);
  PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
  RETURN jsonb_build_object('item_id', p_item_id, 'outcome', v_state);
END;
$function$;

-- ── Reconcile (20261125120000 + privilege check) ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retention_reconcile_run(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  v_item uuid;
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.category <> 'quarantine_copy' THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.prepared_by IS NOT DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'self_execution_refused' USING ERRCODE = '42501';
  END IF;
  -- 20261129120000: settling and recording completion is execution.
  IF NOT private.lock_purge_privilege(v_admin, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'purge_executor_privilege_required' USING ERRCODE = '42501';
  END IF;
  FOR v_item IN SELECT i.id FROM private.retention_purge_items i
                 WHERE i.run_id = r.id AND i.state IN ('deleting', 'failed') AND i.claim_id IS NOT NULL ORDER BY i.id LOOP
    v_out := v_out || jsonb_build_object('item_id', v_item, 'outcome', private.retention_purge_settle_copy(r, v_item, v_admin));
    PERFORM private.retention_purge_event(r.id, v_item, 'item_reconciled', v_admin);
  END LOOP;
  PERFORM private.retention_purge_expire_runs();
  PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
  RETURN jsonb_build_object('results', v_out, 'run', private.retention_purge_run_view(r.id));
END;
$function$;

-- ── Claim guard (20261125120000 + privilege check) ────────────────────────
CREATE OR REPLACE FUNCTION private.retention_purge_claims_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- 20261129120000: both run admins still hold their purge privilege.
    IF NOT private.lock_purge_privilege(NEW.prepared_by, 'retention_purge_preparer')
       OR NOT private.lock_purge_privilege(NEW.approved_by, 'retention_purge_approver') THEN
      RAISE EXCEPTION 'claim_admins_not_authorized' USING ERRCODE = '42501';
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
            OR (NEW.close_reason = 'expired' AND OLD.lease_expires_at <= clock_timestamp())
            OR NEW.close_reason = 'withdrawn') THEN   -- 20261125120000: an unused claim may be given up early
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'retention_purge_claims_append_only' USING ERRCODE = '42501';
END;
$function$;

-- ── Dashboard purge view (20261128120000 + privileges, ambiguous items) ───
CREATE OR REPLACE FUNCTION public.admin_retention_purge_dashboard(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 25, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := private.require_admin();
  v_items jsonb;
  v_last timestamptz;
BEGIN
  IF (p_status IS NOT NULL AND p_status NOT IN ('prepared', 'approved', 'expired', 'cancelled', 'completed', 'needs_attention'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id, 'category', r.category, 'stored_status', r.status, 'status', r.display,
           'item_count', r.item_count,
           'items_by_state', (SELECT COALESCE(jsonb_object_agg(s.state, s.n), '{}'::jsonb)
                                FROM (SELECT i.state, count(*) AS n FROM private.retention_purge_items i WHERE i.run_id = r.id GROUP BY i.state) s),
           'prepared_at', r.prepared_at, 'approval_expires_at', r.approval_expires_at,
           'approved_at', r.approved_at, 'execution_expires_at', r.execution_expires_at, 'closed_at', r.closed_at,
           'prepared_by_viewer', r.prepared_by IS NOT DISTINCT FROM v_admin,
           'approved_by_viewer', r.approved_by IS NOT DISTINCT FROM v_admin,
           -- informational only; admin_retention_approve_run re-checks everything when an approval is submitted
           -- 20261129120000: needs the approver privilege too (a hint; approval re-checks)
           'viewer_may_approve', r.display = 'prepared' AND r.prepared_by IS DISTINCT FROM v_admin
                                 AND private.has_purge_privilege(v_admin, 'retention_purge_approver'),
           'ambiguous_items', (SELECT count(*) FROM private.retention_purge_items i WHERE i.run_id = r.id
                                  AND i.state IN ('deleting', 'failed', 'needs_attention')))
           ORDER BY r.prepared_at DESC, r.id), '[]'::jsonb),
         min(r.prepared_at)
    INTO v_items, v_last
    FROM (SELECT x.*, private.retention_purge_display_status(x) AS display FROM private.retention_purge_runs x
           WHERE (p_before IS NULL OR x.prepared_at < p_before)
             AND (p_status IS NULL OR private.retention_purge_display_status(x) = p_status)
           ORDER BY x.prepared_at DESC, x.id LIMIT p_limit) r;
  RETURN jsonb_build_object(
    'items', v_items,
    'next_before', CASE WHEN jsonb_array_length(v_items) = p_limit THEN v_last END,
    'pending_approval', (SELECT count(*) FROM private.retention_purge_runs x WHERE private.retention_purge_display_status(x) = 'prepared'),
    'needs_attention', (SELECT count(*) FROM private.retention_purge_runs x WHERE private.retention_purge_display_status(x) = 'needs_attention'),
    -- 20261129120000: the viewer's purge privileges and how many active
    -- administrators hold each (fewer than one of each besides the preparer
    -- means no run can complete).
    'viewer_privileges', jsonb_build_object('preparer', private.has_purge_privilege(v_admin, 'retention_purge_preparer'),
                                            'approver', private.has_purge_privilege(v_admin, 'retention_purge_approver')),
    'authorized_admins', jsonb_build_object(
      'preparers', (SELECT count(DISTINCT g.user_id) FROM private.admin_privileges g
                     WHERE g.privilege = 'retention_purge_preparer' AND g.revoked_at IS NULL AND private.retention_purge_admin_active(g.user_id)),
      'approvers', (SELECT count(DISTINCT g.user_id) FROM private.admin_privileges g
                     WHERE g.privilege = 'retention_purge_approver' AND g.revoked_at IS NULL AND private.retention_purge_admin_active(g.user_id)),
      -- a run can complete only with a preparer and a DIFFERENT approver
      'runs_possible', EXISTS (SELECT 1 FROM private.admin_privileges pp JOIN private.admin_privileges aa ON aa.user_id <> pp.user_id
                                WHERE pp.privilege = 'retention_purge_preparer' AND pp.revoked_at IS NULL AND private.retention_purge_admin_active(pp.user_id)
                                  AND aa.privilege = 'retention_purge_approver' AND aa.revoked_at IS NULL AND private.retention_purge_admin_active(aa.user_id))));
END;
$function$;

-- ── Confirm with the Storage outcome (Edge Function, 20261129120000) ────────
-- p_result: {"api": <outcome>, "unavailable": <check>} from the single-object
-- delete and the verification read. Recorded as the attempt's API evidence,
-- then settled exactly as before — from the database's own evidence (claim
-- consumed by the Storage guard + metadata gone), never from this report.
CREATE FUNCTION public.admin_retention_confirm_copy(p_run_id uuid, p_item_id uuid, p_storage_error text, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  i private.retention_purge_items;
  v_api text := p_result ->> 'api';
  v_check text := COALESCE(p_result ->> 'unavailable', 'not_checked');
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR (p_result - 'api' - 'unavailable') <> '{}'::jsonb
     OR v_api IS NULL OR v_api NOT IN ('accepted', 'not_found', 'refused', 'http_error', 'timeout', 'unreachable', 'unexpected', 'unknown')
     OR v_check NOT IN ('not_found', 'still_readable', 'error', 'not_checked')
     OR (v_api = 'accepted') <> (p_storage_error IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id;
  IF NOT FOUND OR r.category <> 'quarantine_copy' THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.prepared_by IS NOT DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'self_execution_refused' USING ERRCODE = '42501';
  END IF;
  IF NOT private.lock_purge_privilege(v_admin, 'retention_purge_approver') THEN
    RAISE EXCEPTION 'purge_executor_privilege_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO i FROM private.retention_purge_items x WHERE x.id = p_item_id AND x.run_id = r.id;
  IF FOUND AND i.state = 'deleting' AND i.claim_id IS NOT NULL THEN
    INSERT INTO private.retention_purge_erasure_records (item_id, run_id, classification, api_outcome, unavailable_check, actor_id)
    VALUES (i.id, r.id, CASE WHEN v_api = 'accepted' THEN 'api_accepted' ELSE 'api_failed' END, v_api, v_check, v_admin);
  END IF;
  RETURN public.admin_retention_confirm_copy(p_run_id, p_item_id, p_storage_error);
END;
$$;

-- ── Reconciliation (read-only, admins) ──────────────────────────────────────
-- Items that are in flight, failed, or could not be settled safely, with the
-- evidence the database holds and a recommended next step. No paths.
CREATE FUNCTION public.admin_retention_purge_reconciliation(p_run_id uuid DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
BEGIN
  PERFORM private.require_admin();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  WITH x AS (
    SELECT i.id, i.run_id, private.retention_purge_display_status(r) AS run_status, i.subject_kind, i.subject_id, i.state, i.attempts, i.last_error,
           i.updated_at,
           (SELECT to_jsonb(e) - 'id' - 'item_id' - 'run_id' - 'tombstone_id' - 'actor_id'
              FROM private.retention_purge_erasure_records e WHERE e.item_id = i.id ORDER BY e.id DESC LIMIT 1) AS evidence,
           CASE WHEN c.id IS NULL THEN 'none'
                WHEN c.closed_at IS NOT NULL THEN c.close_reason
                WHEN c.lease_expires_at > clock_timestamp() THEN 'live'
                ELSE 'lease_over' END AS claim_state,
           CASE WHEN i.subject_kind = 'quarantine_copy'
                THEN EXISTS (SELECT 1 FROM private.media_quarantine q JOIN storage.objects o
                                ON o.bucket_id = q.quarantine_bucket AND o.name = q.quarantine_path WHERE q.id = i.subject_id) END AS metadata_present
      FROM private.retention_purge_items i
      JOIN private.retention_purge_runs r ON r.id = i.run_id
      LEFT JOIN private.retention_purge_claims c ON c.id = i.claim_id
     WHERE i.state IN ('deleting', 'failed', 'needs_attention') AND (p_run_id IS NULL OR i.run_id = p_run_id)
     ORDER BY i.updated_at DESC LIMIT p_limit)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_id', x.id, 'run_id', x.run_id, 'run_status', x.run_status, 'subject_kind', x.subject_kind, 'subject_id', x.subject_id,
           'state', x.state, 'attempts', x.attempts, 'last_error', x.last_error, 'updated_at', x.updated_at,
           'evidence', x.evidence, 'claim_state', x.claim_state, 'storage_metadata_present', x.metadata_present,
           'recommended_action', CASE
             WHEN x.state = 'deleting' AND x.claim_state = 'live' THEN 'wait_for_lease'
             WHEN x.state IN ('deleting', 'failed') THEN 'reconcile_then_retry'
             WHEN x.last_error = 'object_missing_unverified' THEN 'investigate_unverified_disappearance'
             WHEN x.last_error = 'object_reappeared' THEN 'investigate_reappeared_object'
             ELSE 'investigate_repeated_failure' END) ORDER BY x.updated_at DESC), '[]'::jsonb)
    INTO v_items FROM x;
  RETURN jsonb_build_object(
    'items', v_items,
    -- Supabase Storage gives a project no way to confirm removal from the
    -- underlying object store, or to list objects whose metadata is gone.
    'physical_erasure_verifiable', false,
    'classifications_24h', (SELECT COALESCE(jsonb_object_agg(s.classification, s.n), '{}'::jsonb)
                              FROM (SELECT e.classification, count(*) AS n FROM private.retention_purge_erasure_records e
                                     WHERE e.recorded_at > clock_timestamp() - interval '24 hours' GROUP BY 1) s));
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.admin_privileges_guard(), private.admin_privileges_no_change(), private.admin_privileges_record(),
                       private.has_purge_privilege(uuid, text), private.lock_purge_privilege(uuid, text), private.require_privilege_operator(),
                       private.grant_admin_privilege(uuid, text, uuid, text), private.revoke_admin_privilege(uuid, text, uuid, text),
                       private.retention_purge_attempt_record(uuid), private.retention_purge_record_completion(),
                       private.retention_purge_record_attention()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_retention_confirm_copy(uuid, uuid, text, jsonb), public.admin_retention_purge_reconciliation(uuid, integer)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_retention_confirm_copy(uuid, uuid, text, jsonb), public.admin_retention_purge_reconciliation(uuid, integer)
  TO authenticated;

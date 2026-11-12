-- Phase 2B M4 step 4B — two-administrator manual retention purge executor.
--
-- Scope (nothing else can be purged by this code):
--   * report_evidence: content_reports.evidence of ordinary, resolved reports
--     past evidence_purge_after. Only that column is cleared; the report row,
--     details, status, resolution, ids and the audit log stay.
--   * quarantine_copy: the private moderation-quarantine object of a TERMINAL
--     (restored / cancelled) job past retain_until. Only that exact object is
--     deleted; never a source file, never by prefix.
-- Excluded by construction: child safety, active legal holds (subject or
-- account), ambiguous deleted-owner holds (G6), open reports, live
-- restrictions / profile locks / suspensions, non-terminal quarantine jobs,
-- notes, reporter details, profile-field originals.
--
-- Flow (manual only; nothing is scheduled):
--   preview (read-only) → Admin A prepares a bounded run of exact ids (frozen
--   with a digest, the policy snapshot and a 30-minute approval window) →
--   Admin B (≠ A) approves that exact run (digest + count) → an admin other
--   than A executes within 30 minutes. Every item is re-checked immediately
--   before it is purged; a changed or newly held item is SKIPPED, never
--   forced. Each purge goes through a two-admin claim (20261124120000), so the
--   report and Storage guards authorise it independently.
--
-- Report evidence: one transaction per item — claim, clear, tombstone, audit
-- and completion commit together or not at all (a sub-transaction; a failure
-- records a bounded retry instead).
-- Quarantine copies: claim (DB) → Storage API delete of the exact path
-- (admin-retention-purge Edge Function, service role, checked by the Storage
-- guard against the claim) → confirm (DB). Confirmation requires BOTH the
-- object to be gone AND the claim to have been consumed by the guard: an
-- object that disappeared without an authorised delete is never counted as
-- purged — it is flagged needs_attention for manual investigation.
--
-- Tombstones hold operational metadata only: ids, run, admins, policy, due
-- date, size and a coarse category. No content, hash, text, details, path or
-- note.

-- ── 1. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE private.retention_purge_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category             text NOT NULL CHECK (category IN ('report_evidence', 'quarantine_copy')),
  policy_key           text NOT NULL,
  policy_period        interval NOT NULL,
  item_count           integer NOT NULL CHECK (item_count BETWEEN 1 AND 50),
  set_digest           text NOT NULL CHECK (set_digest ~ '^[0-9a-f]{32}$'),
  prepared_by          uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  prepared_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  approval_expires_at  timestamptz NOT NULL,
  approved_by          uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at          timestamptz,
  execution_expires_at timestamptz,
  status               text NOT NULL DEFAULT 'prepared'
                       CHECK (status IN ('prepared', 'approved', 'completed', 'expired', 'cancelled')),
  closed_at            timestamptz,
  CONSTRAINT retention_purge_runs_two_admins CHECK (approved_by IS NULL OR prepared_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT retention_purge_runs_approval_shape CHECK ((approved_at IS NULL) = (execution_expires_at IS NULL)
                                                       AND (status NOT IN ('approved', 'completed') OR approved_at IS NOT NULL)),
  CONSTRAINT retention_purge_runs_closed_shape CHECK ((closed_at IS NULL) = (status IN ('prepared', 'approved'))),
  CONSTRAINT retention_purge_runs_windows CHECK (approval_expires_at <= prepared_at + interval '30 minutes'
                                                 AND (approved_at IS NULL OR execution_expires_at <= approved_at + interval '30 minutes'))
);

CREATE TABLE private.retention_purge_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES private.retention_purge_runs (id) ON DELETE RESTRICT,
  subject_kind     text NOT NULL CHECK (subject_kind IN ('report_evidence', 'quarantine_copy')),
  subject_id       uuid NOT NULL,
  due_at           timestamptz,
  size_bytes       bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  state            text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'deleting', 'failed', 'completed', 'skipped', 'needs_attention')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  claim_id         uuid,
  lease_expires_at timestamptz,
  last_error       text CHECK (last_error ~ '^[a-z0-9_]{1,64}$'),
  skip_reasons     text[],
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, subject_id),
  CONSTRAINT retention_purge_items_deleting_shape CHECK (state <> 'deleting' OR (claim_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT retention_purge_items_completed_shape CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT retention_purge_items_skipped_shape CHECK ((state = 'skipped') = (skip_reasons IS NOT NULL))
);
-- A subject is in at most one open item (prepared or approved, not finished).
CREATE UNIQUE INDEX retention_purge_items_one_open ON private.retention_purge_items (subject_kind, subject_id)
  WHERE state IN ('pending', 'deleting', 'failed');

CREATE TABLE private.retention_purge_tombstones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL UNIQUE REFERENCES private.retention_purge_items (id) ON DELETE RESTRICT,
  run_id          uuid NOT NULL REFERENCES private.retention_purge_runs (id) ON DELETE RESTRICT,
  subject_kind    text NOT NULL CHECK (subject_kind IN ('report_evidence', 'quarantine_copy')),
  subject_id      uuid NOT NULL,
  policy_key      text NOT NULL,
  policy_period   interval NOT NULL,
  due_at          timestamptz,
  size_bytes      bigint,
  category_detail text NOT NULL CHECK (category_detail ~ '^[a-z_]{1,32}:[a-z_]{1,32}$'),
  prepared_by     uuid,
  approved_by     uuid,
  executed_by     uuid NOT NULL,
  purged_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.retention_purge_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES private.retention_purge_runs (id) ON DELETE RESTRICT,
  item_id    uuid REFERENCES private.retention_purge_items (id) ON DELETE RESTRICT,
  event      text NOT NULL CHECK (event IN ('prepared', 'approved', 'cancelled', 'expired', 'completed',
                                            'item_claimed', 'item_completed', 'item_skipped', 'item_failed',
                                            'item_flagged', 'item_reconciled')),
  admin_id   uuid,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX retention_purge_events_run_idx ON private.retention_purge_events (run_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_purge_runs', 'retention_purge_items', 'retention_purge_tombstones', 'retention_purge_events'] LOOP
    EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE private.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;

-- ── 1b. Claims can be withdrawn early ───────────────────────────────────────
-- (20261124120000 closed a claim only when the Storage / report guard used
-- it, or after its lease.) The executor gives up an unused claim as soon as
-- its item ends any other way, so no authority outlives its purpose. This
-- only narrows what a claim can authorise; the function body is otherwise
-- unchanged.
ALTER TABLE private.retention_purge_claims DROP CONSTRAINT retention_purge_claims_close_reason_check;
ALTER TABLE private.retention_purge_claims ADD CONSTRAINT retention_purge_claims_close_reason_check
  CHECK (close_reason IN ('consumed', 'expired', 'withdrawn'));
CREATE OR REPLACE FUNCTION private.retention_purge_claims_guard()
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
            OR (NEW.close_reason = 'expired' AND OLD.lease_expires_at <= clock_timestamp())
            OR NEW.close_reason = 'withdrawn') THEN   -- 20261125120000: an unused claim may be given up early
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'retention_purge_claims_append_only' USING ERRCODE = '42501';
END;
$$;

-- ── 2. History guards ───────────────────────────────────────────────────────
-- Tombstones and events: insert only. Runs and items: fixed identity, allowed
-- state transitions only, deleted-admin anonymisation. No DELETE / TRUNCATE.
CREATE FUNCTION private.retention_purge_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'retention_purge_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER retention_purge_tombstones_history BEFORE UPDATE OR DELETE ON private.retention_purge_tombstones
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_append_only();
CREATE TRIGGER retention_purge_tombstones_no_truncate BEFORE TRUNCATE ON private.retention_purge_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_append_only();
CREATE TRIGGER retention_purge_events_history BEFORE UPDATE OR DELETE ON private.retention_purge_events
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_append_only();
CREATE TRIGGER retention_purge_events_no_truncate BEFORE TRUNCATE ON private.retention_purge_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_append_only();

CREATE FUNCTION private.retention_purge_runs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id = OLD.id AND NEW.category = OLD.category AND NEW.policy_key = OLD.policy_key
       AND NEW.policy_period = OLD.policy_period AND NEW.item_count = OLD.item_count AND NEW.set_digest = OLD.set_digest
       AND NEW.prepared_at = OLD.prepared_at AND NEW.approval_expires_at = OLD.approval_expires_at
       AND (NEW.prepared_by IS NOT DISTINCT FROM OLD.prepared_by OR NEW.prepared_by IS NULL)
       AND (NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by OR NEW.approved_by IS NULL OR OLD.approved_by IS NULL)
       AND (OLD.approved_at IS NULL OR (NEW.approved_at = OLD.approved_at AND NEW.execution_expires_at = OLD.execution_expires_at))
       AND (NEW.status = OLD.status
            OR (OLD.status = 'prepared' AND NEW.status IN ('approved', 'expired', 'cancelled'))
            OR (OLD.status = 'approved' AND NEW.status IN ('completed', 'expired', 'cancelled')))
       AND (OLD.closed_at IS NULL OR NEW.closed_at = OLD.closed_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'retention_purge_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER retention_purge_runs_history BEFORE UPDATE OR DELETE ON private.retention_purge_runs
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_runs_guard();
CREATE TRIGGER retention_purge_runs_no_truncate BEFORE TRUNCATE ON private.retention_purge_runs
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_append_only();

CREATE FUNCTION private.retention_purge_items_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id = OLD.id AND NEW.run_id = OLD.run_id AND NEW.subject_kind = OLD.subject_kind AND NEW.subject_id = OLD.subject_id
       AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
       AND NEW.attempts >= OLD.attempts
       AND OLD.state NOT IN ('completed', 'skipped', 'needs_attention')
       AND (NEW.state = OLD.state
            OR (OLD.state = 'pending'  AND NEW.state IN ('deleting', 'failed', 'completed', 'skipped', 'needs_attention'))
            OR (OLD.state = 'deleting' AND NEW.state IN ('failed', 'completed', 'skipped', 'needs_attention'))
            OR (OLD.state = 'failed'   AND NEW.state IN ('deleting', 'completed', 'skipped', 'needs_attention'))) THEN
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'retention_purge_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER retention_purge_items_history BEFORE UPDATE OR DELETE ON private.retention_purge_items
  FOR EACH ROW EXECUTE FUNCTION private.retention_purge_items_guard();
CREATE TRIGGER retention_purge_items_no_truncate BEFORE TRUNCATE ON private.retention_purge_items
  FOR EACH STATEMENT EXECUTE FUNCTION private.retention_purge_append_only();

-- Audit vocabulary (per purged item).
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_action_check CHECK (action = ANY (ARRAY[
  'claim', 'release', 'resolve', 'reopen', 'hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields',
  'release_profile_fields', 'suspend', 'lift_suspension',
  'place_legal_hold', 'renew_legal_hold', 'request_legal_hold_release', 'release_legal_hold',
  'purge_report_evidence', 'purge_quarantine_copy']));

-- ── 3. Helpers ──────────────────────────────────────────────────────────────
-- Everything that stops this exact subject being purged NOW (the 4A blockers
-- plus availability, due date and, for copies, the exact private object).
CREATE FUNCTION private.retention_purge_item_blockers(p_kind text, p_id uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.content_reports;
  q private.media_quarantine;
  o storage.objects;
  b text[];
BEGIN
  IF p_kind = 'report_evidence' THEN
    SELECT * INTO r FROM public.content_reports x WHERE x.id = p_id;
    IF NOT FOUND THEN RETURN ARRAY['not_found']; END IF;
    b := private.report_evidence_purge_blockers(r.id);
    IF r.evidence IS NULL THEN b := b || 'evidence_unavailable'::text; END IF;
    IF r.evidence_purge_after > now() THEN b := b || 'not_due'::text; END IF;
    RETURN b;
  ELSIF p_kind = 'quarantine_copy' THEN
    SELECT * INTO q FROM private.media_quarantine x WHERE x.id = p_id;
    IF NOT FOUND THEN RETURN ARRAY['not_found']; END IF;
    b := private.quarantine_copy_purge_blockers(q.id);
    IF q.state NOT IN ('restored', 'cancelled') AND NOT ('quarantine_not_terminal' = ANY (b)) THEN
      b := b || 'quarantine_not_terminal'::text;
    END IF;
    IF q.retain_until > now() THEN b := b || 'not_due'::text; END IF;
    IF q.quarantine_path !~ '^q/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original$'
       OR (q.quarantine_bucket = q.source_bucket AND q.quarantine_path = q.source_path) THEN
      b := b || 'path_unexpected'::text;
    END IF;
    SELECT * INTO o FROM storage.objects so WHERE so.bucket_id = q.quarantine_bucket AND so.name = q.quarantine_path;
    IF NOT FOUND THEN
      b := b || 'object_missing'::text;
    ELSIF q.size_bytes IS NULL OR (o.metadata ->> 'size') IS NULL OR (o.metadata ->> 'size')::bigint <> q.size_bytes THEN
      b := b || 'object_metadata_mismatch'::text;
    END IF;
    RETURN b;
  END IF;
  RETURN ARRAY['invalid_subject'];
END;
$$;

CREATE FUNCTION private.retention_purge_policy_key(p_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE p_category WHEN 'report_evidence' THEN 'report_evidence_after_resolution'
                         WHEN 'quarantine_copy' THEN 'quarantine_copy_after_release' END;
$$;

-- The policy must be enforced and conform before anything is prepared or run.
CREATE FUNCTION private.retention_purge_require_policy(p_category text)
RETURNS private.retention_policy
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  p private.retention_policy;
BEGIN
  SELECT * INTO p FROM private.retention_policy x WHERE x.key = private.retention_purge_policy_key(p_category);
  IF NOT FOUND OR p.status <> 'enforced' OR p.period IS NULL THEN
    RAISE EXCEPTION 'policy_not_enforced' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM private.retention_policy_conformance() c WHERE c.policy_key = p.key AND NOT c.conforms) THEN
    RAISE EXCEPTION 'retention_policy_drift' USING ERRCODE = 'P0001';
  END IF;
  RETURN p;
END;
$$;

CREATE FUNCTION private.retention_purge_admin_active(p_admin uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_admin IS NOT NULL AND EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = p_admin)
     AND NOT private.account_is_hidden(p_admin);
$$;

CREATE FUNCTION private.retention_purge_digest(p_ids uuid[])
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT md5(string_agg(x::text, ',' ORDER BY x)) FROM unnest(p_ids) x;
$$;

CREATE FUNCTION private.retention_purge_event(p_run uuid, p_item uuid, p_event text, p_admin uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO private.retention_purge_events (run_id, item_id, event, admin_id, detail) VALUES (p_run, p_item, p_event, p_admin, p_detail);
$$;

CREATE FUNCTION private.retention_purge_error_code(p_message text, p_state text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN p_message ~ '^[a-z0-9_]{1,64}$' THEN p_message ELSE 'error_' || lower(p_state) END;
$$;

-- Bookkeeping: close runs whose window has passed. Items that provably were
-- not deleted (pending, or failed with no claim / an expired claim) are
-- skipped ('run_expired'); anything else stays until it is reconciled (an
-- authorised delete may already have happened).
CREATE FUNCTION private.retention_purge_expire_runs()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r private.retention_purge_runs;
BEGIN
  FOR r IN SELECT * FROM private.retention_purge_runs x
            WHERE (x.status = 'prepared' AND x.approval_expires_at <= now())
               OR (x.status = 'approved' AND x.execution_expires_at <= now())
            FOR UPDATE SKIP LOCKED LOOP
    UPDATE private.retention_purge_items i SET state = 'skipped', skip_reasons = ARRAY['run_expired']
     WHERE i.run_id = r.id
       AND (i.state = 'pending'
            OR (i.state = 'failed' AND (i.claim_id IS NULL OR EXISTS (SELECT 1 FROM private.retention_purge_claims c
                                                                       WHERE c.id = i.claim_id AND c.close_reason = 'expired'))));
    IF NOT EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.run_id = r.id AND i.state IN ('deleting', 'failed')) THEN
      UPDATE private.retention_purge_runs SET status = 'expired', closed_at = clock_timestamp() WHERE id = r.id;
      PERFORM private.retention_purge_event(r.id, NULL, 'expired', NULL);
    END IF;
  END LOOP;
END;
$$;

-- Closes a run once none of its items is open.
CREATE FUNCTION private.retention_purge_maybe_complete(p_run uuid, p_admin uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.run_id = p_run AND i.state IN ('pending', 'deleting', 'failed')) THEN
    UPDATE private.retention_purge_runs SET status = CASE WHEN status = 'approved' THEN 'completed' ELSE 'expired' END,
           closed_at = clock_timestamp()
     WHERE id = p_run AND status IN ('approved', 'prepared') AND (status = 'approved' OR approval_expires_at <= now());
    IF FOUND THEN
      PERFORM private.retention_purge_event(p_run, NULL, 'completed', p_admin);
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION private.retention_purge_run_view(p_run uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'category', r.category, 'status', r.status, 'policy_key', r.policy_key, 'policy_period', r.policy_period::text,
    'item_count', r.item_count, 'set_digest', r.set_digest,
    'prepared_by', r.prepared_by, 'prepared_at', r.prepared_at, 'approval_expires_at', r.approval_expires_at,
    'approved_by', r.approved_by, 'approved_at', r.approved_at, 'execution_expires_at', r.execution_expires_at,
    'closed_at', r.closed_at,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'id', i.id, 'subject_kind', i.subject_kind, 'subject_id', i.subject_id, 'state', i.state, 'due_at', i.due_at,
                 'size_bytes', i.size_bytes, 'attempts', i.attempts, 'last_error', i.last_error, 'skip_reasons', to_jsonb(i.skip_reasons),
                 'current_blockers', CASE WHEN i.state IN ('pending', 'failed')
                                          THEN to_jsonb(private.retention_purge_item_blockers(i.subject_kind, i.subject_id)) END)
                 ORDER BY i.subject_id)
               FROM private.retention_purge_items i WHERE i.run_id = r.id), '[]'::jsonb))
    FROM private.retention_purge_runs r WHERE r.id = p_run;
$$;

-- Common execution authorisation: approved, inside its window, the caller is
-- an active admin who did NOT prepare it, and both run admins are still active.
CREATE FUNCTION private.retention_purge_authorize_execution(p_run_id uuid, p_admin uuid, p_category text)
RETURNS private.retention_purge_runs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  RETURN r;
END;
$$;

-- ── 4. Preview (read-only) ──────────────────────────────────────────────────
CREATE FUNCTION public.admin_retention_purge_preview(p_category text, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  p private.retention_policy;
  v_conforms boolean;
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('report_evidence', 'quarantine_copy') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM private.retention_policy x WHERE x.key = private.retention_purge_policy_key(p_category);
  v_conforms := NOT EXISTS (SELECT 1 FROM private.retention_policy_conformance() c WHERE c.policy_key = p.key AND NOT c.conforms);
  RETURN (
    WITH c AS (
      SELECT rc.record_id AS id, rc.due_at,
             private.retention_purge_item_blockers(p_category, rc.record_id)
               || CASE WHEN EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.subject_kind = p_category
                                       AND i.subject_id = rc.record_id AND i.state IN ('pending', 'deleting', 'failed'))
                       THEN ARRAY['in_open_run'] ELSE ARRAY[]::text[] END AS blockers,
             CASE WHEN p_category = 'report_evidence'
                  THEN (SELECT octet_length(r.evidence::text) FROM public.content_reports r WHERE r.id = rc.record_id)
                  ELSE (SELECT q.size_bytes FROM private.media_quarantine q WHERE q.id = rc.record_id) END::bigint AS size_bytes
        FROM private.retention_candidates() rc WHERE rc.category = p_category
    )
    SELECT jsonb_build_object(
      'category', p_category,
      'policy', jsonb_build_object('key', p.key, 'period', p.period::text, 'status', p.status, 'conforms', v_conforms,
                                   'executable', p.status = 'enforced' AND v_conforms),
      'eligible', COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', e.id, 'due_at', e.due_at, 'size_bytes', e.size_bytes)
                                             ORDER BY e.due_at, e.id)
                              FROM (SELECT * FROM c WHERE cardinality(c.blockers) = 0 ORDER BY c.due_at, c.id LIMIT p_limit) e), '[]'::jsonb),
      'excluded', COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_id', x.id, 'blockers', to_jsonb(x.blockers)) ORDER BY x.id)
                              FROM (SELECT * FROM c WHERE cardinality(c.blockers) > 0 ORDER BY c.id LIMIT p_limit) x), '[]'::jsonb),
      'totals', (SELECT jsonb_build_object('eligible', count(*) FILTER (WHERE cardinality(blockers) = 0),
                                           'excluded', count(*) FILTER (WHERE cardinality(blockers) > 0),
                                           'eligible_bytes', COALESCE(sum(size_bytes) FILTER (WHERE cardinality(blockers) = 0), 0))
                   FROM c))
  );
END;
$$;

-- ── 5. Prepare (Admin A) ────────────────────────────────────────────────────
CREATE FUNCTION public.admin_retention_prepare_run(p_category text, p_subject_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
$$;

-- ── 6. Approve (Admin B) ────────────────────────────────────────────────────
-- Binds to the exact frozen set (digest + count). Approval never changes
-- eligibility: execution re-checks every item and skips any that changed.
CREATE FUNCTION public.admin_retention_approve_run(p_run_id uuid, p_set_digest text, p_item_count integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  IF r.status = 'expired' OR (r.status = 'prepared' AND r.approval_expires_at <= now()) THEN
    RAISE EXCEPTION 'run_expired' USING ERRCODE = 'PT409';
  END IF;
  IF r.status <> 'prepared' THEN
    RAISE EXCEPTION 'run_not_pending' USING ERRCODE = 'PT409';
  END IF;
  IF NOT private.retention_purge_admin_active(r.prepared_by) THEN
    RAISE EXCEPTION 'preparer_inactive' USING ERRCODE = '42501';
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
$$;

-- Either run admin (or any admin) may cancel before completion; nothing is purged.
CREATE FUNCTION public.admin_retention_cancel_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
BEGIN
  SELECT * INTO r FROM private.retention_purge_runs x WHERE x.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF r.status NOT IN ('prepared', 'approved') THEN
    RAISE EXCEPTION 'run_not_pending' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM private.retention_purge_items i WHERE i.run_id = r.id AND i.state = 'deleting') THEN
    RAISE EXCEPTION 'run_has_deletions_in_flight' USING ERRCODE = 'PT409';
  END IF;
  UPDATE private.retention_purge_items SET state = 'skipped', skip_reasons = ARRAY['run_cancelled']
   WHERE run_id = r.id AND state IN ('pending', 'failed');
  UPDATE private.retention_purge_runs SET status = 'cancelled', closed_at = clock_timestamp() WHERE id = r.id;
  PERFORM private.retention_purge_event(r.id, NULL, 'cancelled', v_admin);
  RETURN private.retention_purge_run_view(r.id);
END;
$$;

-- ── 7. Execute: report evidence ─────────────────────────────────────────────
CREATE FUNCTION public.admin_retention_execute_reports(p_run_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  i private.retention_purge_items;
  rep public.content_reports;
  b text[];
  v_claim uuid;
  v_tomb uuid;
  v_rows integer;
  v_err text;
  v_done integer := 0; v_skipped integer := 0; v_failed integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  PERFORM private.retention_purge_expire_runs();
  r := private.retention_purge_authorize_execution(p_run_id, v_admin, 'report_evidence');
  PERFORM private.retention_purge_require_policy('report_evidence');
  FOR i IN SELECT * FROM private.retention_purge_items x
            WHERE x.run_id = r.id AND x.state IN ('pending', 'failed')
            ORDER BY x.subject_id LIMIT p_limit FOR UPDATE LOOP
    BEGIN
      -- Same lock order as the report guard and legal-hold placement.
      PERFORM private.legal_hold_lock('report', i.subject_id);
      SELECT * INTO rep FROM public.content_reports x WHERE x.id = i.subject_id FOR UPDATE;
      IF rep.target_owner_id IS NOT NULL THEN
        PERFORM private.legal_hold_lock('account', rep.target_owner_id);
      END IF;
      b := private.retention_purge_item_blockers('report_evidence', i.subject_id);
      IF cardinality(b) > 0 THEN
        UPDATE private.retention_purge_items SET state = 'skipped', skip_reasons = b WHERE id = i.id;
        PERFORM private.retention_purge_event(r.id, i.id, 'item_skipped', v_admin, jsonb_build_object('blockers', to_jsonb(b)));
        v_skipped := v_skipped + 1;
      ELSE
        INSERT INTO private.retention_purge_claims (subject_kind, subject_id, run_id, prepared_by, approved_by, lease_expires_at)
        VALUES ('report_evidence', i.subject_id, r.id, r.prepared_by, r.approved_by, clock_timestamp() + interval '1 minute')
        RETURNING id INTO v_claim;
        UPDATE public.content_reports SET evidence = NULL WHERE id = i.subject_id AND evidence IS NOT NULL;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'evidence_unavailable';
        END IF;
        INSERT INTO private.retention_purge_tombstones (item_id, run_id, subject_kind, subject_id, policy_key, policy_period, due_at,
                                                        size_bytes, category_detail, prepared_by, approved_by, executed_by)
        VALUES (i.id, r.id, 'report_evidence', i.subject_id, r.policy_key, r.policy_period, rep.evidence_purge_after,
                i.size_bytes, rep.reason || ':' || rep.status, r.prepared_by, r.approved_by, v_admin)
        RETURNING id INTO v_tomb;
        INSERT INTO public.moderation_actions (admin_id, report_id, action, target_type, target_id, target_owner_id, reason_code, metadata)
        VALUES (v_admin, rep.id, 'purge_report_evidence', rep.target_type, rep.target_id,
                (SELECT u.id FROM auth.users u WHERE u.id = rep.target_owner_id), r.policy_key,
                jsonb_build_object('run_id', r.id, 'item_id', i.id, 'tombstone_id', v_tomb, 'prepared_by', r.prepared_by,
                                   'approved_by', r.approved_by, 'due_at', rep.evidence_purge_after));
        UPDATE private.retention_purge_items SET state = 'completed', completed_at = clock_timestamp(), claim_id = v_claim,
               last_error = NULL WHERE id = i.id;
        PERFORM private.retention_purge_event(r.id, i.id, 'item_completed', v_admin);
        v_done := v_done + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Everything above for this item is rolled back (evidence included).
      v_err := private.retention_purge_error_code(SQLERRM, SQLSTATE);
      UPDATE private.retention_purge_items
         SET attempts = LEAST(attempts + 1, 3), last_error = v_err,
             state = CASE WHEN attempts + 1 >= 3 THEN 'needs_attention' ELSE 'failed' END
       WHERE id = i.id;
      PERFORM private.retention_purge_event(r.id, i.id, CASE WHEN i.attempts + 1 >= 3 THEN 'item_flagged' ELSE 'item_failed' END,
                                            v_admin, jsonb_build_object('error', v_err));
      v_failed := v_failed + 1;
    END;
  END LOOP;
  PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
  RETURN jsonb_build_object('run', private.retention_purge_run_view(r.id),
                            'processed', jsonb_build_object('completed', v_done, 'skipped', v_skipped, 'failed', v_failed));
END;
$$;

-- ── 8. Execute: quarantine copies (claim → Storage delete → confirm) ────────
-- Settles an item that is 'deleting' (or 'failed' after a delete attempt)
-- from the database's own evidence, never from the caller's word:
--   object gone AND claim consumed by the Storage guard → completed
--   object still there, claim lease over                  → failed / flagged
--   object gone, claim NOT consumed                       → needs_attention
--   object still there, claim lease live                  → 'in_flight'
--   claim consumed but an object is back at the path       → needs_attention
-- Returns the resulting state (or 'in_flight').
CREATE FUNCTION private.retention_purge_settle_copy(r private.retention_purge_runs, p_item uuid, p_admin uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  i private.retention_purge_items;
  q private.media_quarantine;
  c private.retention_purge_claims;
  v_present boolean;
  v_tomb uuid;
BEGIN
  SELECT * INTO i FROM private.retention_purge_items x WHERE x.id = p_item AND x.run_id = r.id FOR UPDATE;
  IF NOT FOUND OR i.subject_kind <> 'quarantine_copy' THEN
    RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'PT404';
  END IF;
  IF i.state NOT IN ('deleting', 'failed') OR i.claim_id IS NULL THEN
    RETURN i.state;
  END IF;
  SELECT * INTO q FROM private.media_quarantine x WHERE x.id = i.subject_id;
  SELECT * INTO c FROM private.retention_purge_claims x WHERE x.id = i.claim_id;
  v_present := EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = q.quarantine_bucket AND o.name = q.quarantine_path);
  IF NOT v_present AND c.close_reason = 'consumed' THEN
    INSERT INTO private.retention_purge_tombstones (item_id, run_id, subject_kind, subject_id, policy_key, policy_period, due_at,
                                                    size_bytes, category_detail, prepared_by, approved_by, executed_by)
    VALUES (i.id, r.id, 'quarantine_copy', i.subject_id, r.policy_key, r.policy_period, q.retain_until, i.size_bytes,
            q.media_kind || ':' || q.state, r.prepared_by, r.approved_by, p_admin)
    RETURNING id INTO v_tomb;
    INSERT INTO public.moderation_actions (admin_id, action, target_type, target_id, target_owner_id, reason_code, metadata)
    VALUES (p_admin, 'purge_quarantine_copy',
            CASE WHEN q.origin_target_type IN ('profile', 'post', 'comment', 'item_comment', 'folder_comment', 'gallery_comment',
                                               'message', 'collection_item', 'folder') THEN q.origin_target_type ELSE 'profile' END,
            CASE WHEN q.origin_target_type IN ('profile', 'post', 'comment', 'item_comment', 'folder_comment', 'gallery_comment',
                                               'message', 'collection_item', 'folder') THEN q.origin_target_id ELSE q.owner_id END,
            (SELECT u.id FROM auth.users u WHERE u.id = q.owner_id), r.policy_key,
            jsonb_build_object('run_id', r.id, 'item_id', i.id, 'tombstone_id', v_tomb, 'quarantine_id', q.id,
                               'prepared_by', r.prepared_by, 'approved_by', r.approved_by, 'due_at', q.retain_until));
    UPDATE private.retention_purge_items SET state = 'completed', completed_at = clock_timestamp(), lease_expires_at = NULL,
           last_error = NULL WHERE id = i.id;
    PERFORM private.retention_purge_event(r.id, i.id, 'item_completed', p_admin);
    RETURN 'completed';
  ELSIF v_present AND c.close_reason = 'consumed' THEN
    -- The guard authorised a delete, yet an object is at the path again.
    UPDATE private.retention_purge_items SET state = 'needs_attention', last_error = 'object_reappeared', lease_expires_at = NULL WHERE id = i.id;
    PERFORM private.retention_purge_event(r.id, i.id, 'item_flagged', p_admin, jsonb_build_object('error', 'object_reappeared'));
    RETURN 'needs_attention';
  ELSIF NOT v_present THEN
    -- Gone, but not through an authorised delete: never count it as purged,
    -- and give up the unused claim so it can authorise nothing else.
    UPDATE private.retention_purge_claims SET closed_at = clock_timestamp(), close_reason = 'withdrawn'
     WHERE id = c.id AND closed_at IS NULL;
    UPDATE private.retention_purge_items SET state = 'needs_attention', last_error = 'object_missing_unverified', lease_expires_at = NULL WHERE id = i.id;
    PERFORM private.retention_purge_event(r.id, i.id, 'item_flagged', p_admin, jsonb_build_object('error', 'object_missing_unverified'));
    RETURN 'needs_attention';
  ELSIF c.closed_at IS NULL AND c.lease_expires_at > clock_timestamp() THEN
    RETURN 'in_flight';   -- a delete may still be under way
  ELSE
    IF c.closed_at IS NULL THEN
      UPDATE private.retention_purge_claims SET closed_at = clock_timestamp(), close_reason = 'expired' WHERE id = c.id;
    END IF;
    UPDATE private.retention_purge_items
       SET state = CASE WHEN attempts >= 3 THEN 'needs_attention' ELSE 'failed' END,
           last_error = COALESCE(last_error, 'delete_not_completed'), lease_expires_at = NULL
     WHERE id = i.id;
    PERFORM private.retention_purge_event(r.id, i.id, CASE WHEN i.attempts >= 3 THEN 'item_flagged' ELSE 'item_failed' END,
                                          p_admin, jsonb_build_object('error', 'delete_not_completed'));
    RETURN CASE WHEN i.attempts >= 3 THEN 'needs_attention' ELSE 'failed' END;
  END IF;
END;
$$;

-- Claims the next (or the given) open copy of an approved run for deletion.
-- Returns the exact bucket/path from the job record (never from the caller),
-- or {done: true} when nothing is left to claim.
CREATE FUNCTION public.admin_retention_claim_copy(p_run_id uuid, p_item_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  r private.retention_purge_runs;
  i private.retention_purge_items;
  q private.media_quarantine;
  b text[];
  v_claim private.retention_purge_claims;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_settled text;
BEGIN
  PERFORM private.retention_purge_expire_runs();
  -- A finished run has nothing left to claim.
  IF EXISTS (SELECT 1 FROM private.retention_purge_runs x WHERE x.id = p_run_id AND x.category = 'quarantine_copy'
                AND x.status = 'completed' AND x.prepared_by IS DISTINCT FROM v_admin) THEN
    RETURN jsonb_build_object('done', true);
  END IF;
  r := private.retention_purge_authorize_execution(p_run_id, v_admin, 'quarantine_copy');
  PERFORM private.retention_purge_require_policy('quarantine_copy');
  LOOP
    SELECT * INTO i FROM private.retention_purge_items x
     WHERE x.run_id = r.id AND (p_item_id IS NULL OR x.id = p_item_id) AND NOT (x.id = ANY (v_seen))
       AND (x.state IN ('pending', 'failed') OR (x.state = 'deleting' AND x.lease_expires_at <= clock_timestamp()))
     ORDER BY x.subject_id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      IF p_item_id IS NOT NULL AND (p_item_id = ANY (v_seen) OR EXISTS (SELECT 1 FROM private.retention_purge_items x
                                     WHERE x.id = p_item_id AND x.run_id = r.id AND x.state = 'deleting')) THEN
        RETURN jsonb_build_object('item_id', p_item_id, 'outcome', 'item_busy');
      END IF;
      PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
      RETURN jsonb_build_object('done', true);
    END IF;
    -- A previous attempt's claim (failed, or in flight with its lease over):
    -- settle it first (an authorised delete may already have happened, or
    -- its lease may still be running).
    v_seen := v_seen || i.id;
    IF i.state IN ('failed', 'deleting') AND i.claim_id IS NOT NULL THEN
      v_settled := private.retention_purge_settle_copy(r, i.id, v_admin);
      IF v_settled = 'in_flight' THEN
        CONTINUE;   -- the previous claim's lease is still running
      ELSIF v_settled <> 'failed' THEN
        IF p_item_id IS NOT NULL THEN
          RETURN jsonb_build_object('item_id', i.id, 'outcome', v_settled);
        END IF;
        CONTINUE;
      END IF;
      SELECT * INTO i FROM private.retention_purge_items x WHERE x.id = i.id;
    END IF;
    IF i.attempts >= 3 THEN
      UPDATE private.retention_purge_items SET state = 'needs_attention', last_error = COALESCE(last_error, 'retries_exhausted') WHERE id = i.id;
      PERFORM private.retention_purge_event(r.id, i.id, 'item_flagged', v_admin, jsonb_build_object('error', 'retries_exhausted'));
      CONTINUE;
    END IF;
    SELECT * INTO q FROM private.media_quarantine x WHERE x.id = i.subject_id;
    PERFORM private.legal_hold_lock('quarantine_copy', i.subject_id);
    PERFORM private.legal_hold_lock('account', q.owner_id);
    b := private.retention_purge_item_blockers('quarantine_copy', i.subject_id);
    IF cardinality(b) > 0 THEN
      UPDATE private.retention_purge_items SET state = 'skipped', skip_reasons = b, lease_expires_at = NULL WHERE id = i.id;
      PERFORM private.retention_purge_event(r.id, i.id, 'item_skipped', v_admin, jsonb_build_object('blockers', to_jsonb(b)));
      IF p_item_id IS NOT NULL THEN
        RETURN jsonb_build_object('item_id', i.id, 'outcome', 'skipped', 'blockers', to_jsonb(b));
      END IF;
      CONTINUE;
    END IF;
    INSERT INTO private.retention_purge_claims (subject_kind, subject_id, object_bucket, object_path, run_id, prepared_by, approved_by,
                                                lease_expires_at)
    VALUES ('quarantine_copy', q.id, q.quarantine_bucket, q.quarantine_path, r.id, r.prepared_by, r.approved_by,
            clock_timestamp() + interval '2 minutes')
    RETURNING * INTO v_claim;
    UPDATE private.retention_purge_items
       SET state = 'deleting', attempts = attempts + 1, claim_id = v_claim.id, lease_expires_at = v_claim.lease_expires_at, last_error = NULL
     WHERE id = i.id;
    PERFORM private.retention_purge_event(r.id, i.id, 'item_claimed', v_admin);
    RETURN jsonb_build_object('item_id', i.id, 'outcome', 'claimed', 'bucket', q.quarantine_bucket, 'path', q.quarantine_path,
                              'lease_expires_at', v_claim.lease_expires_at);
  END LOOP;
END;
$$;

-- After the Storage delete call (successful or not): settle from the
-- database's own evidence. p_storage_error records a failed call.
CREATE FUNCTION public.admin_retention_confirm_copy(p_run_id uuid, p_item_id uuid, p_storage_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  IF p_storage_error IS NOT NULL THEN
    UPDATE private.retention_purge_items SET last_error = private.retention_purge_error_code(lower(p_storage_error), 'storage')
     WHERE id = p_item_id AND run_id = r.id AND state = 'deleting';
  END IF;
  v_state := private.retention_purge_settle_copy(r, p_item_id, v_admin);
  PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
  RETURN jsonb_build_object('item_id', p_item_id, 'outcome', v_state);
END;
$$;

-- Settles every in-flight copy of a run (e.g. after a crash between the
-- Storage delete and the confirmation). Allowed after the execution window,
-- but never claims or deletes anything.
CREATE FUNCTION public.admin_retention_reconcile_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  FOR v_item IN SELECT i.id FROM private.retention_purge_items i
                 WHERE i.run_id = r.id AND i.state IN ('deleting', 'failed') AND i.claim_id IS NOT NULL ORDER BY i.id LOOP
    v_out := v_out || jsonb_build_object('item_id', v_item, 'outcome', private.retention_purge_settle_copy(r, v_item, v_admin));
    PERFORM private.retention_purge_event(r.id, v_item, 'item_reconciled', v_admin);
  END LOOP;
  PERFORM private.retention_purge_expire_runs();
  PERFORM private.retention_purge_maybe_complete(r.id, v_admin);
  RETURN jsonb_build_object('results', v_out, 'run', private.retention_purge_run_view(r.id));
END;
$$;

-- ── 9. Reads ────────────────────────────────────────────────────────────────
CREATE FUNCTION public.admin_retention_purge_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN private.retention_purge_run_view(p_run_id) || jsonb_build_object(
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('event', e.event, 'item_id', e.item_id, 'admin_id', e.admin_id,
                                                            'detail', e.detail, 'at', e.created_at) ORDER BY e.id)
                          FROM private.retention_purge_events e WHERE e.run_id = p_run_id), '[]'::jsonb),
    'tombstones', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.purged_at)
                              FROM private.retention_purge_tombstones t WHERE t.run_id = p_run_id), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.admin_list_retention_purge_runs(p_status text DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  IF (p_status IS NOT NULL AND p_status NOT IN ('prepared', 'approved', 'completed', 'expired', 'cancelled'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'category', r.category, 'status', r.status, 'item_count', r.item_count,
                                                       'prepared_by', r.prepared_by, 'approved_by', r.approved_by, 'prepared_at', r.prepared_at,
                                                       'needs_attention', (SELECT count(*) FROM private.retention_purge_items i
                                                                            WHERE i.run_id = r.id AND i.state = 'needs_attention'))
                                    ORDER BY r.prepared_at DESC)
                     FROM (SELECT * FROM private.retention_purge_runs x WHERE p_status IS NULL OR x.status = p_status
                            ORDER BY x.prepared_at DESC LIMIT p_limit) r), '[]'::jsonb);
END;
$$;

-- ── 10. Privileges ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.retention_purge_append_only(), private.retention_purge_runs_guard(), private.retention_purge_items_guard(),
  private.retention_purge_item_blockers(text, uuid), private.retention_purge_policy_key(text), private.retention_purge_require_policy(text),
  private.retention_purge_admin_active(uuid), private.retention_purge_digest(uuid[]),
  private.retention_purge_event(uuid, uuid, text, uuid, jsonb), private.retention_purge_error_code(text, text),
  private.retention_purge_expire_runs(), private.retention_purge_maybe_complete(uuid, uuid), private.retention_purge_run_view(uuid),
  private.retention_purge_authorize_execution(uuid, uuid, text),
  private.retention_purge_settle_copy(private.retention_purge_runs, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_retention_purge_preview(text, integer), public.admin_retention_prepare_run(text, uuid[]),
  public.admin_retention_approve_run(uuid, text, integer), public.admin_retention_cancel_run(uuid),
  public.admin_retention_execute_reports(uuid, integer), public.admin_retention_claim_copy(uuid, uuid),
  public.admin_retention_confirm_copy(uuid, uuid, text), public.admin_retention_reconcile_run(uuid),
  public.admin_retention_purge_run(uuid), public.admin_list_retention_purge_runs(text, integer)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_retention_purge_preview(text, integer), public.admin_retention_prepare_run(text, uuid[]),
  public.admin_retention_approve_run(uuid, text, integer), public.admin_retention_cancel_run(uuid),
  public.admin_retention_execute_reports(uuid, integer), public.admin_retention_claim_copy(uuid, uuid),
  public.admin_retention_confirm_copy(uuid, uuid, text), public.admin_retention_reconcile_run(uuid),
  public.admin_retention_purge_run(uuid), public.admin_list_retention_purge_runs(text, integer)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

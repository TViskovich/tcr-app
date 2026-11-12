-- Phase 2B M4, steps 1–3 — retention policy, legal holds, purge candidates.
--
-- NOTHING IN THIS MIGRATION DELETES, PURGES OR SHORTENS ANYTHING.
--   * No existing retention deadline (evidence_purge_after, retain_until,
--     purge_after, reserved_until) is changed, and no existing function body
--     is replaced: the moderation functions keep their own literals.
--   * The retention policy table centralises the periods for review and for
--     the read-only candidate discovery below; a conformance check reports
--     any drift between it and the literals still in those functions.
--   * Legal holds only add protection. Releasing a hold never deletes
--     anything; it only lets normal retention apply again.
--   * Purge candidate discovery is STABLE (it cannot write) and returns ids
--     and metadata only — never evidence, notes or original values.
--   * No purge executor, worker, schedule or cron entry is created.
--
-- Provisional decisions this implements (Phase 2B M4 brief):
--   D1 Child-safety evidence is never purgeable by any automatic or
--      candidate path; releasing a child-safety hold needs a release
--      request with a legal-review reference and approval by a second admin.
--      This migration does NOT decide how long child-safety evidence may or
--      must be kept: its policy row is 'unresolved' (see "Open conflict").
--   D2 Ordinary evidence: 90 days after resolution. Free-text moderation
--      notes: 1 year, PROPOSED (pending legal review) — every note is
--      reported as blocked by policy_pending_legal_review.
--   D3 Open reports keep their evidence; the summary shows report ageing.
--   D4 Deletion behaviour is unchanged. The summary reports active holds on
--      accounts that are pending deletion, because deletion currently
--      cascades some held evidence (moderated_profile_fields) — see below.
--   D5 Any admin may place an ordinary hold; another admin must release it;
--      at most 1 year; renewal creates a new audited row.
--   D6 No executor in this migration (manual + dry run comes later).
--
-- Open conflict (not resolved here): 20261114120000 §6 designed report holds
-- as mandatory, bounded (≤ 1 year) and renewable only by a new audited row,
-- so that preservation is never open-ended. 20261119120000 instead keeps
-- child-safety quarantine copies under legal_hold = true with no end date.
-- This migration keeps both as they are: ordinary holds are bounded; a
-- child-safety hold has no automatic expiry and stays until released through
-- the two-admin, legal-review path. Whether open-ended preservation of
-- child-safety material is permitted, required or limited is a legal
-- decision that is recorded as unresolved, not assumed.
--
-- Known gap (D4, not changed here): account deletion still CASCADE-deletes
-- moderated_profile_fields (including child-safety originals), even under an
-- account or profile_field hold. The hold row itself survives (no FK).

-- ── 1. Retention policy ─────────────────────────────────────────────────────
CREATE TABLE private.retention_policy (
  key                   text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
  period                interval CHECK (period IS NULL OR period > interval '0'),
  -- enforced:    already applied by existing code (the literal lives there)
  -- provisional: approved provisionally for M4, applied only by discovery
  -- proposed:    pending legal review; nothing may become eligible under it
  -- unresolved:  no period decided; nothing may become eligible under it
  status                text NOT NULL CHECK (status IN ('enforced', 'provisional', 'proposed', 'unresolved')),
  legal_review_required boolean NOT NULL,
  applies_to            text NOT NULL CHECK (char_length(applies_to) BETWEEN 1 AND 200),
  description           text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  CONSTRAINT retention_policy_period_shape CHECK ((status = 'unresolved') = (period IS NULL))
);
ALTER TABLE private.retention_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.retention_policy FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.retention_policy (key, period, status, legal_review_required, applies_to, description) VALUES
  ('report_evidence_after_resolution', interval '90 days', 'enforced', false,
   'public.content_reports.evidence',
   'Report evidence becomes purgeable 90 days after the report is resolved (evidence_purge_after, set by the moderation functions). Open and reopened reports have no date and keep their evidence.'),
  ('quarantine_copy_after_release', interval '90 days', 'enforced', false,
   'private.media_quarantine (moderation-quarantine bucket)',
   'A non-legal-hold quarantine copy gets retain_until 90 days after it is no longer needed (retained, restored or cancelled).'),
  ('profile_field_original_after_end', interval '90 days', 'provisional', false,
   'public.moderated_profile_fields.original_value',
   'Provisional (D2): an ended (restored or released) field restriction keeps its original value for 90 days after it ended. Not applied by any existing code; used by purge candidate discovery only.'),
  ('moderation_note', interval '1 year', 'proposed', true,
   'moderation_actions.note, account_suspensions.note / lift_note',
   'Proposed (D2): free-text moderation notes kept 1 year. Pending legal review; no note is eligible for purge until this is approved.'),
  ('ordinary_legal_hold_max', interval '1 year', 'provisional', false,
   'private.moderation_legal_holds (ordinary)',
   'Provisional (D5): an ordinary legal hold lasts at most 1 year from placement; it can be renewed by a new audited hold.'),
  ('child_safety_evidence', NULL, 'unresolved', true,
   'all evidence flagged child_safety',
   'UNRESOLVED (D1): no retention period has been decided. Child-safety evidence is never eligible for purge, and open-ended retention is not assumed to be legally authorised. Requires legal review.'),
  ('username_reservation', interval '90 days', 'enforced', false,
   'private.username_reservations',
   'A deleted account''s username stays reserved for 90 days (keyed HMAC only).'),
  ('deletion_job_metadata', interval '30 days', 'enforced', false,
   'public.account_deletion_jobs',
   'Deletion job records are kept 30 days after completion. The date is set by the account-maintenance Edge Function (TypeScript), so it is not covered by the database conformance check.');

-- The period for a policy key; NULL for an unresolved policy. Unknown keys raise.
CREATE FUNCTION private.retention_period(p_key text)
RETURNS interval
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  p private.retention_policy;
BEGIN
  SELECT * INTO p FROM private.retention_policy r WHERE r.key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention_policy_missing' USING ERRCODE = 'P0001';
  END IF;
  RETURN p.period;
END;
$$;

-- Read-only drift check: does each existing function that sets a deadline
-- still use exactly the policy's period (as an "interval 'N days'" literal)?
CREATE FUNCTION private.retention_policy_conformance()
RETURNS TABLE (policy_key text, function_name text, expected_literal text, conforms boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.policy_key, s.fn, e.lit,
         COALESCE(position(e.lit IN pr.prosrc) > 0
                  AND NOT EXISTS (SELECT 1 FROM regexp_matches(pr.prosrc, 'interval ''([0-9]+) days''', 'g') m
                                   WHERE m[1]::int <> e.days), false)
    FROM (VALUES
      ('report_evidence_after_resolution', 'public.admin_resolve_report'),
      ('report_evidence_after_resolution', 'public.admin_remove_content'),
      ('report_evidence_after_resolution', 'public.admin_restore_content'),
      ('report_evidence_after_resolution', 'public.admin_clear_profile_fields'),
      ('report_evidence_after_resolution', 'private.end_profile_field_restrictions'),
      ('quarantine_copy_after_release',    'private.end_media_holds'),
      ('quarantine_copy_after_release',    'public.media_quarantine_advance'),
      ('username_reservation',             'private.finalize_account_deletion')) s(policy_key, fn)
    JOIN private.retention_policy p ON p.key = s.policy_key
    CROSS JOIN LATERAL (SELECT extract(day FROM p.period)::int AS days,
                               'interval ''' || extract(day FROM p.period)::int || ' days''' AS lit) e
    LEFT JOIN pg_catalog.pg_proc pr ON pr.oid = to_regproc(s.fn);
$$;

-- ── 2. Legal holds ──────────────────────────────────────────────────────────
-- A hold protects one subject (or every subject of one account) from purge.
-- It never protects anything from account deletion (D4, unchanged).
CREATE TABLE private.moderation_legal_holds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind         text NOT NULL CHECK (subject_kind IN ('report', 'quarantine_copy', 'profile_field', 'account')),
  subject_id           uuid NOT NULL,          -- no FK: the hold outlives its subject
  subject_owner_id     uuid,                   -- the collector whose evidence it is (no FK, minimal)
  hold_type            text NOT NULL CHECK (hold_type IN ('ordinary', 'child_safety')),
  basis_code           text NOT NULL CHECK (basis_code IN ('law_enforcement_request', 'litigation', 'regulatory_inquiry',
                                                           'internal_investigation', 'child_safety_preservation',
                                                           'other_legal_obligation')),
  basis_note           text NOT NULL CHECK (char_length(basis_note) BETWEEN 1 AND 1000),
  placed_by            uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  placed_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at           timestamptz,
  renewed_from         uuid UNIQUE REFERENCES private.moderation_legal_holds (id) ON DELETE RESTRICT,
  -- Child-safety release, step 1 (request with a legal-review reference).
  release_requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  release_requested_at timestamptz,
  release_review_ref   text CHECK (release_review_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$'),
  release_request_note text CHECK (release_request_note IS NULL OR char_length(release_request_note) BETWEEN 1 AND 1000),
  -- Release (manual, renewal or expiry bookkeeping).
  released_at          timestamptz,
  released_by          uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  release_reason       text CHECK (release_reason IN ('no_longer_required', 'placed_in_error', 'legal_review_cleared',
                                                      'renewed', 'expired')),
  release_note         text CHECK (release_note IS NULL OR char_length(release_note) BETWEEN 1 AND 1000),
  -- Ordinary: bounded (the RPC enforces the policy maximum; this is the hard
  -- ceiling). Child safety: no automatic expiry (see "Open conflict").
  CONSTRAINT moderation_legal_holds_expiry_shape CHECK (
    (hold_type = 'ordinary' AND expires_at IS NOT NULL AND expires_at > placed_at
       AND expires_at <= placed_at + interval '366 days')
    OR (hold_type = 'child_safety' AND expires_at IS NULL)),
  CONSTRAINT moderation_legal_holds_basis_shape CHECK (basis_code <> 'child_safety_preservation' OR hold_type = 'child_safety'),
  CONSTRAINT moderation_legal_holds_release_shape CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT moderation_legal_holds_request_shape CHECK (
    (release_requested_at IS NULL) = (release_review_ref IS NULL)
    AND (release_requested_at IS NULL) = (release_request_note IS NULL)
    AND (release_requested_at IS NULL OR hold_type = 'child_safety')),
  CONSTRAINT moderation_legal_holds_reason_by_type CHECK (
    release_reason IS NULL
    OR (hold_type = 'ordinary' AND release_reason IN ('no_longer_required', 'placed_in_error', 'renewed', 'expired'))
    OR (hold_type = 'child_safety' AND release_reason = 'legal_review_cleared' AND release_requested_at IS NOT NULL)),
  -- Another admin releases (the placer cannot; a deleted admin's NULL is fine).
  CONSTRAINT moderation_legal_holds_second_admin CHECK (
    release_reason IS NULL OR release_reason IN ('renewed', 'expired')
    OR released_by IS NULL OR placed_by IS NULL OR released_by <> placed_by),
  -- Child safety: the approver is neither the requester nor the placer.
  CONSTRAINT moderation_legal_holds_child_safety_two_admins CHECK (
    hold_type <> 'child_safety' OR released_at IS NULL
    OR released_by IS NULL OR release_requested_by IS NULL OR released_by <> release_requested_by)
);
-- One open hold per subject and legal basis (expired ones are closed first).
CREATE UNIQUE INDEX moderation_legal_holds_one_open ON private.moderation_legal_holds (subject_kind, subject_id, basis_code)
  WHERE released_at IS NULL;
CREATE INDEX moderation_legal_holds_subject_idx ON private.moderation_legal_holds (subject_kind, subject_id) WHERE released_at IS NULL;
CREATE INDEX moderation_legal_holds_owner_idx ON private.moderation_legal_holds (subject_owner_id) WHERE released_at IS NULL;

ALTER TABLE private.moderation_legal_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.moderation_legal_holds FROM PUBLIC, anon, authenticated, service_role;

-- Append-only: insert (time is never caller-supplied), one release request,
-- one release, and the ON DELETE SET NULL of a deleted admin. No DELETE or
-- TRUNCATE.
CREATE FUNCTION private.moderation_legal_holds_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  c_admins constant text[] := ARRAY['placed_by', 'release_requested_by', 'released_by'];
  c_request constant text[] := ARRAY['release_requested_by', 'release_requested_at', 'release_review_ref', 'release_request_note'];
  c_release constant text[] := ARRAY['released_at', 'released_by', 'release_reason', 'release_note'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.release_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'moderation_legal_holds_append_only' USING ERRCODE = '42501';
    END IF;
    NEW.placed_at := clock_timestamp();
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A deleted admin's ids → NULL, nothing else.
    IF (to_jsonb(NEW) - c_admins) = (to_jsonb(OLD) - c_admins)
       AND (NEW.placed_by IS NULL OR NEW.placed_by IS NOT DISTINCT FROM OLD.placed_by)
       AND (NEW.release_requested_by IS NULL OR NEW.release_requested_by IS NOT DISTINCT FROM OLD.release_requested_by)
       AND (NEW.released_by IS NULL OR NEW.released_by IS NOT DISTINCT FROM OLD.released_by) THEN
      RETURN NEW;
    END IF;
    -- One release request on an open child-safety hold.
    IF OLD.released_at IS NULL AND OLD.release_requested_at IS NULL AND NEW.release_requested_at IS NOT NULL
       AND (to_jsonb(NEW) - c_request) = (to_jsonb(OLD) - c_request) THEN
      RETURN NEW;
    END IF;
    -- One release of an open hold.
    IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
       AND (to_jsonb(NEW) - c_release) = (to_jsonb(OLD) - c_release) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'moderation_legal_holds_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER moderation_legal_holds_history BEFORE INSERT OR UPDATE OR DELETE ON private.moderation_legal_holds
  FOR EACH ROW EXECUTE FUNCTION private.moderation_legal_holds_guard();
CREATE TRIGGER moderation_legal_holds_no_truncate BEFORE TRUNCATE ON private.moderation_legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION private.moderation_legal_holds_guard();

-- Audit vocabulary.
ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_action_check CHECK (action = ANY (ARRAY[
  'claim', 'release', 'resolve', 'reopen', 'hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields',
  'release_profile_fields', 'suspend', 'lift_suspension',
  'place_legal_hold', 'renew_legal_hold', 'request_legal_hold_release', 'release_legal_hold']));

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Whether a report is child-safety by any route: its own reason, the
-- restriction it produced or was attached to, or a suspension citing it.
CREATE FUNCTION private.report_is_child_safety(p_report_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = p_report_id AND r.reason = 'child_safety')
      OR EXISTS (SELECT 1 FROM public.content_reports r JOIN public.moderated_content m ON m.id = r.moderation_id
                  WHERE r.id = p_report_id AND m.child_safety)
      OR EXISTS (SELECT 1 FROM public.moderated_content m WHERE m.report_id = p_report_id AND m.child_safety)
      OR EXISTS (SELECT 1 FROM public.account_suspensions s WHERE s.report_id = p_report_id AND s.child_safety);
$$;

-- Active = open and not past its expiry (expiry needs no scheduled task).
CREATE FUNCTION private.legal_hold_active(p_kind text, p_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM private.moderation_legal_holds h
                  WHERE h.subject_kind = p_kind AND h.subject_id = p_id
                    AND h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now()));
$$;

-- What a hold would protect, and how to describe it in the audit log.
CREATE FUNCTION private.legal_hold_subject(p_kind text, p_id uuid,
  OUT subject_found boolean, OUT owner_id uuid, OUT child_safety boolean, OUT available boolean,
  OUT audit_target_type text, OUT audit_target_id uuid, OUT report_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.content_reports;
  q private.media_quarantine;
  f public.moderated_profile_fields;
  c_audit_types constant text[] := ARRAY['profile', 'post', 'comment', 'item_comment', 'folder_comment',
                                         'gallery_comment', 'message', 'collection_item', 'folder'];
BEGIN
  subject_found := false; child_safety := false; available := false;
  IF p_kind = 'report' THEN
    SELECT * INTO r FROM public.content_reports x WHERE x.id = p_id;
    IF NOT FOUND THEN RETURN; END IF;
    subject_found := true; owner_id := r.target_owner_id; available := r.evidence IS NOT NULL;
    child_safety := private.report_is_child_safety(r.id);
    audit_target_type := r.target_type; audit_target_id := r.target_id; report_id := r.id;
  ELSIF p_kind = 'quarantine_copy' THEN
    SELECT * INTO q FROM private.media_quarantine x WHERE x.id = p_id;
    IF NOT FOUND THEN RETURN; END IF;
    subject_found := true; owner_id := q.owner_id; child_safety := q.child_safety;
    available := q.state IN ('pending', 'copied', 'verified', 'quarantined', 'restore_pending', 'restoring', 'failed')
              OR EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = q.quarantine_bucket AND o.name = q.quarantine_path);
    IF q.origin_target_type = ANY (c_audit_types) THEN
      audit_target_type := q.origin_target_type; audit_target_id := q.origin_target_id;
    ELSE
      audit_target_type := 'profile'; audit_target_id := q.owner_id;
    END IF;
  ELSIF p_kind = 'profile_field' THEN
    SELECT * INTO f FROM public.moderated_profile_fields x WHERE x.id = p_id;
    IF NOT FOUND THEN RETURN; END IF;
    subject_found := true; owner_id := f.user_id; available := true;
    child_safety := EXISTS (SELECT 1 FROM public.moderated_content m WHERE m.id = f.moderation_id AND m.child_safety);
    audit_target_type := 'profile'; audit_target_id := f.user_id; report_id := f.report_id;
  ELSIF p_kind = 'account' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_id) THEN RETURN; END IF;
    subject_found := true; owner_id := p_id; available := true;
    audit_target_type := 'profile'; audit_target_id := p_id;
  END IF;
END;
$$;

CREATE FUNCTION private.legal_hold_lock(p_kind text, p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('legal_hold:' || p_kind || ':' || p_id::text, 0));
$$;

-- Bookkeeping: close a subject's ordinary holds that have already expired
-- (they stopped protecting anything at expires_at).
CREATE FUNCTION private.close_expired_legal_holds(p_kind text, p_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.moderation_legal_holds h SET released_at = h.expires_at, release_reason = 'expired'
   WHERE h.subject_kind = p_kind AND h.subject_id = p_id AND h.released_at IS NULL
     AND h.expires_at IS NOT NULL AND h.expires_at <= now();
$$;

CREATE FUNCTION private.legal_hold_view(h private.moderation_legal_holds)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', h.id, 'subject_kind', h.subject_kind, 'subject_id', h.subject_id, 'subject_owner_id', h.subject_owner_id,
    'hold_type', h.hold_type, 'basis_code', h.basis_code, 'basis_note', h.basis_note,
    'placed_by', h.placed_by, 'placed_at', h.placed_at, 'expires_at', h.expires_at, 'renewed_from', h.renewed_from,
    'release_requested_by', h.release_requested_by, 'release_requested_at', h.release_requested_at,
    'release_review_ref', h.release_review_ref, 'release_request_note', h.release_request_note,
    'released_at', h.released_at, 'released_by', h.released_by, 'release_reason', h.release_reason,
    'release_note', h.release_note,
    'owner_pending_deletion', EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = h.subject_owner_id),
    'state', CASE WHEN h.released_at IS NOT NULL THEN CASE h.release_reason WHEN 'expired' THEN 'expired'
                                                                         WHEN 'renewed' THEN 'renewed' ELSE 'released' END
                  WHEN h.expires_at IS NOT NULL AND h.expires_at <= now() THEN 'expired'
                  WHEN h.release_requested_at IS NOT NULL THEN 'release_requested'
                  ELSE 'active' END);
$$;

CREATE FUNCTION private.log_legal_hold_action(p_admin uuid, h private.moderation_legal_holds, p_action text,
                                              p_reason text, p_note text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM private.legal_hold_subject(h.subject_kind, h.subject_id);
  INSERT INTO public.moderation_actions (admin_id, report_id, action, target_type, target_id, target_owner_id,
                                         reason_code, note, metadata)
  VALUES (p_admin,
          CASE WHEN s.report_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = s.report_id)
               THEN s.report_id END,
          p_action,
          COALESCE(s.audit_target_type, 'profile'),
          COALESCE(s.audit_target_id, h.subject_owner_id, h.subject_id),
          (SELECT u.id FROM auth.users u WHERE u.id = h.subject_owner_id),
          p_reason, p_note,
          jsonb_build_object('hold_id', h.id, 'subject_kind', h.subject_kind, 'subject_id', h.subject_id,
                             'hold_type', h.hold_type, 'basis_code', h.basis_code, 'expires_at', h.expires_at) || p_extra);
END;
$$;

-- ── Admin operations ────────────────────────────────────────────────────────
-- Places a hold. Any admin. Ordinary: expiry required, 1 day … policy max.
-- Child safety (the subject is child-safety, the admin says so, or the basis
-- is child_safety_preservation): no expiry.
CREATE FUNCTION public.admin_place_legal_hold(
  p_subject_kind text, p_subject_id uuid, p_basis_code text, p_basis_note text,
  p_expires_at timestamptz DEFAULT NULL, p_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_basis_note);
  v_max interval := private.retention_period('ordinary_legal_hold_max');
  s record;
  v_type text;
  h private.moderation_legal_holds;
BEGIN
  IF p_subject_kind IS NULL OR p_subject_kind NOT IN ('report', 'quarantine_copy', 'profile_field', 'account') OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'invalid_subject' USING ERRCODE = '22023';
  END IF;
  IF p_basis_code IS NULL OR p_basis_code NOT IN ('law_enforcement_request', 'litigation', 'regulatory_inquiry',
                                                  'internal_investigation', 'child_safety_preservation', 'other_legal_obligation') THEN
    RAISE EXCEPTION 'invalid_basis_code' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'basis_note_required' USING ERRCODE = '22023';
  END IF;
  PERFORM private.legal_hold_lock(p_subject_kind, p_subject_id);
  SELECT * INTO s FROM private.legal_hold_subject(p_subject_kind, p_subject_id);
  IF NOT s.subject_found THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF NOT s.available THEN
    RAISE EXCEPTION 'evidence_unavailable' USING ERRCODE = 'PT409';
  END IF;
  v_type := CASE WHEN s.child_safety OR COALESCE(p_child_safety, false) OR p_basis_code = 'child_safety_preservation'
                 THEN 'child_safety' ELSE 'ordinary' END;
  IF v_type = 'ordinary' AND (p_expires_at IS NULL OR p_expires_at < now() + interval '1 day' OR p_expires_at > now() + v_max) THEN
    RAISE EXCEPTION 'invalid_expiry' USING ERRCODE = '22023',
      HINT = 'An ordinary legal hold needs an end date between 1 day and 1 year from now; renew it before it ends if still required.';
  END IF;
  IF v_type = 'child_safety' AND p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_expiry' USING ERRCODE = '22023',
      HINT = 'A child-safety hold has no automatic end date; it stays until released after legal review by two admins.';
  END IF;
  PERFORM private.close_expired_legal_holds(p_subject_kind, p_subject_id);
  IF EXISTS (SELECT 1 FROM private.moderation_legal_holds x
              WHERE x.subject_kind = p_subject_kind AND x.subject_id = p_subject_id
                AND x.basis_code = p_basis_code AND x.released_at IS NULL) THEN
    RAISE EXCEPTION 'already_held' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, subject_owner_id, hold_type, basis_code, basis_note,
                                              placed_by, expires_at)
  VALUES (p_subject_kind, p_subject_id, s.owner_id, v_type, p_basis_code, v_note, v_admin, p_expires_at)
  RETURNING * INTO h;
  PERFORM private.log_legal_hold_action(v_admin, h, 'place_legal_hold', p_basis_code, v_note);
  RETURN private.legal_hold_view(h);
END;
$$;

-- Renews an ACTIVE ordinary hold: closes it ('renewed') and places a new
-- audited hold for the same subject and basis. An expired hold is not
-- renewed (the lapse stays visible); place a new one instead.
CREATE FUNCTION public.admin_renew_legal_hold(p_hold_id uuid, p_expires_at timestamptz, p_note text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  v_max interval := private.retention_period('ordinary_legal_hold_max');
  h private.moderation_legal_holds;
  n private.moderation_legal_holds;
BEGIN
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'basis_note_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  PERFORM private.legal_hold_lock(h.subject_kind, h.subject_id);
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id FOR UPDATE;
  IF h.hold_type <> 'ordinary' THEN
    RAISE EXCEPTION 'child_safety_hold_has_no_expiry' USING ERRCODE = '22023';
  END IF;
  IF h.released_at IS NOT NULL OR h.expires_at <= now() THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'PT409';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= h.expires_at OR p_expires_at > now() + v_max THEN
    RAISE EXCEPTION 'invalid_expiry' USING ERRCODE = '22023',
      HINT = 'The new end date must be later than the current one and at most 1 year from now.';
  END IF;
  UPDATE private.moderation_legal_holds SET released_at = clock_timestamp(), released_by = v_admin, release_reason = 'renewed'
   WHERE id = h.id;
  INSERT INTO private.moderation_legal_holds (subject_kind, subject_id, subject_owner_id, hold_type, basis_code, basis_note,
                                              placed_by, expires_at, renewed_from)
  VALUES (h.subject_kind, h.subject_id, h.subject_owner_id, 'ordinary', h.basis_code, v_note, v_admin, p_expires_at, h.id)
  RETURNING * INTO n;
  PERFORM private.log_legal_hold_action(v_admin, n, 'renew_legal_hold', h.basis_code, v_note,
                                        jsonb_build_object('renewed_from', h.id, 'previous_expires_at', h.expires_at));
  RETURN private.legal_hold_view(n);
END;
$$;

-- Releases an ACTIVE ordinary hold. Must be a different admin from the one
-- who placed (or last renewed) it, and not the collector whose evidence it is.
CREATE FUNCTION public.admin_release_legal_hold(p_hold_id uuid, p_reason_code text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  h private.moderation_legal_holds;
BEGIN
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('no_longer_required', 'placed_in_error') THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  PERFORM private.legal_hold_lock(h.subject_kind, h.subject_id);
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id FOR UPDATE;
  IF h.hold_type = 'child_safety' THEN
    RAISE EXCEPTION 'child_safety_release_requires_review' USING ERRCODE = '42501';
  END IF;
  IF h.released_at IS NOT NULL OR h.expires_at <= now() THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'PT409';
  END IF;
  IF h.subject_owner_id = v_admin THEN
    RAISE EXCEPTION 'conflict_of_interest' USING ERRCODE = '42501';
  END IF;
  IF h.placed_by = v_admin THEN
    RAISE EXCEPTION 'second_admin_required' USING ERRCODE = '42501';
  END IF;
  UPDATE private.moderation_legal_holds
     SET released_at = clock_timestamp(), released_by = v_admin, release_reason = p_reason_code, release_note = v_note
   WHERE id = h.id
  RETURNING * INTO h;
  PERFORM private.log_legal_hold_action(v_admin, h, 'release_legal_hold', p_reason_code, v_note);
  RETURN private.legal_hold_view(h);
END;
$$;

-- Child-safety release, step 1: an admin records the legal-review reference.
CREATE FUNCTION public.admin_request_legal_hold_release(p_hold_id uuid, p_legal_review_ref text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  v_ref text := btrim(COALESCE(p_legal_review_ref, ''));
  h private.moderation_legal_holds;
BEGIN
  IF v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$' THEN
    RAISE EXCEPTION 'legal_review_reference_required' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  PERFORM private.legal_hold_lock(h.subject_kind, h.subject_id);
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id FOR UPDATE;
  IF h.hold_type <> 'child_safety' THEN
    RAISE EXCEPTION 'not_child_safety_hold' USING ERRCODE = '22023';
  END IF;
  IF h.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'PT409';
  END IF;
  IF h.release_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'release_already_requested' USING ERRCODE = 'PT409';
  END IF;
  IF h.subject_owner_id = v_admin THEN
    RAISE EXCEPTION 'conflict_of_interest' USING ERRCODE = '42501';
  END IF;
  UPDATE private.moderation_legal_holds
     SET release_requested_by = v_admin, release_requested_at = clock_timestamp(),
         release_review_ref = v_ref, release_request_note = v_note
   WHERE id = h.id
  RETURNING * INTO h;
  PERFORM private.log_legal_hold_action(v_admin, h, 'request_legal_hold_release', 'legal_review_cleared', v_note,
                                        jsonb_build_object('legal_review_ref', v_ref));
  RETURN private.legal_hold_view(h);
END;
$$;

-- Child-safety release, step 2: a second admin (neither the requester nor
-- the placer) approves. Releasing does NOT make child-safety evidence
-- purgeable: discovery always blocks it while its policy is unresolved.
CREATE FUNCTION public.admin_approve_legal_hold_release(p_hold_id uuid, p_note text, p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  h private.moderation_legal_holds;
BEGIN
  IF NOT COALESCE(p_confirm_child_safety, false) THEN
    RAISE EXCEPTION 'child_safety_confirmation_required' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  PERFORM private.legal_hold_lock(h.subject_kind, h.subject_id);
  SELECT * INTO h FROM private.moderation_legal_holds x WHERE x.id = p_hold_id FOR UPDATE;
  IF h.hold_type <> 'child_safety' THEN
    RAISE EXCEPTION 'not_child_safety_hold' USING ERRCODE = '22023';
  END IF;
  IF h.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'PT409';
  END IF;
  IF h.release_requested_at IS NULL THEN
    RAISE EXCEPTION 'release_not_requested' USING ERRCODE = 'PT409';
  END IF;
  IF h.subject_owner_id = v_admin THEN
    RAISE EXCEPTION 'conflict_of_interest' USING ERRCODE = '42501';
  END IF;
  IF h.release_requested_by = v_admin OR h.placed_by = v_admin THEN
    RAISE EXCEPTION 'second_admin_required' USING ERRCODE = '42501';
  END IF;
  UPDATE private.moderation_legal_holds
     SET released_at = clock_timestamp(), released_by = v_admin, release_reason = 'legal_review_cleared', release_note = v_note
   WHERE id = h.id
  RETURNING * INTO h;
  PERFORM private.log_legal_hold_action(v_admin, h, 'release_legal_hold', 'legal_review_cleared', v_note,
                                        jsonb_build_object('legal_review_ref', h.release_review_ref, 'child_safety_confirmed', true));
  RETURN private.legal_hold_view(h);
END;
$$;

CREATE FUNCTION public.admin_list_legal_holds(p_state text DEFAULT 'active', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('active', 'expired', 'release_requested', 'all')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(private.legal_hold_view(h) ORDER BY h.placed_at DESC)
      FROM (SELECT x.* FROM private.moderation_legal_holds x
             WHERE p_state = 'all'
                OR (p_state = 'active' AND x.released_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > now()))
                OR (p_state = 'expired' AND x.released_at IS NULL AND x.expires_at <= now())
                OR (p_state = 'release_requested' AND x.released_at IS NULL AND x.release_requested_at IS NOT NULL)
             ORDER BY x.placed_at DESC LIMIT p_limit OFFSET p_offset) h), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.admin_subject_legal_holds(p_subject_kind text, p_subject_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'subject_kind', p_subject_kind, 'subject_id', p_subject_id,
    'held', private.legal_hold_active(p_subject_kind, p_subject_id),
    'holds', COALESCE((SELECT jsonb_agg(private.legal_hold_view(h) ORDER BY h.placed_at DESC)
                         FROM private.moderation_legal_holds h
                        WHERE h.subject_kind = p_subject_kind AND h.subject_id = p_subject_id), '[]'::jsonb));
END;
$$;

-- ── 3. Purge candidate discovery (read-only) ────────────────────────────────
-- One row per purgeable piece of evidence. status:
--   eligible  due and nothing blocks it
--   not_due   nothing blocks it but its date has not passed
--   blocked   one or more blockers (listed), whether due or not
-- Blockers: child_safety, legal_hold, quarantine_legal_hold, open_report,
--   live_restriction, live_profile_field, live_suspension, in_progress,
--   no_retention_date, policy_pending_legal_review.
-- Rows carry ids and metadata only — never evidence, notes or values.
CREATE FUNCTION private.retention_candidates()
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
    -- Report evidence.
    SELECT 'report_evidence'::text AS category, r.id AS record_id, r.target_owner_id AS owner_id,
           private.report_is_child_safety(r.id) AS cs, r.evidence_purge_after AS due_at,
           ARRAY[
             CASE WHEN r.status IN ('open', 'reviewing') THEN 'open_report' END,
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'report' AND held.subject_id = r.id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = r.target_owner_id))
                  THEN 'legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.moderated_content m
                                WHERE (m.id = r.moderation_id OR m.report_id = r.id) AND m.lifted_at IS NULL)
                  THEN 'live_restriction' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.moderated_profile_fields f WHERE f.report_id = r.id AND f.status = 'active')
                  THEN 'live_profile_field' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.account_suspensions s WHERE s.report_id = r.id AND s.lifted_at IS NULL
                                  AND (s.expires_at IS NULL OR s.expires_at > now()))
                  THEN 'live_suspension' END,
             CASE WHEN r.status IN ('actioned', 'dismissed') AND r.evidence_purge_after IS NULL THEN 'no_retention_date' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'report_evidence_after_resolution') THEN 'policy_pending_legal_review' END
           ] AS b,
           jsonb_build_object('report_status', r.status, 'reason', r.reason, 'created_at', r.created_at,
                              'resolved_at', r.reviewed_at,
                              'age_days', floor(extract(epoch FROM now() - r.created_at) / 86400)::int) AS detail
      FROM public.content_reports r
     WHERE r.evidence IS NOT NULL
    UNION ALL
    -- Quarantine copies (private moderation-quarantine bucket).
    SELECT 'quarantine_copy', q.id, q.owner_id, q.child_safety, q.retain_until,
           ARRAY[
             CASE WHEN q.legal_hold THEN 'quarantine_legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'quarantine_copy' AND held.subject_id = q.id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = q.owner_id))
                  THEN 'legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM private.media_quarantine_holds mh WHERE mh.quarantine_id = q.id AND mh.ended_at IS NULL)
                  THEN 'live_restriction' END,
             CASE WHEN q.state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring', 'failed')
                    OR q.lease_expires_at > now() THEN 'in_progress' END,
             CASE WHEN q.retain_until IS NULL THEN 'no_retention_date' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'quarantine_copy_after_release') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('state', q.state, 'desired', q.desired, 'media_kind', q.media_kind,
                              'size_bytes', q.size_bytes, 'copy_present', o.present)
      FROM private.media_quarantine q
     CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM storage.objects so
                                         WHERE so.bucket_id = q.quarantine_bucket AND so.name = q.quarantine_path) AS present) o
     WHERE o.present OR q.state IN ('copied', 'verified', 'quarantined', 'restore_pending', 'restoring', 'restored')
    UNION ALL
    -- Profile-field originals.
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
    -- Free-text moderation notes (audit log).
    SELECT 'moderation_note', a.id, a.target_owner_id,
           a.reason_code = 'child_safety' OR a.reason_code = 'child_safety_review_cleared'
             OR a.metadata->>'child_safety' = 'true' OR a.metadata->>'hold_type' = 'child_safety'
             OR (a.report_id IS NOT NULL AND private.report_is_child_safety(a.report_id)),
           a.created_at + (SELECT period FROM pol WHERE key = 'moderation_note'),
           ARRAY[
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'report' AND held.subject_id = a.report_id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = a.target_owner_id))
                  THEN 'legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = a.report_id AND r.status IN ('open', 'reviewing'))
                  THEN 'open_report' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'moderation_note') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('source', 'moderation_actions', 'action', a.action, 'created_at', a.created_at)
      FROM public.moderation_actions a
     WHERE a.note IS NOT NULL
    UNION ALL
    -- Free-text suspension notes.
    SELECT 'moderation_note', s.id, s.user_id, s.child_safety,
           COALESCE(s.lifted_at, s.expires_at, s.created_at) + (SELECT period FROM pol WHERE key = 'moderation_note'),
           ARRAY[
             CASE WHEN s.lifted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) THEN 'live_suspension' END,
             CASE WHEN EXISTS (SELECT 1 FROM held WHERE (held.subject_kind = 'report' AND held.subject_id = s.report_id)
                                                     OR (held.subject_kind = 'account' AND held.subject_id = s.user_id))
                  THEN 'legal_hold' END,
             CASE WHEN EXISTS (SELECT 1 FROM public.content_reports r WHERE r.id = s.report_id AND r.status IN ('open', 'reviewing'))
                  THEN 'open_report' END,
             CASE WHEN (SELECT pending FROM pol WHERE key = 'moderation_note') THEN 'policy_pending_legal_review' END
           ],
           jsonb_build_object('source', 'account_suspensions', 'created_at', s.created_at, 'lifted_at', s.lifted_at)
      FROM public.account_suspensions s
     WHERE s.note IS NOT NULL OR s.lift_note IS NOT NULL
  )
  SELECT x.category, x.record_id, x.owner_id, x.cs, x.due_at, y.blockers,
         CASE WHEN cardinality(y.blockers) > 0 THEN 'blocked'
              WHEN x.due_at > now() THEN 'not_due'
              ELSE 'eligible' END,
         x.detail || jsonb_build_object('due', x.due_at IS NOT NULL AND x.due_at <= now())
    FROM raw x
   CROSS JOIN LATERAL (SELECT CASE WHEN x.cs THEN ARRAY['child_safety'] ELSE ARRAY[]::text[] END
                              || array_remove(x.b, NULL) AS bc) z
   CROSS JOIN LATERAL (SELECT CASE WHEN x.due_at IS NULL AND cardinality(z.bc) = 0
                                   THEN ARRAY['no_retention_date'] ELSE z.bc END AS blockers) y;
$$;

CREATE FUNCTION public.admin_retention_candidates(
  p_category text DEFAULT NULL, p_status text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  IF (p_category IS NOT NULL AND p_category NOT IN ('report_evidence', 'quarantine_copy', 'profile_field_original', 'moderation_note'))
     OR (p_status IS NOT NULL AND p_status NOT IN ('eligible', 'not_due', 'blocked'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('category', c.category, 'record_id', c.record_id, 'owner_id', c.owner_id,
                                        'child_safety', c.child_safety, 'due_at', c.due_at, 'blockers', to_jsonb(c.blockers),
                                        'status', c.status, 'detail', c.detail)
                     ORDER BY c.category, c.due_at NULLS LAST, c.record_id)
      FROM (SELECT * FROM private.retention_candidates() rc
             WHERE (p_category IS NULL OR rc.category = p_category) AND (p_status IS NULL OR rc.status = p_status)
             ORDER BY rc.category, rc.due_at NULLS LAST, rc.record_id
             LIMIT p_limit OFFSET p_offset) c), '[]'::jsonb);
END;
$$;

-- Dry-run overview: counts per category / status / blocker, report ageing
-- (D3), hold status, holds on accounts pending deletion (D4), the policy and
-- its conformance with the functions that apply it.
CREATE FUNCTION public.admin_retention_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'generated_at', now(),
    'categories', COALESCE((
      SELECT jsonb_object_agg(cat.category, jsonb_build_object(
               'eligible', cat.eligible, 'not_due', cat.not_due, 'blocked', cat.blocked, 'by_blocker', cat.by_blocker))
        FROM (SELECT c.category,
                     count(*) FILTER (WHERE c.status = 'eligible') AS eligible,
                     count(*) FILTER (WHERE c.status = 'not_due') AS not_due,
                     count(*) FILTER (WHERE c.status = 'blocked') AS blocked,
                     COALESCE((SELECT jsonb_object_agg(bb.b, bb.n) FROM (
                                 SELECT b, count(*) AS n FROM private.retention_candidates() c2, unnest(c2.blockers) b
                                  WHERE c2.category = c.category GROUP BY b) bb), '{}'::jsonb) AS by_blocker
                FROM private.retention_candidates() c GROUP BY c.category) cat), '{}'::jsonb),
    'open_reports', (
      SELECT jsonb_build_object(
               'total', count(*),
               'older_than_30_days', count(*) FILTER (WHERE r.created_at < now() - interval '30 days'),
               'older_than_90_days', count(*) FILTER (WHERE r.created_at < now() - interval '90 days'),
               'older_than_180_days', count(*) FILTER (WHERE r.created_at < now() - interval '180 days'),
               'child_safety', count(*) FILTER (WHERE r.reason = 'child_safety'),
               'oldest_created_at', min(r.created_at))
        FROM public.content_reports r WHERE r.status IN ('open', 'reviewing')),
    'legal_holds', (
      SELECT jsonb_build_object(
               'active', count(*) FILTER (WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now())),
               'active_child_safety', count(*) FILTER (WHERE h.released_at IS NULL AND h.hold_type = 'child_safety'),
               'expired_not_closed', count(*) FILTER (WHERE h.released_at IS NULL AND h.expires_at <= now()),
               'expiring_within_30_days', count(*) FILTER (WHERE h.released_at IS NULL AND h.expires_at > now()
                                                              AND h.expires_at <= now() + interval '30 days'),
               'release_requested', count(*) FILTER (WHERE h.released_at IS NULL AND h.release_requested_at IS NOT NULL),
               'on_accounts_pending_deletion', count(*) FILTER (
                  WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR h.expires_at > now())
                    AND EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = h.subject_owner_id)))
        FROM private.moderation_legal_holds h),
    'policy', (SELECT jsonb_agg(jsonb_build_object('key', p.key, 'period', p.period::text, 'status', p.status,
                                                   'legal_review_required', p.legal_review_required) ORDER BY p.key)
                 FROM private.retention_policy p),
    'policy_conformance', jsonb_build_object(
      'ok', NOT EXISTS (SELECT 1 FROM private.retention_policy_conformance() c WHERE NOT c.conforms),
      'drift', COALESCE((SELECT jsonb_agg(jsonb_build_object('policy_key', c.policy_key, 'function', c.function_name))
                           FROM private.retention_policy_conformance() c WHERE NOT c.conforms), '[]'::jsonb)));
END;
$$;

-- ── 4. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.retention_period(text), private.retention_policy_conformance(),
  private.moderation_legal_holds_guard(), private.report_is_child_safety(uuid), private.legal_hold_active(text, uuid),
  private.legal_hold_subject(text, uuid), private.legal_hold_lock(text, uuid), private.close_expired_legal_holds(text, uuid),
  private.legal_hold_view(private.moderation_legal_holds),
  private.log_legal_hold_action(uuid, private.moderation_legal_holds, text, text, text, jsonb),
  private.retention_candidates() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_place_legal_hold(text, uuid, text, text, timestamptz, boolean),
  public.admin_renew_legal_hold(uuid, timestamptz, text), public.admin_release_legal_hold(uuid, text, text),
  public.admin_request_legal_hold_release(uuid, text, text), public.admin_approve_legal_hold_release(uuid, text, boolean),
  public.admin_list_legal_holds(text, integer, integer), public.admin_subject_legal_holds(text, uuid),
  public.admin_retention_candidates(text, text, integer, integer), public.admin_retention_summary()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_place_legal_hold(text, uuid, text, text, timestamptz, boolean),
  public.admin_renew_legal_hold(uuid, timestamptz, text), public.admin_release_legal_hold(uuid, text, text),
  public.admin_request_legal_hold_release(uuid, text, text), public.admin_approve_legal_hold_release(uuid, text, boolean),
  public.admin_list_legal_holds(text, integer, integer), public.admin_subject_legal_holds(text, uuid),
  public.admin_retention_candidates(text, text, integer, integer), public.admin_retention_summary()
  TO authenticated;

NOTIFY pgrst, 'reload schema';

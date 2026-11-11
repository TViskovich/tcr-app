-- Phase 2B M3 — reversible administrative account suspension.
--
-- A suspended collector is treated exactly like an account that is pending
-- deletion for everything outside their own account: the existing lifecycle
-- helpers (account_is_hidden, hidden_account_ids, caller_is_hidden) now also
-- recognise an active suspension, so every restrictive read guard, write
-- guard, interaction guard, signing resolver and Edge Function caller check
-- built on them enforces it too — against existing sessions, direct API
-- calls and Storage alike. Suspension is NOT deletion: it never creates an
-- account_lifecycle row, never touches the deletion pipeline, and preserves
-- every row the collector owns.
--
-- Expiry needs no scheduled task: a suspension is active while
-- lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now()), evaluated
-- by the database clock on every check.
--
-- Delete Account and Download My Data keep working: their Edge Functions
-- authenticate the caller without the hidden-account refusal (as they
-- already do for accounts pending deletion), and the deletion and export
-- RPCs read account_lifecycle directly, never these helpers.

-- ── 1. Table ────────────────────────────────────────────────────────────────
CREATE TABLE public.account_suspensions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL: a permanently deleted account keeps an anonymised history row.
  user_id      uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reason_code  text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,48}$'),
  note         text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  report_id    uuid REFERENCES public.content_reports (id) ON DELETE RESTRICT,
  child_safety boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz,
  lifted_at    timestamptz,
  lifted_by    uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  lift_reason  text CHECK (lift_reason ~ '^[a-z_]{1,48}$'),
  lift_note    text CHECK (lift_note IS NULL OR char_length(lift_note) BETWEEN 1 AND 1000),
  CONSTRAINT account_suspensions_expiry_shape CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT account_suspensions_lift_shape CHECK ((lifted_at IS NULL) = (lift_reason IS NULL)),
  CONSTRAINT account_suspensions_child_safety_reason CHECK (reason_code <> 'child_safety' OR child_safety)
);
-- One open (not yet lifted or closed) suspension per collector. An expired
-- one is closed (lift_reason 'expired') before a new one is imposed.
CREATE UNIQUE INDEX account_suspensions_one_open ON public.account_suspensions (user_id)
  WHERE lifted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX account_suspensions_user_idx ON public.account_suspensions (user_id, created_at DESC);
CREATE INDEX account_suspensions_report_idx ON public.account_suspensions (report_id) WHERE report_id IS NOT NULL;

ALTER TABLE public.account_suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_suspensions FROM PUBLIC, anon, authenticated, service_role;
-- The standard account-lifecycle guards every public table carries.
CREATE POLICY account_lifecycle_read_guard ON public.account_suspensions AS RESTRICTIVE FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_suspensions
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- History is append-only: a row can only be lifted (or closed as expired)
-- once, and anonymised by an account's permanent deletion.
CREATE FUNCTION private.account_suspensions_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only the ON DELETE SET NULL of a deleted account …
    IF (to_jsonb(NEW) - ARRAY['user_id', 'created_by', 'lifted_by']) = (to_jsonb(OLD) - ARRAY['user_id', 'created_by', 'lifted_by'])
       AND (NEW.user_id IS NULL OR NEW.user_id IS NOT DISTINCT FROM OLD.user_id)
       AND (NEW.created_by IS NULL OR NEW.created_by IS NOT DISTINCT FROM OLD.created_by)
       AND (NEW.lifted_by IS NULL OR NEW.lifted_by IS NOT DISTINCT FROM OLD.lifted_by) THEN
      RETURN NEW;
    END IF;
    -- … or ending an open suspension once.
    IF OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['lifted_at', 'lifted_by', 'lift_reason', 'lift_note'])
           = (to_jsonb(OLD) - ARRAY['lifted_at', 'lifted_by', 'lift_reason', 'lift_note']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'account_suspensions_append_only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER account_suspensions_history BEFORE UPDATE OR DELETE ON public.account_suspensions
  FOR EACH ROW EXECUTE FUNCTION private.account_suspensions_guard();
CREATE TRIGGER account_suspensions_no_truncate BEFORE TRUNCATE ON public.account_suspensions
  FOR EACH STATEMENT EXECUTE FUNCTION private.account_suspensions_guard();

-- ── 2. Active-suspension helpers ────────────────────────────────────────────
CREATE FUNCTION private.account_is_suspended(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.account_suspensions s
     WHERE s.user_id = p_user_id AND s.lifted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()));
$$;

-- ── 3. Lifecycle helpers now recognise suspensions ──────────────────────────
-- (Bodies replaced; signatures, attributes and grants unchanged.)
CREATE OR REPLACE FUNCTION private.account_is_hidden(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p_user_id IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = p_user_id)
          OR private.account_is_suspended(p_user_id)); -- 20261122120000
$function$;

CREATE OR REPLACE FUNCTION private.hidden_account_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(array_agg(DISTINCT x.user_id), '{}') FROM (
    SELECT l.user_id FROM public.account_lifecycle l
    UNION ALL -- 20261122120000
    SELECT s.user_id FROM public.account_suspensions s
     WHERE s.lifted_at IS NULL AND s.user_id IS NOT NULL AND (s.expires_at IS NULL OR s.expires_at > now())) x;
$function$;

CREATE OR REPLACE FUNCTION private.conversation_has_hidden_participant(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants p
    WHERE p.conversation_id = p_conversation_id
      AND private.account_is_hidden(p.user_id) -- 20261122120000: lifecycle or suspension
  );
$function$;

CREATE OR REPLACE FUNCTION private.hidden_conversation_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(array_agg(DISTINCT p.conversation_id), '{}')
  FROM public.conversation_participants p
  WHERE p.user_id = ANY (private.hidden_account_ids()); -- 20261122120000: lifecycle or suspension
$function$;

-- A suspended collector's own writes fail with a recognisable error.
CREATE OR REPLACE FUNCTION private.guard_account_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF private.caller_is_hidden() THEN
    IF private.account_is_suspended(auth.uid())
       AND NOT EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = auth.uid()) THEN
      RAISE EXCEPTION 'account_suspended' -- 20261122120000
        USING ERRCODE = '42501', HINT = 'This account is suspended.';
    END IF;
    RAISE EXCEPTION 'account_inactive'
      USING ERRCODE = '42501', HINT = 'This account is scheduled for deletion.';
  END IF;
  RETURN NULL;
END;
$function$;

-- Admin evidence views show an active suspension.
CREATE OR REPLACE FUNCTION private.moderation_account_summary(p_user uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN p_user IS NULL THEN jsonb_build_object('present', false, 'account_state', 'deleted')
    ELSE jsonb_build_object('present', true,
      'username', (SELECT p.username FROM public.profiles p WHERE p.id = p_user),
      'account_state', COALESCE((SELECT l.state FROM public.account_lifecycle l WHERE l.user_id = p_user),
                                CASE WHEN private.account_is_suspended(p_user) THEN 'suspended' END, -- 20261122120000
                                'active'))
  END;
$function$;

-- ── 4. Reasons and audit actions ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.moderation_reason_valid(p_kind text, p_reason text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(CASE p_kind
    WHEN 'no_violation'           THEN p_reason IN ('within_guidelines', 'insufficient_evidence')
    WHEN 'duplicate'              THEN p_reason IN ('duplicate_report')
    WHEN 'administrative_closure' THEN p_reason IN ('target_deleted', 'account_deleted', 'out_of_scope', 'test_report')
    WHEN 'reopen'                 THEN p_reason IN ('new_information', 'resolved_in_error', 'quality_review')
    WHEN 'hide'                   THEN p_reason IN ('pending_review', 'urgent_risk')
    WHEN 'remove'                 THEN p_reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                                                    'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property',
                                                    'other_violation')
    WHEN 'restore'                THEN p_reason IN ('resolved_in_error', 'new_information', 'appeal_granted',
                                                    'child_safety_review_cleared')
    WHEN 'release'                THEN p_reason IN ('owner_may_edit', 'policy_review', 'child_safety_review_cleared')
    -- 20261122120000
    WHEN 'suspend'                THEN p_reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm',
                                                    'child_safety', 'scam_fraud', 'impersonation', 'intellectual_property',
                                                    'repeat_violations', 'ban_evasion', 'urgent_risk', 'other_violation')
    WHEN 'unsuspend'              THEN p_reason IN ('resolved_in_error', 'new_information', 'appeal_granted',
                                                    'child_safety_review_cleared')
  END, false);
$function$;

ALTER TABLE public.moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_action_check CHECK (action = ANY (ARRAY[
  'claim', 'release', 'resolve', 'reopen', 'hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields',
  'release_profile_fields', 'suspend', 'lift_suspension']));

-- What a collector may see about their own suspension: a broad category,
-- never the internal reason code, note, report, reporter or admin.
CREATE FUNCTION private.suspension_category(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_reason IN ('spam', 'scam_fraud') THEN 'spam_or_scams'
    WHEN p_reason = 'impersonation' THEN 'impersonation'
    WHEN p_reason = 'intellectual_property' THEN 'intellectual_property'
    WHEN p_reason = 'ban_evasion' THEN 'ban_evasion'
    ELSE 'community_guidelines'
  END;
$$;

-- ── 5. Administration ───────────────────────────────────────────────────────
CREATE FUNCTION private.suspension_view(s public.account_suspensions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'user_id', s.user_id,
    'username', (SELECT p.username FROM public.profiles p WHERE p.id = s.user_id),
    'reason_code', s.reason_code, 'note', s.note, 'report_id', s.report_id, 'child_safety', s.child_safety,
    'created_by', s.created_by, 'created_at', s.created_at, 'expires_at', s.expires_at,
    'lifted_at', s.lifted_at, 'lifted_by', s.lifted_by, 'lift_reason', s.lift_reason, 'lift_note', s.lift_note,
    'state', CASE WHEN s.lifted_at IS NOT NULL THEN CASE WHEN s.lift_reason = 'expired' THEN 'expired' ELSE 'lifted' END
                  WHEN s.expires_at IS NOT NULL AND s.expires_at <= now() THEN 'expired'
                  ELSE 'active' END);
$$;

-- Closes a collector's open suspension that has already expired (bookkeeping
-- only — it stopped applying at expires_at).
CREATE FUNCTION private.close_expired_suspension(p_user uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE public.account_suspensions s SET lifted_at = s.expires_at, lift_reason = 'expired'
   WHERE s.user_id = p_user AND s.lifted_at IS NULL AND s.expires_at IS NOT NULL AND s.expires_at <= now();
$$;

CREATE FUNCTION public.admin_suspend_account(
  p_user_id uuid, p_reason_code text, p_expires_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL, p_report_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  r public.content_reports;
  s public.account_suspensions;
  v_state text;
BEGIN
  IF p_user_id IS NULL OR NOT private.moderation_reason_valid('suspend', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND (p_expires_at < now() + interval '1 hour' OR p_expires_at > now() + interval '366 days') THEN
    RAISE EXCEPTION 'invalid_expiry' USING ERRCODE = '22023',
      HINT = 'A temporary suspension lasts between 1 hour and 1 year; omit the expiry for an indefinite one.';
  END IF;
  IF p_user_id = v_admin THEN
    RAISE EXCEPTION 'cannot_suspend_self' USING ERRCODE = '22023';
  END IF;
  -- Admins are managed in admin_users (SQL editor), never suspended from the
  -- app, so no decision here can leave the platform without an admin.
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = p_user_id) THEN
    RAISE EXCEPTION 'cannot_suspend_admin' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF p_report_id IS NOT NULL THEN
    SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'report_not_found' USING ERRCODE = 'PT404';
    END IF;
    IF r.target_owner_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'report_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Serialize every decision about this collector.
  PERFORM pg_advisory_xact_lock(hashtextextended('suspension:' || p_user_id::text, 0));
  SELECT l.state INTO v_state FROM public.account_lifecycle l WHERE l.user_id = p_user_id;
  IF v_state = 'deleting' THEN
    RAISE EXCEPTION 'account_deleting' USING ERRCODE = 'PT409';
  END IF;
  PERFORM private.close_expired_suspension(p_user_id);
  SELECT * INTO s FROM public.account_suspensions x WHERE x.user_id = p_user_id AND x.lifted_at IS NULL FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'already_suspended' USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.account_suspensions (user_id, reason_code, note, report_id, child_safety, created_by, expires_at)
  VALUES (p_user_id, p_reason_code, v_note, p_report_id,
          p_reason_code = 'child_safety' OR COALESCE(r.reason = 'child_safety', false), v_admin, p_expires_at)
  RETURNING * INTO s;
  INSERT INTO public.moderation_actions (admin_id, report_id, action, target_type, target_id, target_owner_id,
                                         reason_code, note, metadata)
  VALUES (v_admin, p_report_id, 'suspend', 'profile', p_user_id, p_user_id, p_reason_code, v_note,
          jsonb_build_object('suspension_id', s.id, 'expires_at', s.expires_at, 'indefinite', s.expires_at IS NULL,
                             'child_safety', s.child_safety, 'pending_deletion', v_state IS NOT NULL));
  RETURN private.suspension_view(s);
END;
$$;

-- Lifts a collector's active suspension. A child-safety suspension needs a
-- second admin (not the one who imposed it), explicit confirmation, the
-- child_safety_review_cleared reason and a note.
CREATE FUNCTION public.admin_lift_suspension(
  p_user_id uuid, p_reason_code text, p_note text DEFAULT NULL, p_confirm_child_safety boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
  v_note text := private.moderation_note(p_note);
  s public.account_suspensions;
BEGIN
  IF p_user_id IS NULL OR NOT private.moderation_reason_valid('unsuspend', p_reason_code) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('suspension:' || p_user_id::text, 0));
  PERFORM private.close_expired_suspension(p_user_id);
  SELECT * INTO s FROM public.account_suspensions x WHERE x.user_id = p_user_id AND x.lifted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_suspended' USING ERRCODE = 'PT409';
  END IF;
  IF s.child_safety THEN
    IF NOT COALESCE(p_confirm_child_safety, false) THEN
      RAISE EXCEPTION 'child_safety_confirmation_required' USING ERRCODE = '22023';
    END IF;
    IF p_reason_code <> 'child_safety_review_cleared' OR v_note IS NULL THEN
      RAISE EXCEPTION 'child_safety_review_required' USING ERRCODE = '22023';
    END IF;
    IF s.created_by IS NOT DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'second_admin_required' USING ERRCODE = '42501';
    END IF;
  ELSIF p_reason_code = 'child_safety_review_cleared' THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '22023';
  END IF;

  UPDATE public.account_suspensions
     SET lifted_at = clock_timestamp(), lifted_by = v_admin, lift_reason = p_reason_code, lift_note = v_note
   WHERE id = s.id
  RETURNING * INTO s;
  INSERT INTO public.moderation_actions (admin_id, report_id, action, target_type, target_id, target_owner_id,
                                         reason_code, note, metadata)
  VALUES (v_admin, s.report_id, 'lift_suspension', 'profile', p_user_id, p_user_id, p_reason_code, v_note,
          jsonb_build_object('suspension_id', s.id, 'child_safety', s.child_safety));
  RETURN private.suspension_view(s);
END;
$$;

CREATE FUNCTION public.admin_list_suspensions(p_state text DEFAULT 'active', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  IF p_state NOT IN ('active', 'all') OR p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(private.suspension_view(s) ORDER BY s.created_at DESC)
      FROM (SELECT x.* FROM public.account_suspensions x
             WHERE p_state = 'all' OR (x.lifted_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > now()))
             ORDER BY x.created_at DESC LIMIT p_limit OFFSET p_offset) s), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.admin_account_suspensions(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'suspended', private.account_is_suspended(p_user_id),
    'history', COALESCE((SELECT jsonb_agg(private.suspension_view(s) ORDER BY s.created_at DESC)
                           FROM public.account_suspensions s WHERE s.user_id = p_user_id), '[]'::jsonb));
END;
$$;

-- ── 6. The collector's own status ───────────────────────────────────────────
-- Only: whether they are suspended, since when, until when, and a broad
-- category. Never the reason code, note, report, reporter or admin.
CREATE FUNCTION public.my_account_suspension()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object('suspended', true, 'category', private.suspension_category(s.reason_code),
                              'since', s.created_at, 'expires_at', s.expires_at, 'indefinite', s.expires_at IS NULL)
      FROM public.account_suspensions s
     WHERE s.user_id = auth.uid() AND s.lifted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
     LIMIT 1), jsonb_build_object('suspended', false));
$$;

-- ── 7. Server-side helper for Edge Functions ────────────────────────────────
-- Which of these accounts are hidden (pending deletion, being deleted, or
-- suspended). Replaces direct account_lifecycle reads in Edge Functions.
CREATE FUNCTION public.account_hidden_ids(p_user_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT DISTINCT u FROM unnest(p_user_ids) u
  WHERE cardinality(p_user_ids) <= 1000 AND private.account_is_hidden(u);
$$;

-- ── 8. Privileges ───────────────────────────────────────────────────────────
-- account_is_suspended is used inside RLS-evaluated helpers that already run
-- as their owner, so no API role needs it.
REVOKE ALL ON FUNCTION private.account_suspensions_guard(), private.account_is_suspended(uuid),
  private.suspension_category(text), private.suspension_view(public.account_suspensions),
  private.close_expired_suspension(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_suspend_account(uuid, text, timestamptz, text, uuid),
  public.admin_lift_suspension(uuid, text, text, boolean), public.admin_list_suspensions(text, integer, integer),
  public.admin_account_suspensions(uuid), public.my_account_suspension() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_suspend_account(uuid, text, timestamptz, text, uuid),
  public.admin_lift_suspension(uuid, text, text, boolean), public.admin_list_suspensions(text, integer, integer),
  public.admin_account_suspensions(uuid), public.my_account_suspension() TO authenticated;
REVOKE ALL ON FUNCTION public.account_hidden_ids(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_hidden_ids(uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

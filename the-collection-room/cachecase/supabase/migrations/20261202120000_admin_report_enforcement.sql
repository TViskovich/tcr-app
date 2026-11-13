-- ============================================================================
-- Administrator moderation enforcement from a report — Phase 2B M5.2.
--
-- The admin report screen (app/admin/report/[id].tsx) gains an Enforcement
-- section. Every enforcement decision is made by the EXISTING functions —
-- nothing here hides, removes, restores, clears or suspends on its own:
--
--   hide                    public.admin_hide_content          (M2.1)
--   remove                  public.admin_remove_content        (M2.1)
--   restore                 public.admin_restore_content       (M2.1/M2.2)
--   clear_profile_fields    public.admin_clear_profile_fields  (M2.2)
--   restore_profile_fields  public.admin_restore_profile_fields(M2.2)
--   suspend                 public.admin_suspend_account       (M3)
--   lift_suspension         public.admin_lift_suspension       (M3)
--
-- Each keeps its own authorization, reason codes, child-safety rules
-- (dedicated reason, note, explicit confirmation, a second administrator),
-- report transitions, media-quarantine triggers and audit rows.
--
-- New here:
--   admin_report_enforcement  read-only: the enforcement state of ONE report —
--                             the restriction on its content, media
--                             quarantine progress (counts and states, never
--                             paths), cleared profile fields (names, never
--                             values), the reported account's suspension and
--                             which actions apply, with the reason when not.
--   admin_report_enforce      one entry point: locks the report (and, for a
--                             restore, every report linked to the
--                             restriction, in id order — the order the
--                             existing restore uses), refuses with
--                             report_changed if the case moved on since the
--                             screen loaded it, derives the restriction,
--                             profile and account from the REPORT (never from
--                             client-supplied ids), then calls the existing
--                             function. Report-level decisions (hide, remove,
--                             clear fields) also require the caller to hold
--                             the claim (claim_required) — stricter than the
--                             underlying functions, never looser.
--
-- Not changed: any table, policy, trigger, existing function, retention rule,
-- legal hold, the account-deletion and export pipelines, Registry, Transfers.
--
-- Errors: those of the delegated function, plus
--   22023 invalid_action | invalid_version | invalid_argument
--   PT409 report_changed | claim_required | not_restricted |
--         restricted_via_other_report | owner_unavailable
-- ============================================================================

-- ── 1. Read model (server-only helpers) ─────────────────────────────────────
-- The restriction relevant to this report: an ACTIVE one first — the one
-- linked to it, else one on the same reported row placed through another
-- report — and only then the (lifted) one it was last linked to. A report
-- that still links a lifted restriction must not hide a newer active one.
CREATE FUNCTION private.report_enforcement_restriction(r public.content_reports)
RETURNS public.moderated_content
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.* FROM public.moderated_content m
   WHERE m.id = r.moderation_id
      OR (m.target_type = r.target_type AND m.target_id = r.target_id AND m.lifted_at IS NULL)
   ORDER BY (m.lifted_at IS NULL) DESC, (m.id = r.moderation_id) DESC NULLS LAST, m.created_at DESC
   LIMIT 1;
$$;

-- Media quarantine progress for a restriction: counts, states and error
-- codes only — never buckets, paths or hashes.
CREATE FUNCTION private.report_enforcement_media(p_moderation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH jobs AS (
    SELECT DISTINCT q.id, q.state, q.needs_attention, q.legal_hold, q.last_error
      FROM private.media_quarantine_holds h JOIN private.media_quarantine q ON q.id = h.quarantine_id
     WHERE p_moderation_id IS NOT NULL
       AND (h.moderation_id = p_moderation_id
            OR h.profile_field_id IN (SELECT f.id FROM public.moderated_profile_fields f WHERE f.moderation_id = p_moderation_id))
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM jobs),
    'by_state', COALESCE((SELECT jsonb_object_agg(x.state, x.n) FROM (SELECT j.state, count(*) AS n FROM jobs j GROUP BY j.state) x), '{}'::jsonb),
    -- queued for the quarantine worker (copy, verify, remove the original)
    'in_progress', (SELECT count(*) FROM jobs j WHERE j.state IN ('pending', 'copied', 'verified', 'restoring')),
    -- restoration is never automatic: an administrator restores these with
    -- admin-media-restore (M2.3c) after the restriction is lifted
    'awaiting_restore', (SELECT count(*) FROM jobs j WHERE j.state = 'restore_pending'),
    'needs_attention', (SELECT count(*) FROM jobs j WHERE j.needs_attention OR j.state = 'failed'),
    'legal_hold', (SELECT count(*) FROM jobs j WHERE j.legal_hold),
    'errors', COALESCE((SELECT jsonb_agg(DISTINCT CASE WHEN j.last_error ~ '^[a-z_]{1,48}$' THEN j.last_error ELSE 'error' END)
                          FROM jobs j WHERE j.last_error IS NOT NULL), '[]'::jsonb),
    'automatic', COALESCE((SELECT c.enabled FROM private.media_quarantine_scheduler_config c LIMIT 1), false));
$$;

-- Whether p_admin imposed (or escalated) a restriction — the existing
-- child-safety rules then require a different administrator to lift it.
CREATE FUNCTION private.report_enforcement_acted(m public.moderated_content, p_admin uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT m.id IS NOT NULL AND (m.created_by = p_admin OR EXISTS (
    SELECT 1 FROM public.moderation_actions a
     WHERE a.admin_id = p_admin AND a.action IN ('hide', 'remove', 'clear_profile_fields')
       AND a.metadata ->> 'moderation_id' = m.id::text));
$$;

REVOKE ALL ON FUNCTION private.report_enforcement_restriction(public.content_reports) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_enforcement_media(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.report_enforcement_acted(public.moderated_content, uuid) FROM PUBLIC, anon, authenticated;

-- ── 2. Enforcement state of one report ──────────────────────────────────────
-- `actions.<name>.available` and `.blocked` are hints for the screen; every
-- action is re-checked by admin_report_enforce and the existing function.
CREATE FUNCTION public.admin_report_enforcement(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin    uuid := private.require_admin();
  r          public.content_reports;
  m          public.moderated_content;
  s          public.account_suspensions;
  v_claim    text;
  v_pending  boolean;
  v_exists   boolean;
  v_owner    uuid;
  v_admin_o  boolean;
  v_life     text;
  v_cs       boolean;
  v_active   boolean;
  v_linked   boolean;
  v_acted    boolean;
  v_fields   jsonb := NULL;
  v_clear    jsonb := '[]'::jsonb;
  v_locked   integer := 0;
  v_related  integer;
  v_profile  boolean;
  a          jsonb := '{}'::jsonb;
  -- action → blocked reason (NULL = available)
  b_hide text; b_remove text; b_restore text; b_clear text; b_prestore text; b_suspend text; b_lift text;
BEGIN
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  v_claim := private.report_review_claim(r, v_admin);
  v_pending := r.status IN ('open', 'reviewing');
  v_exists := private.moderation_target_exists(r.target_type, r.target_id);
  v_profile := r.target_type = 'profile';
  v_owner := r.target_owner_id;
  v_cs := private.report_is_child_safety(r.id);
  m := private.report_enforcement_restriction(r);
  v_active := m.id IS NOT NULL AND m.lifted_at IS NULL;
  v_linked := m.id IS NOT NULL AND m.id = r.moderation_id;
  v_acted := private.report_enforcement_acted(m, v_admin);
  v_related := (SELECT count(*) FROM public.content_reports o
                 WHERE o.target_type = r.target_type AND o.target_id = r.target_id AND o.id <> r.id
                   AND (o.status = 'open' OR (o.status = 'reviewing' AND o.claimed_by = v_admin)))::integer;

  IF v_owner IS NOT NULL THEN
    v_admin_o := EXISTS (SELECT 1 FROM public.admin_users x WHERE x.user_id = v_owner);
    SELECT l.state INTO v_life FROM public.account_lifecycle l WHERE l.user_id = v_owner;
    SELECT * INTO s FROM public.account_suspensions x WHERE x.user_id = v_owner ORDER BY x.created_at DESC LIMIT 1;
  END IF;

  IF v_profile THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('field', f.field, 'status', f.status, 'created_at', f.created_at,
                                                 'mine', f.created_by = v_admin,
                                                 'current_is_cleared', NULLIF(btrim(COALESCE(to_jsonb(p) ->> f.field, '')), '') IS NULL)
                              ORDER BY f.field), '[]'::jsonb),
           count(*)::integer
      INTO v_fields, v_locked
      FROM public.moderated_profile_fields f LEFT JOIN public.profiles p ON p.id = f.user_id
     WHERE f.user_id = r.target_id AND f.status = 'active';
    SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_clear
      FROM public.profiles p, unnest(ARRAY['display_name', 'bio', 'tagline', 'location', 'website', 'hero_display_name',
                                           'avatar_url', 'hero_image_url', 'showcase_badge_url']) k
     WHERE p.id = r.target_id AND NULLIF(btrim(COALESCE(to_jsonb(p) ->> k, '')), '') IS NOT NULL
       AND k <> ALL (private.locked_profile_fields(r.target_id));
  END IF;

  -- Report-level decisions: pending, claimed by the caller.
  IF NOT v_pending THEN
    b_hide := 'already_resolved'; b_remove := 'already_resolved'; b_clear := 'already_resolved';
  ELSIF v_claim = 'other' THEN
    b_hide := 'claimed_by_other'; b_remove := 'claimed_by_other'; b_clear := 'claimed_by_other';
  ELSIF v_claim <> 'mine' THEN
    b_hide := 'claim_required'; b_remove := 'claim_required'; b_clear := 'claim_required';
  END IF;
  IF v_profile THEN
    b_hide := 'unsupported_target'; b_remove := 'unsupported_target';
    IF b_clear IS NULL AND NOT v_exists THEN b_clear := 'target_not_found';
    ELSIF b_clear IS NULL AND jsonb_array_length(v_clear) = 0 AND v_locked = 0 THEN b_clear := 'nothing_to_clear';
    END IF;
  ELSE
    b_clear := 'unsupported_target';
    IF b_hide IS NULL AND v_active AND m.state = 'removed' THEN b_hide := 'already_removed';
    ELSIF b_hide IS NULL AND v_active AND v_linked THEN b_hide := 'already_hidden';
    ELSIF b_hide IS NULL AND NOT v_exists THEN b_hide := 'target_not_found';
    END IF;
    IF b_remove IS NULL AND NOT v_exists AND NOT v_active THEN b_remove := 'target_not_found'; END IF;
  END IF;

  -- Restore: an active restriction linked to THIS report (non-profile).
  IF v_profile THEN b_restore := 'use_profile_restore';
  ELSIF NOT v_active THEN b_restore := 'not_restricted';
  ELSIF NOT v_linked THEN b_restore := 'restricted_via_other_report';
  ELSIF m.child_safety AND v_acted THEN b_restore := 'child_safety_second_admin_required';
  END IF;
  IF NOT v_profile THEN b_prestore := 'unsupported_target';
  ELSIF v_locked = 0 THEN b_prestore := 'not_restricted';
  ELSIF NOT v_active THEN b_prestore := 'not_restricted';
  ELSIF m.child_safety AND v_acted THEN b_prestore := 'child_safety_second_admin_required';
  END IF;

  -- Account.
  IF v_owner IS NULL THEN b_suspend := 'owner_unavailable'; b_lift := 'owner_unavailable';
  ELSE
    IF v_admin_o THEN b_suspend := 'cannot_suspend_admin';
    ELSIF v_owner = v_admin THEN b_suspend := 'cannot_suspend_self';
    ELSIF v_life = 'deleting' THEN b_suspend := 'account_deleting';
    ELSIF private.account_is_suspended(v_owner) THEN b_suspend := 'already_suspended';
    END IF;
    IF NOT private.account_is_suspended(v_owner) THEN b_lift := 'not_suspended';
    ELSIF s.child_safety AND s.created_by = v_admin THEN b_lift := 'second_admin_required';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'version', private.report_review_version(r),
    'report_status', r.status,
    'claim', v_claim,
    'child_safety', v_cs,
    'legal_hold', private.legal_hold_active('report', r.id),
    'target', jsonb_build_object('type', r.target_type, 'exists', v_exists, 'other_pending_reports', v_related),
    'restriction', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object(
        'target_type', m.target_type, 'state', CASE WHEN m.lifted_at IS NULL THEN m.state ELSE 'lifted' END,
        'active', m.lifted_at IS NULL, 'linked', v_linked, 'child_safety', m.child_safety, 'reason_code', m.reason_code,
        'created_at', m.created_at, 'created_by_me', m.created_by = v_admin, 'acted_by_me', v_acted,
        'lifted_at', m.lifted_at, 'lift_reason', m.lift_reason,
        'reports_linked', (SELECT count(*) FROM public.content_reports c WHERE c.moderation_id = m.id)) END,
    'media', private.report_enforcement_media(m.id),
    'profile', CASE WHEN v_profile THEN jsonb_build_object('restricted_fields', v_fields, 'clearable_fields', v_clear) END,
    'account', CASE WHEN v_owner IS NULL THEN jsonb_build_object('present', false) ELSE jsonb_build_object(
        'present', true, 'is_admin', v_admin_o, 'lifecycle', COALESCE(v_life, 'active'),
        'suspended', private.account_is_suspended(v_owner),
        'suspension', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
            'state', CASE WHEN s.lifted_at IS NOT NULL THEN CASE WHEN s.lift_reason = 'expired' THEN 'expired' ELSE 'lifted' END
                          WHEN s.expires_at IS NOT NULL AND s.expires_at <= now() THEN 'expired' ELSE 'active' END,
            'reason_code', s.reason_code, 'child_safety', s.child_safety, 'created_at', s.created_at,
            'expires_at', s.expires_at, 'lifted_at', s.lifted_at, 'lift_reason', s.lift_reason,
            'created_by_me', s.created_by = v_admin, 'from_this_report', s.report_id = r.id) END,
        'suspensions_total', (SELECT count(*) FROM public.account_suspensions x WHERE x.user_id = v_owner)) END,
    'actions', jsonb_build_object(
      'hide',                   jsonb_build_object('available', b_hide IS NULL, 'blocked', b_hide),
      'remove',                 jsonb_build_object('available', b_remove IS NULL, 'blocked', b_remove),
      'restore',                jsonb_build_object('available', b_restore IS NULL, 'blocked', b_restore),
      'clear_profile_fields',   jsonb_build_object('available', b_clear IS NULL, 'blocked', b_clear),
      'restore_profile_fields', jsonb_build_object('available', b_prestore IS NULL, 'blocked', b_prestore),
      'suspend',                jsonb_build_object('available', b_suspend IS NULL, 'blocked', b_suspend),
      'lift_suspension',        jsonb_build_object('available', b_lift IS NULL, 'blocked', b_lift)));
END;
$$;

-- ── 3. Version-checked enforcement entry point ─────────────────────────────
-- p_options (all optional, validated by the existing functions):
--   include_related       boolean   remove, clear_profile_fields
--   disposition           text      restore, restore_profile_fields
--   confirm_child_safety  boolean   restore, restore_profile_fields, lift_suspension
--   fields                text[]    clear_profile_fields, restore_profile_fields
--   expires_at            timestamptz  suspend (omit for indefinite)
CREATE FUNCTION public.admin_report_enforce(
  p_report_id        uuid,
  p_action           text,
  p_expected_version text,
  p_reason_code      text,
  p_note             text  DEFAULT NULL,
  p_options          jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   uuid := private.require_admin();
  r         public.content_reports;
  m         public.moderated_content;
  v_opts    jsonb := COALESCE(p_options, '{}'::jsonb);
  v_related boolean;
  v_disp    text;
  v_confirm boolean;
  v_fields  text[];
  v_expires timestamptz;
  v_res     jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('hide', 'remove', 'restore', 'clear_profile_fields', 'restore_profile_fields',
                                          'suspend', 'lift_suspension') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'invalid_version' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_opts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_related := (v_opts ->> 'include_related')::boolean;
    v_disp := v_opts ->> 'disposition';
    v_confirm := COALESCE((v_opts ->> 'confirm_child_safety')::boolean, false);
    v_expires := (v_opts ->> 'expires_at')::timestamptz;
    IF v_opts ? 'fields' THEN
      IF jsonb_typeof(v_opts -> 'fields') <> 'array' THEN RAISE EXCEPTION 'bad'; END IF;
      v_fields := ARRAY(SELECT jsonb_array_elements_text(v_opts -> 'fields'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END;

  -- Lock: the report; for a restore, every report linked to its restriction
  -- (ascending id, as admin_restore_content and the profile restore do).
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF p_action IN ('restore', 'restore_profile_fields') AND r.moderation_id IS NOT NULL THEN
    PERFORM 1 FROM public.content_reports c WHERE c.id = r.id OR c.moderation_id = r.moderation_id ORDER BY c.id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.content_reports c WHERE c.id = r.id FOR UPDATE;
  END IF;
  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  IF private.report_review_version(r) IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'report_changed' USING ERRCODE = 'PT409';
  END IF;

  IF p_action IN ('hide', 'remove', 'clear_profile_fields') THEN
    IF r.status IN ('open', 'reviewing') AND private.report_review_claim(r, v_admin) <> 'mine' THEN
      RAISE EXCEPTION 'claim_required' USING ERRCODE = 'PT409';
    END IF;
    IF p_action = 'hide' THEN
      v_res := public.admin_hide_content(r.id, p_reason_code, p_note, NULL);
    ELSIF p_action = 'remove' THEN
      v_res := public.admin_remove_content(r.id, p_reason_code, p_note, NULL, COALESCE(v_related, true));
    ELSE
      v_res := public.admin_clear_profile_fields(r.id, v_fields, p_reason_code, p_note, COALESCE(v_related, false));
    END IF;
  ELSIF p_action = 'restore' THEN
    m := private.report_enforcement_restriction(r);
    IF m.id IS NULL OR m.lifted_at IS NOT NULL THEN
      RAISE EXCEPTION 'not_restricted' USING ERRCODE = 'PT409';
    END IF;
    IF m.id IS DISTINCT FROM r.moderation_id THEN
      RAISE EXCEPTION 'restricted_via_other_report' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_restore_content(m.id, p_reason_code, p_note, v_disp, v_confirm);
  ELSIF p_action = 'restore_profile_fields' THEN
    IF r.target_type <> 'profile' THEN
      RAISE EXCEPTION 'unsupported_target' USING ERRCODE = '22023';
    END IF;
    v_res := public.admin_restore_profile_fields(r.target_id, v_fields, p_reason_code, p_note, v_disp, v_confirm);
  ELSIF p_action = 'suspend' THEN
    IF r.target_owner_id IS NULL THEN
      RAISE EXCEPTION 'owner_unavailable' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_suspend_account(r.target_owner_id, p_reason_code, v_expires, p_note, r.id);
  ELSE
    IF r.target_owner_id IS NULL THEN
      RAISE EXCEPTION 'owner_unavailable' USING ERRCODE = 'PT409';
    END IF;
    v_res := public.admin_lift_suspension(r.target_owner_id, p_reason_code, p_note, v_confirm);
  END IF;

  SELECT * INTO r FROM public.content_reports c WHERE c.id = p_report_id;
  -- Suspension views carry account ids and the note; the screen re-reads
  -- the enforcement state instead.
  RETURN jsonb_build_object('action', p_action, 'changed', COALESCE((v_res ->> 'changed')::boolean, true),
                            'report_status', r.status, 'version', private.report_review_version(r),
                            'related_resolved', COALESCE((v_res ->> 'related_resolved')::integer, 0),
                            'cleared', v_res -> 'cleared', 'already_locked', v_res -> 'already_locked',
                            'ended', v_res -> 'ended', 'not_restricted', v_res -> 'not_restricted',
                            'public_media_still_reachable', v_res -> 'public_media_still_reachable',
                            'profile_restriction', v_res -> 'profile_restriction',
                            'media', private.report_enforcement_media(COALESCE((v_res ->> 'moderation_id')::uuid, r.moderation_id)));
END;
$$;

-- ── 4. Privileges ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_report_enforcement(uuid)',
    'public.admin_report_enforce(uuid, text, text, text, text, jsonb)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Phase 2B M4 step 5D.1: in-flight purge authorization hardening (LOCAL).
--
-- The gap (20261129120000): the Storage guard consumed a live quarantine-copy
-- claim without re-checking the two administrators named on it, and losing
-- standing — a suspension, removal from admin_users, or the start of account
-- deletion — neither withdrew claims nor serialised with authorisations
-- (only a privilege revocation did). A claim issued just before could still
-- authorise a delete for the rest of its lease (up to 2 minutes).
--
-- Now:
--   1. private.lock_purge_privilege locks the grant row FIRST and only then
--      re-reads the administrator's standing (a fresh snapshot), so a change
--      committed while it waited is always seen.
--   2. The Storage guard re-authorises BOTH claim administrators (active, not
--      suspended, not pending deletion, still in admin_users, still holding
--      their privilege) immediately before consuming the claim, alongside its
--      existing eligibility, child-safety and legal-hold re-checks.
--   3. Losing standing locks that administrator's grant rows (waiting for any
--      authorisation in flight) and withdraws every live claim naming them.
--      Lock order everywhere: grant rows, then claim rows.
--
-- Report-evidence claims are created and consumed inside one transaction
-- that already holds the grant locks (claim guard), so they need no change.
-- Unchanged: the two-administrator model, windows, reconciliation (settling
-- an already-performed delete never needs the run's administrators).

-- ── 1. Lock, then check ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.lock_purge_privilege(p_user uuid, p_privilege text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM private.admin_privileges g
   WHERE g.user_id = p_user AND g.privilege = p_privilege AND g.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- A separate statement: a fresh snapshot, taken after the lock was granted.
  RETURN private.retention_purge_admin_active(p_user);
END;
$$;

-- ── 2. Losing standing withdraws claims ─────────────────────────────────────
CREATE FUNCTION private.purge_authority_lost(p_user uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  -- Waits for any authorisation that is relying on these grants, and makes
  -- new ones wait until this transaction ends (they then see the change).
  PERFORM 1 FROM private.admin_privileges g WHERE g.user_id = p_user AND g.revoked_at IS NULL ORDER BY g.id FOR UPDATE;
  UPDATE private.retention_purge_claims c
     SET closed_at = clock_timestamp(), close_reason = 'withdrawn'
   WHERE c.closed_at IS NULL AND (c.prepared_by = p_user OR c.approved_by = p_user);
END;
$$;

CREATE FUNCTION private.purge_authority_lost_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.purge_authority_lost(CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END);
  RETURN NULL;
END;
$$;
-- Removed as an administrator (also when the auth user is deleted: cascade).
CREATE TRIGGER admin_users_purge_authority AFTER DELETE ON public.admin_users
  FOR EACH ROW EXECUTE FUNCTION private.purge_authority_lost_trigger();
-- Suspended (a new suspension, or one that becomes active again).
CREATE TRIGGER account_suspensions_purge_authority AFTER INSERT OR UPDATE ON public.account_suspensions
  FOR EACH ROW WHEN (NEW.lifted_at IS NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > now()))
  EXECUTE FUNCTION private.purge_authority_lost_trigger();
-- Account deletion begins (any lifecycle row hides the account).
CREATE TRIGGER account_lifecycle_purge_authority AFTER INSERT ON public.account_lifecycle
  FOR EACH ROW EXECUTE FUNCTION private.purge_authority_lost_trigger();

-- ── 3. Storage guard (20261124120000 + claim re-authorisation) ──────────────
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
  v_prep uuid;
  v_appr uuid;
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
    -- 20261130120000: re-authorise the claim's two administrators NOW, before
    -- the claim is consumed. Their grant rows are locked (then their standing
    -- re-read) BEFORE the claim row — the same order as a revocation or a
    -- loss of standing (suspension, removal, account deletion), which lock
    -- the grants and then withdraw the claims — so the two serialise: either
    -- this delete commits first, or it sees the change and is refused.
    SELECT c.prepared_by, c.approved_by INTO v_prep, v_appr FROM private.retention_purge_claims c
     WHERE c.subject_kind = 'quarantine_copy' AND c.subject_id = q.id AND c.closed_at IS NULL
       AND c.object_bucket = OLD.bucket_id AND c.object_path = OLD.name AND c.lease_expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quarantine_object_protected' USING ERRCODE = '42501';
    END IF;
    IF NOT private.lock_purge_privilege(v_prep, 'retention_purge_preparer')
       OR NOT private.lock_purge_privilege(v_appr, 'retention_purge_approver') THEN
      RAISE EXCEPTION 'claim_admins_not_authorized' USING ERRCODE = '42501';
    END IF;
    SELECT c.id INTO v_claim FROM private.retention_purge_claims c
     WHERE c.subject_kind = 'quarantine_copy' AND c.subject_id = q.id AND c.closed_at IS NULL
       AND c.object_bucket = OLD.bucket_id AND c.object_path = OLD.name AND c.lease_expires_at > clock_timestamp()
       AND c.prepared_by = v_prep AND c.approved_by = v_appr
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

REVOKE ALL ON FUNCTION private.purge_authority_lost(uuid), private.purge_authority_lost_trigger()
  FROM PUBLIC, anon, authenticated, service_role;

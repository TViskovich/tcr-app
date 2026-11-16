-- P2.3 Issue 1: reliable server-side deletion of item-images objects.
--
-- Problem (confirmed in production smoke testing, B2b/B2c): the item-images
-- bucket deliberately has NO Storage SELECT policy (20260821130000), so every
-- client-side storage.remove() on it silently matches 0 objects. Removed
-- photos, photos of deleted items/folders and replaced folder covers all
-- stayed in Storage as orphans. Client read access is NOT widened here.
--
-- Design: a durable deletion ledger, filled TRANSACTIONALLY by triggers in the
-- same transaction that removes the last database reference, and processed by
-- a service-role worker (Edge Function item-image-cleanup) that re-checks
-- every path under the per-path advisory lock every new reference already
-- takes ('item-images-path:<path>', 20261121120000).
--
--   * Enqueue: AFTER DELETE / UPDATE OF storage_path on collection_item_images
--     (covers remove_item_image, item delete, folder-delete cascade, account
--     deletion cascade — and already-shipped app builds), AFTER DELETE /
--     UPDATE OF cover_storage_path on folders, and request_item_upload_cleanup
--     (a client's own rejected uploads). Only paths under the row owner's own
--     "<owner uuid>/" prefix are ever enqueued.
--   * Grace: 15 minutes for normal deletions, 24 hours for abandoned uploads.
--   * Claim: re-checks under the per-path lock. Held (quarantine), moderated,
--     report evidence or an in-progress export -> deferred (re-checked every
--     6 h). Any other live reference -> kept (terminal; never deleted).
--   * New references (P2.3 review F1): once an object has been CLAIMED for
--     deletion even once it is CONDEMNED — every new reference to it, by
--     storage path or by public URL, is refused (content_unavailable) for good,
--     whatever the claim's age, retries or outcome. A worker's Storage call may
--     therefore land at ANY later time (stalled request, timed-out function,
--     overlapping workers) and can only ever remove an object nothing is
--     allowed to reference. Safety does not depend on leases or timing. A new
--     reference still cancels a deletion that was never claimed (still inside
--     its grace period), which keeps the file.
--   * Account deletion stays authoritative (F6): nothing is recorded for an
--     account with an open deletion job, and the job's creation clears that
--     owner's ledger rows (its own Storage manifest removes the files).
--   * Complete: authoritative — the row is 'deleted' only when the object is
--     really absent from storage.objects; otherwise retried with backoff and
--     marked 'failed' after 5 attempts (visible in admin status).
--   * Idempotent: an already-absent object completes as 'deleted'.
--
-- Everything is OFF by default, three independent gates:
--   1. private.item_image_cleanup_config.enabled = false (claim refuses),
--   2. the 'item-image-cleanup' pg_cron job is created INACTIVE,
--   3. the worker secret (Vault 'item_image_cleanup_worker_secret' + the
--      function's ITEM_IMAGE_CLEANUP_WORKER_SECRET) is not created here.
-- With everything off, the ledger only records — nothing is deleted.
--
-- Historical orphans (files orphaned before this migration) are NEVER
-- enqueued automatically; see the separate, audited cleanup procedure.

-- ── 1. Switch ────────────────────────────────────────────────────────────────
CREATE TABLE private.item_image_cleanup_config (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled    boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by text NOT NULL DEFAULT current_user
);
INSERT INTO private.item_image_cleanup_config (id, enabled) VALUES (true, false);
ALTER TABLE private.item_image_cleanup_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.item_image_cleanup_config FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.item_image_cleanup_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE((SELECT c.enabled FROM private.item_image_cleanup_config c WHERE c.id), false); $$;

-- ── 2. Ledger ────────────────────────────────────────────────────────────────
CREATE TABLE private.item_image_deletions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket           text NOT NULL DEFAULT 'item-images' CHECK (bucket = 'item-images'),
  path             text NOT NULL CHECK (path <> '' AND left(path, 1) <> '/' AND position('..' IN path) = 0 AND position(E'\\' IN path) = 0),
  owner_id         uuid NOT NULL,
  source           text NOT NULL CHECK (source IN ('image_removed', 'item_deleted', 'folder_cover_replaced',
                                                   'folder_deleted', 'upload_rejected', 'historical')),
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'deferred', 'deleted',
                                                                    'kept', 'cancelled', 'failed')),
  not_before       timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  claim_token      uuid,
  lease_expires_at timestamptz,
  last_reason      text,
  last_error_code  text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at     timestamptz,
  CHECK (split_part(path, '/', 1) = owner_id::text),
  CHECK ((state = 'claimed') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- One open entry per object.
CREATE UNIQUE INDEX item_image_deletions_open ON private.item_image_deletions (bucket, path)
  WHERE state IN ('pending', 'claimed', 'deferred', 'failed');
CREATE INDEX item_image_deletions_due ON private.item_image_deletions (not_before)
  WHERE state IN ('pending', 'deferred');
CREATE INDEX item_image_deletions_claimed ON private.item_image_deletions (lease_expires_at)
  WHERE state = 'claimed';
CREATE INDEX item_image_deletions_terminal ON private.item_image_deletions (completed_at)
  WHERE state IN ('deleted', 'kept', 'cancelled');
ALTER TABLE private.item_image_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.item_image_deletions FROM PUBLIC, anon, authenticated, service_role;

-- Worker runs (counts and codes only — never paths).
CREATE TABLE private.item_image_cleanup_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger     text NOT NULL CHECK (trigger IN ('sweep', 'operator')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  claimed     integer NOT NULL DEFAULT 0,
  outcomes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code  text,
  duration_ms integer
);
CREATE INDEX item_image_cleanup_runs_started ON private.item_image_cleanup_runs (started_at);
ALTER TABLE private.item_image_cleanup_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.item_image_cleanup_runs FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Helpers ───────────────────────────────────────────────────────────────
CREATE FUNCTION private.item_image_path_owner(p_path text)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN split_part(p_path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN split_part(p_path, '/', 1)::uuid END;
$$;

-- Why an object must stay, or NULL when nothing protects it any more.
--   held / moderated / report_evidence / export : retention — deferred, re-checked later
--   referenced                                   : a live reference — kept, never deleted
CREATE FUNCTION private.item_image_deletion_block_reason(p_path text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_path IS NULL THEN 'referenced'
    WHEN private.storage_path_held('item-images', p_path) THEN 'held'
    WHEN private.image_path_moderated(p_path) THEN 'moderated'
    WHEN EXISTS (SELECT 1 FROM public.content_reports r
                  WHERE jsonb_path_exists(r.evidence, '$.** ? (@.bucket == "item-images" && @.path == $p)',
                                          jsonb_build_object('p', p_path))) THEN 'report_evidence'
    WHEN EXISTS (SELECT 1 FROM public.account_export_entries e
                  WHERE e.source_bucket = 'item-images' AND e.source_path = p_path) THEN 'export'
    WHEN private.item_images_path_protected(p_path) THEN 'referenced'
    WHEN EXISTS (SELECT 1 FROM private.share_snapshot_copies c
                  WHERE c.kind = 'post_photo' AND c.source_path = p_path) THEN 'referenced'
  END;
$$;

-- Condemned: claimed at least once (whatever happened since). Such an object
-- may be removed by a delayed worker at any time, so it may never be
-- referenced again (P2.3 review F1).
CREATE FUNCTION private.item_image_path_condemned(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM private.item_image_deletions d
                  WHERE d.bucket = 'item-images' AND d.path = p_path
                    AND (d.state IN ('claimed', 'deleted', 'failed')
                         OR (d.state IN ('pending', 'deferred') AND d.attempts > 0)
                         OR (d.state = 'kept' AND d.last_reason = 'referenced_after_claim')));
$$;

-- An open account deletion job owns this account's Storage cleanup (F6).
CREATE FUNCTION private.item_image_owner_being_deleted(p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.account_deletion_jobs j
                  WHERE j.user_id = p_owner AND j.status IN ('queued', 'cleaning_storage', 'deleting_account', 'failed'));
$$;

-- Records a deletion request. Never raises for an unusable path (a malformed
-- or foreign-owner path is simply not recorded): it runs inside the user's own
-- delete, which must never fail because of cleanup bookkeeping.
CREATE FUNCTION private.enqueue_item_image_deletion(p_path text, p_owner uuid, p_source text, p_delay interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_path IS NULL OR p_owner IS NULL OR p_path = '' OR left(p_path, 1) = '/'
     OR position('..' IN p_path) > 0 OR position(E'\\' IN p_path) > 0
     OR private.item_image_path_owner(p_path) IS DISTINCT FROM p_owner THEN
    RETURN;
  END IF;
  -- F6: account deletion's own manifest removes every object of this account.
  IF private.item_image_owner_being_deleted(p_owner) THEN
    RETURN;
  END IF;
  INSERT INTO private.item_image_deletions (path, owner_id, source, not_before)
  VALUES (p_path, p_owner, p_source, clock_timestamp() + p_delay)
  ON CONFLICT (bucket, path) WHERE state IN ('pending', 'claimed', 'deferred', 'failed') DO NOTHING;
END;
$$;

-- ── 4. Enqueue triggers ──────────────────────────────────────────────────────
CREATE FUNCTION private.item_image_row_released()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.storage_path IS NOT DISTINCT FROM OLD.storage_path THEN
    RETURN NULL;
  END IF;
  PERFORM private.enqueue_item_image_deletion(
    OLD.storage_path, OLD.user_id,
    CASE WHEN EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = OLD.item_id)
         THEN 'image_removed' ELSE 'item_deleted' END,
    interval '15 minutes');
  RETURN NULL;
END;
$$;
CREATE TRIGGER item_image_deletion_enqueue AFTER DELETE OR UPDATE OF storage_path ON public.collection_item_images
  FOR EACH ROW EXECUTE FUNCTION private.item_image_row_released();

CREATE FUNCTION private.folder_cover_released()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.cover_storage_path IS NOT DISTINCT FROM OLD.cover_storage_path THEN
    RETURN NULL;
  END IF;
  PERFORM private.enqueue_item_image_deletion(
    OLD.cover_storage_path, OLD.user_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'folder_deleted' ELSE 'folder_cover_replaced' END,
    interval '15 minutes');
  RETURN NULL;
END;
$$;
CREATE TRIGGER item_image_deletion_enqueue AFTER DELETE OR UPDATE OF cover_storage_path ON public.folders
  FOR EACH ROW EXECUTE FUNCTION private.folder_cover_released();

-- ── 5. New-reference guard ───────────────────────────────────────────────────
-- Same lock as the claim re-check (and as the existing media_hold_guard). Each
-- trigger argument is 'path:<column>' (an item-images object path) or
-- 'url:<column>' (a public item-images URL naming one).
--   * condemned object (claimed at least once): refused, permanently (F1);
--   * never-claimed pending/deferred deletion: cancelled — the file is kept.
CREATE FUNCTION private.item_image_deletion_reference_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_arg text;
  v_mode text;
  v_col text;
  v_new text;
  v_old text;
  v_path text;
BEGIN
  FOREACH v_arg IN ARRAY TG_ARGV LOOP
    v_mode := split_part(v_arg, ':', 1);
    v_col := split_part(v_arg, ':', 2);
    v_new := to_jsonb(NEW) ->> v_col;
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> v_col END;
    IF v_new IS NULL OR v_new IS NOT DISTINCT FROM v_old THEN CONTINUE; END IF;
    v_path := CASE WHEN v_mode = 'url' THEN private.public_object_path(v_new, 'item-images') ELSE v_new END;
    IF v_path IS NULL THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('item-images-path:' || v_path, 0));
    IF private.item_image_path_condemned(v_path) THEN
      RAISE EXCEPTION 'content_unavailable' USING ERRCODE = '42501';
    END IF;
    UPDATE private.item_image_deletions d
       SET state = 'cancelled', last_reason = 'rereferenced',
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE d.bucket = 'item-images' AND d.path = v_path AND d.state IN ('pending', 'deferred') AND d.attempts = 0;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER item_image_deletion_guard BEFORE INSERT OR UPDATE OF storage_path, image_url ON public.collection_item_images
  FOR EACH ROW EXECUTE FUNCTION private.item_image_deletion_reference_guard('path:storage_path', 'url:image_url');
CREATE TRIGGER item_image_deletion_guard BEFORE INSERT OR UPDATE OF cover_storage_path, cover_image_url ON public.folders
  FOR EACH ROW EXECUTE FUNCTION private.item_image_deletion_reference_guard('path:cover_storage_path', 'url:cover_image_url');
CREATE TRIGGER item_image_deletion_guard BEFORE INSERT OR UPDATE OF image_url ON public.collection_items
  FOR EACH ROW EXECUTE FUNCTION private.item_image_deletion_reference_guard('url:image_url');

-- F6: when an account deletion job is created, its own Storage manifest
-- becomes the single cleanup path for that account — drop the account's
-- ledger rows (no stranded or duplicate deletion jobs). The account is hidden
-- from then on, so none of its objects can be referenced again.
CREATE FUNCTION private.item_image_deletions_account_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM private.item_image_deletions d WHERE d.owner_id = NEW.user_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER item_image_deletions_account_deletion AFTER INSERT ON public.account_deletion_jobs
  FOR EACH ROW WHEN (NEW.user_id IS NOT NULL) EXECUTE FUNCTION private.item_image_deletions_account_deletion();

-- ── 6. Client: a caller's own rejected uploads ───────────────────────────────
-- Replaces the client-side storage.remove() of addItemImages' rollback paths
-- (which silently deletes nothing). Only the caller's own, existing objects in
-- the item or cover folder shapes, uploaded within the last 48 hours (F8 —
-- historical orphans are never reachable this way); 24 h grace, so an upload
-- whose row insert is merely slow is never removed (and a later reference
-- cancels it anyway).
CREATE FUNCTION public.request_item_upload_cleanup(p_paths text[])
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_path text;
  v_count integer := 0;
BEGIN
  IF v_user IS NULL OR (SELECT private.caller_is_hidden()) THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_paths IS NULL OR cardinality(p_paths) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  FOREACH v_path IN ARRAY p_paths LOOP
    IF v_path IS NULL
       OR v_path !~ ('^' || v_user::text || '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|covers)/[A-Za-z0-9._-]{1,128}$')
       OR NOT EXISTS (SELECT 1 FROM storage.objects o
                       WHERE o.bucket_id = 'item-images' AND o.name = v_path
                         AND (o.owner = v_user OR o.owner_id = v_user::text)
                         -- F8: only a just-failed upload; never an older file.
                         AND o.created_at > clock_timestamp() - interval '48 hours') THEN
      CONTINUE;
    END IF;
    PERFORM private.enqueue_item_image_deletion(v_path, v_user, 'upload_rejected', interval '24 hours');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── 7. Worker RPCs (service role only) ───────────────────────────────────────
-- Begin: the switch, at most one running run, abandoned runs reaped,
-- housekeeping (terminal rows and runs older than 30 days).
CREATE FUNCTION public.item_image_cleanup_begin(p_trigger text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_trigger IS NULL OR p_trigger NOT IN ('sweep', 'operator') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF NOT private.item_image_cleanup_enabled() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'disabled');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('item_image_cleanup_begin'));
  UPDATE private.item_image_cleanup_runs SET status = 'abandoned', finished_at = clock_timestamp()
   WHERE status = 'running' AND started_at < clock_timestamp() - interval '10 minutes';
  IF EXISTS (SELECT 1 FROM private.item_image_cleanup_runs WHERE status = 'running') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'busy');
  END IF;
  DELETE FROM private.item_image_deletions
   WHERE state IN ('deleted', 'kept', 'cancelled') AND completed_at < clock_timestamp() - interval '30 days';
  DELETE FROM private.item_image_cleanup_runs
   WHERE status <> 'running' AND started_at < clock_timestamp() - interval '30 days';
  INSERT INTO private.item_image_cleanup_runs (trigger) VALUES (p_trigger) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'run_id', v_id);
END;
$$;

CREATE FUNCTION public.item_image_cleanup_finish(p_run_id uuid, p_status text, p_claimed integer,
                                                 p_outcomes jsonb, p_error text, p_duration_ms integer)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  UPDATE private.item_image_cleanup_runs
     SET status = p_status, finished_at = clock_timestamp(), claimed = COALESCE(p_claimed, 0),
         outcomes = COALESCE(p_outcomes, '{}'::jsonb), error_code = left(p_error, 64), duration_ms = p_duration_ms
   WHERE id = p_run_id AND status = 'running';
END;
$$;

-- Claim: each due entry is re-checked under its per-path lock. Only entries
-- that nothing protects are returned (state 'claimed', with a lease and a
-- claim token); protected ones are deferred or kept right here.
CREATE FUNCTION public.item_image_deletion_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id bigint, path text, claim_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_reason text;
  v_token uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF NOT private.item_image_cleanup_enabled() THEN
    RETURN;
  END IF;
  -- Lock order matches the new-reference guard (per-path advisory lock FIRST,
  -- then the ledger row), so a claim and a concurrent new reference serialize
  -- instead of deadlocking. The row is re-read after both locks are held.
  FOR r IN
    SELECT d.id, d.path FROM private.item_image_deletions d
     WHERE (d.state IN ('pending', 'deferred') AND d.not_before <= clock_timestamp())
        OR (d.state = 'claimed' AND d.lease_expires_at <= clock_timestamp())
     ORDER BY d.not_before, d.id
     LIMIT p_limit
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('item-images-path:' || r.path, 0));
    PERFORM 1 FROM private.item_image_deletions d
     WHERE d.id = r.id
       AND ((d.state IN ('pending', 'deferred') AND d.not_before <= clock_timestamp())
            OR (d.state = 'claimed' AND d.lease_expires_at <= clock_timestamp()))
     FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;   -- cancelled, completed or taken meanwhile
    END IF;
    v_reason := private.item_image_deletion_block_reason(r.path);
    IF v_reason IS NULL THEN
      v_token := gen_random_uuid();
      UPDATE private.item_image_deletions d
         SET state = 'claimed', claim_token = v_token, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
             attempts = d.attempts + 1, last_reason = NULL, updated_at = clock_timestamp()
       WHERE d.id = r.id;
      id := r.id; path := r.path; claim_token := v_token;
      RETURN NEXT;
    ELSIF v_reason = 'referenced' THEN
      -- A reference to a CONDEMNED object can only come from a column the
      -- guard does not cover; it is kept (nothing more is sent to Storage)
      -- but flagged for an operator (admin monitoring), since an earlier,
      -- delayed removal may still land.
      UPDATE private.item_image_deletions d
         SET state = 'kept',
             last_reason = CASE WHEN d.attempts > 0 THEN 'referenced_after_claim' ELSE v_reason END,
             claim_token = NULL, lease_expires_at = NULL,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE d.id = r.id;
    ELSE
      UPDATE private.item_image_deletions d
         SET state = 'deferred', last_reason = v_reason, claim_token = NULL, lease_expires_at = NULL,
             not_before = clock_timestamp() + interval '6 hours', updated_at = clock_timestamp()
       WHERE d.id = r.id;
    END IF;
  END LOOP;
END;
$$;

-- Complete: authoritative. 'deleted' only when the object is really gone from
-- storage.objects (whether this attempt or an earlier one removed it).
-- Otherwise retried with backoff (5, 10, 20, 40 min) and 'failed' after 5
-- attempts. A stale or foreign claim token changes nothing.
CREATE FUNCTION public.item_image_deletion_complete(p_id bigint, p_claim_token uuid, p_error_code text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d private.item_image_deletions;
BEGIN
  SELECT * INTO d FROM private.item_image_deletions x
   WHERE x.id = p_id AND x.state = 'claimed' AND x.claim_token = p_claim_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale_claim';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = d.bucket AND o.name = d.path AND NOT COALESCE(o.is_delete_marker, false)) THEN
    UPDATE private.item_image_deletions x
       SET state = 'deleted', claim_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE x.id = d.id;
    RETURN 'deleted';
  END IF;
  IF d.attempts >= 5 THEN
    UPDATE private.item_image_deletions x
       SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
           last_error_code = COALESCE(left(p_error_code, 64), 'still_present'), updated_at = clock_timestamp()
     WHERE x.id = d.id;
    RETURN 'failed';
  END IF;
  UPDATE private.item_image_deletions x
     SET state = 'pending', claim_token = NULL, lease_expires_at = NULL,
         last_error_code = COALESCE(left(p_error_code, 64), 'still_present'),
         not_before = clock_timestamp() + make_interval(mins => 5 * (2 ^ (d.attempts - 1))::integer),
         updated_at = clock_timestamp()
   WHERE x.id = d.id;
  RETURN 'retry';
END;
$$;

-- Dry run (read-only): what the worker would do with the next due entries now.
CREATE FUNCTION public.item_image_deletion_candidates(p_limit integer)
RETURNS TABLE (id bigint, path text, source text, state text, not_before timestamptz, attempts integer, would text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT d.id, d.path, d.source, d.state, d.not_before, d.attempts,
         COALESCE(CASE private.item_image_deletion_block_reason(d.path)
                    WHEN 'referenced' THEN 'keep:referenced'
                    ELSE 'defer:' || private.item_image_deletion_block_reason(d.path) END,
                  'delete')
    FROM private.item_image_deletions d
   WHERE d.state IN ('pending', 'deferred', 'claimed', 'failed')
   ORDER BY d.not_before, d.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

-- Operator recovery: put failed entries back in the queue (re-checked again).
CREATE FUNCTION public.item_image_deletion_retry_failed(p_ids bigint[])
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  UPDATE private.item_image_deletions d
     SET state = 'pending', attempts = 0, not_before = clock_timestamp(), updated_at = clock_timestamp()
   WHERE d.id = ANY (p_ids) AND d.state = 'failed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ── 8. Admin visibility (counts only) ────────────────────────────────────────
CREATE FUNCTION public.admin_item_image_cleanup_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.require_admin();
  -- Read-only. Never returns a storage path, URL or file content: entries are
  -- identified by ledger id, source, the owner's username and (for an item
  -- photo) the item id.
  RETURN jsonb_build_object(
    'enabled', private.item_image_cleanup_enabled(),
    'sweep_active', COALESCE((SELECT j.active FROM cron.job j WHERE j.jobname = 'item-image-cleanup'), false),
    'by_state', (SELECT COALESCE(jsonb_object_agg(s.state, s.n), '{}'::jsonb)
                   FROM (SELECT d.state, count(*) AS n FROM private.item_image_deletions d GROUP BY d.state) s),
    'due', (SELECT count(*) FROM private.item_image_deletions d
             WHERE d.state IN ('pending', 'deferred') AND d.not_before <= clock_timestamp()),
    'failed', (SELECT count(*) FROM private.item_image_deletions d WHERE d.state = 'failed'),
    'retrying', (SELECT count(*) FROM private.item_image_deletions d WHERE d.state = 'pending' AND d.attempts > 0),
    'referenced_after_claim', (SELECT count(*) FROM private.item_image_deletions d WHERE d.last_reason = 'referenced_after_claim'),
    'error_categories', (SELECT COALESCE(jsonb_object_agg(e.code, e.n), '{}'::jsonb)
                           FROM (SELECT d.last_error_code AS code, count(*) AS n FROM private.item_image_deletions d
                                  WHERE d.last_error_code IS NOT NULL AND d.state IN ('pending', 'failed')
                                  GROUP BY d.last_error_code) e),
    'needs_attention', (SELECT COALESCE(jsonb_agg(x ORDER BY x.updated_at DESC), '[]'::jsonb) FROM (
                          SELECT d.id, d.source, d.state, d.attempts, d.last_error_code, d.last_reason, d.updated_at,
                                 p.username AS owner_username,
                                 CASE WHEN split_part(d.path, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                      THEN split_part(d.path, '/', 2)::uuid END AS item_id
                            FROM private.item_image_deletions d
                            LEFT JOIN public.profiles p ON p.id = d.owner_id
                           WHERE d.state = 'failed' OR d.last_reason = 'referenced_after_claim'
                              OR (d.state = 'pending' AND d.attempts > 0)
                           ORDER BY d.updated_at DESC LIMIT 25) x),
    'last_completed_at', (SELECT max(r.finished_at) FROM private.item_image_cleanup_runs r WHERE r.status = 'completed'),
    'last_failed_at', (SELECT max(r.finished_at) FROM private.item_image_cleanup_runs r WHERE r.status IN ('failed', 'abandoned')));
END;
$$;

-- ── 9. Dispatcher + sweep job (job created INACTIVE) ─────────────────────────
CREATE FUNCTION private.run_item_image_cleanup()
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  IF NOT private.item_image_cleanup_enabled() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.item_image_deletions d
                  WHERE (d.state IN ('pending', 'deferred') AND d.not_before <= clock_timestamp())
                     OR (d.state = 'claimed' AND d.lease_expires_at <= clock_timestamp())) THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'item_image_cleanup_worker_secret' LIMIT 1;
  IF v_url IS NULL OR v_url NOT LIKE 'http%' OR v_secret IS NULL OR length(v_secret) < 32 THEN
    RAISE LOG 'item-image-cleanup: project_url / item_image_cleanup_worker_secret not configured in Vault; not dispatched';
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/item-image-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('trigger', 'sweep'),
    timeout_milliseconds := 45000);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'item-image-cleanup: dispatch failed (%)', SQLSTATE;
  RETURN NULL;
END;
$$;

-- ── 10. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.item_image_cleanup_enabled(), private.item_image_path_owner(text),
                       private.item_image_deletion_block_reason(text),
                       private.enqueue_item_image_deletion(text, uuid, text, interval),
                       private.item_image_row_released(), private.folder_cover_released(),
                       private.item_image_deletion_reference_guard(), private.run_item_image_cleanup(),
                       private.item_image_path_condemned(text), private.item_image_owner_being_deleted(uuid),
                       private.item_image_deletions_account_deletion()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_item_upload_cleanup(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.request_item_upload_cleanup(text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.item_image_cleanup_begin(text),
                       public.item_image_cleanup_finish(uuid, text, integer, jsonb, text, integer),
                       public.item_image_deletion_claim(integer, integer),
                       public.item_image_deletion_complete(bigint, uuid, text),
                       public.item_image_deletion_candidates(integer),
                       public.item_image_deletion_retry_failed(bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.item_image_cleanup_begin(text),
                          public.item_image_cleanup_finish(uuid, text, integer, jsonb, text, integer),
                          public.item_image_deletion_claim(integer, integer),
                          public.item_image_deletion_complete(bigint, uuid, text),
                          public.item_image_deletion_candidates(integer),
                          public.item_image_deletion_retry_failed(bigint[])
  TO service_role;
REVOKE ALL ON FUNCTION public.admin_item_image_cleanup_status() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_item_image_cleanup_status() TO authenticated;

-- Activation is a separate, approved operator step (runbook): this job, the
-- switch in section 1 AND the worker secret must all be turned on.
SELECT cron.schedule('item-image-cleanup', '*/10 * * * *', 'SELECT private.run_item_image_cleanup()');
SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'item-image-cleanup';

NOTIFY pgrst, 'reload schema';

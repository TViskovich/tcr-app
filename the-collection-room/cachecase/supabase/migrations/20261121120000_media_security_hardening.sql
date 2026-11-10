-- Phase 2B M2.3d — media security hardening.
--
--   1. Storage write guard: no role — the service role included — may create,
--      overwrite, move or delete an object at a path a live quarantine job
--      holds, except the one worker step that job is in (delete while
--      "verified", write back while "restoring"). Closes the
--      backfill-share-snapshots bypass and every future service-role path.
--   2. backfill_snapshot_check: the historical backfill may not republish
--      restricted content or write to a held destination.
--   3. Snapshot reconciliation: candidates, and a locked re-check-then-claim
--      for removing abandoned or unreferenced ledgered copies (and finishing
--      interrupted staging deletions). Nothing is scheduled.
--   4. Folder covers: a picked cover item must belong to the folder's owner.

-- ── 1. Storage write guard ──────────────────────────────────────────────────
CREATE FUNCTION private.storage_held_write_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  -- Only a database operator acting as themselves (logged in as postgres, no
  -- SET ROLE: SQL editor, migrations) is exempt. This runs as its owner, so
  -- current_user cannot identify the caller; the Storage API logs in as its own
  -- role and switches to the request's role, and every API role is guarded.
  IF session_user = 'postgres' AND current_setting('role') = 'none' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT q.state INTO v_state FROM private.media_quarantine q
     WHERE q.source_bucket = OLD.bucket_id AND q.source_path = OLD.name AND q.state NOT IN ('restored', 'cancelled');
    -- The quarantine worker removes a source only once its copy is verified.
    IF FOUND AND NOT (TG_OP = 'DELETE' AND v_state = 'verified') THEN
      RAISE EXCEPTION 'media_held' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT q.state INTO v_state FROM private.media_quarantine q
     WHERE q.source_bucket = NEW.bucket_id AND q.source_path = NEW.name AND q.state NOT IN ('restored', 'cancelled');
    -- The restore worker writes the original back only while restoring.
    IF FOUND AND NOT (TG_OP = 'INSERT' AND v_state = 'restoring') THEN
      RAISE EXCEPTION 'media_held' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION private.storage_held_write_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER moderation_held_write_guard BEFORE INSERT OR UPDATE OR DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION private.storage_held_write_guard();

-- ── 2. Historical backfill ──────────────────────────────────────────────────
-- Why a backfill row must not be (re)published (NULL = it may). The row is
-- looked up server-side; the URL and destination only identify it.
CREATE FUNCTION public.backfill_snapshot_check(p_table text, p_row_id uuid, p_source_url text, p_dest_base text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_post uuid;
  v_item uuid;
  v_owner uuid;
  v_src text := private.public_object_path(p_source_url, 'item-images');
BEGIN
  IF p_table = 'posts' THEN
    SELECT p.id, p.item_id, p.user_id INTO v_post, v_item, v_owner FROM public.posts p WHERE p.id = p_row_id;
  ELSIF p_table = 'card_share_items' THEN
    SELECT x.post_id, x.item_id, p.user_id INTO v_post, v_item, v_owner
      FROM public.card_share_items x JOIN public.posts p ON p.id = x.post_id WHERE x.id = p_row_id;
  ELSIF p_table = 'rate_my_grail_cards' THEN
    SELECT x.post_id, x.item_id, p.user_id INTO v_post, v_item, v_owner
      FROM public.rate_my_grail_cards x JOIN public.posts p ON p.id = x.post_id WHERE x.id = p_row_id;
  ELSE
    RETURN 'invalid_table';
  END IF;
  IF v_post IS NULL THEN RETURN 'row_missing'; END IF;
  IF private.account_is_hidden(v_owner) THEN RETURN 'owner_unavailable'; END IF;
  IF private.is_moderated('post', v_post) OR (v_item IS NOT NULL AND private.item_restricted(v_item)) THEN RETURN 'restricted'; END IF;
  IF v_src IS NULL THEN RETURN 'invalid_source'; END IF;
  IF private.image_path_moderated(v_src) OR private.storage_path_held('item-images', v_src) THEN RETURN 'restricted'; END IF;
  IF p_dest_base IS NULL OR split_part(p_dest_base, '/', 1) <> v_owner::text THEN RETURN 'invalid_destination'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['jpg', 'png', 'webp', 'heic', 'heif']) e
              WHERE private.storage_path_held('share-snapshots', p_dest_base || '.' || e)) THEN
    RETURN 'destination_held';
  END IF;
  RETURN NULL;
END;
$$;

-- ── 3. Snapshot reconciliation ──────────────────────────────────────────────
-- True when anything still links to this share-snapshots object.
CREATE FUNCTION private.share_snapshot_path_referenced(p_path text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH s AS (SELECT '/storage/v1/object/public/share-snapshots/' || p_path AS suffix)
  SELECT p_path IS NULL
      OR EXISTS (SELECT 1 FROM s, public.posts p
                 WHERE right(p.image_url, length(s.suffix)) = s.suffix
                    OR right(p.folder_cover_snapshot_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.post_images x WHERE right(x.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.card_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.folder_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.rate_my_grail_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.profiles x
                 WHERE right(x.avatar_url, length(s.suffix)) = s.suffix OR right(x.hero_image_url, length(s.suffix)) = s.suffix
                    OR right(x.showcase_badge_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.registered_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM public.content_reports r
                 WHERE jsonb_path_exists(r.evidence, '$.** ? (@.bucket == "share-snapshots" && @.path == $p)', jsonb_build_object('p', p_path)))
      OR EXISTS (SELECT 1 FROM public.account_export_entries e WHERE e.source_bucket = 'share-snapshots' AND e.source_path = p_path);
$$;

-- What reconciliation may act on, never younger than the grace period:
--   abandoned      reserved and never published (the request died)
--   rejected       refused at publication, object not yet removed
--   discarded      discarded, removal not yet confirmed
--   unreferenced   published, but no row links to it (a failed client post)
--   staging        a post-photo staging source still marked "deleting"
CREATE FUNCTION private.share_snapshot_reconcile_reason(c private.share_snapshot_copies, p_grace interval)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN c.updated_at > now() - p_grace OR c.created_at > now() - p_grace THEN NULL
    WHEN c.status = 'reserved' THEN 'abandoned'
    WHEN c.status = 'rejected' THEN 'rejected'
    WHEN c.status = 'discarded' THEN 'discarded'
    WHEN c.status = 'published' AND c.kind = 'post_photo' AND c.source_state = 'deleting'
         AND NOT private.item_images_path_protected(c.source_path) THEN 'staging'
    WHEN c.status = 'published' AND NOT private.share_snapshot_path_referenced(c.dest_path)
         AND NOT private.storage_path_held('share-snapshots', c.dest_path) THEN 'unreferenced'
  END;
$$;

CREATE FUNCTION public.share_snapshot_reconcile_candidates(p_grace_hours integer, p_limit integer)
RETURNS TABLE (copy_id uuid, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_grace_hours IS NULL OR p_grace_hours < 24 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT x.id, x.r FROM (
    SELECT c.id, private.share_snapshot_reconcile_reason(c, make_interval(hours => p_grace_hours)) AS r
      FROM private.share_snapshot_copies c
     WHERE c.status IN ('reserved', 'rejected', 'discarded', 'published')
     ORDER BY c.created_at) x
  WHERE x.r IS NOT NULL
  LIMIT p_limit;
END;
$$;

-- Re-checks ONE candidate under its per-path lock (the same lock every new
-- reference takes) and, if it still qualifies, claims it: the copy becomes
-- "discarded" (no new reference can attach), and the exact objects to remove
-- are returned. A staging source is returned for deletion only if still
-- unreferenced. Returns {ok:false, reason} when the candidate no longer
-- qualifies — the caller then removes nothing.
CREATE FUNCTION public.share_snapshot_reconcile_claim(p_copy_id uuid, p_grace_hours integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c private.share_snapshot_copies;
  v_reason text;
BEGIN
  IF p_grace_hours IS NULL OR p_grace_hours < 24 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM private.share_snapshot_copies x WHERE x.id = p_copy_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('share-snapshots-path:' || COALESCE(c.dest_path, c.dest_base), 0));
  IF c.kind = 'post_photo' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('item-images-path:' || c.source_path, 0));
  END IF;
  SELECT * INTO c FROM private.share_snapshot_copies x WHERE x.id = p_copy_id FOR UPDATE;
  v_reason := private.share_snapshot_reconcile_reason(c, make_interval(hours => p_grace_hours));
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible'); END IF;

  IF v_reason = 'staging' THEN
    RETURN jsonb_build_object('ok', true, 'reason', v_reason, 'bucket', 'item-images', 'paths', jsonb_build_array(c.source_path));
  END IF;
  IF c.dest_path IS NOT NULL AND private.storage_path_held('share-snapshots', c.dest_path) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'held');
  END IF;
  UPDATE private.share_snapshot_copies SET status = 'discarded', updated_at = now() WHERE id = c.id AND status <> 'discarded';
  RETURN jsonb_build_object('ok', true, 'reason', v_reason, 'bucket', 'share-snapshots', 'paths',
    CASE WHEN c.dest_path IS NOT NULL THEN jsonb_build_array(c.dest_path)
         ELSE (SELECT jsonb_agg(c.dest_base || '.' || e) FROM unnest(ARRAY['jpg', 'png', 'webp', 'heic', 'heif']) e) END);
END;
$$;

-- Older share-snapshots objects outside the ledger that nothing references,
-- reported (counted) for an operator — never deleted automatically: without
-- a ledger row there is no operation that provably created them.
CREATE FUNCTION public.share_snapshot_unledgered_orphans(p_grace_hours integer)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT count(*)::integer FROM storage.objects o
   WHERE p_grace_hours >= 24 AND o.bucket_id = 'share-snapshots' AND o.created_at < now() - make_interval(hours => p_grace_hours)
     AND NOT EXISTS (SELECT 1 FROM private.share_snapshot_copies c WHERE c.dest_path = o.name)
     AND NOT private.storage_path_held('share-snapshots', o.name)
     AND NOT private.share_snapshot_path_referenced(o.name);
$$;

-- New references to a reconciled snapshot are refused (copied from
-- 20261119120000, plus the share-snapshots lock and ledger check).
CREATE OR REPLACE FUNCTION private.reject_held_media_reference()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_arg text;
  v_col text;
  v_mode text;
  v_new text;
  v_old text;
  v_path text;
BEGIN
  IF current_user = 'postgres' AND current_setting('cachecase.profile_moderation_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  FOREACH v_arg IN ARRAY TG_ARGV LOOP
    v_mode := split_part(v_arg, ':', 1);
    v_col := split_part(v_arg, ':', 2);
    v_new := to_jsonb(NEW) ->> v_col;
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> v_col END;
    IF v_new IS NULL OR v_new IS NOT DISTINCT FROM v_old THEN CONTINUE; END IF;
    IF v_mode = 'url' THEN
      -- 20261121120000: a share snapshot being reconciled (discarded or
      -- removed by its ledger) cannot gain a new reference; the per-path lock
      -- serializes this check with the reconciliation re-check.
      v_path := private.public_object_path(v_new, 'share-snapshots');
      IF v_path IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('share-snapshots-path:' || v_path, 0));
        IF EXISTS (SELECT 1 FROM private.share_snapshot_copies c
                    WHERE c.dest_path = v_path AND c.status IN ('discarded', 'removed')) THEN
          RAISE EXCEPTION 'content_unavailable' USING ERRCODE = '42501';
        END IF;
      END IF;
      IF private.storage_path_held('avatars', private.public_object_path(v_new, 'avatars'))
         OR private.storage_path_held('share-snapshots', private.public_object_path(v_new, 'share-snapshots'))
         OR private.storage_path_held('item-images', private.public_object_path(v_new, 'item-images')) THEN
        RAISE EXCEPTION 'content_unavailable' USING ERRCODE = '42501';
      END IF;
    ELSE -- 'path': an item-images object path
      PERFORM pg_advisory_xact_lock(hashtextextended('item-images-path:' || v_new, 0));
      IF private.storage_path_held('item-images', v_new) OR EXISTS (
           SELECT 1 FROM private.share_snapshot_copies c
            WHERE c.kind = 'post_photo' AND c.source_path = v_new AND c.source_state = 'deleting') THEN
        RAISE EXCEPTION 'content_unavailable' USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


-- ── 4. Folder covers ────────────────────────────────────────────────────────
-- A picked cover item must be one of the folder owner's own items. The item
-- row is locked (FOR SHARE) so its owner cannot change concurrently.
CREATE FUNCTION private.folder_cover_item_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF NEW.cover_item_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.cover_item_id IS NOT DISTINCT FROM OLD.cover_item_id AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id) THEN
    RETURN NEW;
  END IF;
  SELECT ci.user_id INTO v_owner FROM public.collection_items ci WHERE ci.id = NEW.cover_item_id FOR SHARE;
  IF v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'invalid_cover_item' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.folder_cover_item_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER folder_cover_item_guard BEFORE INSERT OR UPDATE OF cover_item_id, user_id ON public.folders
  FOR EACH ROW EXECUTE FUNCTION private.folder_cover_item_guard();

-- ── 5. Poison jobs (copied from 20261120120000, plus the exhaustion check) ──
CREATE FUNCTION private.media_quarantine_flag_exhausted()
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH f AS (
    UPDATE private.media_quarantine q
       SET needs_attention = true, last_error = 'attempts_exhausted', lease_token = NULL, lease_expires_at = NULL
     WHERE NOT q.needs_attention AND q.attempts >= private.media_quarantine_max_attempts()
       AND q.state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring')
       AND (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
    RETURNING q.id, q.state, q.attempts)
  INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, detail)
  SELECT f.id, 'needs_attention', f.state, f.state, jsonb_build_object('error', 'attempts_exhausted', 'attempt', f.attempts) FROM f;
$$;
REVOKE ALL ON FUNCTION private.media_quarantine_flag_exhausted() FROM PUBLIC, anon, authenticated, service_role;

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
  -- 20261121120000: a job that used its whole attempt budget without
  -- completing (a worker that keeps dying on it — e.g. out of memory — never
  -- records an error) is flagged for an admin instead of being claimed again,
  -- so one poison job cannot stall the queue.
  PERFORM private.media_quarantine_flag_exhausted();
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

CREATE OR REPLACE FUNCTION public.media_quarantine_claim_restore(p_job_ids uuid[], p_lease_seconds integer)
RETURNS TABLE (id uuid, state text, desired text, source_bucket text, source_path text, quarantine_bucket text,
               quarantine_path text, owner_id uuid, size_bytes bigint, source_sha256 text, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_job_ids IS NULL OR cardinality(p_job_ids) NOT BETWEEN 1 AND 10 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  -- 20261121120000: a job that used its whole attempt budget without
  -- completing (a worker that keeps dying on it — e.g. out of memory — never
  -- records an error) is flagged for an admin instead of being claimed again,
  -- so one poison job cannot stall the queue.
  PERFORM private.media_quarantine_flag_exhausted();
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


-- media_quarantine_inspect reads clock_timestamp() for its lease check, so it
-- is volatile, not stable (database linter finding).
ALTER FUNCTION public.media_quarantine_inspect(uuid, uuid) VOLATILE;

-- ── Privileges ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION private.share_snapshot_path_referenced(text),
  private.share_snapshot_reconcile_reason(private.share_snapshot_copies, interval) FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.backfill_snapshot_check(text, uuid, text, text)',
    'public.share_snapshot_reconcile_candidates(integer, integer)',
    'public.share_snapshot_reconcile_claim(uuid, integer)',
    'public.share_snapshot_unledgered_orphans(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

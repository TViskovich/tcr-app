-- ============================================================================
-- Permanent account deletion — Dashboard Milestone 2, Checkpoint 4.
--
-- Builds on account_lifecycle (20261103120000): a collector reaches
-- 'deleting' (Delete Now, or the scheduler when the 14-day window ends) and
-- from then on can't cancel. The account-maintenance Edge Function then
-- runs a deletion JOB in stages:
--   queued → cleaning_storage (durable manifest of every file to remove,
--   removed through the Storage API in retried batches) → deleting_account
--   (auth.admin.deleteUser — the BEFORE DELETE trigger below applies the
--   retention policy atomically with the deletion) → completed.
--   Repeated failures → failed (admin-only indicator + server logs).
-- A job is reported completed only after both stages have succeeded.
--
-- Approved retention policy, applied by private.finalize_account_deletion
-- in the same transaction as the auth user's deletion:
--   * Everything the collector owns goes with their profile (existing
--     ON DELETE CASCADE): collections, items, photos rows, Grails, posts,
--     comments, likes, saves, follows, tags, notifications, their
--     authored messages, lifecycle row, export jobs.
--   * Copies of their photos/collectible details inside OTHER collectors'
--     shared-item posts are removed (the other post, its text and its
--     unrelated attachments stay; the app shows "unavailable").
--   * Registry (unreleased): cards they currently own become
--     owner_account_deleted + private, registry photos removed; cards
--     already transferred to someone else are untouched; registry and
--     ownership event history keeps its rows with their identity removed
--     (existing ON DELETE SET NULL).
--   * Transfers (unreleased): the other participant keeps their history
--     (FKs become SET NULL); pending transfers either way are cancelled
--     with closed_reason 'account_deleted' — no ownership change, no
--     notification.
--   * Waitlist rows for the account (linked or same email) are deleted.
--   * Direct conversations: survivors keep their own messages; the
--     conversation becomes read-only (no new messages into a direct
--     conversation with fewer than two participants).
--   * The username is reserved for 90 days as a keyed HMAC (the key is a
--     Vault secret, 'username_reservation_key'); the username itself isn't
--     stored.
--   * Job metadata (no email, no username) is kept 30 days after
--     completion (production backups are kept 7 days), then the user id
--     and file manifest are purged.
-- ============================================================================

-- ── Transfers: keep the other participant's history ────────────────────────
ALTER TABLE public.ownership_transfers
  ALTER COLUMN from_owner_id DROP NOT NULL,
  ALTER COLUMN to_owner_id DROP NOT NULL,
  DROP CONSTRAINT ownership_transfers_from_owner_id_fkey,
  DROP CONSTRAINT ownership_transfers_to_owner_id_fkey,
  ADD CONSTRAINT ownership_transfers_from_owner_id_fkey
    FOREIGN KEY (from_owner_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT ownership_transfers_to_owner_id_fkey
    FOREIGN KEY (to_owner_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN closed_reason text
    CONSTRAINT ownership_transfers_closed_reason_check CHECK (closed_reason IS NULL OR closed_reason = 'account_deleted');

-- ── Item posts can lose their copied photo ─────────────────────────────────
-- An item post must carry a photo while it points at an item; once the item
-- is gone (deleted account), the copied photo is removed too.
DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint
  WHERE conrelid = 'public.posts'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) = 'CHECK (((post_type <> ''item''::text) OR (image_url IS NOT NULL)))';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'expected item-post image constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE public.posts DROP CONSTRAINT %I', v_name);
END;
$$;
ALTER TABLE public.posts ADD CONSTRAINT posts_item_image_check
  CHECK (post_type <> 'item' OR image_url IS NOT NULL OR item_id IS NULL);

-- ── Deletion jobs and their file manifest (server only) ────────────────────
CREATE TABLE public.account_deletion_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,                         -- no FK: outlives the account; purged after 30 days
  mode            text NOT NULL CHECK (mode IN ('scheduled', 'immediate')),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'cleaning_storage', 'deleting_account', 'completed', 'failed')),
  runs            integer NOT NULL DEFAULT 0,   -- times a worker claimed it
  step_failures   integer NOT NULL DEFAULT 0,   -- consecutive failed runs
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  objects_total   integer,
  objects_deleted integer NOT NULL DEFAULT 0,
  last_error_code text,                         -- controlled codes only
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  failed_at       timestamptz,
  purge_after     timestamptz,
  CONSTRAINT account_deletion_jobs_completed_shape CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND purge_after IS NOT NULL))
);
-- One open job per account (a failed job stays open until resolved).
CREATE UNIQUE INDEX account_deletion_jobs_one_open ON public.account_deletion_jobs (user_id)
  WHERE status IN ('queued', 'cleaning_storage', 'deleting_account', 'failed');
CREATE INDEX account_deletion_jobs_due ON public.account_deletion_jobs (next_attempt_at)
  WHERE status IN ('queued', 'cleaning_storage', 'deleting_account');
CREATE INDEX account_deletion_jobs_purge ON public.account_deletion_jobs (purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE public.account_deletion_storage_queue (
  job_id          uuid NOT NULL REFERENCES public.account_deletion_jobs (id) ON DELETE CASCADE,
  bucket          text NOT NULL,
  path            text NOT NULL,
  deleted_at      timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error_code text,
  PRIMARY KEY (job_id, bucket, path)
);
CREATE INDEX account_deletion_storage_pending ON public.account_deletion_storage_queue (job_id) WHERE deleted_at IS NULL;

ALTER TABLE public.account_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_storage_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_jobs, public.account_deletion_storage_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_deletion_jobs, public.account_deletion_storage_queue TO service_role;
CREATE POLICY account_lifecycle_read_guard ON public.account_deletion_jobs AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE POLICY account_lifecycle_read_guard ON public.account_deletion_storage_queue AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_deletion_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_deletion_storage_queue
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- ── Username reservations: keyed HMAC, 90 days ─────────────────────────────
CREATE TABLE private.username_reservations (
  username_hmac  bytea PRIMARY KEY,
  reserved_until timestamptz NOT NULL
);
REVOKE ALL ON private.username_reservations FROM PUBLIC, anon, authenticated;

-- HMAC-SHA256 of the lowercased username with the Vault secret
-- 'username_reservation_key'. NULL when the key isn't configured.
CREATE FUNCTION private.username_hmac(p_username text)
RETURNS bytea
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'username_reservation_key' LIMIT 1;
  IF v_key IS NULL OR length(v_key) < 32 THEN
    RETURN NULL;
  END IF;
  RETURN extensions.hmac(lower(btrim(p_username)), v_key, 'sha256');
END;
$$;
REVOKE ALL ON FUNCTION private.username_hmac(text) FROM PUBLIC, anon, authenticated;

-- New profiles can't take a reserved username. Without a configured key no
-- reservation can exist (creating one requires it), so sign-up stays open.
CREATE FUNCTION private.reject_reserved_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hmac bytea;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.username_reservations WHERE reserved_until > now()) THEN
    RETURN NEW;
  END IF;
  v_hmac := private.username_hmac(NEW.username);
  IF v_hmac IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.username_reservations r WHERE r.username_hmac = v_hmac AND r.reserved_until > now()
  ) THEN
    RAISE EXCEPTION 'username_reserved' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_reserved_username BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.reject_reserved_username();

-- Sign-up can ask before creating the account (the app shows the reason).
CREATE FUNCTION public.username_is_reserved(p_username text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.username_reservations r
    WHERE r.username_hmac = private.username_hmac(p_username) AND r.reserved_until > now()
  );
$$;
REVOKE ALL ON FUNCTION public.username_is_reserved(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.username_is_reserved(text) TO anon, authenticated, service_role;

-- ── Read-only conversations ────────────────────────────────────────────────
-- A direct conversation that has lost a participant (deleted account)
-- takes no new messages. Groups (dormant feature) are not affected.
CREATE FUNCTION private.reject_message_to_closed_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT COALESCE(to_jsonb(c) ->> 'kind', 'direct') INTO v_kind FROM public.conversations c WHERE c.id = NEW.conversation_id;
  IF v_kind = 'direct'
     AND (SELECT count(*) FROM public.conversation_participants p WHERE p.conversation_id = NEW.conversation_id) < 2 THEN
    RAISE EXCEPTION 'conversation_closed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_closed_guard BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.reject_message_to_closed_conversation();

-- ── The retention policy, atomic with the auth user's deletion ────────────
CREATE FUNCTION private.finalize_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := OLD.id;
  v_via_lifecycle boolean;
  v_hmac bytea;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = v_user AND state = 'deleting') INTO v_via_lifecycle;

  -- Registry (unreleased): cards the collector still owns.
  DELETE FROM public.card_images
  WHERE registered_card_id IN (SELECT id FROM public.registered_cards WHERE current_owner_id = v_user);
  UPDATE public.registered_cards
  SET status = 'owner_account_deleted',
      visibility = 'private',
      snapshot_image_url = NULL,
      snapshot_image_storage_path = NULL,
      snapshot_image_status = CASE WHEN snapshot_image_status IS NULL THEN NULL ELSE 'unavailable' END,
      snapshot_image_error_code = NULL,
      updated_at = now()
  WHERE current_owner_id = v_user;

  -- Transfers (unreleased): pending either way are cancelled, quietly.
  UPDATE public.ownership_transfers
  SET status = 'cancelled', resolved_at = now(), closed_reason = 'account_deleted'
  WHERE status = 'pending' AND v_user IN (from_owner_id, to_owner_id);

  -- Copies of the collector's items inside OTHER collectors' posts.
  DELETE FROM public.card_share_items s
  USING public.collection_items ci, public.posts p
  WHERE s.item_id = ci.id AND ci.user_id = v_user AND p.id = s.post_id AND p.user_id <> v_user;
  DELETE FROM public.folder_share_items s
  USING public.collection_items ci, public.posts p
  WHERE s.item_id = ci.id AND ci.user_id = v_user AND p.id = s.post_id AND p.user_id <> v_user;
  DELETE FROM public.rate_my_grail_cards s
  USING public.collection_items ci, public.posts p
  WHERE s.item_id = ci.id AND ci.user_id = v_user AND p.id = s.post_id AND p.user_id <> v_user;
  DELETE FROM public.post_images s
  USING public.collection_items ci, public.posts p
  WHERE s.item_id = ci.id AND ci.user_id = v_user AND p.id = s.post_id AND p.user_id <> v_user;
  UPDATE public.posts p
  SET image_url = NULL, item_id = NULL
  FROM public.collection_items ci
  WHERE p.item_id = ci.id AND ci.user_id = v_user AND p.user_id <> v_user AND p.post_type = 'item';
  UPDATE public.posts p
  SET folder_id = NULL, folder_name = NULL, folder_cover_snapshot_url = NULL, folder_item_count = 0
  FROM public.folders f
  WHERE p.folder_id = f.id AND f.user_id = v_user AND p.user_id <> v_user AND p.post_type = 'folder_share';

  -- Waitlist records for the account.
  DELETE FROM public.waitlist_signups
  WHERE onboarded_user_id = v_user OR (OLD.email IS NOT NULL AND lower(email) = lower(OLD.email));

  -- Username reservation (only for real account deletions, not e.g. an
  -- aborted sign-up being rolled back).
  IF v_via_lifecycle THEN
    SELECT private.username_hmac(p.username) INTO v_hmac FROM public.profiles p WHERE p.id = v_user;
    IF v_hmac IS NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user) THEN
      RAISE EXCEPTION 'username_reservation_key_missing' USING ERRCODE = 'P0001';
    END IF;
    IF v_hmac IS NOT NULL THEN
      INSERT INTO private.username_reservations (username_hmac, reserved_until)
      VALUES (v_hmac, now() + interval '90 days')
      ON CONFLICT (username_hmac) DO UPDATE SET reserved_until = GREATEST(private.username_reservations.reserved_until, EXCLUDED.reserved_until);
    END IF;
  END IF;

  RETURN OLD;
END;
$$;
CREATE TRIGGER account_final_deletion BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.finalize_account_deletion();

-- ── Worker functions (service role only) ───────────────────────────────────

-- Starts (or returns) the deletion job: the account moves to 'deleting'
-- first, so cancellation is impossible from here on.
CREATE FUNCTION public.account_deletion_start(p_user_id uuid, p_mode text)
RETURNS public.account_deletion_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.account_deletion_jobs;
BEGIN
  PERFORM public.begin_account_deletion(p_user_id, p_mode);
  SELECT * INTO v_job FROM public.account_deletion_jobs
  WHERE user_id = p_user_id AND status IN ('queued', 'cleaning_storage', 'deleting_account', 'failed');
  IF FOUND THEN
    RETURN v_job;
  END IF;
  INSERT INTO public.account_deletion_jobs (user_id, mode) VALUES (p_user_id, p_mode) RETURNING * INTO v_job;
  RETURN v_job;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_job FROM public.account_deletion_jobs
  WHERE user_id = p_user_id AND status IN ('queued', 'cleaning_storage', 'deleting_account', 'failed');
  RETURN v_job;
END;
$$;

-- Accounts whose recovery window has ended → deleting + a queued job.
CREATE FUNCTION public.account_deletion_enqueue_due(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_count integer := 0;
BEGIN
  FOR v_user IN SELECT * FROM public.list_due_account_deletions(p_limit) LOOP
    PERFORM public.account_deletion_start(v_user, 'scheduled');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Atomically claims due jobs for one worker run (concurrent workers never
-- get the same job). Only accounts that are really in 'deleting' qualify —
-- a cancelled account has no lifecycle row and is never processed.
CREATE FUNCTION public.account_deletion_claim(p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.account_deletion_jobs
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.account_deletion_jobs j
  SET lease_until = now() + make_interval(secs => p_lease_seconds), runs = runs + 1, updated_at = now()
  WHERE j.id IN (
    SELECT c.id FROM public.account_deletion_jobs c
    WHERE c.status IN ('queued', 'cleaning_storage', 'deleting_account')
      AND c.next_attempt_at <= now()
      AND (c.lease_until IS NULL OR c.lease_until < now())
      AND (
        c.status = 'deleting_account' -- the auth user may already be gone
        OR EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = c.user_id AND l.state = 'deleting')
      )
    ORDER BY c.created_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
$$;

-- Writes the job's durable file manifest from what is actually in Storage
-- (idempotent; re-run before the account is deleted to catch late files).
--   own folders:   avatars, item-images, share-snapshots, account-exports
--   dm-attachments uploaded by the collector or attached to their messages
--   registry photos of cards they currently own
--   copies of their items/collections in OTHER collectors' posts
CREATE FUNCTION public.account_deletion_build_manifest(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_total integer;
BEGIN
  SELECT user_id INTO v_user FROM public.account_deletion_jobs WHERE id = p_job_id;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  WITH foreign_refs AS (
    SELECT s.snapshot_image_url AS url FROM public.card_share_items s
      JOIN public.collection_items ci ON ci.id = s.item_id JOIN public.posts p ON p.id = s.post_id
      WHERE ci.user_id = v_user AND p.user_id <> v_user
    UNION ALL SELECT s.snapshot_image_url FROM public.folder_share_items s
      JOIN public.collection_items ci ON ci.id = s.item_id JOIN public.posts p ON p.id = s.post_id
      WHERE ci.user_id = v_user AND p.user_id <> v_user
    UNION ALL SELECT s.snapshot_image_url FROM public.rate_my_grail_cards s
      JOIN public.collection_items ci ON ci.id = s.item_id JOIN public.posts p ON p.id = s.post_id
      WHERE ci.user_id = v_user AND p.user_id <> v_user
    UNION ALL SELECT s.image_url FROM public.post_images s
      JOIN public.collection_items ci ON ci.id = s.item_id JOIN public.posts p ON p.id = s.post_id
      WHERE ci.user_id = v_user AND p.user_id <> v_user
    UNION ALL SELECT p.image_url FROM public.posts p
      JOIN public.collection_items ci ON ci.id = p.item_id
      WHERE ci.user_id = v_user AND p.user_id <> v_user AND p.post_type = 'item'
    UNION ALL SELECT p.folder_cover_snapshot_url FROM public.posts p
      JOIN public.folders f ON f.id = p.folder_id
      WHERE f.user_id = v_user AND p.user_id <> v_user AND p.post_type = 'folder_share'
  ),
  foreign_paths AS (
    SELECT DISTINCT substring(url FROM '/share-snapshots/([^?]+)') AS name FROM foreign_refs WHERE url IS NOT NULL
  )
  INSERT INTO public.account_deletion_storage_queue (job_id, bucket, path)
  SELECT p_job_id, o.bucket_id, o.name
  FROM storage.objects o
  WHERE (o.bucket_id IN ('avatars', 'item-images', 'share-snapshots', 'account-exports') AND o.name LIKE v_user::text || '/%')
     OR (o.bucket_id = 'dm-attachments' AND (
           o.owner = v_user OR o.owner_id = v_user::text
           OR o.name IN (SELECT m.attachment_storage_path FROM public.messages m WHERE m.sender_id = v_user AND m.attachment_storage_path IS NOT NULL)))
     OR (o.bucket_id = 'registry-images' AND split_part(o.name, '/', 1) IN (
           SELECT rc.id::text FROM public.registered_cards rc WHERE rc.current_owner_id = v_user))
     OR (o.bucket_id = 'share-snapshots' AND o.name IN (SELECT name FROM foreign_paths WHERE name IS NOT NULL))
  ON CONFLICT (job_id, bucket, path) DO NOTHING;

  SELECT count(*) INTO v_total FROM public.account_deletion_storage_queue WHERE job_id = p_job_id;
  UPDATE public.account_deletion_jobs SET objects_total = v_total, updated_at = now() WHERE id = p_job_id;
  RETURN v_total;
END;
$$;

-- Housekeeping: purge job identity and manifests 30 days after completion,
-- and drop expired username reservations.
CREATE FUNCTION public.account_deletion_housekeeping()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jobs integer;
  v_reservations integer;
BEGIN
  DELETE FROM public.account_deletion_storage_queue q
  USING public.account_deletion_jobs j
  WHERE q.job_id = j.id AND j.status = 'completed' AND j.purge_after <= now();
  UPDATE public.account_deletion_jobs SET user_id = NULL, updated_at = now()
  WHERE status = 'completed' AND purge_after <= now() AND user_id IS NOT NULL;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  DELETE FROM private.username_reservations WHERE reserved_until <= now();
  GET DIAGNOSTICS v_reservations = ROW_COUNT;
  RETURN jsonb_build_object('jobs_purged', v_jobs, 'reservations_expired', v_reservations);
END;
$$;

-- Admin-only indicator: how many deletions need attention (no identities).
CREATE FUNCTION public.account_deletion_admin_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'failed', (SELECT count(*) FROM public.account_deletion_jobs WHERE status = 'failed'),
    'in_progress', (SELECT count(*) FROM public.account_deletion_jobs WHERE status IN ('queued', 'cleaning_storage', 'deleting_account')),
    'oldest_failed_at', (SELECT min(failed_at) FROM public.account_deletion_jobs WHERE status = 'failed'),
    'failure_codes', (SELECT COALESCE(jsonb_object_agg(code, n), '{}'::jsonb) FROM (
      SELECT COALESCE(last_error_code, 'unknown') AS code, count(*) AS n
      FROM public.account_deletion_jobs WHERE status = 'failed' GROUP BY 1) t)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_start(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_enqueue_due(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_claim(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_build_manifest(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_housekeeping() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_deletion_admin_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_deletion_start(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_enqueue_due(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_claim(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_build_manifest(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_housekeeping() TO service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_admin_summary() TO authenticated, service_role;

-- Phase 2B M2.3b — private media quarantine foundation.
--
-- Builds the database and Storage side of reversible media quarantine and
-- QUEUES the work; nothing here copies, moves, deletes or restores a file. The
-- M2.3c worker will perform the Storage steps through the service-role job
-- contract defined below.
--
--   1. A private moderation-quarantine bucket no API role but the service role
--      can touch.
--   2. private.media_quarantine (one job per source object),
--      private.media_quarantine_holds (many restrictions may hold one file),
--      private.media_quarantine_events (append-only history).
--   3. Queueing: triggers on moderated_content and moderated_profile_fields
--      derive the files from trusted records and queue them in the SAME
--      transaction as the moderation decision (hide, remove, child-safety
--      upgrade, profile-field clear); lifting a restriction or restoring or
--      releasing a field ends its holds in the same transaction.
--   4. Storage guards: collectors cannot delete, overwrite, move or re-upload a
--      held path; child-safety-held files are unreadable to collectors and are
--      no longer signed or exported for anyone, owners included; account
--      deletion and the service-role cleanup paths skip held files, so
--      evidence survives the reported collector deleting their account.
--   5. Reference guards: no new link to a held file.
--   6. Staging-upload reservation: closes the M2.3a race between "this staging
--      upload is unreferenced, delete it" and a new reference to it.
--   7. Compatibility: M2.2 profile restore recognises an original preserved by
--      quarantine.
--
-- Lock order (matches M2.1/M2.2): reports → moderation advisory lock →
-- content rows → media path advisory lock → quarantine job rows.

-- ── 1. Bucket ───────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('moderation-quarantine', 'moderation-quarantine', false)
ON CONFLICT (id) DO NOTHING;

-- Restrictive and FOR ALL: even if a permissive policy is ever added for this
-- bucket, anon and authenticated can never list, read, upload, overwrite,
-- move into or delete from it. (The service role bypasses RLS.)
CREATE POLICY moderation_quarantine_deny ON storage.objects AS RESTRICTIVE FOR ALL TO public
  USING (bucket_id <> 'moderation-quarantine')
  WITH CHECK (bucket_id <> 'moderation-quarantine');

-- ── 2. Tables ───────────────────────────────────────────────────────────────
-- States (see private.media_quarantine_guard for the allowed transitions):
--   pending          queued; the source object exists and is untouched
--   copied           worker copied it into the quarantine bucket
--   verified         worker re-read the copy; size and SHA-256 match
--   quarantined      worker removed the source (only after verified)
--   source_missing   the source was already gone; the path stays reserved
--   restore_pending  every hold ended with "restore"; awaiting the worker
--   restoring        worker is copying it back
--   restored         back at its original path (terminal)
--   cancelled        no longer needed before anything was quarantined, or the
--                    worker removed an unneeded copy (terminal)
--   failed           needs attention (attempts exhausted); resumable
-- `desired` is what the holds currently want: quarantine | restore | retain.
CREATE TABLE private.media_quarantine (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_bucket    text NOT NULL CHECK (source_bucket IN ('avatars', 'share-snapshots', 'item-images', 'dm-attachments')),
  source_path      text NOT NULL CHECK (source_path ~ '^[^/\\]+(/[^/\\]+)+$' AND source_path NOT LIKE '%..%'),
  owner_id         uuid NOT NULL,           -- verified owner; no FK so evidence survives account deletion
  media_kind       text NOT NULL CHECK (media_kind IN ('avatar', 'hero_image', 'showcase_badge', 'share_snapshot',
                                                       'item_image', 'folder_cover', 'dm_photo')),
  origin_target_type text NOT NULL,         -- the moderation target that first queued it
  origin_target_id uuid NOT NULL,
  mime_type        text,
  size_bytes       bigint,
  source_sha256    text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  quarantine_sha256 text CHECK (quarantine_sha256 ~ '^[0-9a-f]{64}$'),
  quarantine_bucket text NOT NULL DEFAULT 'moderation-quarantine' CHECK (quarantine_bucket = 'moderation-quarantine'),
  quarantine_path  text NOT NULL UNIQUE,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'copied', 'verified', 'quarantined', 'source_missing',
                                                                    'restore_pending', 'restoring', 'restored', 'cancelled', 'failed')),
  desired          text NOT NULL DEFAULT 'quarantine' CHECK (desired IN ('quarantine', 'restore', 'retain')),
  child_safety     boolean NOT NULL DEFAULT false,
  legal_hold       boolean NOT NULL DEFAULT false,
  retain_until     timestamptz,             -- set when the last hold ends with "retain"; purge is M4
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token      uuid,
  lease_expires_at timestamptz,
  next_attempt_at  timestamptz,
  last_error       text CHECK (last_error ~ '^[a-z_]{1,64}$'),
  source_removed_at timestamptz,
  quarantined_at   timestamptz,
  restored_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_quarantine_lease_shape CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT media_quarantine_child_safety_hold CHECK (NOT child_safety OR legal_hold),
  CONSTRAINT media_quarantine_verified_shape CHECK (
    state NOT IN ('verified', 'quarantined', 'restore_pending', 'restoring', 'restored')
    OR (source_sha256 IS NOT NULL AND quarantine_sha256 = source_sha256)),
  CONSTRAINT media_quarantine_removed_shape CHECK (
    state NOT IN ('quarantined', 'restore_pending', 'restoring', 'restored') OR source_removed_at IS NOT NULL)
);
-- One live job per source object (terminal jobs may repeat).
CREATE UNIQUE INDEX media_quarantine_one_live ON private.media_quarantine (source_bucket, source_path)
  WHERE state NOT IN ('restored', 'cancelled');
CREATE INDEX media_quarantine_work_idx ON private.media_quarantine (state, next_attempt_at)
  WHERE state IN ('pending', 'copied', 'verified', 'restore_pending', 'restoring', 'failed');
CREATE INDEX media_quarantine_owner_idx ON private.media_quarantine (owner_id);

CREATE TABLE private.media_quarantine_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarantine_id    uuid NOT NULL REFERENCES private.media_quarantine (id) ON DELETE RESTRICT,
  moderation_id    uuid NOT NULL REFERENCES public.moderated_content (id) ON DELETE RESTRICT,
  -- the M2.2 field restriction, when the hold comes from one. Deliberately no
  -- FK: the field row is deleted with the collector's account, while the hold
  -- (and the evidence it protects) must stay exactly as it is.
  profile_field_id uuid,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at         timestamptz,
  end_disposition  text CHECK (end_disposition IN ('restore', 'retain')),
  CONSTRAINT media_quarantine_holds_end_shape CHECK ((ended_at IS NULL) = (end_disposition IS NULL))
);
CREATE UNIQUE INDEX media_quarantine_holds_one_active ON private.media_quarantine_holds
  (quarantine_id, moderation_id, COALESCE(profile_field_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ended_at IS NULL;
CREATE INDEX media_quarantine_holds_moderation_idx ON private.media_quarantine_holds (moderation_id) WHERE ended_at IS NULL;
CREATE INDEX media_quarantine_holds_field_idx ON private.media_quarantine_holds (profile_field_id) WHERE profile_field_id IS NOT NULL;

CREATE TABLE private.media_quarantine_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quarantine_id uuid REFERENCES private.media_quarantine (id) ON DELETE RESTRICT,
  moderation_id uuid,
  event         text NOT NULL CHECK (event ~ '^[a-z_]{1,48}$'),
  from_state    text,
  to_state      text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX media_quarantine_events_job_idx ON private.media_quarantine_events (quarantine_id, id);
CREATE INDEX media_quarantine_events_moderation_idx ON private.media_quarantine_events (moderation_id) WHERE moderation_id IS NOT NULL;

ALTER TABLE private.media_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.media_quarantine_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.media_quarantine_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.media_quarantine, private.media_quarantine_holds, private.media_quarantine_events
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Integrity guards ─────────────────────────────────────────────────────
CREATE FUNCTION private.media_quarantine_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_bucket IS DISTINCT FROM OLD.source_bucket
     OR NEW.source_path IS DISTINCT FROM OLD.source_path OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.media_kind IS DISTINCT FROM OLD.media_kind OR NEW.origin_target_type IS DISTINCT FROM OLD.origin_target_type
     OR NEW.origin_target_id IS DISTINCT FROM OLD.origin_target_id OR NEW.quarantine_bucket IS DISTINCT FROM OLD.quarantine_bucket
     OR NEW.quarantine_path IS DISTINCT FROM OLD.quarantine_path OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.child_safety AND NOT NEW.child_safety) OR (OLD.legal_hold AND NOT NEW.legal_hold)
     OR (OLD.source_sha256 IS NOT NULL AND NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256)
     OR (OLD.source_removed_at IS NOT NULL AND NEW.source_removed_at IS DISTINCT FROM OLD.source_removed_at)
     OR OLD.state IN ('restored', 'cancelled') THEN
    RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_ok := CASE OLD.state
      WHEN 'pending'         THEN NEW.state IN ('copied', 'source_missing', 'failed', 'cancelled')
      WHEN 'copied'          THEN NEW.state IN ('verified', 'failed', 'cancelled')
      WHEN 'verified'        THEN NEW.state IN ('quarantined', 'failed', 'cancelled')
      WHEN 'quarantined'     THEN NEW.state IN ('restore_pending')
      WHEN 'source_missing'  THEN NEW.state IN ('cancelled')
      WHEN 'restore_pending' THEN NEW.state IN ('restoring', 'quarantined')
      WHEN 'restoring'       THEN NEW.state IN ('restored', 'failed', 'quarantined')
      WHEN 'failed'          THEN NEW.state IN ('pending', 'copied', 'verified', 'restore_pending', 'cancelled')
      ELSE false
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_quarantine_transition' USING ERRCODE = '22023',
        DETAIL = OLD.state || ' -> ' || NEW.state;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_quarantine_history BEFORE UPDATE OR DELETE ON private.media_quarantine
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_guard();

CREATE FUNCTION private.media_quarantine_holds_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.quarantine_id IS DISTINCT FROM OLD.quarantine_id
     OR NEW.moderation_id IS DISTINCT FROM OLD.moderation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.profile_field_id IS DISTINCT FROM OLD.profile_field_id
     OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at
                                       OR NEW.end_disposition IS DISTINCT FROM OLD.end_disposition)) THEN
    RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_quarantine_holds_history BEFORE UPDATE OR DELETE ON private.media_quarantine_holds
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_holds_guard();

CREATE FUNCTION private.media_quarantine_events_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'media_quarantine_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER media_quarantine_events_append_only BEFORE UPDATE OR DELETE ON private.media_quarantine_events
  FOR EACH ROW EXECUTE FUNCTION private.media_quarantine_events_guard();
CREATE TRIGGER media_quarantine_no_truncate BEFORE TRUNCATE ON private.media_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_quarantine_events_guard();
CREATE TRIGGER media_quarantine_holds_no_truncate BEFORE TRUNCATE ON private.media_quarantine_holds
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_quarantine_events_guard();
CREATE TRIGGER media_quarantine_events_no_truncate BEFORE TRUNCATE ON private.media_quarantine_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.media_quarantine_events_guard();

-- ── 4. Path helpers ─────────────────────────────────────────────────────────
-- States in which a job still reserves its source path.
CREATE FUNCTION private.media_quarantine_live(p_state text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT p_state NOT IN ('restored', 'cancelled') $$;

-- True when a live job reserves this object (any hold reason).
CREATE FUNCTION private.storage_path_held(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_bucket IS NOT NULL AND p_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.media_quarantine q
    WHERE q.source_bucket = p_bucket AND q.source_path = p_name AND q.state NOT IN ('restored', 'cancelled'));
$$;

-- Every object held for a child-safety restriction, as "bucket/path" keys
-- (computed once per query by the Storage read guard).
CREATE FUNCTION private.child_safety_held_keys()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(q.source_bucket || '/' || q.source_path), '{}')
  FROM private.media_quarantine q
  WHERE q.child_safety AND q.state NOT IN ('restored', 'cancelled');
$$;

CREATE FUNCTION private.media_child_safety_held(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM private.media_quarantine q
                 WHERE q.source_bucket = p_bucket AND q.source_path = p_name
                   AND q.child_safety AND q.state NOT IN ('restored', 'cancelled'));
$$;

-- The object path of one of THIS project's public object URLs for `p_bucket`
-- (as getPublicUrl produces them), or NULL. Never guesses.
CREATE FUNCTION private.public_object_path(p_url text, p_bucket text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN v ~ '^[^/\\]+(/[^/\\]+)+$' AND v NOT LIKE '%..%' THEN v END
  FROM (SELECT substring(p_url FROM '/storage/v1/object/public/' || p_bucket || '/([^?#]+)') AS v) s;
$$;

-- ── 5. Queueing ─────────────────────────────────────────────────────────────
-- Adds a hold by restriction `p_mod` (and M2.2 field `p_field`) on one object,
-- creating its job if none is live. The object must sit in its verified
-- owner's own namespace — a URL a collector stored that points at someone
-- else's file is skipped and recorded, never queued. Never touches Storage.
CREATE FUNCTION private.queue_media_hold(
  p_mod uuid, p_field uuid, p_bucket text, p_path text, p_owner uuid, p_kind text,
  p_child_safety boolean, p_target_type text, p_target_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_job private.media_quarantine;
  v_obj storage.objects;
BEGIN
  IF p_path IS NULL THEN RETURN; END IF;
  IF p_owner IS NULL OR p_path !~ '^[^/\\]+(/[^/\\]+)+$' OR p_path LIKE '%..%' THEN
    INSERT INTO private.media_quarantine_events (moderation_id, event, detail)
    VALUES (p_mod, 'skipped', jsonb_build_object('reason', 'invalid_path', 'bucket', p_bucket));
    RETURN;
  END IF;
  -- Ownership: every collector-writable bucket is namespaced by owner id; a DM
  -- photo is namespaced by conversation and comes only from the trusted
  -- messages row (its sender is the owner).
  IF p_bucket <> 'dm-attachments' AND split_part(p_path, '/', 1) <> p_owner::text THEN
    INSERT INTO private.media_quarantine_events (moderation_id, event, detail)
    VALUES (p_mod, 'skipped', jsonb_build_object('reason', 'not_owned', 'bucket', p_bucket));
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('media-quarantine:' || p_bucket || '/' || p_path, 0));

  SELECT * INTO v_job FROM private.media_quarantine q
   WHERE q.source_bucket = p_bucket AND q.source_path = p_path AND q.state NOT IN ('restored', 'cancelled')
   FOR UPDATE;
  IF FOUND THEN
    IF v_job.owner_id <> p_owner THEN
      INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, detail)
      VALUES (v_job.id, p_mod, 'skipped', jsonb_build_object('reason', 'owner_mismatch'));
      RETURN;
    END IF;
    INSERT INTO private.media_quarantine_holds (quarantine_id, moderation_id, profile_field_id)
    VALUES (v_job.id, p_mod, p_field)
    ON CONFLICT (quarantine_id, moderation_id, COALESCE(profile_field_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE ended_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, from_state, to_state)
      VALUES (v_job.id, p_mod, 'hold_added', v_job.state, v_job.state);
    END IF;
    -- A new hold always wants the file out again.
    UPDATE private.media_quarantine
       SET desired = 'quarantine', retain_until = NULL,
           child_safety = child_safety OR p_child_safety, legal_hold = legal_hold OR p_child_safety,
           state = CASE WHEN state = 'restore_pending' THEN 'quarantined' ELSE state END
     WHERE id = v_job.id
       AND (desired <> 'quarantine' OR retain_until IS NOT NULL OR (p_child_safety AND NOT child_safety) OR state = 'restore_pending');
    RETURN;
  END IF;

  SELECT * INTO v_obj FROM storage.objects o WHERE o.bucket_id = p_bucket AND o.name = p_path;
  INSERT INTO private.media_quarantine (source_bucket, source_path, owner_id, media_kind, origin_target_type, origin_target_id,
                                        mime_type, size_bytes, quarantine_path, state, child_safety, legal_hold)
  VALUES (p_bucket, p_path, p_owner, p_kind, p_target_type, p_target_id,
          v_obj.metadata ->> 'mimetype', (v_obj.metadata ->> 'size')::bigint,
          'q/' || gen_random_uuid()::text || '/original',
          CASE WHEN v_obj.id IS NULL THEN 'source_missing' ELSE 'pending' END,
          p_child_safety, p_child_safety)
  RETURNING * INTO v_job;
  INSERT INTO private.media_quarantine_holds (quarantine_id, moderation_id, profile_field_id) VALUES (v_job.id, p_mod, p_field);
  INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, to_state, detail)
  VALUES (v_job.id, p_mod, 'queued', v_job.state, jsonb_build_object('kind', p_kind, 'bucket', p_bucket));
END;
$$;

-- Derives every file a restriction must hold, from trusted rows only.
--   public media, always:   snapshot copies of the content (share-snapshots),
--                           profile images (see the field trigger)
--   private media, child safety only: the content's own item images, folder
--                           cover and DM photo
CREATE FUNCTION private.queue_media_for_restriction(m public.moderated_content)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_owner uuid;
  v_path text;
BEGIN
  IF m.target_type = 'post' THEN
    SELECT p.user_id INTO v_owner FROM public.posts p WHERE p.id = m.target_id;
    IF v_owner IS NULL THEN RETURN; END IF;
    FOR r IN
      SELECT u FROM (
        SELECT p.image_url AS u FROM public.posts p WHERE p.id = m.target_id
        UNION SELECT p.folder_cover_snapshot_url FROM public.posts p WHERE p.id = m.target_id
        UNION SELECT x.image_url FROM public.post_images x WHERE x.post_id = m.target_id
        UNION SELECT x.snapshot_image_url FROM public.card_share_items x WHERE x.post_id = m.target_id
        UNION SELECT x.snapshot_image_url FROM public.folder_share_items x WHERE x.post_id = m.target_id
        UNION SELECT x.snapshot_image_url FROM public.rate_my_grail_cards x WHERE x.post_id = m.target_id) s
      WHERE u IS NOT NULL
    LOOP
      PERFORM private.queue_media_hold(m.id, NULL, 'share-snapshots', private.public_object_path(r.u, 'share-snapshots'),
                                       v_owner, 'share_snapshot', m.child_safety, m.target_type, m.target_id);
      IF m.child_safety THEN
        PERFORM private.queue_media_hold(m.id, NULL, 'item-images', private.public_object_path(r.u, 'item-images'),
                                         v_owner, 'item_image', true, m.target_type, m.target_id);
      END IF;
    END LOOP;

  ELSIF m.target_type IN ('collection_item', 'item_image', 'folder') THEN
    -- The items concerned: the item, the image's item, or every item in the
    -- folder tree.
    IF to_regclass('pg_temp.mq_items') IS NULL THEN
      CREATE TEMP TABLE mq_items (item_id uuid PRIMARY KEY, image_path text) ON COMMIT DROP;
    END IF;
    TRUNCATE pg_temp.mq_items;
    IF m.target_type = 'collection_item' THEN
      INSERT INTO pg_temp.mq_items SELECT m.target_id, NULL;
    ELSIF m.target_type = 'item_image' THEN
      INSERT INTO pg_temp.mq_items SELECT i.item_id, i.storage_path FROM public.collection_item_images i WHERE i.id = m.target_id;
    ELSE
      INSERT INTO pg_temp.mq_items
      WITH RECURSIVE down (id, depth) AS (
        SELECT m.target_id, 0
        UNION ALL SELECT f.id, d.depth + 1 FROM public.folders f JOIN down d ON f.parent_folder_id = d.id WHERE d.depth < 100)
      SELECT DISTINCT ci.id, NULL FROM public.collection_items ci WHERE ci.folder_id IN (SELECT id FROM down);
    END IF;

    -- Public copies made through the M2.3a ledger (exact source known).
    FOR r IN
      SELECT c.dest_path, c.caller_id FROM private.share_snapshot_copies c JOIN pg_temp.mq_items t ON t.item_id = c.item_id
      WHERE c.status = 'published' AND c.dest_path IS NOT NULL AND (t.image_path IS NULL OR c.source_path = t.image_path)
    LOOP
      PERFORM private.queue_media_hold(m.id, NULL, 'share-snapshots', r.dest_path, r.caller_id, 'share_snapshot',
                                       m.child_safety, m.target_type, m.target_id);
    END LOOP;
    -- Snapshot rows that name the item (older copies, made before the ledger).
    -- Only for a whole item or folder: an image restriction cannot tell which
    -- image an unledgered copy was made from.
    IF m.target_type <> 'item_image' THEN
      FOR r IN
        SELECT x.u, p.user_id FROM (
          SELECT post_id, item_id, image_url AS u FROM public.post_images
          UNION ALL SELECT post_id, item_id, snapshot_image_url FROM public.card_share_items
          UNION ALL SELECT post_id, item_id, snapshot_image_url FROM public.folder_share_items
          UNION ALL SELECT post_id, item_id, snapshot_image_url FROM public.rate_my_grail_cards
          UNION ALL SELECT id, item_id, image_url FROM public.posts WHERE post_type = 'item') x
        JOIN pg_temp.mq_items t ON t.item_id = x.item_id
        JOIN public.posts p ON p.id = x.post_id
        WHERE x.u IS NOT NULL
      LOOP
        PERFORM private.queue_media_hold(m.id, NULL, 'share-snapshots', private.public_object_path(r.u, 'share-snapshots'),
                                         r.user_id, 'share_snapshot', m.child_safety, m.target_type, m.target_id);
      END LOOP;
    END IF;
    IF m.target_type = 'folder' THEN
      FOR r IN
        WITH RECURSIVE down (id, depth) AS (
          SELECT m.target_id, 0
          UNION ALL SELECT f.id, d.depth + 1 FROM public.folders f JOIN down d ON f.parent_folder_id = d.id WHERE d.depth < 100)
        SELECT c.dest_path AS path, c.caller_id AS owner FROM private.share_snapshot_copies c
         WHERE c.kind = 'folder_cover' AND c.status = 'published' AND c.folder_id IN (SELECT id FROM down)
        UNION
        SELECT private.public_object_path(p.folder_cover_snapshot_url, 'share-snapshots'), p.user_id FROM public.posts p
         WHERE p.folder_id IN (SELECT id FROM down) AND p.folder_cover_snapshot_url IS NOT NULL
      LOOP
        PERFORM private.queue_media_hold(m.id, NULL, 'share-snapshots', r.path, r.owner, 'share_snapshot',
                                         m.child_safety, m.target_type, m.target_id);
      END LOOP;
    END IF;

    IF m.child_safety THEN
      FOR r IN
        SELECT i.storage_path AS path, ci.user_id AS owner FROM public.collection_item_images i
          JOIN public.collection_items ci ON ci.id = i.item_id JOIN pg_temp.mq_items t ON t.item_id = i.item_id
         WHERE t.image_path IS NULL OR i.storage_path = t.image_path
      LOOP
        PERFORM private.queue_media_hold(m.id, NULL, 'item-images', r.path, r.owner, 'item_image', true, m.target_type, m.target_id);
      END LOOP;
      IF m.target_type = 'folder' THEN
        FOR r IN
          WITH RECURSIVE down (id, depth) AS (
            SELECT m.target_id, 0
            UNION ALL SELECT f.id, d.depth + 1 FROM public.folders f JOIN down d ON f.parent_folder_id = d.id WHERE d.depth < 100)
          SELECT f.cover_storage_path AS path, f.user_id AS owner FROM public.folders f
           WHERE f.id IN (SELECT id FROM down) AND f.cover_storage_path IS NOT NULL
        LOOP
          PERFORM private.queue_media_hold(m.id, NULL, 'item-images', r.path, r.owner, 'folder_cover', true, m.target_type, m.target_id);
        END LOOP;
      END IF;
    END IF;

  ELSIF m.target_type = 'message' AND m.child_safety THEN
    SELECT x.attachment_storage_path, x.sender_id INTO v_path, v_owner FROM public.messages x
     WHERE x.id = m.target_id AND x.attachment_type = 'image'
       AND x.attachment_storage_path = x.conversation_id::text || '/' || x.id::text || '/image.jpg';
    PERFORM private.queue_media_hold(m.id, NULL, 'dm-attachments', v_path, v_owner, 'dm_photo', true, m.target_type, m.target_id);

  ELSIF m.target_type = 'profile' THEN
    -- Re-queue the umbrella's active field restrictions (child-safety upgrade).
    FOR r IN SELECT f.* FROM public.moderated_profile_fields f WHERE f.moderation_id = m.id AND f.status = 'active' LOOP
      PERFORM private.queue_profile_field_media(r.id);
    END LOOP;
  END IF;
END;
$$;

CREATE FUNCTION private.queue_profile_field_media(p_field uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  f public.moderated_profile_fields;
  m public.moderated_content;
BEGIN
  SELECT * INTO f FROM public.moderated_profile_fields x WHERE x.id = p_field;
  IF NOT FOUND OR f.status <> 'active' OR f.field NOT IN ('avatar_url', 'hero_image_url', 'showcase_badge_url') THEN RETURN; END IF;
  SELECT * INTO m FROM public.moderated_content x WHERE x.id = f.moderation_id;
  PERFORM private.queue_media_hold(m.id, f.id, 'avatars', private.public_object_path(f.original_value, 'avatars'), f.user_id,
    CASE f.field WHEN 'avatar_url' THEN 'avatar' WHEN 'hero_image_url' THEN 'hero_image' ELSE 'showcase_badge' END,
    m.child_safety, 'profile', f.user_id);
END;
$$;

-- Ends holds and decides what each affected job now wants. A job stays
-- quarantined while ANY hold is active; once none is, it is restored only if
-- every hold ended with "restore" (an overturned or reopened restriction, a
-- restored field); any "retain" (a released field — the removal stands)
-- keeps it quarantined and starts its retention clock (child-safety files
-- carry a legal hold and have none).
CREATE FUNCTION private.end_media_holds(p_mod uuid, p_field uuid, p_disposition text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  v_desired text;
BEGIN
  FOR j IN
    SELECT q.* FROM private.media_quarantine q
     WHERE q.id IN (SELECT h.quarantine_id FROM private.media_quarantine_holds h
                     WHERE h.ended_at IS NULL AND h.moderation_id = p_mod
                       AND (p_field IS NULL OR h.profile_field_id = p_field))
     ORDER BY q.id FOR UPDATE
  LOOP
    UPDATE private.media_quarantine_holds h SET ended_at = clock_timestamp(), end_disposition = p_disposition
     WHERE h.quarantine_id = j.id AND h.ended_at IS NULL AND h.moderation_id = p_mod
       AND (p_field IS NULL OR h.profile_field_id = p_field);
    INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, from_state, to_state, detail)
    VALUES (j.id, p_mod, 'hold_ended', j.state, j.state, jsonb_build_object('disposition', p_disposition));
    IF EXISTS (SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.ended_at IS NULL) THEN
      CONTINUE;
    END IF;
    v_desired := CASE WHEN EXISTS (SELECT 1 FROM private.media_quarantine_holds h
                                    WHERE h.quarantine_id = j.id AND h.end_disposition = 'retain')
                      THEN 'retain' ELSE 'restore' END;
    UPDATE private.media_quarantine
       SET desired = v_desired,
           retain_until = CASE WHEN v_desired = 'retain' AND NOT legal_hold THEN clock_timestamp() + interval '90 days' END,
           -- Nothing was touched yet: no file work is needed at all.
           state = CASE
             WHEN v_desired = 'restore' AND state IN ('pending', 'source_missing') THEN 'cancelled'
             WHEN v_desired = 'restore' AND state = 'quarantined' THEN 'restore_pending'
             ELSE state END
     WHERE id = j.id;
    INSERT INTO private.media_quarantine_events (quarantine_id, moderation_id, event, from_state, to_state, detail)
    SELECT j.id, p_mod, 'released', j.state, q.state, jsonb_build_object('desired', v_desired)
      FROM private.media_quarantine q WHERE q.id = j.id;
  END LOOP;
END;
$$;

-- Triggers on the restriction tables: queueing and hold ends happen inside
-- the admin function's own transaction, so they commit or roll back with the
-- moderation decision and its audit row.
CREATE FUNCTION private.moderated_content_media()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifted_at IS NULL THEN PERFORM private.queue_media_for_restriction(NEW); END IF;
  ELSIF OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL THEN
    PERFORM private.end_media_holds(NEW.id, NULL, 'restore');
  ELSIF NEW.lifted_at IS NULL AND NEW.child_safety AND NOT OLD.child_safety THEN
    PERFORM private.queue_media_for_restriction(NEW);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderated_content_media AFTER INSERT OR UPDATE OF lifted_at, child_safety ON public.moderated_content
  FOR EACH ROW EXECUTE FUNCTION private.moderated_content_media();

CREATE FUNCTION private.moderated_profile_fields_media()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.queue_profile_field_media(NEW.id);
  ELSIF OLD.status = 'active' AND NEW.status IN ('restored', 'released') THEN
    PERFORM private.end_media_holds(NEW.moderation_id, NEW.id, CASE NEW.status WHEN 'restored' THEN 'restore' ELSE 'retain' END);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderated_profile_fields_media AFTER INSERT OR UPDATE OF status ON public.moderated_profile_fields
  FOR EACH ROW EXECUTE FUNCTION private.moderated_profile_fields_media();

-- ── 6. Storage guards ───────────────────────────────────────────────────────
-- Collectors may not delete, overwrite (upsert/update), move, or re-upload at a
-- held path. Unheld paths are unaffected; the service role (the worker, and
-- the server cleanup paths that now skip held files) bypasses RLS.
CREATE POLICY moderation_hold_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (NOT private.storage_path_held(bucket_id, name));
CREATE POLICY moderation_hold_update_guard ON storage.objects AS RESTRICTIVE FOR UPDATE TO public
  USING (NOT private.storage_path_held(bucket_id, name))
  WITH CHECK (NOT private.storage_path_held(bucket_id, name));
CREATE POLICY moderation_hold_delete_guard ON storage.objects AS RESTRICTIVE FOR DELETE TO public
  USING (NOT private.storage_path_held(bucket_id, name));
-- Child-safety-held files: unreadable to every collector (no listing, no
-- download through the API, no signed URL — signing requires SELECT).
CREATE POLICY moderation_child_safety_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO public
  USING (NOT COALESCE((bucket_id || '/' || name) = ANY ((SELECT private.child_safety_held_keys())::text[]), false));

-- Account deletion must not destroy held evidence: held objects never enter
-- the deletion manifest (the worker quarantines them; the quarantine bucket is
-- not in the manifest's bucket list at all).
CREATE FUNCTION private.account_deletion_skip_held()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF private.storage_path_held(NEW.bucket, NEW.path) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_deletion_skip_held BEFORE INSERT ON public.account_deletion_storage_queue
  FOR EACH ROW EXECUTE FUNCTION private.account_deletion_skip_held();

-- For the service-role cleanup paths (delete-post, cleanup-share-snapshots):
-- which of these paths are held and must be left in place.
CREATE FUNCTION public.storage_paths_held(p_bucket text, p_paths text[])
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT DISTINCT p FROM unnest(p_paths) p
  WHERE cardinality(p_paths) <= 1000 AND private.storage_path_held(p_bucket, p);
$$;

-- ── 7. Reference guards ─────────────────────────────────────────────────────
-- No NEW link to a held file. Only a changed value is checked, so editing the
-- other columns of a row that already carries one keeps working. The M2.2
-- admin write path (postgres + cachecase.profile_moderation_write) may write a
-- restored original back. Item-image and cover paths also honour the
-- staging-upload reservation (section 8).
CREATE FUNCTION private.reject_held_media_reference()
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

-- ── 8. Staging-upload reservation (closes the M2.3a race) ───────────────────
-- copy-post-photo deletes its staging source only after publish confirmed the
-- path is unreferenced. Publish now takes a per-path lock and marks the source
-- "deleting"; the reference guard above takes the same lock and refuses that
-- path while it is marked, so a reference committed after the check can no
-- longer be orphaned by the delete. The Edge Function reports the removal.
ALTER TABLE private.share_snapshot_copies
  ADD COLUMN source_state text CHECK (source_state IN ('deleting', 'removed'));
ALTER TABLE private.share_snapshot_copies
  ADD CONSTRAINT share_snapshot_copies_source_state_shape CHECK (source_state IS NULL OR kind = 'post_photo');

-- (Named to run after M2.2's profile_field_lock, so a locked field reports
-- profile_field_locked first.)
CREATE TRIGGER profile_media_hold_guard BEFORE INSERT OR UPDATE OF avatar_url, hero_image_url, showcase_badge_url ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:avatar_url', 'url:hero_image_url', 'url:showcase_badge_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF image_url, folder_cover_snapshot_url ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:image_url', 'url:folder_cover_snapshot_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF image_url ON public.post_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:image_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF snapshot_image_url ON public.card_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:snapshot_image_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF snapshot_image_url ON public.folder_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:snapshot_image_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF snapshot_image_url ON public.rate_my_grail_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('url:snapshot_image_url');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF storage_path ON public.collection_item_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('path:storage_path');
CREATE TRIGGER media_hold_guard BEFORE INSERT OR UPDATE OF cover_storage_path ON public.folders
  FOR EACH ROW EXECUTE FUNCTION private.reject_held_media_reference('path:cover_storage_path');

CREATE OR REPLACE FUNCTION public.share_snapshot_copy_publish(p_copy_id uuid, p_dest_path text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r private.share_snapshot_copies;
  v_problem text;
BEGIN
  SELECT * INTO r FROM private.share_snapshot_copies WHERE id = p_copy_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state');
  END IF;
  IF p_dest_path IS NULL OR p_dest_path NOT IN (
       SELECT r.dest_base || '.' || e FROM unnest(ARRAY['jpg', 'png', 'webp', 'heic', 'heif']) e) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination');
  END IF;
  -- M2.3b: serialize with any new reference to a staging source (see the
  -- reference guard), then re-check.
  IF r.kind = 'post_photo' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('item-images-path:' || r.source_path, 0));
  END IF;

  v_problem := private.share_snapshot_problem(r.caller_id, r.kind, r.item_id, r.folder_id, r.source_path);
  UPDATE private.share_snapshot_copies
     SET dest_path = p_dest_path,
         status = CASE WHEN v_problem IS NULL THEN 'published' ELSE 'rejected' END,
         source_state = CASE WHEN v_problem IS NULL AND r.kind = 'post_photo' THEN 'deleting' END,
         updated_at = now()
   WHERE id = p_copy_id;
  IF v_problem IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_problem);
  END IF;
  RETURN jsonb_build_object('ok', true, 'delete_source', r.kind = 'post_photo');
END;
$$;

-- The staging source of a published post-photo copy was deleted.
CREATE FUNCTION public.share_snapshot_copy_source_removed(p_copy_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH u AS (
    UPDATE private.share_snapshot_copies c SET source_state = 'removed', updated_at = now()
     WHERE c.id = p_copy_id AND c.kind = 'post_photo' AND c.status = 'published' AND c.source_state = 'deleting'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Discard never hands out a held object (a copy queued for quarantine because
-- its item was moderated mid-request stays where it is, as evidence).
CREATE OR REPLACE FUNCTION public.share_snapshot_copy_discard(p_copy_ids uuid[])
RETURNS TABLE (copy_id uuid, paths text[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.share_snapshot_copies c
     SET status = 'discarded', updated_at = now()
   WHERE c.id = ANY (p_copy_ids) AND cardinality(p_copy_ids) <= 50
     AND c.status IN ('reserved', 'published', 'rejected', 'discarded')
     AND NOT private.storage_path_held('share-snapshots', c.dest_path)
  RETURNING c.id,
            CASE WHEN c.dest_path IS NOT NULL THEN ARRAY[c.dest_path]
                 ELSE ARRAY(SELECT c.dest_base || '.' || e FROM unnest(ARRAY['jpg','png','webp','heic','heif']) e) END;
$$;

-- A staging path that is held (or still being deleted) is never "unreferenced".
CREATE OR REPLACE FUNCTION private.item_images_path_protected(p_path text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH s AS (SELECT '/storage/v1/object/public/item-images/' || p_path AS suffix)
  SELECT p_path IS NULL
      OR private.storage_path_held('item-images', p_path)
      OR EXISTS (SELECT 1 FROM public.collection_item_images i WHERE i.storage_path = p_path)
      OR EXISTS (SELECT 1 FROM public.folders f WHERE f.cover_storage_path = p_path)
      OR EXISTS (SELECT 1 FROM s, public.collection_item_images i WHERE right(i.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.collection_items ci WHERE right(ci.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.folders f WHERE right(f.cover_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.posts p
                 WHERE right(p.image_url, length(s.suffix)) = s.suffix
                    OR right(p.folder_cover_snapshot_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.post_images x WHERE right(x.image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.card_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.folder_share_items x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.rate_my_grail_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM s, public.registered_cards x WHERE right(x.snapshot_image_url, length(s.suffix)) = s.suffix)
      OR EXISTS (SELECT 1 FROM public.content_reports r
                 WHERE jsonb_path_exists(r.evidence, '$.** ? (@.bucket == "item-images" && @.path == $p)',
                                         jsonb_build_object('p', p_path)))
      OR EXISTS (SELECT 1 FROM public.account_export_entries e WHERE e.source_bucket = 'item-images' AND e.source_path = p_path);
$$;

-- ── 9. Child-safety media: no signing or export for anyone ──────────────────
-- (Owners keep their other moderated content, as in M2.1.) A held
-- child-safety image resolves with no storage path, which the signing
-- function already reports as unavailable for every caller.
CREATE OR REPLACE FUNCTION public.resolve_item_images_for_signing(p_image_ids uuid[])
 RETURNS TABLE(image_id uuid, item_id uuid, storage_path text, owner_id uuid, item_is_public boolean, folder_effectively_visible boolean, grail_showcased boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH resolved AS (
    SELECT
      img.id           AS image_id,
      img.item_id      AS item_id,
      CASE WHEN private.media_child_safety_held('item-images', img.storage_path) THEN NULL
           ELSE img.storage_path END AS storage_path, -- 20261119120000
      f.id             AS folder_id,
      f.user_id        AS owner_id,
      ci.is_public     AS item_is_public,
      (private.is_moderated('item_image', img.id) OR private.item_hidden(ci.id)) AS moderated -- 20261116120000
    FROM public.collection_item_images img
    JOIN public.collection_items ci ON ci.id = img.item_id
    JOIN public.folders f ON f.id = ci.folder_id
    WHERE img.id = ANY (p_image_ids)
      AND NOT private.account_is_hidden(f.user_id) -- account lifecycle (20261103120000)
  ),
  folder_visibility AS (
    SELECT d.folder_id, public._folder_is_effectively_visible_for(d.folder_id, NULL) AS visible
    FROM (SELECT DISTINCT r.folder_id FROM resolved r) d
  )
  SELECT
    r.image_id,
    r.item_id,
    r.storage_path,
    r.owner_id,
    r.item_is_public AND NOT r.moderated,
    fv.visible AND NOT r.moderated,
    NOT r.moderated AND EXISTS (
      SELECT 1
      FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'item'
        AND gs.item_id = r.item_id
        AND gs.user_id = r.owner_id
    )
  FROM resolved r
  JOIN folder_visibility fv ON fv.folder_id = r.folder_id;
$function$;

-- Folder covers: a child-safety-held item image or cover upload is restricted
-- for the owner too.
CREATE OR REPLACE FUNCTION public.folder_cover_eligibility(p_folder_ids uuid[], p_caller uuid)
RETURNS TABLE (folder_id uuid, authorized boolean, cover_item_owned boolean,
               cover_path_restricted boolean, restricted_item_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH f AS (
    SELECT f.id, f.user_id, f.cover_item_id, f.cover_storage_path,
           (p_caller IS NOT NULL AND p_caller = f.user_id) AS is_owner
    FROM public.folders f
    WHERE f.id = ANY (p_folder_ids) AND cardinality(p_folder_ids) <= 50
  ), a AS (
    SELECT f.*,
           (NOT private.account_is_hidden(f.user_id) AND NOT private.account_is_hidden(p_caller) AND (
              f.is_owner OR (
                NOT private.users_blocked(p_caller, f.user_id)
                AND NOT private.folder_tree_moderated(f.id)
                AND (public._folder_is_effectively_visible_for(f.id, p_caller)
                     OR EXISTS (SELECT 1 FROM public.profile_grail_slots g
                                WHERE g.entry_type = 'collection' AND g.collection_id = f.id AND g.user_id = f.user_id))))
           ) AS authorized
    FROM f
  )
  SELECT a.id,
         a.authorized,
         (a.cover_item_id IS NULL OR EXISTS (SELECT 1 FROM public.collection_items ci
                                              WHERE ci.id = a.cover_item_id AND ci.user_id = a.user_id)),
         (a.authorized AND ((NOT a.is_owner AND private.image_path_moderated(a.cover_storage_path))
                            OR private.media_child_safety_held('item-images', a.cover_storage_path))),
         CASE WHEN a.authorized THEN ARRAY(
           SELECT m.target_id FROM public.moderated_content m
             JOIN public.collection_items ci ON ci.id = m.target_id
            WHERE NOT a.is_owner AND m.target_type = 'collection_item' AND m.lifted_at IS NULL
              AND (ci.folder_id = a.id OR ci.id = a.cover_item_id)
           UNION
           SELECT i.item_id FROM public.moderated_content m
             JOIN public.collection_item_images i ON i.id = m.target_id
             JOIN public.collection_items ci ON ci.id = i.item_id
            WHERE NOT a.is_owner AND m.target_type = 'item_image' AND m.lifted_at IS NULL AND i.is_primary
              AND (ci.folder_id = a.id OR ci.id = a.cover_item_id)
           UNION
           SELECT a.cover_item_id WHERE NOT a.is_owner AND a.cover_item_id IS NOT NULL AND private.item_hidden(a.cover_item_id)
           UNION -- 20261119120000: child-safety-held primary images, for every caller
           SELECT i.item_id FROM private.media_quarantine q
             JOIN public.collection_item_images i ON i.storage_path = q.source_path AND i.is_primary
             JOIN public.collection_items ci ON ci.id = i.item_id
            WHERE q.source_bucket = 'item-images' AND q.child_safety AND q.state NOT IN ('restored', 'cancelled')
              AND (ci.folder_id = a.id OR ci.id = a.cover_item_id)
         ) ELSE '{}'::uuid[] END
  FROM a;
$$;

CREATE OR REPLACE FUNCTION public.export_owned_storage_objects(p_user_id uuid, p_after_bucket text DEFAULT ''::text, p_after_name text DEFAULT ''::text, p_limit integer DEFAULT 1000)
 RETURNS TABLE(bucket_id text, name text, size bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT o.bucket_id, o.name, COALESCE((o.metadata ->> 'size')::bigint, 0)
  FROM storage.objects o
  WHERE o.bucket_id IN ('avatars', 'item-images', 'share-snapshots')
    AND o.name LIKE p_user_id::text || '/%'
    AND (o.bucket_id, o.name) > (COALESCE(p_after_bucket, ''), COALESCE(p_after_name, ''))
    AND NOT private.media_child_safety_held(o.bucket_id, o.name) -- 20261119120000
  ORDER BY o.bucket_id, o.name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$function$;

CREATE OR REPLACE FUNCTION public.export_sent_message_attachments(p_user_id uuid, p_after_message_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000)
 RETURNS TABLE(message_id uuid, bucket_id text, name text, size bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT m.id, o.bucket_id, o.name, COALESCE((o.metadata ->> 'size')::bigint, 0)
  FROM public.messages m
  JOIN storage.objects o
    ON o.bucket_id = 'dm-attachments'
   AND o.name = m.attachment_storage_path
  WHERE m.sender_id = p_user_id
    AND m.attachment_type = 'image'
    AND m.attachment_storage_path = m.conversation_id::text || '/' || m.id::text || '/image.jpg'
    AND (o.owner = p_user_id OR o.owner_id = p_user_id::text)
    AND m.id > COALESCE(p_after_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND NOT private.media_child_safety_held(o.bucket_id, o.name) -- 20261119120000
  ORDER BY m.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$function$;

-- ── 10. M2.2 compatibility ──────────────────────────────────────────────────
-- An original image held by quarantine (still at its path, or already in the
-- quarantine bucket awaiting restoration) counts as preserved, so the profile
-- restore no longer refuses with original_media_missing. This gate does not
-- move the file back: the hold ends with "restore" and the M2.3c worker does.
CREATE OR REPLACE FUNCTION private.profile_media_present(p_field text, p_value text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_field NOT IN ('avatar_url', 'hero_image_url', 'showcase_badge_url') THEN true
    WHEN substring(p_value FROM '/storage/v1/object/public/avatars/([^?#]+)') IS NULL THEN true
    ELSE EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'avatars'
                   AND o.name = substring(p_value FROM '/storage/v1/object/public/avatars/([^?#]+)'))
      OR EXISTS (SELECT 1 FROM private.media_quarantine q -- 20261119120000
                  WHERE q.source_bucket = 'avatars'
                    AND q.source_path = substring(p_value FROM '/storage/v1/object/public/avatars/([^?#]+)')
                    AND q.state IN ('copied', 'verified', 'quarantined', 'restore_pending', 'restoring'))
  END;
$function$;

-- ── 11. Worker contract (M2.3c; nothing calls these yet) ────────────────────
-- Claims up to p_limit jobs needing file work, each under a fresh lease.
-- Work needed:  desired 'quarantine' and state pending/copied/verified/failed,
--               desired 'restore' and state restore_pending/restoring/copied/verified
--               (copied/verified with nothing holding them: remove the copy).
CREATE FUNCTION public.media_quarantine_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, state text, desired text, source_bucket text, source_path text, quarantine_bucket text,
               quarantine_path text, owner_id uuid, size_bytes bigint, source_sha256 text, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT q.id FROM private.media_quarantine q
     WHERE (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= clock_timestamp())
       AND ((q.desired = 'quarantine' AND q.state IN ('pending', 'copied', 'verified', 'failed'))
            OR (q.desired <> 'quarantine' AND q.state IN ('restore_pending', 'restoring', 'copied', 'verified', 'failed')))
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

-- Records one worker step under its lease. The transition table and shape
-- constraints refuse anything out of order: "verified" needs both checksums to
-- match, "quarantined" needs the worker to confirm the source was removed
-- (source_removed), "restored" needs restored. Returns {ok} or {ok:false, reason}.
CREATE FUNCTION public.media_quarantine_advance(p_id uuid, p_lease uuid, p_to_state text, p_facts jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  j private.media_quarantine;
  v_err text := NULLIF(p_facts ->> 'error', '');
BEGIN
  SELECT * INTO j FROM private.media_quarantine q WHERE q.id = p_id FOR UPDATE;
  IF NOT FOUND OR p_lease IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_expires_at < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease');
  END IF;
  IF p_to_state = 'quarantined' AND (p_facts ->> 'source_removed') IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_not_removed');
  END IF;
  IF p_to_state = 'quarantined' AND (j.desired <> 'quarantine' OR NOT EXISTS (
       SELECT 1 FROM private.media_quarantine_holds h WHERE h.quarantine_id = j.id AND h.ended_at IS NULL)) THEN
    -- Released while the worker was busy: keep the source, drop the copy.
    IF j.desired = 'restore' THEN RETURN jsonb_build_object('ok', false, 'reason', 'released'); END IF;
  END IF;
  BEGIN
    UPDATE private.media_quarantine
       SET state = p_to_state,
           source_sha256 = COALESCE(source_sha256, p_facts ->> 'source_sha256'),
           quarantine_sha256 = COALESCE(p_facts ->> 'quarantine_sha256', quarantine_sha256),
           size_bytes = COALESCE((p_facts ->> 'size_bytes')::bigint, size_bytes),
           mime_type = COALESCE(p_facts ->> 'mime_type', mime_type),
           source_removed_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE source_removed_at END,
           quarantined_at = CASE WHEN p_to_state = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END,
           restored_at = CASE WHEN p_to_state = 'restored' THEN clock_timestamp() ELSE restored_at END,
           retain_until = CASE WHEN p_to_state = 'quarantined' AND desired = 'retain' AND NOT legal_hold
                               THEN COALESCE(retain_until, clock_timestamp() + interval '90 days') ELSE retain_until END,
           last_error = v_err,
           next_attempt_at = CASE WHEN v_err IS NOT NULL THEN clock_timestamp() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7))::integer)) END,
           lease_token = CASE WHEN p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_token END,
           lease_expires_at = CASE WHEN p_to_state IN ('quarantined', 'restored', 'cancelled', 'source_missing', 'failed') THEN NULL ELSE lease_expires_at END
     WHERE id = p_id;
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  END;
  INSERT INTO private.media_quarantine_events (quarantine_id, event, from_state, to_state, detail)
  VALUES (p_id, 'worker_step', j.state, p_to_state, jsonb_strip_nulls(jsonb_build_object('error', v_err)));
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── 12. Admin visibility ────────────────────────────────────────────────────
CREATE FUNCTION public.admin_media_quarantine_status(p_moderation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_admin uuid := private.require_admin();
BEGIN
  RETURN jsonb_build_object(
    'moderation_id', p_moderation_id,
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q.id, 'bucket', q.source_bucket, 'path', q.source_path, 'kind', q.media_kind, 'state', q.state,
               'desired', q.desired, 'child_safety', q.child_safety, 'legal_hold', q.legal_hold,
               'retain_until', q.retain_until, 'last_error', q.last_error, 'attempts', q.attempts,
               'hold_active', h.ended_at IS NULL, 'hold_ended_at', h.ended_at, 'end_disposition', h.end_disposition,
               'created_at', q.created_at, 'updated_at', q.updated_at) ORDER BY q.created_at)
        FROM private.media_quarantine_holds h JOIN private.media_quarantine q ON q.id = h.quarantine_id
       WHERE h.moderation_id = p_moderation_id), '[]'::jsonb),
    'skipped', COALESCE((
      SELECT jsonb_agg(e.detail ORDER BY e.id) FROM private.media_quarantine_events e
       WHERE e.moderation_id = p_moderation_id AND e.event = 'skipped'), '[]'::jsonb));
END;
$$;

-- ── 13. Privileges ──────────────────────────────────────────────────────────
-- Storage policies run as the requesting role, so the two read-only path
-- checks they use must be executable by API roles (the private schema is not
-- exposed through the API). Everything else is internal or server-only.
REVOKE ALL ON FUNCTION private.storage_path_held(text, text), private.child_safety_held_keys(),
  private.media_child_safety_held(text, text), private.public_object_path(text, text), private.media_quarantine_live(text),
  private.queue_media_hold(uuid, uuid, text, text, uuid, text, boolean, text, uuid),
  private.queue_media_for_restriction(public.moderated_content), private.queue_profile_field_media(uuid),
  private.end_media_holds(uuid, uuid, text), private.moderated_content_media(), private.moderated_profile_fields_media(),
  private.account_deletion_skip_held(), private.reject_held_media_reference(), private.media_quarantine_guard(),
  private.media_quarantine_holds_guard(), private.media_quarantine_events_guard()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.storage_path_held(text, text), private.child_safety_held_keys() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.media_child_safety_held(text, text) TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.storage_paths_held(text, text[])',
    'public.share_snapshot_copy_source_removed(uuid)',
    'public.media_quarantine_claim(integer, integer)',
    'public.media_quarantine_advance(uuid, uuid, text, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_media_quarantine_status(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_media_quarantine_status(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

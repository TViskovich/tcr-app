-- ============================================================================
-- Collector blocking — App Store moderation, Phase 1B (database layer).
--
-- A collector can block another collector. While a block exists, enforced in
-- the database rather than the app:
--   * Interactions — neither collector can follow, like, comment on, rate,
--     tag, save, repost, quote, share or message the other, in either
--     direction, and no new direct conversation can start between them.
--     A parallel trigger (user_block_guard) sits beside every account-
--     lifecycle interaction_target_guard; the lifecycle guard is unchanged.
--   * Reads — restrictive SELECT policies (user_block_read_guard, signed-in
--     users only) hide each collector's content from the other. Profiles are
--     one-directional: the blocked collector can't see the blocker's
--     profile; the blocker can still open the blocked collector's profile
--     (to unblock).
--   * Direct messages — history (messages and attachments) stays readable
--     by both participants; only new messages are refused.
--   * Notifications — social notifications between the pair are hidden
--     while blocked, new or refreshed ones are suppressed, and unread ones
--     are marked read when the block is made, so unblocking never surfaces
--     old activity as new. Nothing is deleted except what removing a tag
--     already removes (its tag notification).
--   * Blocking removes follows and tags in both directions. Unblocking
--     restores nothing; it only lifts the restrictions.
--
-- Not covered (documented limits): signed-out reads of public content
-- (profiles_select_public / posts_select_public are true for anon); public
-- bucket URLs (avatars, share-snapshots) and signed URLs already issued
-- (≤ 300 s); item-image signing decides on public visibility, not on the
-- viewer. ownership_transfers (Transfers, not launching) is deliberately NOT
-- guarded here — a release dependency before Transfers is enabled.
--
-- Section 9 is a separate, narrow account-lifecycle fix: an existing grail
-- rating can no longer be re-pointed at a hidden account's post.
-- ============================================================================

-- ── 1. The block list ───────────────────────────────────────────────────────
CREATE TABLE public.user_blocks (
  blocker_id uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  blocked_id uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
-- "Who blocked me?" lookups for enforcement (server-side only).
CREATE INDEX user_blocks_blocked_idx ON public.user_blocks (blocked_id, blocker_id);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
-- This project's public schema grants clients full table privileges by
-- default: revoke everything, then allow reading (own rows, via RLS) only.
-- Changes go through block_collector / unblock_collector.
REVOKE ALL ON public.user_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_blocks TO authenticated;
GRANT ALL ON public.user_blocks TO service_role;

-- A collector sees only their own outgoing blocks — never who blocked them.
CREATE POLICY user_blocks_select_own ON public.user_blocks
  FOR SELECT TO authenticated
  USING (blocker_id = (SELECT auth.uid()));

-- Account lifecycle compatibility (every public table carries both; see
-- supabase/tests/database/account_lifecycle.test.sql). Rows are only ever
-- visible to their own blocker, so hiding a hidden caller's view is enough.
CREATE POLICY account_lifecycle_read_guard ON public.user_blocks AS RESTRICTIVE
  FOR SELECT TO public
  USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.user_blocks
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- ── 2. Private helpers (not exposed through the API) ───────────────────────
-- Set-based, evaluated once per statement inside the read guards (the same
-- pattern as private.hidden_account_ids). auth.uid() is NULL for anon and
-- the service role, which therefore get the empty set.
CREATE FUNCTION private.blocked_by_me()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(b.blocked_id), '{}') FROM public.user_blocks b WHERE b.blocker_id = auth.uid();
$$;

CREATE FUNCTION private.blocked_me()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(b.blocker_id), '{}') FROM public.user_blocks b WHERE b.blocked_id = auth.uid();
$$;

CREATE FUNCTION private.block_related_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(x.id), '{}') FROM (
    SELECT b.blocked_id AS id FROM public.user_blocks b WHERE b.blocker_id = auth.uid()
    UNION
    SELECT b.blocker_id FROM public.user_blocks b WHERE b.blocked_id = auth.uid()
  ) x;
$$;

-- Is there a block between a and b, in either direction?
CREATE FUNCTION private.users_blocked(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_blocks b
    WHERE (b.blocker_id = p_a AND b.blocked_id = p_b) OR (b.blocker_id = p_b AND b.blocked_id = p_a)
  );
$$;

-- Advisory-lock key for a pair, order-independent. block_collector takes it
-- exclusively; every guarded interaction takes it shared before checking, so
-- a block and an interaction between the same pair never interleave (see
-- section 4).
CREATE FUNCTION private.user_block_pair_key(p_a uuid, p_b uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT hashtextextended('user_block:' || LEAST(p_a, p_b)::text || ':' || GREATEST(p_a, p_b)::text, 0);
$$;

REVOKE ALL ON FUNCTION private.blocked_by_me() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.blocked_me() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.block_related_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.users_blocked(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.user_block_pair_key(uuid, uuid) FROM PUBLIC;
-- Policies and triggers run as the querying role, so it needs EXECUTE; the
-- private schema is not served by the API.
GRANT EXECUTE ON FUNCTION private.blocked_by_me() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.blocked_me() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.block_related_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.users_blocked(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.user_block_pair_key(uuid, uuid) TO authenticated, service_role;

-- ── 3. Client functions ─────────────────────────────────────────────────────
-- block_collector: idempotent. Missing, hidden and unknown targets all get
-- the same neutral account_unavailable. Cap: 1000 blocks per collector,
-- enforced under a per-collector lock so concurrent calls can't exceed it.
CREATE FUNCTION public.block_collector(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '22023';
  END IF;
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'cannot_block_self' USING ERRCODE = '22023';
  END IF;
  IF private.account_is_hidden(v_actor) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) OR private.account_is_hidden(p_user_id) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
  END IF;

  -- This collector's block changes, then this pair (exclusive; interaction
  -- guards take the shared side of the pair lock).
  PERFORM pg_advisory_xact_lock(hashtextextended('user_block_count:' || v_actor::text, 0));
  PERFORM pg_advisory_xact_lock(private.user_block_pair_key(v_actor, p_user_id));

  IF EXISTS (SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = v_actor AND b.blocked_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'blocked', 'already_blocked', true);
  END IF;
  IF (SELECT count(*) FROM public.user_blocks b WHERE b.blocker_id = v_actor) >= 1000 THEN
    RAISE EXCEPTION 'block_limit_reached' USING ERRCODE = '54000';
  END IF;

  -- Unread activity between the pair is marked read (not deleted) so it
  -- can't resurface as new after an unblock.
  UPDATE public.notifications n SET read = true
  WHERE NOT n.read
    AND ((n.user_id = v_actor AND n.actor_id = p_user_id) OR (n.user_id = p_user_id AND n.actor_id = v_actor));

  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (v_actor, p_user_id);

  DELETE FROM public.follows f
  WHERE (f.follower_id = v_actor AND f.following_id = p_user_id) OR (f.follower_id = p_user_id AND f.following_id = v_actor);
  -- Removing a tag also removes its tag notification (existing behaviour of
  -- the *_tags_unnotify triggers).
  DELETE FROM public.collection_item_tags t
  WHERE (t.tagged_by = v_actor AND t.tagged_user_id = p_user_id) OR (t.tagged_by = p_user_id AND t.tagged_user_id = v_actor);
  DELETE FROM public.folder_tags t
  WHERE (t.tagged_by = v_actor AND t.tagged_user_id = p_user_id) OR (t.tagged_by = p_user_id AND t.tagged_user_id = v_actor);

  RETURN jsonb_build_object('status', 'blocked', 'already_blocked', false);
END;
$$;

-- unblock_collector: idempotent; restores nothing (no follows, tags or
-- notifications come back as new).
CREATE FUNCTION public.unblock_collector(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_removed integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '22023';
  END IF;
  IF private.account_is_hidden(v_actor) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('user_block_count:' || v_actor::text, 0));
  DELETE FROM public.user_blocks b WHERE b.blocker_id = v_actor AND b.blocked_id = p_user_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN jsonb_build_object('status', 'unblocked', 'was_blocked', v_removed > 0);
END;
$$;

-- The caller's own block list, newest first. SECURITY DEFINER so a mutual
-- block (the other collector also blocked the caller, hiding their profile)
-- still lists them for unblocking; returns only the basic public identity
-- fields. Accounts pending deletion are left out.
CREATE FUNCTION public.list_blocked_collectors(p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text, blocked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT b.blocked_id, p.username, p.display_name, p.avatar_url, b.created_at
  FROM public.user_blocks b
  JOIN public.profiles p ON p.id = b.blocked_id
  WHERE b.blocker_id = auth.uid()
    AND NOT private.account_is_hidden(auth.uid())
    AND NOT private.account_is_hidden(b.blocked_id)
    AND (p_before IS NULL OR b.created_at < p_before)
  ORDER BY b.created_at DESC, b.blocked_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
$$;

-- Whether the caller blocked this collector. Never reveals whether the
-- other collector blocked the caller.
CREATE FUNCTION public.get_block_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('blocked_by_me', EXISTS (
    SELECT 1 FROM public.user_blocks b WHERE b.blocker_id = auth.uid() AND b.blocked_id = p_user_id
  ));
$$;

REVOKE ALL ON FUNCTION public.block_collector(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unblock_collector(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_blocked_collectors(integer, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_block_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.block_collector(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unblock_collector(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_blocked_collectors(integer, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_block_status(uuid) TO authenticated, service_role;

-- ── 4. Interaction guard ────────────────────────────────────────────────────
-- Row-level BEFORE trigger, the same argument format as
-- private.reject_hidden_interaction_target (which is NOT modified):
--   user:<column> | post:<column> | item:<column> | folder:<column> | conversation
-- The actor is auth.uid(); writes with no end-user identity (service role,
-- internal jobs) pass, as with the lifecycle guards.
-- Concurrency: the shared pair lock is taken BEFORE the block check, and the
-- check runs as a new statement (fresh READ COMMITTED snapshot). Either the
-- interaction holds the lock first — then block_collector waits for it to
-- commit and its DELETEs see (and remove) the new row — or the block holds
-- it first — then the interaction waits and its check sees the committed
-- block.
CREATE FUNCTION private.reject_blocked_interaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_kind   text := split_part(TG_ARGV[0], ':', 1);
  v_column text := split_part(TG_ARGV[0], ':', 2);
  v_error  text := COALESCE(NULLIF(TG_ARGV[1], ''), 'account_unavailable');
  v_new    jsonb := to_jsonb(NEW);
  v_value  uuid;
  v_target uuid;
  v_other  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_kind = 'conversation' THEN
    FOR v_other IN
      SELECT p.user_id FROM public.conversation_participants p
      WHERE p.conversation_id = (v_new ->> 'conversation_id')::uuid AND p.user_id <> v_actor
    LOOP
      PERFORM pg_advisory_xact_lock_shared(private.user_block_pair_key(v_actor, v_other));
      IF private.users_blocked(v_actor, v_other) THEN
        RAISE EXCEPTION '%', v_error USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  v_value := (v_new ->> v_column)::uuid;
  IF v_value IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_kind = 'user' THEN
    v_target := v_value;
  ELSIF v_kind = 'post' THEN
    SELECT p.user_id INTO v_target FROM public.posts p WHERE p.id = v_value;
  ELSIF v_kind = 'item' THEN
    SELECT ci.user_id INTO v_target FROM public.collection_items ci WHERE ci.id = v_value;
  ELSIF v_kind = 'folder' THEN
    SELECT f.user_id INTO v_target FROM public.folders f WHERE f.id = v_value;
  ELSE
    RAISE EXCEPTION 'reject_blocked_interaction: unknown kind %', TG_ARGV[0];
  END IF;

  IF v_target IS NULL OR v_target = v_actor THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(private.user_block_pair_key(v_actor, v_target));
  IF private.users_blocked(v_actor, v_target) THEN
    RAISE EXCEPTION '%', v_error USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.reject_blocked_interaction() FROM PUBLIC;

CREATE TRIGGER user_block_guard BEFORE INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:following_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('post:post_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('post:post_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.grail_ratings
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('post:post_id');
-- grail_ratings_update_own lets a rater change post_id: guard re-pointing too.
CREATE TRIGGER user_block_guard_repoint BEFORE UPDATE OF post_id ON public.grail_ratings
  FOR EACH ROW WHEN (NEW.post_id IS DISTINCT FROM OLD.post_id)
  EXECUTE FUNCTION private.reject_blocked_interaction('post:post_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.item_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.item_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.folder_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('folder:folder_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.folder_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('folder:folder_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.gallery_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('folder:folder_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.saved_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.saved_folders
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('folder:folder_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.saved_grails
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:owner_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:tagged_user_id', 'tag_user_not_found');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:tagged_user_id', 'tag_user_not_found');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('user:user_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('conversation');
-- Sharing the other collector's item into any conversation.
CREATE TRIGGER user_block_guard_attachment BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:attachment_item_id');
CREATE TRIGGER user_block_guard_repost BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('post:repost_of_post_id');
CREATE TRIGGER user_block_guard_quote BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('post:quote_of_post_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.card_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.folder_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.rate_my_grail_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
CREATE TRIGGER user_block_guard BEFORE INSERT ON public.post_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_blocked_interaction('item:item_id');
-- (posts_repost_guard already refuses re-pointing a repost or quote.)

-- ── 5. Notifications between a blocked pair ────────────────────────────────
-- Social notifications only (transfer notifications are untouched). A new
-- one is silently dropped; an update that would make one unread or fresh is
-- skipped; marking read is always allowed.
CREATE FUNCTION private.suppress_blocked_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.type NOT IN ('follow', 'like', 'comment', 'message', 'grail_rating', 'item_tag', 'folder_tag')
     OR NEW.actor_id IS NULL OR NEW.user_id IS NULL OR NEW.actor_id = NEW.user_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.read AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF private.users_blocked(NEW.actor_id, NEW.user_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.suppress_blocked_notification() FROM PUBLIC;

CREATE TRIGGER user_block_notification_guard BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION private.suppress_blocked_notification();

-- ── 6. Read guards (signed-in users only; anon reads are unchanged) ────────
-- RESTRICTIVE: AND-ed with every existing policy, including the lifecycle
-- guards. Each evaluates its set once per statement.
CREATE POLICY user_block_read_guard ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(id = ANY ((SELECT private.blocked_me())::uuid[]), false));

CREATE POLICY user_block_read_guard ON public.posts AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.comments AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.likes AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.grail_ratings AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(rater_user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.collection_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.folders AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.collection_item_images AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.profile_grail_slots AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.profile_showcase_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.item_comments AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.item_likes AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
-- Folder interactions: their permissive policies use a SECURITY DEFINER
-- visibility helper (not RLS), so also require the folder itself to be
-- visible to the caller (RLS-checked, including this guard on folders).
CREATE POLICY user_block_read_guard ON public.folder_comments AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_comments.folder_id));
CREATE POLICY user_block_read_guard ON public.folder_likes AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_likes.folder_id));
CREATE POLICY user_block_read_guard ON public.gallery_comments AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND EXISTS (SELECT 1 FROM public.folders f WHERE f.id = gallery_comments.folder_id));
CREATE POLICY user_block_read_guard ON public.follows AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(follower_id = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND NOT COALESCE(following_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.collection_item_tags AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(tagged_by = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND NOT COALESCE(tagged_user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.folder_tags AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(tagged_by = ANY ((SELECT private.block_related_ids())::uuid[]), false)
         AND NOT COALESCE(tagged_user_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.saved_grails AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT COALESCE(owner_id = ANY ((SELECT private.block_related_ids())::uuid[]), false));
CREATE POLICY user_block_read_guard ON public.notifications AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (type IN ('follow', 'like', 'comment', 'message', 'grail_rating', 'item_tag', 'folder_tag')
              AND COALESCE(actor_id = ANY ((SELECT private.block_related_ids())::uuid[]), false)));
-- Comments, likes, ratings, share items, post images and Rate-My-Grails cards
-- on a hidden post are already hidden: their account_lifecycle_read_guard
-- requires EXISTS (posts …), which RLS now filters with this guard. Item
-- comments/likes require their item (RLS-checked) the same way. Messages,
-- conversations and participants are deliberately not guarded (history).

-- ── 7. Direct conversations ─────────────────────────────────────────────────
-- Same body as 20261104120000_account_lifecycle_dm_privacy.sql plus the
-- marked block check (also enforced by the conversation_participants and
-- messages guards).
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(other_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  conv_id uuid;
  caller_id uuid;
  lock_key bigint;
BEGIN
  caller_id := auth.uid();

  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF other_user_id IS NULL THEN
    RAISE EXCEPTION 'Recipient is required';
  END IF;

  IF caller_id = other_user_id THEN
    RAISE EXCEPTION 'Cannot create a conversation with yourself';
  END IF;

  -- Account lifecycle (20261104120000): neither side may be pending
  -- deletion — including when the conversation already exists.
  IF private.account_is_hidden(caller_id) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE = '42501';
  END IF;
  IF private.account_is_hidden(other_user_id) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
  END IF;

  -- Collector blocking (20261112120000): no conversation with a collector
  -- either side has blocked — same neutral token as an unavailable account.
  IF private.users_blocked(caller_id, other_user_id) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '42501';
  END IF;

  -- Deterministic, order-independent lock key for this pair: canonicalize
  -- via (LEAST, GREATEST) so A→B and B→A calls always compute the
  -- identical key, then reduce the pair's 256 bits into one 64-bit
  -- advisory-lock key via hashtextextended — a built-in deterministic
  -- hash that produces the same output for the same input across
  -- concurrent calls on this database. Unrelated pairs can theoretically
  -- map to the same 64-bit key (256 bits of input onto a 64-bit key
  -- space). That only matters if two such unrelated pairs happen to
  -- attempt conversation creation at the same time — the consequence is
  -- one pair briefly, unnecessarily waiting on the other's lock, nothing
  -- more. It can never return the wrong conversation or corrupt data:
  -- the lookup below runs after the lock is acquired and is still keyed
  -- on the real caller_id/other_user_id values, not on the lock key
  -- itself, so a collision can only cost time, never correctness.
  lock_key := hashtextextended(
    LEAST(caller_id, other_user_id)::text || ':' || GREATEST(caller_id, other_user_id)::text,
    0
  );

  -- Transaction-scoped: released automatically on COMMIT or ROLLBACK, no
  -- matching unlock call exists or is needed. Only this exact pair's key
  -- is locked, so unrelated pairs' creation calls are normally unaffected
  -- by this — this is not a global serializing lock.
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Lookup runs after the lock is held, so a concurrent caller for the
  -- same pair that just committed a new conversation is visible here.
  SELECT cp1.conversation_id INTO conv_id
  FROM conversation_participants cp1
  JOIN conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.user_id = caller_id
    AND cp2.user_id = other_user_id
  LIMIT 1;

  IF conv_id IS NOT NULL THEN
    RETURN conv_id;
  END IF;

  INSERT INTO conversations DEFAULT VALUES
  RETURNING id INTO conv_id;

  INSERT INTO conversation_participants (conversation_id, user_id)
  VALUES
    (conv_id, caller_id),
    (conv_id, other_user_id);

  RETURN conv_id;
END;
$function$;

-- ── 8. Verification ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  -- Every lifecycle-guarded interaction table (except Transfers) has a
  -- block guard too.
  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE t.tgname = 'interaction_target_guard' AND c.relname <> 'ownership_transfers'
    AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = t.tgrelid AND g.tgname = 'user_block_guard');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'user blocking: interaction tables without user_block_guard: %', v_missing;
  END IF;
END;
$$;

-- ── 9. Account lifecycle: no re-pointing a grail rating at a hidden post ───
-- Separate, narrow fix (Phase 1B). The lifecycle interaction guard only ran
-- on INSERT, and grail_ratings_update_own lets a rater change post_id, so an
-- existing rating could be moved onto a hidden collector's post. This reuses
-- the unchanged lifecycle guard for that one UPDATE; every other rating
-- behaviour (score updates, own-post rules, notifications) is unchanged.
CREATE TRIGGER interaction_target_guard_repoint BEFORE UPDATE OF post_id ON public.grail_ratings
  FOR EACH ROW WHEN (NEW.post_id IS DISTINCT FROM OLD.post_id)
  EXECUTE FUNCTION private.reject_hidden_interaction_target('post:post_id');

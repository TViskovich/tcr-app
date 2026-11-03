-- ============================================================================
-- Account lifecycle — Dashboard Milestone 2, Checkpoint 1 (reversible
-- foundation for account deletion).
--
-- A collector is ACTIVE unless they have an account_lifecycle row:
--   pending_deletion — scheduled deletion with a recovery window
--   deleting         — the point of no return (permanent deletion runs)
--
-- While a row exists the account is HIDDEN and FROZEN, enforced here in the
-- database rather than in the app:
--   * Reads — a RESTRICTIVE select policy on every public table hides the
--     collector's rows from everyone else (signed in or anonymous), and
--     hides everything except their own lifecycle row from the collector
--     themselves. The SECURITY DEFINER visibility helpers (folder privacy,
--     Grails showcase, item visibility, image signing) learn the same rule,
--     so no definer path re-exposes hidden content.
--   * Writes — a statement-level guard trigger on every public table
--     rejects any write made with the collector's identity, whether it
--     comes from PostgREST, a SECURITY DEFINER function or a trigger. Writes
--     with no end-user identity (service role, internal cleanup) pass.
--   * Interactions — other collectors can't follow, like, comment, tag,
--     message, save, share or start a conversation/transfer with them.
--   * Storage — restrictive policies stop uploads, updates, deletes and
--     policy-gated reads by the collector.
--
-- Nothing here deletes, moves or copies data. Cancelling (removing the
-- pending row) makes every original row visible again exactly as it was.
-- Permanent deletion, export and scheduling are later checkpoints; this
-- migration only adds the state model and server-only transition functions
-- they will call.
--
-- Known limits (not enforceable by Postgres): objects in the PUBLIC buckets
-- (avatars, share-snapshots) stay reachable by anyone already holding their
-- URL; signed URLs already issued for private images stay valid until they
-- expire (300 s); service-role Edge Functions check the caller's state
-- themselves (supabase/functions/_shared).
-- ============================================================================

-- ── Private helpers (not exposed through the API) ───────────────────────────
-- Policies need EXECUTE on the helper, but a public RPC would let anyone ask
-- "is this account pending deletion?". The API only serves public and
-- graphql_public (supabase/config.toml), so the helpers live in `private`.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

-- ── State table ─────────────────────────────────────────────────────────────
CREATE TABLE public.account_lifecycle (
  user_id             uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  state               text NOT NULL CHECK (state IN ('pending_deletion', 'deleting')),
  mode                text NOT NULL CHECK (mode IN ('scheduled', 'immediate')),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  scheduled_for       timestamptz,
  deleting_started_at timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_lifecycle_pending_shape
    CHECK (state <> 'pending_deletion' OR (mode = 'scheduled' AND scheduled_for IS NOT NULL AND deleting_started_at IS NULL)),
  CONSTRAINT account_lifecycle_deleting_shape
    CHECK (state <> 'deleting' OR deleting_started_at IS NOT NULL)
);

COMMENT ON TABLE public.account_lifecycle IS
  'Non-active accounts only (no row = active). Written exclusively by the service-role transition functions below.';

CREATE INDEX account_lifecycle_due_idx
  ON public.account_lifecycle (scheduled_for)
  WHERE state = 'pending_deletion';

ALTER TABLE public.account_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_lifecycle FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_lifecycle TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_lifecycle TO service_role;

-- A collector may read only their own state (what a pending collector's app
-- needs to show the recovery screen). Nobody else can tell they're pending.
CREATE POLICY account_lifecycle_select_own ON public.account_lifecycle
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ── Hidden-account helpers ──────────────────────────────────────────────────
CREATE FUNCTION private.account_is_hidden(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.account_lifecycle l WHERE l.user_id = p_user_id);
$$;

-- The current request's identity (auth.uid()) is a hidden account.
CREATE FUNCTION private.caller_is_hidden()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.account_is_hidden(auth.uid());
$$;

REVOKE ALL ON FUNCTION private.account_is_hidden(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.caller_is_hidden() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.account_is_hidden(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.caller_is_hidden() TO anon, authenticated, service_role;

-- ── Transition rules (enforced for every role, service role included) ──────
--   insert: active → pending_deletion (scheduled) | active → deleting (immediate)
--   update: pending_deletion → deleting only
--   delete: pending_deletion → active (cancel); a deleting row disappears
--           only with its auth user (ON DELETE CASCADE), never on its own
-- SECURITY DEFINER so the cascade check can read auth.users whichever role
-- performs the change (service role, or the auth service during deletion).
CREATE FUNCTION private.enforce_account_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.state = 'pending_deletion' AND NEW.mode = 'scheduled')
       OR (NEW.state = 'deleting' AND NEW.mode = 'immediate') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'account_lifecycle_invalid_transition' USING ERRCODE = 'P0001';

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
      RAISE EXCEPTION 'account_lifecycle_immutable' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.state = 'pending_deletion' AND NEW.state = 'deleting' THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'account_lifecycle_invalid_transition' USING ERRCODE = 'P0001';

  ELSE -- DELETE
    IF OLD.state = 'pending_deletion' THEN
      RETURN OLD;
    END IF;
    -- ON DELETE CASCADE runs after the auth user row is gone.
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'account_lifecycle_deleting_is_final' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TRIGGER account_lifecycle_transition
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_lifecycle
  FOR EACH ROW EXECUTE FUNCTION private.enforce_account_lifecycle_transition();

-- ── Server-only transition functions (future Edge Functions / scheduler) ───
-- SECURITY INVOKER and executable by service_role only: a client can't call
-- them, and even if it could it has no write privilege on the table.

-- active → pending_deletion. Recovery window in days (product: 14).
CREATE FUNCTION public.schedule_account_deletion(p_user_id uuid, p_recovery_days integer DEFAULT 14)
RETURNS public.account_lifecycle
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.account_lifecycle;
BEGIN
  IF p_recovery_days IS NULL OR p_recovery_days < 1 OR p_recovery_days > 30 THEN
    RAISE EXCEPTION 'account_lifecycle_invalid_recovery_window' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.account_lifecycle WHERE user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'account_lifecycle_already_%', v_row.state USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.account_lifecycle (user_id, state, mode, scheduled_for)
  VALUES (p_user_id, 'pending_deletion', 'scheduled', now() + make_interval(days => p_recovery_days))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- pending_deletion → active. true = restored, false = was already active.
-- Raises once deletion has started.
CREATE FUNCTION public.cancel_account_deletion(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT state INTO v_state FROM public.account_lifecycle WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_state <> 'pending_deletion' THEN
    RAISE EXCEPTION 'account_lifecycle_deleting_is_final' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.account_lifecycle WHERE user_id = p_user_id;
  RETURN true;
END;
$$;

-- active → deleting ('immediate'), or pending_deletion → deleting
-- ('immediate' when the collector chooses Delete Now, 'scheduled' when the
-- window ends). Idempotent: an account already deleting is returned as is.
CREATE FUNCTION public.begin_account_deletion(p_user_id uuid, p_mode text)
RETURNS public.account_lifecycle
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.account_lifecycle;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('scheduled', 'immediate') THEN
    RAISE EXCEPTION 'account_lifecycle_invalid_mode' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.account_lifecycle WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_mode <> 'immediate' THEN
      RAISE EXCEPTION 'account_lifecycle_not_scheduled' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.account_lifecycle (user_id, state, mode, deleting_started_at)
    VALUES (p_user_id, 'deleting', 'immediate', now())
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  IF v_row.state = 'deleting' THEN
    RETURN v_row;
  END IF;
  IF p_mode = 'scheduled' AND v_row.scheduled_for > now() THEN
    RAISE EXCEPTION 'account_lifecycle_not_due' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.account_lifecycle
  SET state = 'deleting', mode = p_mode, deleting_started_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Accounts whose recovery window has ended, oldest first (for the future
-- scheduler; it calls begin_account_deletion(id, 'scheduled') for each).
CREATE FUNCTION public.list_due_account_deletions(p_limit integer DEFAULT 50)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT user_id FROM public.account_lifecycle
  WHERE state = 'pending_deletion' AND scheduled_for <= now()
  ORDER BY scheduled_for, user_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.schedule_account_deletion(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_account_deletion(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_due_account_deletions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_account_deletion(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_account_deletions(integer) TO service_role;

-- ── Write guard: a hidden collector can't change anything ───────────────────
-- Statement-level, so it costs one lookup per statement and also covers
-- writes made inside SECURITY DEFINER functions and triggers (RLS doesn't
-- apply there). auth.uid() is NULL for the service role and for internal
-- jobs, which therefore pass.
CREATE FUNCTION private.guard_account_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF private.caller_is_hidden() THEN
    RAISE EXCEPTION 'account_inactive'
      USING ERRCODE = '42501', HINT = 'This account is scheduled for deletion.';
  END IF;
  RETURN NULL;
END;
$$;

-- ── Interaction guard: nobody can reach a hidden collector ──────────────────
-- Row-level BEFORE INSERT/UPDATE. TG_ARGV[0] names how to find the account
-- the new row targets; TG_ARGV[1] is the error to raise (defaults to
-- account_unavailable; tags reuse the existing tag_user_not_found token so
-- the app's copy applies unchanged).
--   user:<column>   the column holds a user id
--   post:<column>   the column holds a post id      (its author)
--   item:<column>   the column holds an item id     (its owner)
--   folder:<column> the column holds a folder id    (its owner)
--   conversation    every other participant of NEW.conversation_id
CREATE FUNCTION private.reject_hidden_interaction_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind   text := split_part(TG_ARGV[0], ':', 1);
  v_column text := split_part(TG_ARGV[0], ':', 2);
  v_error  text := COALESCE(NULLIF(TG_ARGV[1], ''), 'account_unavailable');
  v_value  uuid;
  v_target uuid;
  v_new    jsonb := to_jsonb(NEW);
BEGIN
  IF v_kind = 'conversation' THEN
    IF EXISTS (
      SELECT 1 FROM public.conversation_participants p
      WHERE p.conversation_id = (v_new ->> 'conversation_id')::uuid
        AND p.user_id IS DISTINCT FROM (v_new ->> 'sender_id')::uuid
        AND private.account_is_hidden(p.user_id)
    ) THEN
      RAISE EXCEPTION '%', v_error USING ERRCODE = '42501';
    END IF;
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
    RAISE EXCEPTION 'reject_hidden_interaction_target: unknown kind %', TG_ARGV[0];
  END IF;

  IF private.account_is_hidden(v_target) THEN
    RAISE EXCEPTION '%', v_error USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:following_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('post:post_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('post:post_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.grail_ratings
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('post:post_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.item_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.item_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.folder_likes
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('folder:folder_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.folder_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('folder:folder_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.gallery_comments
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('folder:folder_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.saved_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.saved_folders
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('folder:folder_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.saved_grails
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:owner_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.collection_item_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:tagged_user_id', 'tag_user_not_found');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.folder_tags
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:tagged_user_id', 'tag_user_not_found');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.conversation_participants
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:user_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('conversation');
CREATE TRIGGER interaction_target_guard_repost BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('post:repost_of_post_id');
CREATE TRIGGER interaction_target_guard_quote BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('post:quote_of_post_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.card_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.folder_share_items
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.rate_my_grail_cards
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.post_images
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('item:item_id');
-- Registry/transfer infrastructure (unreleased): no transfer to, and no
-- acceptance of a transfer from, a hidden collector.
CREATE TRIGGER interaction_target_guard BEFORE INSERT ON public.ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION private.reject_hidden_interaction_target('user:to_owner_id');
CREATE TRIGGER interaction_target_guard_accept BEFORE UPDATE OF status ON public.ownership_transfers
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION private.reject_hidden_interaction_target('user:from_owner_id');

-- ── Read guard + write guard on EVERY public table ──────────────────────────
-- One RESTRICTIVE select policy per table (ANDed with the existing
-- permissive policies, none of which change):
--   * the caller must not be hidden (a pending collector sees nothing but
--     their own lifecycle row), and
--   * rows owned by, authored by or pointing at a hidden collector are
--     hidden from everyone else.
-- Tables without an entry below get the caller rule only. Owner-hiding for
-- detail tables (item details, images, view counts, registry events…)
-- comes through their existing EXISTS (…) policies, which read the parent
-- table under its (now restrictive) RLS.
DO $$
DECLARE
  v_extra jsonb := jsonb_build_object(
    'profiles',               'NOT private.account_is_hidden(id)',
    'folders',                'NOT private.account_is_hidden(user_id)',
    'collection_items',       'NOT private.account_is_hidden(user_id)',
    'collection_item_images', 'NOT private.account_is_hidden(user_id)',
    'posts',                  'NOT private.account_is_hidden(user_id)',
    'comments',               'NOT private.account_is_hidden(user_id) AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'likes',                  'NOT private.account_is_hidden(user_id) AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'grail_ratings',          'NOT private.account_is_hidden(rater_user_id) AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'card_share_items',       'EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'folder_share_items',     'EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'rate_my_grail_cards',    'EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_id)',
    'item_likes',             'NOT private.account_is_hidden(user_id)',
    'item_comments',          'NOT private.account_is_hidden(user_id)',
    'folder_likes',           'NOT private.account_is_hidden(user_id)',
    'folder_comments',        'NOT private.account_is_hidden(user_id)',
    'gallery_comments',       'NOT private.account_is_hidden(user_id)',
    'follows',                'NOT private.account_is_hidden(follower_id) AND NOT private.account_is_hidden(following_id)',
    'profile_grail_slots',    'NOT private.account_is_hidden(user_id)',
    'profile_showcase_items', 'NOT private.account_is_hidden(user_id)',
    'collection_item_tags',   'NOT private.account_is_hidden(tagged_by) AND NOT private.account_is_hidden(tagged_user_id)',
    'folder_tags',            'NOT private.account_is_hidden(tagged_by) AND NOT private.account_is_hidden(tagged_user_id)',
    'notifications',          'NOT private.account_is_hidden(actor_id)',
    'saved_grails',           'NOT private.account_is_hidden(owner_id)',
    'registered_cards',       'NOT private.account_is_hidden(current_owner_id)',
    'sales_events',           'EXISTS (SELECT 1 FROM public.registered_cards rc WHERE rc.id = registered_card_id)',
    'businesses',             'NOT private.account_is_hidden(claimed_by_user_id)'
  );
  v_table text;
  v_using text;
BEGIN
  FOR v_table IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'account_lifecycle'
    ORDER BY c.relname
  LOOP
    v_using := 'NOT (SELECT private.caller_is_hidden())';
    IF v_extra ? v_table THEN
      v_using := v_using || ' AND ' || (v_extra ->> v_table);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('CREATE POLICY account_lifecycle_read_guard ON public.%I AS RESTRICTIVE FOR SELECT TO public USING (%s)', v_table, v_using);
    EXECUTE format('CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write()', v_table);
  END LOOP;
END;
$$;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- A hidden collector can't upload, replace, delete or read through Storage's
-- policy-gated API. (Public-bucket URLs bypass policies entirely; see the
-- header.)
CREATE POLICY account_lifecycle_read_guard ON storage.objects AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE POLICY account_lifecycle_insert_guard ON storage.objects AS RESTRICTIVE
  FOR INSERT TO public WITH CHECK (NOT (SELECT private.caller_is_hidden()));
CREATE POLICY account_lifecycle_update_guard ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE POLICY account_lifecycle_delete_guard ON storage.objects AS RESTRICTIVE
  FOR DELETE TO public USING (NOT (SELECT private.caller_is_hidden()));

-- ── SECURITY DEFINER visibility helpers learn the same rule ────────────────
-- These bypass RLS, so each one checks hidden owners (and hidden callers)
-- itself. Bodies are unchanged apart from the marked lines.

CREATE OR REPLACE FUNCTION public._folder_is_effectively_visible_for(target_folder_id uuid, caller uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  current_is_public boolean;
  current_parent uuid;
  target_owner uuid;
  visited uuid[] := ARRAY[]::uuid[];
  hops integer := 0;
BEGIN
  IF target_folder_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT f.is_public, f.parent_folder_id, f.user_id
    INTO current_is_public, current_parent, target_owner
    FROM public.folders f
    WHERE f.id = target_folder_id;

  IF NOT FOUND THEN
    RETURN false; -- nonexistent folder — fail closed, never leak existence
  END IF;

  -- Account lifecycle: a hidden owner's folders are invisible to everyone,
  -- and a hidden caller sees no folders (added by 20261103120000).
  IF private.account_is_hidden(target_owner) OR private.account_is_hidden(caller) THEN
    RETURN false;
  END IF;

  -- Owner of the target folder always sees their own tree, regardless of
  -- any ancestor's privacy. Checked against the TARGET's own owner only
  -- (not re-checked per ancestor) — a correctly-created tree has exactly
  -- one owner throughout (see the parent-ownership WITH CHECK below), and
  -- scoping the override to the leaf folder being asked about means a
  -- malformed/legacy cross-owner attachment can never silently grant
  -- access to a folder the caller doesn't actually own.
  IF caller IS NOT NULL AND caller = target_owner THEN
    RETURN true;
  END IF;

  LOOP
    IF NOT current_is_public THEN
      RETURN false; -- most-restrictive-wins: any non-public node blocks a non-owner
    END IF;

    IF current_parent IS NULL THEN
      RETURN true; -- reached the root; every node so far (incl. target) was public
    END IF;

    hops := hops + 1;
    IF hops > 100 OR current_parent = ANY(visited) THEN
      RETURN false; -- pathological/cyclic stored data — fail closed, never trust it
    END IF;
    visited := visited || current_parent;

    SELECT f.is_public, f.parent_folder_id
      INTO current_is_public, current_parent
      FROM public.folders f
      WHERE f.id = current_parent;

    IF NOT FOUND THEN
      RETURN false; -- broken ancestor chain (should be impossible under ON DELETE
                     -- SET NULL, but fail closed rather than assume) — never trust it
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public._item_visible_to(p_item_id uuid, p_viewer uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT NOT private.account_is_hidden(p_viewer) -- account lifecycle (20261103120000)
    AND EXISTS (
    SELECT 1 FROM public.collection_items ci
    WHERE ci.id = p_item_id
      AND NOT private.account_is_hidden(ci.user_id) -- account lifecycle (20261103120000)
      AND (
        (
          public._folder_is_effectively_visible_for(ci.folder_id, p_viewer)
          AND (ci.is_public = true OR ci.user_id = p_viewer)
        )
        OR EXISTS (
          SELECT 1 FROM public.profile_grail_slots gs
          WHERE gs.entry_type = 'item'
            AND gs.item_id = ci.id
            AND gs.user_id = ci.user_id
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.item_is_grail_showcased(target_item_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_grail_slots gs
    WHERE gs.entry_type = 'item' AND gs.item_id = target_item_id
      AND NOT private.account_is_hidden(gs.user_id) -- account lifecycle (20261103120000)
  );
$function$;

CREATE OR REPLACE FUNCTION public.folder_is_grail_showcased(target_folder_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_grail_slots gs
    WHERE gs.entry_type = 'collection' AND gs.collection_id = target_folder_id
      AND NOT private.account_is_hidden(gs.user_id) -- account lifecycle (20261103120000)
  );
$function$;

-- Image signing (get-collection-item-image-signed-url): a hidden owner's
-- images never resolve, so no caller — including the owner — gets a URL.
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
      img.storage_path AS storage_path,
      f.id             AS folder_id,
      f.user_id        AS owner_id,
      ci.is_public     AS item_is_public
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
    r.item_is_public,
    fv.visible,
    EXISTS (
      SELECT 1
      FROM public.profile_grail_slots gs
      WHERE gs.entry_type = 'item'
        AND gs.item_id = r.item_id
        AND gs.user_id = r.owner_id
    )
  FROM resolved r
  JOIN folder_visibility fv ON fv.folder_id = r.folder_id;
$function$;

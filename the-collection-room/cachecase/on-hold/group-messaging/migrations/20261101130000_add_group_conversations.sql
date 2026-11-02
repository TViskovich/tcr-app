BEGIN;

-- ============================================================================
-- Group messaging — M1, Checkpoint 1: database foundation and security.
--
-- Extends the existing direct-message tables (conversations,
-- conversation_participants, messages); there is no second messaging system.
-- Every existing conversation is a 'direct' one and keeps working unchanged:
-- same rows, same URLs, same read markers, notifications and dedupe.
--
--   conversations             + kind ('direct' | 'group', default 'direct'),
--                               name (groups only), created_by
--   conversation_participants + role ('admin' | 'member'), joined_at, added_by
--   conversation_group_departures — who voluntarily left which group (and who
--                               had added them): the anti-abuse record below
--
-- Membership changes go ONLY through SECURITY DEFINER functions that take
-- the caller from auth.uid() and lock the conversation row first, so checks
-- (admin-only, the 32-member cap, last-admin succession) can't race:
--   create_group_conversation, add_group_members, remove_group_member,
--   leave_group, rename_group, set_group_member_role.
-- Clients can no longer write any membership/conversation column directly:
-- they may only update their own last_read_at and hidden_at.
--
-- Also in this migration:
--   * get_or_create_conversation matches DIRECT conversations only — a group
--     that happens to contain both users is never returned as their DM.
--   * SF-1 (docs/security-follow-ups.md): every policy now uses the
--     caller-scoped is_my_conversation(conv); the two-argument
--     is_conversation_participant(conv, uid) — which let any signed-in user
--     ask about anyone's membership — is no longer executable by clients.
--   * messages.created_at is stamped by the server for client inserts, so a
--     client can't forge message times (ordering, unread state).
--
-- Group typing indicators stay off (client-side) until Realtime channels are
-- private; nothing here changes typing.
-- ============================================================================

-- ── 1. Columns ──────────────────────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('direct', 'group'));
-- A name only on a group; trimmed, 1–50 characters.
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_name_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_name_check CHECK (
    name IS NULL
    OR (kind = 'group' AND name = btrim(name) AND char_length(name) BETWEEN 1 AND 50)
  );

-- The group-creation rate limit's lookup.
CREATE INDEX IF NOT EXISTS conversations_group_created_by_idx
  ON public.conversations (created_by, created_at)
  WHERE kind = 'group';

ALTER TABLE public.conversation_participants
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.conversation_participants DROP CONSTRAINT IF EXISTS conversation_participants_role_check;
ALTER TABLE public.conversation_participants
  ADD CONSTRAINT conversation_participants_role_check CHECK (role IN ('admin', 'member'));

-- Existing (direct) participants joined when their conversation began.
UPDATE public.conversation_participants cp
SET joined_at = c.created_at
FROM public.conversations c
WHERE c.id = cp.conversation_id
  AND cp.joined_at > c.created_at;

-- ── 2. Anti-abuse: voluntary departures ────────────────────────────────────
-- One row per (group, user) who LEFT it themselves (admin removal is not
-- recorded). Two rules read it, in add_group_members /
-- create_group_conversation:
--   * a group can never re-add someone who left it;
--   * whoever had added a person can't add them to ANY group for 7 days
--     after they leave (stops "leave, get re-added to a new group" loops).
-- Server-only: RLS on, no policies, no client privileges.
CREATE TABLE IF NOT EXISTS public.conversation_group_departures (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  left_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_group_departures_cooldown_idx
  ON public.conversation_group_departures (user_id, added_by, left_at);
ALTER TABLE public.conversation_group_departures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversation_group_departures FROM PUBLIC, anon, authenticated;

-- ── 3. Caller-scoped membership check (SF-1) ───────────────────────────────
-- "Is the CALLER a participant of this conversation?" — the caller is
-- auth.uid(), never an argument, so nobody can ask about anyone else.
-- SECURITY DEFINER so RLS on conversation_participants can call it without
-- recursing into itself.
CREATE OR REPLACE FUNCTION public.is_my_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.user_id = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_my_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_conversation(uuid) TO authenticated, service_role;

-- Policies: same rules as before, now caller-scoped and signed-in only (a
-- signed-out request gets nothing instead of an error).
DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
CREATE POLICY "conversations_select" ON public.conversations
  FOR SELECT TO authenticated
  USING (public.is_my_conversation(id));

-- Conversations are written only by the server (functions/triggers) now.
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;

DROP POLICY IF EXISTS "messages_select" ON public.messages;
CREATE POLICY "messages_select" ON public.messages
  FOR SELECT TO authenticated
  USING (public.is_my_conversation(conversation_id));

DROP POLICY IF EXISTS "messages_insert" ON public.messages;
CREATE POLICY "messages_insert" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND public.is_my_conversation(conversation_id));

DROP POLICY IF EXISTS "participants_select" ON public.conversation_participants;
CREATE POLICY "participants_select" ON public.conversation_participants
  FOR SELECT TO authenticated
  USING (public.is_my_conversation(conversation_id));

DROP POLICY IF EXISTS "dm_attachments_select_participant" ON storage.objects;
CREATE POLICY "dm_attachments_select_participant" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'dm-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    AND public.is_my_conversation(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "dm_attachments_insert_participant" ON storage.objects;
CREATE POLICY "dm_attachments_insert_participant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'dm-attachments'
    AND name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/image\.jpg$'
    AND public.is_my_conversation(((storage.foldername(name))[1])::uuid)
  );

-- No policy uses it any more; server-side code may still call it.
REVOKE EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid) TO service_role;

-- ── 4. Client write privileges ────────────────────────────────────────────
-- Clients keep reading through RLS; the only client write left on these two
-- tables is a participant's own read marker / inbox-hide flag (the
-- participants_update_own policies already limit that to their own row).
REVOKE ALL ON TABLE public.conversations FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.conversations FROM authenticated;

REVOKE ALL ON TABLE public.conversation_participants FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.conversation_participants FROM authenticated;
GRANT UPDATE (last_read_at, hidden_at) ON TABLE public.conversation_participants TO authenticated;

-- Messages are insert-only for clients (there were never update/delete
-- policies; the privileges go too).
REVOKE ALL ON TABLE public.messages FROM anon;
REVOKE UPDATE, DELETE ON TABLE public.messages FROM authenticated;

-- ── 5. Server-stamped message times ──────────────────────────────────────
-- A client insert always gets the server's time; trusted server-side roles
-- (service_role, migrations, seeding scripts) keep what they set.
CREATE OR REPLACE FUNCTION public.stamp_message_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_message_created_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_stamp_created_at ON public.messages;
CREATE TRIGGER messages_stamp_created_at
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_message_created_at();

-- ── 6. Direct conversations: direct only ─────────────────────────────────
-- Same body as 20260725130000 (advisory-lock dedupe, same errors), except
-- that only a conversation of kind 'direct' can be returned, and a new one is
-- created as kind 'direct' with its creator recorded.
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

  lock_key := hashtextextended(
    LEAST(caller_id, other_user_id)::text || ':' || GREATEST(caller_id, other_user_id)::text,
    0
  );
  PERFORM pg_advisory_xact_lock(lock_key);

  SELECT cp1.conversation_id INTO conv_id
  FROM public.conversation_participants cp1
  JOIN public.conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
  JOIN public.conversations c
    ON c.id = cp1.conversation_id
  WHERE cp1.user_id = caller_id
    AND cp2.user_id = other_user_id
    AND c.kind = 'direct'
  LIMIT 1;

  IF conv_id IS NOT NULL THEN
    RETURN conv_id;
  END IF;

  INSERT INTO public.conversations (kind, created_by) VALUES ('direct', caller_id) RETURNING id INTO conv_id;
  INSERT INTO public.conversation_participants (conversation_id, user_id, added_by)
  VALUES (conv_id, caller_id, caller_id), (conv_id, other_user_id, caller_id);

  RETURN conv_id;
END;
$function$;

-- ── 7. Group management ────────────────────────────────────────────────────
-- Errors use stable message tokens the app can map to copy:
--   not_authenticated, group_invalid_name, group_invalid_member_count,
--   group_duplicate_member, group_member_not_found, group_member_unavailable,
--   group_rate_limited, group_full, not_group_member, not_group_admin,
--   cannot_remove_self, last_group_admin, group_invalid_role.
-- A caller who isn't a member of the group gets not_group_member whether or
-- not it exists.

-- Shared validation for a list of people to add: non-empty, no NULLs, no
-- duplicates, never the caller, every one an existing profile, and none
-- barred by the departure rules. p_conversation_id is NULL for a new group.
CREATE OR REPLACE FUNCTION public._validate_group_additions(
  p_caller uuid,
  p_conversation_id uuid,
  p_member_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_member_ids IS NULL OR cardinality(p_member_ids) = 0 THEN
    RAISE EXCEPTION 'group_invalid_member_count' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_member_ids) AS m(id) WHERE m.id IS NULL) THEN
    RAISE EXCEPTION 'group_member_not_found' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_member_ids) <> (SELECT count(DISTINCT m.id) FROM unnest(p_member_ids) AS m(id))
     OR p_caller = ANY (p_member_ids) THEN
    RAISE EXCEPTION 'group_duplicate_member' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_member_ids) AS m(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.id)
  ) THEN
    RAISE EXCEPTION 'group_member_not_found' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_member_ids) AS m(id)
    JOIN public.conversation_group_departures d ON d.user_id = m.id
    WHERE (p_conversation_id IS NOT NULL AND d.conversation_id = p_conversation_id)
       OR (d.added_by = p_caller AND d.left_at > now() - interval '7 days')
  ) THEN
    RAISE EXCEPTION 'group_member_unavailable' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._validate_group_additions(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- Locks a group's conversation row and returns the caller's role in it.
-- Raises not_group_member when it isn't a group or the caller isn't in it.
CREATE OR REPLACE FUNCTION public._lock_group_for_caller(p_caller uuid, p_conversation_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.kind = 'group'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_group_member' USING ERRCODE = '42501';
  END IF;
  SELECT cp.role INTO v_role
  FROM public.conversation_participants cp
  WHERE cp.conversation_id = p_conversation_id AND cp.user_id = p_caller;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not_group_member' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public._lock_group_for_caller(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Creates a group of the caller (admin) plus 2–31 others (3–32 total), with
-- an optional name. At most 10 new groups per caller per 24 hours.
CREATE OR REPLACE FUNCTION public.create_group_conversation(p_member_ids uuid[], p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_name   text := NULLIF(btrim(p_name), '');
  v_id     uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NOT NULL AND char_length(v_name) > 50 THEN
    RAISE EXCEPTION 'group_invalid_name' USING ERRCODE = '22023';
  END IF;
  IF p_member_ids IS NULL OR cardinality(p_member_ids) + 1 NOT BETWEEN 3 AND 32 THEN
    RAISE EXCEPTION 'group_invalid_member_count' USING ERRCODE = '22023';
  END IF;
  PERFORM public._validate_group_additions(v_caller, NULL, p_member_ids);

  -- Serialize one caller's creations so the rate limit can't be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('create_group_conversation:' || v_caller::text, 0));
  IF (
    SELECT count(*) FROM public.conversations c
    WHERE c.kind = 'group' AND c.created_by = v_caller AND c.created_at > now() - interval '24 hours'
  ) >= 10 THEN
    RAISE EXCEPTION 'group_rate_limited' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.conversations (kind, name, created_by)
  VALUES ('group', v_name, v_caller)
  RETURNING id INTO v_id;

  INSERT INTO public.conversation_participants (conversation_id, user_id, role, added_by)
  VALUES (v_id, v_caller, 'admin', v_caller);
  INSERT INTO public.conversation_participants (conversation_id, user_id, role, added_by)
  SELECT v_id, m.id, 'member', v_caller FROM unnest(p_member_ids) AS m(id);

  RETURN v_id;
END;
$$;

-- Admin only. Adds people (as members) up to 32 in total. Returns how many
-- were added.
CREATE OR REPLACE FUNCTION public.add_group_members(p_conversation_id uuid, p_member_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_count  integer;
BEGIN
  IF public._lock_group_for_caller(v_caller, p_conversation_id) <> 'admin' THEN
    RAISE EXCEPTION 'not_group_admin' USING ERRCODE = '42501';
  END IF;
  PERFORM public._validate_group_additions(v_caller, p_conversation_id, p_member_ids);
  IF EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id AND cp.user_id = ANY (p_member_ids)
  ) THEN
    RAISE EXCEPTION 'group_duplicate_member' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count FROM public.conversation_participants cp WHERE cp.conversation_id = p_conversation_id;
  IF v_count + cardinality(p_member_ids) > 32 THEN
    RAISE EXCEPTION 'group_full' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.conversation_participants (conversation_id, user_id, role, added_by)
  SELECT p_conversation_id, m.id, 'member', v_caller FROM unnest(p_member_ids) AS m(id);

  RETURN cardinality(p_member_ids);
END;
$$;

-- Admin only. Removes someone else (use leave_group for yourself). They lose
-- the conversation entirely — messages, participants and attachments are all
-- gated on current membership — and their message notifications for it go.
CREATE OR REPLACE FUNCTION public.remove_group_member(p_conversation_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF public._lock_group_for_caller(v_caller, p_conversation_id) <> 'admin' THEN
    RAISE EXCEPTION 'not_group_admin' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_user_id = v_caller THEN
    RAISE EXCEPTION 'cannot_remove_self' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.conversation_participants cp
  WHERE cp.conversation_id = p_conversation_id AND cp.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_member_not_found' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.notifications n
  WHERE n.user_id = p_user_id AND n.conversation_id = p_conversation_id AND n.type = 'message';
END;
$$;

-- Leave a group. The last admin leaving hands admin to the longest-standing
-- member (earliest joined_at, then user id). Recorded as a departure (see
-- section 2). The last member leaving deletes the conversation.
CREATE OR REPLACE FUNCTION public.leave_group(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_added_by uuid;
BEGIN
  v_role := public._lock_group_for_caller(v_caller, p_conversation_id);

  IF v_role = 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id AND cp.role = 'admin' AND cp.user_id <> v_caller
  ) THEN
    UPDATE public.conversation_participants cp
    SET role = 'admin'
    WHERE (cp.conversation_id, cp.user_id) = (
      SELECT s.conversation_id, s.user_id
      FROM public.conversation_participants s
      WHERE s.conversation_id = p_conversation_id AND s.user_id <> v_caller
      ORDER BY s.joined_at, s.user_id
      LIMIT 1
    );
  END IF;

  DELETE FROM public.conversation_participants cp
  WHERE cp.conversation_id = p_conversation_id AND cp.user_id = v_caller
  RETURNING cp.added_by INTO v_added_by;

  DELETE FROM public.notifications n
  WHERE n.user_id = v_caller AND n.conversation_id = p_conversation_id AND n.type = 'message';

  IF NOT EXISTS (SELECT 1 FROM public.conversation_participants cp WHERE cp.conversation_id = p_conversation_id) THEN
    -- Nobody left: the conversation, its messages, departures and
    -- notifications go with it (ON DELETE CASCADE).
    DELETE FROM public.conversations c WHERE c.id = p_conversation_id;
    RETURN;
  END IF;

  INSERT INTO public.conversation_group_departures (conversation_id, user_id, added_by, left_at)
  VALUES (p_conversation_id, v_caller, v_added_by, now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET added_by = EXCLUDED.added_by, left_at = EXCLUDED.left_at;
END;
$$;

-- Admin only. NULL or blank clears the name (the app then names the group
-- after its members).
CREATE OR REPLACE FUNCTION public.rename_group(p_conversation_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_name   text := NULLIF(btrim(p_name), '');
BEGIN
  IF public._lock_group_for_caller(v_caller, p_conversation_id) <> 'admin' THEN
    RAISE EXCEPTION 'not_group_admin' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NOT NULL AND char_length(v_name) > 50 THEN
    RAISE EXCEPTION 'group_invalid_name' USING ERRCODE = '22023';
  END IF;
  UPDATE public.conversations c SET name = v_name WHERE c.id = p_conversation_id;
END;
$$;

-- Admin only. Promote a member to admin, or demote an admin (yourself
-- included) — never the last admin; transfer first.
CREATE OR REPLACE FUNCTION public.set_group_member_role(p_conversation_id uuid, p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_current text;
BEGIN
  IF public._lock_group_for_caller(v_caller, p_conversation_id) <> 'admin' THEN
    RAISE EXCEPTION 'not_group_admin' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'group_invalid_role' USING ERRCODE = '22023';
  END IF;
  SELECT cp.role INTO v_current
  FROM public.conversation_participants cp
  WHERE cp.conversation_id = p_conversation_id AND cp.user_id = p_user_id;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'group_member_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'admin' AND p_role = 'member' AND NOT EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id AND cp.role = 'admin' AND cp.user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'last_group_admin' USING ERRCODE = '22023';
  END IF;
  UPDATE public.conversation_participants cp
  SET role = p_role
  WHERE cp.conversation_id = p_conversation_id AND cp.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group_conversation(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_group_members(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_group_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_group(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rename_group(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_group_member_role(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_group_conversation(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_group_members(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_group(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_group(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_group_member_role(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

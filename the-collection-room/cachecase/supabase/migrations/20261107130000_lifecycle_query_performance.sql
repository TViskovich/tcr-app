-- ============================================================================
-- Query performance under the account-lifecycle policies — Dashboard
-- Milestone 2, Checkpoint 5.
--
-- Query-plan review (local, ~300 collectors / 30k posts / 150k likes / 75k
-- messages, 10 accounts pending deletion) found:
--   * hot read paths with NO supporting index (pre-existing, production
--     too): feed by created_at, a profile's posts, likes/comments of a page
--     of posts, a conversation's messages, followers, notifications — so
--     those queries scan whole tables;
--   * the lifecycle read guards then call a SECURITY DEFINER function for
--     EVERY scanned row (private.account_is_hidden, …has_hidden_participant),
--     which can't be inlined: the DM inbox query went from 0.25 s to 5.8 s.
--
-- Fix, without changing who can see what:
--   1. the missing indexes;
--   2. the guards compare against the set of hidden accounts (and
--      conversations with a hidden participant) computed ONCE per query —
--      an InitPlan — instead of a function call per row. Same rule: a row
--      owned by / pointing at an account in account_lifecycle is hidden; a
--      NULL owner is not hidden (as before).
-- ============================================================================

-- ── 1. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON public.posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_user_created_at_idx ON public.posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS likes_post_id_idx ON public.likes (post_id);
CREATE INDEX IF NOT EXISTS comments_post_id_created_at_idx ON public.comments (post_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follows_following_id_idx ON public.follows (following_id);
CREATE INDEX IF NOT EXISTS notifications_user_created_at_idx ON public.notifications (user_id, created_at DESC);

-- ── 2. Set-based hidden checks ─────────────────────────────────────────────
-- Every account in account_lifecycle (pending deletion or deleting).
CREATE FUNCTION private.hidden_account_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(user_id), '{}') FROM public.account_lifecycle;
$$;

-- Every conversation with a hidden participant.
CREATE FUNCTION private.hidden_conversation_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(DISTINCT p.conversation_id), '{}')
  FROM public.conversation_participants p
  JOIN public.account_lifecycle l ON l.user_id = p.user_id;
$$;

REVOKE ALL ON FUNCTION private.hidden_account_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.hidden_conversation_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.hidden_account_ids() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.hidden_conversation_ids() TO anon, authenticated, service_role;

-- Rewrites each lifecycle guard in place (ALTER POLICY keeps its name, its
-- RESTRICTIVE kind and its roles):
--   NOT private.account_is_hidden(col)
--     → NOT COALESCE(col = ANY ((SELECT private.hidden_account_ids())::uuid[]), false)
--   NOT private.conversation_has_hidden_participant(col)
--     → NOT COALESCE(col = ANY ((SELECT private.hidden_conversation_ids())::uuid[]), false)
-- and fails the migration if any per-row call is left behind.
DO $$
DECLARE
  r record;
  v_qual text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('account_lifecycle_read_guard', 'account_lifecycle_conversation_guard')
      AND (qual LIKE '%private.account_is_hidden(%' OR qual LIKE '%private.conversation_has_hidden_participant(%')
  LOOP
    v_qual := regexp_replace(r.qual, 'private\.account_is_hidden\(([a-z_.]+)\)',
                             'COALESCE((\1 = ANY ((SELECT private.hidden_account_ids())::uuid[])), false)', 'g');
    v_qual := regexp_replace(v_qual, 'private\.conversation_has_hidden_participant\(([a-z_.]+)\)',
                             'COALESCE((\1 = ANY ((SELECT private.hidden_conversation_ids())::uuid[])), false)', 'g');
    EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', r.policyname, r.schemaname, r.tablename, v_qual);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('account_lifecycle_read_guard', 'account_lifecycle_conversation_guard')
      AND (qual LIKE '%private.account_is_hidden(%' OR qual LIKE '%private.conversation_has_hidden_participant(%')
  ) THEN
    RAISE EXCEPTION 'lifecycle guard rewrite incomplete';
  END IF;
END;
$$;

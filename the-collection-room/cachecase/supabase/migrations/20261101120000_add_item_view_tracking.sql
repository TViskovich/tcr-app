BEGIN;

-- ============================================================================
-- Item view tracking — the foundation for Profile Items' "Most Viewed" sort.
--
-- What counts as a view: a signed-in user other than the item's owner opens
-- the item's detail screen and it loads (app/item/[id].tsx calls
-- record_item_view once per item per screen visit). Thumbnails, previews,
-- carousel swipes and pickers never call it. Views from before this
-- migration were never recorded and cannot be reconstructed; every count
-- starts at zero.
--
-- Storage — no event log, so nothing grows per view:
--   * collection_item_view_counts: ONE row per viewed item — the
--     authoritative running total. Readable (signed in) only for items the
--     reader can already see; never writable by any client role.
--   * collection_item_view_dedupe: ONE row per (item, viewer) — when that
--     viewer last produced a counted view. Only consulted for the 30-minute
--     window, so rows older than that are deleted in small batches by
--     record_item_view itself (no cron needed); the table only ever holds
--     roughly the last half hour's active viewer/item pairs. No client role
--     can read or write it.
--
-- Deduplication (backend-enforced): a view counts only when the viewer's
-- dedupe row for that item is absent or at least 30 minutes old — one
-- atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING on the
-- (item_id, viewer_id) primary key. Concurrent duplicates (retries, double
-- taps, two devices on one account) serialize on that key: the second waits
-- for the first to commit, then sees a fresh row and is not counted. The
-- window rolls from the last COUNTED view, so reopening an item every few
-- minutes still counts once per 30 minutes.
--
-- Identity and visibility: record_item_view is SECURITY DEFINER (it must
-- write tables no client can), so it enforces everything itself. The viewer
-- is always auth.uid() — never a parameter, so no one can record a view as
-- someone else. It counts nothing for: no session, a missing or
-- non-active item, the item's owner, or an item the viewer can't see under
-- the canonical item rule (_item_visible_to — mirrors items_select_public
-- exactly: folder chain public AND item public, or the owner, or the
-- Grail-slot exception). Inaccessible and nonexistent items behave
-- identically (false), so it is not an existence oracle.
-- ============================================================================

-- ── Tables ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collection_item_view_counts (
  item_id          uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,
  view_count       bigint NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  first_counted_at timestamptz NOT NULL DEFAULT now(),
  last_counted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.collection_item_view_dedupe (
  item_id         uuid NOT NULL REFERENCES public.collection_items(id) ON DELETE CASCADE,
  viewer_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_counted_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, viewer_id)
);

-- The retention sweep's scan (oldest rows first).
CREATE INDEX IF NOT EXISTS collection_item_view_dedupe_last_counted_at_idx
  ON public.collection_item_view_dedupe (last_counted_at);

ALTER TABLE public.collection_item_view_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_item_view_dedupe ENABLE ROW LEVEL SECURITY;

-- A count is readable exactly when its item is: the EXISTS runs under the
-- reader's own collection_items RLS (items_select_public).
DROP POLICY IF EXISTS "collection_item_view_counts_select_visible" ON public.collection_item_view_counts;
CREATE POLICY "collection_item_view_counts_select_visible" ON public.collection_item_view_counts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.collection_items ci WHERE ci.id = collection_item_view_counts.item_id));

-- No INSERT/UPDATE/DELETE policies and no write privileges for any client
-- role: only record_item_view writes either table. The dedupe table has no
-- policies at all (RLS on + no grants = no client access).
REVOKE ALL ON TABLE public.collection_item_view_counts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.collection_item_view_dedupe FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.collection_item_view_counts TO authenticated;

-- ── Recording a view ───────────────────────────────────────────────────────
-- Returns true when this call counted a view, false otherwise (not
-- signed in, owner, inaccessible/missing item, or within the 30-minute
-- window). Callers treat it as fire-and-forget.
CREATE OR REPLACE FUNCTION public.record_item_view(p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_viewer  uuid := auth.uid();
  v_owner   uuid;
  v_counted boolean;
BEGIN
  IF v_viewer IS NULL OR p_item_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT ci.user_id INTO v_owner
  FROM public.collection_items ci
  WHERE ci.id = p_item_id AND ci.collection_status = 'active';

  IF NOT FOUND OR v_owner = v_viewer OR NOT public._item_visible_to(p_item_id, v_viewer) THEN
    RETURN false;
  END IF;

  -- Retention: drop a small batch of dedupe rows that are past the window
  -- (they can no longer suppress anything). SKIP LOCKED so concurrent
  -- callers never wait on each other here.
  DELETE FROM public.collection_item_view_dedupe d
  WHERE (d.item_id, d.viewer_id) IN (
    SELECT s.item_id, s.viewer_id
    FROM public.collection_item_view_dedupe s
    WHERE s.last_counted_at < now() - interval '30 minutes'
    ORDER BY s.last_counted_at
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  );

  -- The 30-minute window, atomically: a row is returned only when this
  -- viewer had no row for the item, or its last counted view is at least
  -- 30 minutes old.
  INSERT INTO public.collection_item_view_dedupe AS d (item_id, viewer_id, last_counted_at)
  VALUES (p_item_id, v_viewer, now())
  ON CONFLICT (item_id, viewer_id) DO UPDATE
    SET last_counted_at = EXCLUDED.last_counted_at
    WHERE d.last_counted_at <= EXCLUDED.last_counted_at - interval '30 minutes'
  RETURNING true INTO v_counted;

  IF NOT COALESCE(v_counted, false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.collection_item_view_counts AS c (item_id, view_count)
  VALUES (p_item_id, 1)
  ON CONFLICT (item_id) DO UPDATE
    SET view_count = c.view_count + 1,
        last_counted_at = now();

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.record_item_view(uuid) IS
  'Counts one view of an item by auth.uid() (never its owner; only items the caller can see; at most once per viewer per item per 30 minutes). Fire-and-forget; returns whether this call counted.';

REVOKE ALL ON FUNCTION public.record_item_view(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_item_view(uuid) TO authenticated;

-- ── Reading totals for Profile Items' Most Viewed sort ───────────────────
-- Non-zero totals for one profile's items — the SAME set Profile V2's Items
-- tab and search_profile_items show this caller (owner: all their active
-- items; anyone else: public items in effectively-public folders, no
-- Grail-only items). Items with no views have no row (count them as 0).
-- Highest first, id breaking ties; pages of up to 1,000 (the API's row cap).
-- SECURITY INVOKER: the counts' and items' own RLS apply on top.
CREATE OR REPLACE FUNCTION public.profile_item_view_counts(
  p_owner_id uuid,
  p_limit integer DEFAULT 1000,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (item_id uuid, view_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT c.item_id, c.view_count
  FROM public.collection_item_view_counts c
  JOIN public.collection_items ci ON ci.id = c.item_id
  CROSS JOIN (SELECT (SELECT auth.uid()) AS caller) q
  WHERE ci.user_id = p_owner_id
    AND ci.collection_status = 'active'
    AND c.view_count > 0
    AND (
      q.caller = p_owner_id
      OR (ci.is_public AND public.folder_is_effectively_visible(ci.folder_id))
    )
  ORDER BY c.view_count DESC, c.item_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.profile_item_view_counts(uuid, integer, integer) IS
  'Non-zero view totals for a profile''s items as its Items tab shows them to the caller, highest first, paginated (SECURITY INVOKER — RLS applies).';

REVOKE ALL ON FUNCTION public.profile_item_view_counts(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profile_item_view_counts(uuid, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

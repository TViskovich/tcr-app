-- ============================================================================
-- Download My Data — Dashboard Milestone 2, Checkpoint 3.
--
-- A collector's export is one ZIP built by the account-export Edge Function
-- in small, resumable steps (supabase/functions/account-export):
--   queued → collecting (data files + archive plan) → archiving (owned
--   photos appended in ~6 MB steps to one resumable upload) → ready (7 days)
--   → expired;  any stage → failed (staging and partial upload removed).
--
-- Everything here is server-only. Clients have no table privileges and no
-- Storage policy on the bucket: every read goes through the Edge Function,
-- which identifies the collector from the verified access token, and the
-- finished archive is only ever handed out as a short-lived signed URL.
-- That also lets a collector who is pending deletion export their data:
-- the lifecycle guards (20261103120000) keep blocking their normal reads.
--
-- Final account deletion (Checkpoint 4) removes the rows with the auth user
-- (ON DELETE CASCADE) and must also remove account-exports/{user_id}/.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('account-exports', 'account-exports', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.account_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'collecting', 'archiving', 'ready', 'failed', 'expired')),
  attempts         integer NOT NULL DEFAULT 0,      -- archive (re)builds started
  step_failures    integer NOT NULL DEFAULT 0,      -- consecutive failed steps
  entries_total    integer,
  entries_written  integer NOT NULL DEFAULT 0,
  bytes_total      bigint,
  bytes_written    bigint NOT NULL DEFAULT 0,
  upload_url       text,                            -- resumable upload in progress (server only)
  object_path      text,                            -- {user_id}/{export_id}/… in account-exports
  lease_until      timestamptz,                     -- one step at a time
  last_error_code  text,                            -- controlled codes only
  excluded_records jsonb,                           -- unreleased-feature data found but not exported
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  expires_at       timestamptz,
  CONSTRAINT account_exports_ready_shape CHECK (status <> 'ready' OR (object_path IS NOT NULL AND expires_at IS NOT NULL))
);

-- At most one export in progress per collector (concurrent requests share it).
CREATE UNIQUE INDEX account_exports_one_active
  ON public.account_exports (user_id)
  WHERE status IN ('queued', 'collecting', 'archiving');
CREATE INDEX account_exports_user_created ON public.account_exports (user_id, created_at DESC);
CREATE INDEX account_exports_expiry ON public.account_exports (expires_at) WHERE status = 'ready';

-- The archive plan: one row per file, in archive order. Offsets are fixed
-- when the plan is made; crc32 is recorded before each file is written so a
-- step interrupted after uploading can be reconciled.
CREATE TABLE public.account_export_entries (
  export_id     uuid NOT NULL REFERENCES public.account_exports (id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  archive_name  text NOT NULL,
  source_bucket text NOT NULL,
  source_path   text NOT NULL,
  size          bigint NOT NULL CHECK (size >= 0),
  local_offset  bigint NOT NULL CHECK (local_offset >= 0),
  crc32         bigint,
  written       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (export_id, seq)
);

ALTER TABLE public.account_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_export_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_exports, public.account_export_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_exports, public.account_export_entries TO service_role;

-- The account-lifecycle guards every public table carries (20261103120000):
-- harmless here (no client access at all), required by its catalog audit.
CREATE POLICY account_lifecycle_read_guard ON public.account_exports AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE POLICY account_lifecycle_read_guard ON public.account_export_entries AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_exports
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_export_entries
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

-- ── Server-only helpers ────────────────────────────────────────────────────

-- The collector's own Storage objects that belong in their export, with
-- sizes, in a stable order (keyset pagination). Only paths under the
-- collector's own top-level folder are eligible, so another collector's
-- file can never be listed — whatever the database rows point at.
--   item-images/{user_id}/…     item and collection photos
--   avatars/{user_id}/…         profile photo and images
--   share-snapshots/{user_id}/… photos in the collector's own posts
CREATE FUNCTION public.export_owned_storage_objects(
  p_user_id uuid,
  p_after_bucket text DEFAULT '',
  p_after_name text DEFAULT '',
  p_limit integer DEFAULT 1000
)
RETURNS TABLE (bucket_id text, name text, size bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.bucket_id, o.name, COALESCE((o.metadata ->> 'size')::bigint, 0)
  FROM storage.objects o
  WHERE o.bucket_id IN ('avatars', 'item-images', 'share-snapshots')
    AND o.name LIKE p_user_id::text || '/%'
    AND (o.bucket_id, o.name) > (COALESCE(p_after_bucket, ''), COALESCE(p_after_name, ''))
  ORDER BY o.bucket_id, o.name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
$$;

-- Records about the collector in the UNRELEASED Registry / Transfers
-- features. They are not part of the beta export; their counts are kept on
-- the export job (excluded_records) so the omission is documented and can
-- be revisited before those features launch.
CREATE FUNCTION public.account_export_unreleased_records(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'registered_cards_owned', (SELECT count(*) FROM public.registered_cards WHERE current_owner_id = p_user_id),
    'registered_cards_created', (SELECT count(*) FROM public.registered_cards WHERE created_by = p_user_id),
    'ownership_transfers', (SELECT count(*) FROM public.ownership_transfers WHERE p_user_id IN (from_owner_id, to_owner_id)),
    'registry_events', (SELECT count(*) FROM public.registry_events WHERE p_user_id IN (actor_id, from_owner_id, to_owner_id)),
    'ownership_events', (SELECT count(*) FROM public.ownership_events WHERE p_user_id IN (from_user_id, to_user_id))
  );
$$;

REVOKE ALL ON FUNCTION public.export_owned_storage_objects(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_export_unreleased_records(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_owned_storage_objects(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_export_unreleased_records(uuid) TO service_role;

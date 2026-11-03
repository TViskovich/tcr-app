-- ============================================================================
-- Download My Data — multipart archives (Dashboard Milestone 2, Checkpoint 4).
--
-- A single archive could exceed the project's Storage upload limit. An
-- export is now split into PARTS, each a complete, independently valid ZIP
-- no larger than the configured part size (account-export function,
-- ACCOUNT_EXPORT_PART_BYTES; default under the 50 MB default upload limit).
-- Part 1 holds README.txt, manifest.json (which lists every file and the
-- part it is in) and the data files; photos follow across the parts. No
-- file is ever split or truncated: a single file larger than a part gets a
-- part of its own, and a file the upload limit can't take fails the export
-- with export_too_large rather than producing an incomplete archive.
-- ============================================================================

ALTER TABLE public.account_export_entries
  ADD COLUMN part integer NOT NULL DEFAULT 1 CHECK (part >= 1);
COMMENT ON COLUMN public.account_export_entries.local_offset IS 'Offset of the file''s local header within its part.';

ALTER TABLE public.account_exports
  ADD COLUMN part_count integer CHECK (part_count IS NULL OR part_count >= 1);

CREATE TABLE public.account_export_parts (
  export_id     uuid NOT NULL REFERENCES public.account_exports (id) ON DELETE CASCADE,
  part          integer NOT NULL CHECK (part >= 1),
  object_path   text NOT NULL,
  bytes_total   bigint NOT NULL CHECK (bytes_total > 0),
  bytes_written bigint NOT NULL DEFAULT 0,
  upload_url    text,
  completed     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (export_id, part)
);

ALTER TABLE public.account_export_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_export_parts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_export_parts TO service_role;
CREATE POLICY account_lifecycle_read_guard ON public.account_export_parts AS RESTRICTIVE
  FOR SELECT TO public USING (NOT (SELECT private.caller_is_hidden()));
CREATE TRIGGER account_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_export_parts
  FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_write();

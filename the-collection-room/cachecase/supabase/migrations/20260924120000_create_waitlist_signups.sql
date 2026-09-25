-- ============================================================================
-- CacheCase waitlist — Phase 1 (schema only).
--
-- Framer landing page -> join-waitlist Edge Function -> waitlist_signups.
-- Framer never talks to Supabase directly; the Edge Function (service role)
-- is the only writer. This table has NO public read or write path at all —
-- unlike registered_cards/registry_events (public-by-design) or even
-- ownership_transfers (participant-readable), there is no legitimate client
-- session, authenticated or anonymous, that should ever see a waitlist row
-- directly. RLS is enabled with zero policies, and the default anon/
-- authenticated table grants are revoked outright as defense in depth on
-- top of that — same "don't rely on RLS alone" convention already used by
-- ownership_transfers.
--
-- Not applied to the live database by this session — draft for review only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.waitlist_signups (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  email               text        NOT NULL,
  reserved_username   text        NULL,
  status              text        NOT NULL DEFAULT 'waitlisted',
  access_code         text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  access_granted_at   timestamptz NULL,
  onboarded_at        timestamptz NULL,

  CONSTRAINT waitlist_signups_status_check
    CHECK (status IN ('waitlisted', 'access_granted', 'onboarded'))
);

-- Uniqueness on normalized email (trim + lowercase) rather than the raw
-- column — join-waitlist always inserts already-normalized values, but the
-- constraint itself enforces normalization at the database layer regardless
-- of what any future caller sends.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_normalized_email_key
  ON public.waitlist_signups (lower(btrim(email)));

ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;

-- Deliberately no SELECT/INSERT/UPDATE/DELETE policy of any kind. Every
-- write goes through join-waitlist's service-role client, which bypasses
-- RLS entirely; there is no client-facing read path in Phase 1.

-- Defense in depth on top of "absence of a policy = denial": this project's
-- public schema grants anon/authenticated full table privileges by default
-- (see ownership_transfers' own migration). Revoked outright here for both
-- roles, including SELECT — this table has no authenticated-readable rows
-- the way ownership_transfers does for its participants.
REVOKE ALL ON TABLE public.waitlist_signups FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

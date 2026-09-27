-- ============================================================================
-- Permanent sequential CacheCase account number (displayed as CC000042).
--
-- Stored as a plain bigint; the "CC" + 6-digit zero-padded string is a display
-- concern only (see components/profile-v2/profile-v2-identity-card.tsx).
--
-- Assigned by a BEFORE INSERT trigger from a Postgres sequence, so it is
-- server-side, concurrency-safe (nextval is atomic — two simultaneous signups
-- always get different values), and independent of whichever code path
-- inserts the profile row (the handle_new_user auth trigger today).
-- Immutable afterwards via a BEFORE UPDATE trigger.
--
-- Existing profiles are backfilled oldest-first: created_at ASC (NULLs last),
-- ties broken by id ASC.
-- ============================================================================

-- The whole migration runs in one explicit transaction: LOCK TABLE is only
-- valid inside one, and the lock is held until COMMIT.
BEGIN;

-- Blocks concurrent profile inserts/updates for the (short) duration of this
-- migration so no signup can slip in between backfill and setval.
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

CREATE SEQUENCE IF NOT EXISTS public.cachecase_account_number_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO CYCLE;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_number bigint;

-- Backfill only rows that don't have a number yet (safe to re-run: assigned
-- numbers are never touched; new numbers continue after the current max).
WITH ordered AS (
  SELECT
    id,
    row_number() OVER (ORDER BY created_at ASC NULLS LAST, id ASC) AS rn
  FROM public.profiles
  WHERE account_number IS NULL
),
base AS (
  SELECT COALESCE(MAX(account_number), 0) AS max_number FROM public.profiles
)
UPDATE public.profiles p
SET account_number = base.max_number + ordered.rn
FROM ordered, base
WHERE p.id = ordered.id;

-- Next signup receives max(account_number) + 1. With no profiles at all the
-- sequence is left unstarted so the first value is 1.
SELECT CASE
  WHEN (SELECT MAX(account_number) FROM public.profiles) IS NULL
    THEN setval('public.cachecase_account_number_seq', 1, false)
  ELSE setval('public.cachecase_account_number_seq', (SELECT MAX(account_number) FROM public.profiles), true)
END;

ALTER TABLE public.profiles
  ALTER COLUMN account_number SET NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_number_key UNIQUE (account_number);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_number_positive_check CHECK (account_number > 0);

-- INSERT: always assign from the sequence, ignoring any client-supplied value.
-- UPDATE: the number can never change (a normal profile edit that merely
-- repeats the same value is fine; anything else is rejected).
-- SECURITY DEFINER so the sequence is usable no matter which role inserts
-- (the sequence itself is not granted to anon/authenticated).
CREATE OR REPLACE FUNCTION public.profiles_account_number_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.account_number := nextval('public.cachecase_account_number_seq');
  ELSIF NEW.account_number IS DISTINCT FROM OLD.account_number THEN
    RAISE EXCEPTION 'profiles.account_number is permanent and cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_account_number_guard ON public.profiles;
CREATE TRIGGER profiles_account_number_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_account_number_guard();

REVOKE ALL ON SEQUENCE public.cachecase_account_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profiles_account_number_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

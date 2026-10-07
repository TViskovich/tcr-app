-- Reserve CacheCase account numbers 1–100: moebryan -> 101, tviskovich -> 102,
-- sequence continues at 103. 1–100 stay unused for later manual assignment.
BEGIN;

-- No signup can slip in between the renumber and the setval.
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

-- Abort unless the database is exactly in the audited state.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = 'moebryan')
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = 'tviskovich')
     OR EXISTS (SELECT 1 FROM public.profiles WHERE account_number >= 101) THEN
    RAISE EXCEPTION 'reserve_account_numbers: unexpected profiles state — aborting';
  END IF;
END $$;

-- The guard rejects ANY account_number change, from every role. Disable only
-- that trigger, only inside this transaction; re-enabled before COMMIT, so
-- no other session ever sees it off (the table lock blocks them meanwhile).
ALTER TABLE public.profiles DISABLE TRIGGER profiles_account_number_guard;

UPDATE public.profiles SET account_number = 101 WHERE username = 'moebryan';
UPDATE public.profiles SET account_number = 102 WHERE username = 'tviskovich';

ALTER TABLE public.profiles ENABLE TRIGGER profiles_account_number_guard;

-- is_called = false: the NEXT nextval() returns exactly 103.
SELECT setval('public.cachecase_account_number_seq', 103, false);

COMMIT;

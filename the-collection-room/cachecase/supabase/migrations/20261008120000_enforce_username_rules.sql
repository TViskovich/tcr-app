-- CacheCase username rules — make them authoritative in the database.
--
-- Rules: 3–30 chars, stored lowercase, [a-z0-9_] only. Until now these lived
-- only in the app's sign-up screen and redeem-waitlist-invite's
-- normalizeUsername (supabase/functions/_shared/waitlist-invite.ts); the
-- database had just a case-sensitive UNIQUE (username), and
-- profiles_update_own (no column restriction) let any signed-in user write
-- any username to their own row directly.
--
-- Pre-check (2026-10-05, live): 2 profiles, no malformed usernames, no
-- duplicates after trim + lowercase, no reserved_username values set. Every
-- ADD CONSTRAINT / CREATE UNIQUE INDEX below validates existing rows and
-- aborts the migration if any row violates it — nothing is rewritten.

-- 1. Format. Lowercase-only means the existing UNIQUE (username) can no
--    longer hold case variants (Thomas / thomas / THOMAS).
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check
  CHECK (username ~ '^[a-z0-9_]{3,30}$');

-- 2. Case-insensitive uniqueness as defense in depth, independent of the
--    CHECK above. profiles_username_key (UNIQUE (username)) stays as-is.
CREATE UNIQUE INDEX profiles_username_lower_key
  ON public.profiles (lower(username));

-- 3. Reserved waitlist usernames follow the same rules, so a hand-entered
--    reservation can never lock an invitee into a name sign-up rejects.
ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_reserved_username_format_check
  CHECK (reserved_username IS NULL OR reserved_username ~ '^[a-z0-9_]{3,30}$');

-- 4. Profile bootstrap.
--    Requested username (metadata, the invite/sign-up path): trimmed and
--    lowercased only. If it breaks the rules the CHECK rejects it and no
--    account is created — redeem-waitlist-invite validates first, so this
--    only bites a caller that skipped validation.
--    No usable requested username: generate one that always satisfies the
--    rules, so account creation never fails just because of the email:
--      base   = email local part, lowercased, stripped to [a-z0-9_],
--               cut to 21 chars
--      suffix = first 8 hex chars of the new auth user's UUID (random bits
--               in a v4 UUID)
--      result = base || '_' || suffix, or 'user_' || suffix if base is
--               empty. 10–30 chars, always ^[a-z0-9_]{3,30}$.
--    Otherwise identical to the live definition.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      lower(NULLIF(trim(NEW.raw_user_meta_data->>'username'), '')),
      COALESCE(
        NULLIF(left(regexp_replace(lower(split_part(COALESCE(NEW.email, ''), '@', 1)), '[^a-z0-9_]', '', 'g'), 21), ''),
        'user'
      ) || '_' || left(replace(NEW.id::text, '-', ''), 8)
    ),
    COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'display_name'), ''),
      split_part(NEW.email, '@', 1)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Usernames are permanent for clients. There is no rename feature, and
--    ownership transfers and /user/[username] links resolve by username.
--    Client roles (anon/authenticated, i.e. PostgREST requests) can't change
--    it; the SQL editor and service role still can, for admin fixes.
--    SECURITY INVOKER so current_user is the caller's role.
CREATE OR REPLACE FUNCTION public.profiles_username_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.username IS DISTINCT FROM OLD.username
     AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'profiles.username cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_username_guard ON public.profiles;
CREATE TRIGGER profiles_username_guard
  BEFORE UPDATE OF username ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_username_guard();

REVOKE ALL ON FUNCTION public.profiles_username_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

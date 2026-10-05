-- CacheCase usernames: maximum length 30 -> 15 (handle "@" + username is at
-- most 16 visible characters; the Profile V2 identity card scales long
-- handles down slightly to keep them on one line). Everything else from
-- 20261008120000_enforce_username_rules.sql is unchanged: 3-char minimum,
-- [a-z0-9_] lowercase only, UNIQUE (username), profiles_username_lower_key,
-- and profiles_username_guard all stay as they are.
--
-- Pre-check (2026-10-05, live): longest profiles.username is 11 chars; no
-- reserved_username values set. Each ADD CONSTRAINT validates existing rows
-- and aborts the migration if any row is longer than 15 — nothing is
-- truncated or rewritten.

-- 1. Profile usernames: 3–15.
ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_username_format_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check
  CHECK (username ~ '^[a-z0-9_]{3,15}$');

-- 2. Reserved waitlist usernames: same rule, NULL still allowed.
ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT waitlist_signups_reserved_username_format_check;
ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_reserved_username_format_check
  CHECK (reserved_username IS NULL OR reserved_username ~ '^[a-z0-9_]{3,15}$');

-- 3. Profile bootstrap. Requested username (metadata): trimmed + lowercased
--    only, exactly as before. Fallback base is now cut to 6 chars so the
--    generated username fits 15:
--      base   = email local part, lowercased, stripped to [a-z0-9_],
--               cut to 6 chars ('user' if nothing is left)
--      suffix = first 8 hex chars of the new auth user's UUID
--      result = base || '_' || suffix — 10–15 chars, always ^[a-z0-9_]{3,15}$.
--    Otherwise identical to the applied definition.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      lower(NULLIF(trim(NEW.raw_user_meta_data->>'username'), '')),
      COALESCE(
        NULLIF(left(regexp_replace(lower(split_part(COALESCE(NEW.email, ''), '@', 1)), '[^a-z0-9_]', '', 'g'), 6), ''),
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

NOTIFY pgrst, 'reload schema';

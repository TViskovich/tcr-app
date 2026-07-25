-- Fixes: new row for relation "posts" violates check constraint "posts_post_type_check"
--
-- The live posts_post_type_check constraint was never documented in
-- supabase/schema.sql (added directly against the live project, like several
-- other tables already flagged as undocumented there) and only allowed
-- 'item' and 'text' — so it rejected the 'rate_my_grails' value the Rate My
-- Grails composer (app/rate-my-grails/new.tsx) inserts. This replaces the
-- constraint with one that keeps every existing value and adds the new one.
--
-- Idempotent: DROP ... IF EXISTS + recreate is safe to run more than once.
-- Adding a CHECK constraint validates existing rows but modifies none of
-- them — every current row is already 'item' or 'text', so validation is a
-- no-op in practice.

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_post_type_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_post_type_check
  CHECK (post_type IN ('item', 'text', 'rate_my_grails'));

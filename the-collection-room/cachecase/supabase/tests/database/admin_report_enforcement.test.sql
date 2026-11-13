-- pgTAP test for 20261202120000_admin_report_enforcement.sql (Phase 2B M5.2:
-- moderation enforcement from the admin report screen). Synthetic fixtures
-- inside one rolled-back transaction; runs ONLY on an isolated disposable
-- local stack:  PGOPTIONS='-c cachecase.isolated_stack=on' (or SET it first).

BEGIN;
DO $$ BEGIN
  IF current_setting('cachecase.isolated_stack', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'refusing: enforcement tests run only on an isolated stack (cachecase.isolated_stack=on)';
  END IF;
END $$;
SELECT plan(124);

CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END;
$$;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5200' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.r(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5210' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.t(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-0000e5220' || lpad(n::text, 3, '0'))::uuid $$;
CREATE FUNCTION pg_temp.ver(n int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT private.report_review_version(c) FROM public.content_reports c WHERE c.id = pg_temp.r(n) $$;
CREATE FUNCTION pg_temp.st(n int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT status || ':' || COALESCE(resolution, '-') || ':' || COALESCE(resolution_reason, '-') FROM public.content_reports WHERE id = pg_temp.r(n) $$;
CREATE FUNCTION pg_temp.mod(p_target uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT state || ':' || child_safety::text FROM public.moderated_content WHERE target_id = p_target AND lifted_at IS NULL), 'none') $$;
CREATE FUNCTION pg_temp.audits(n int, p_action text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*)::int FROM public.moderation_actions WHERE report_id = pg_temp.r(n) AND action = p_action $$;
CREATE FUNCTION pg_temp.claim(n int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_report_case_action(pg_temp.r(n), 'claim', pg_temp.ver(n)) $$;
CREATE FUNCTION pg_temp.enf(n int, p_action text, p_reason text, p_note text DEFAULT NULL, p_opts jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_report_enforce(pg_temp.r(n), p_action, pg_temp.ver(n), p_reason, p_note, p_opts) $$;
CREATE FUNCTION pg_temp.view(n int) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.admin_report_enforcement(pg_temp.r(n)) $$;
CREATE FUNCTION pg_temp.avail(n int, p_action text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(v -> 'actions' -> p_action ->> 'blocked', 'available') FROM (SELECT pg_temp.view(n) v) x $$;
GRANT EXECUTE ON FUNCTION pg_temp.login(uuid), pg_temp.u(int), pg_temp.r(int), pg_temp.t(int), pg_temp.ver(int), pg_temp.st(int),
  pg_temp.mod(uuid), pg_temp.audits(int, text), pg_temp.claim(int), pg_temp.enf(int, text, text, text, jsonb), pg_temp.view(int),
  pg_temp.avail(int, text) TO authenticated, anon, service_role;
-- Direct reads of tables clients cannot see (as the test owner).
CREATE FUNCTION pg_temp.sq(q text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v text; BEGIN EXECUTE q INTO v; RETURN v; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.sq(text) TO authenticated;
CREATE TEMP TABLE v (k text PRIMARY KEY, val jsonb);
GRANT ALL ON v TO authenticated, anon, service_role;

-- ── 1. Shape and privileges ─────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['public.admin_report_enforcement(uuid)', 'public.admin_report_enforce(uuid,text,text,text,text,jsonb)']::regprocedure[]) f
             JOIN pg_proc p ON p.oid = f WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=""'] AND p.prosrc LIKE '%private.require_admin()%'
               AND has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT has_function_privilege('service_role', f, 'EXECUTE')), 2,
  'both functions: SECURITY DEFINER, empty search_path, require_admin, signed-in callers only');

SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'private' AND p.proname LIKE 'report_enforcement%'
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 0,
  'private enforcement helpers are not executable by clients');
SELECT ok((SELECT p.prosrc ~ 'public\.admin_hide_content' AND p.prosrc ~ 'public\.admin_remove_content' AND p.prosrc ~ 'public\.admin_restore_content'
             AND p.prosrc ~ 'public\.admin_clear_profile_fields' AND p.prosrc ~ 'public\.admin_restore_profile_fields'
             AND p.prosrc ~ 'public\.admin_suspend_account' AND p.prosrc ~ 'public\.admin_lift_suspension'
             AND p.prosrc !~ '(INSERT INTO|UPDATE|DELETE FROM) (public|private)\.'
             AND p.prosrc ~ 'report_changed' AND p.prosrc ~ 'FOR UPDATE'
           FROM pg_proc p WHERE p.proname = 'admin_report_enforce'),
  'admin_report_enforce locks, checks the version and only delegates to the 7 existing functions (writes nothing itself)');
SELECT ok((SELECT p.prosrc !~ 'source_path|quarantine_path|original_value|sha256|\.note\b' FROM pg_proc p WHERE p.proname = 'admin_report_enforcement')
      AND (SELECT p.prosrc !~ 'source_path|quarantine_path|source_bucket' FROM pg_proc p WHERE p.proname = 'report_enforcement_media'),
  'the enforcement view never reads paths, buckets, hashes, original values or notes');

-- ── Fixtures ────────────────────────────────────────────────────────────
-- 1 admin A · 2 admin B · 3 reporter C · 4 owner O · 5 profile owner Q ·
-- 6 admin S (suspended) · 7 admin P (pending deletion) · 8 admin X (owns
-- content) · 9 reporter D · 10 owner K (child-safety profile) · 11 owner E (expired suspension)
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT pg_temp.u(i), 'enf-' || i || '@example.invalid', jsonb_build_object('username', 'enf_user_' || i) FROM generate_series(1, 11) i;
INSERT INTO public.admin_users (user_id) SELECT pg_temp.u(i) FROM unnest(ARRAY[1, 2, 6, 7, 8]) i;
INSERT INTO public.account_suspensions (user_id, reason_code) VALUES (pg_temp.u(6), 'spam');
INSERT INTO public.account_lifecycle (user_id, state, mode, requested_at, scheduled_for)
VALUES (pg_temp.u(7), 'pending_deletion', 'scheduled', now(), now() + interval '30 days');
INSERT INTO public.account_suspensions (user_id, reason_code, created_at, expires_at)
VALUES (pg_temp.u(11), 'spam', now() - interval '3 days', now() - interval '1 day');
UPDATE public.profiles SET display_name = 'ENF-SECRET-NAME', bio = 'ENF-SECRET-BIO', tagline = 'enf tagline' WHERE id = pg_temp.u(5);
-- t1 post by O with a public image (object present), t2 post by admin X,
-- t3 comment by O, t4 DM from O, t5 another DM from O (must stay untouched),
-- t6 post by E.
INSERT INTO storage.objects (bucket_id, name) VALUES ('share-snapshots', pg_temp.u(4) || '/enf-snap-1.jpg');
INSERT INTO public.posts (id, user_id, content, post_type, image_url) VALUES
  (pg_temp.t(1), pg_temp.u(4), 'enf post by O', 'text', 'http://127.0.0.1:56321/storage/v1/object/public/share-snapshots/' || pg_temp.u(4) || '/enf-snap-1.jpg'),
  (pg_temp.t(2), pg_temp.u(8), 'enf post by admin X', 'text', NULL),
  (pg_temp.t(6), pg_temp.u(11), 'enf post by E', 'text', NULL);
INSERT INTO public.comments (id, user_id, post_id, body) VALUES (pg_temp.t(3), pg_temp.u(4), pg_temp.t(2), 'enf comment by O');
INSERT INTO public.conversations (id) VALUES (pg_temp.t(9));
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES (pg_temp.t(9), pg_temp.u(3)), (pg_temp.t(9), pg_temp.u(4));
INSERT INTO public.messages (id, conversation_id, sender_id, body) VALUES
  (pg_temp.t(4), pg_temp.t(9), pg_temp.u(4), 'enf abusive DM'), (pg_temp.t(5), pg_temp.t(9), pg_temp.u(4), 'enf unrelated DM');

INSERT INTO public.content_reports (id, reporter_id, target_type, target_id, target_owner_id, reason, evidence, priority, created_at) VALUES
  (pg_temp.r(1),  pg_temp.u(3), 'post',    pg_temp.t(1), pg_temp.u(4),  'harassment',   '{"v":1,"content":"enf post by O"}', 'normal', now() - interval '3 hours'),
  (pg_temp.r(2),  pg_temp.u(9), 'post',    pg_temp.t(1), pg_temp.u(4),  'spam',         '{"v":1,"content":"enf post by O"}', 'normal', now() - interval '2 hours'),
  (pg_temp.r(3),  pg_temp.u(3), 'comment', pg_temp.t(3), pg_temp.u(4),  'child_safety', '{"v":1,"body":"enf comment by O"}', 'urgent', now() - interval '1 hour'),
  (pg_temp.r(4),  pg_temp.u(3), 'message', pg_temp.t(4), pg_temp.u(4),  'harassment',   '{"v":1,"body":"enf abusive DM"}', 'normal', now() - interval '50 minutes'),
  (pg_temp.r(5),  pg_temp.u(3), 'profile', pg_temp.u(5), pg_temp.u(5),  'harassment',   '{"v":1,"username":"enf_user_5"}', 'normal', now() - interval '40 minutes'),
  (pg_temp.r(6),  pg_temp.u(3), 'post',    pg_temp.t(2), pg_temp.u(8),  'spam',         '{"v":1,"content":"enf post by admin X"}', 'normal', now() - interval '30 minutes'),
  (pg_temp.r(7),  pg_temp.u(9), 'profile', pg_temp.u(10), pg_temp.u(10), 'child_safety', '{"v":1,"username":"enf_user_10"}', 'urgent', now() - interval '20 minutes'),
  (pg_temp.r(8),  pg_temp.u(3), 'post',    gen_random_uuid(), NULL,      'spam',         '{"v":1,"content":"gone"}', 'normal', now() - interval '10 minutes'),
  (pg_temp.r(9),  pg_temp.u(3), 'post',    pg_temp.t(6), pg_temp.u(11), 'spam',         '{"v":1,"content":"enf post by E"}', 'normal', now() - interval '5 minutes');
INSERT INTO v SELECT 'msgs_other', to_jsonb((SELECT count(*) FROM public.moderated_content WHERE target_id = pg_temp.t(5)));

-- ── 2. Authorization ────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT public.admin_report_enforcement(pg_temp.r(1)) $$, '42501', NULL, 'signed-out: enforcement view refused');
SELECT throws_ok($$ SELECT public.admin_report_enforce(pg_temp.r(1), 'hide', 'x', 'pending_review') $$, '42501', NULL, 'signed-out: enforcement refused');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(3));
SELECT throws_ok($$ SELECT pg_temp.view(1) $$, '42501', 'forbidden', 'collector: view refused');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'remove', 'spam') $$, '42501', 'forbidden', 'collector: enforcement refused');
SELECT pg_temp.login(pg_temp.u(6));
SELECT throws_ok($$ SELECT pg_temp.view(1) $$, '42501', 'account_inactive', 'suspended admin: view refused');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'suspend', 'spam') $$, '42501', 'account_inactive', 'suspended admin: enforcement refused');
SELECT pg_temp.login(pg_temp.u(7));
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'suspend', 'spam') $$, '42501', 'account_inactive', 'pending-deletion admin: enforcement refused');
SELECT pg_temp.login(pg_temp.u(1));
RESET ROLE;
DELETE FROM public.admin_users WHERE user_id = pg_temp.u(7);
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(7));
SELECT throws_ok($$ SELECT pg_temp.view(1) $$, '42501', 'forbidden', 'removed admin: view refused');

-- ── 3. Content: claim, hide, stale version, remove, related, restore ────
SELECT pg_temp.login(pg_temp.u(1));
SELECT is(pg_temp.avail(1, 'hide'), 'claim_required', 'unclaimed: hide offered only after a claim');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'hide', 'pending_review') $$, 'PT409', 'claim_required', 'hide without the claim is refused');
SELECT is(pg_temp.avail(1, 'clear_profile_fields'), 'unsupported_target', 'post: no profile-field actions');
SELECT lives_ok($$ SELECT pg_temp.claim(1) $$, 'A claims r1');
SELECT is(pg_temp.avail(1, 'hide'), 'available', 'claimed by A: hide available');
INSERT INTO v SELECT 'v1', to_jsonb(pg_temp.ver(1));
SELECT pg_temp.login(pg_temp.u(2));
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'remove', 'spam') $$, 'PT409', 'claim_required', 'B cannot enforce on A''s claimed report');
SELECT pg_temp.login(pg_temp.u(1));
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'hide', 'spam') $$, '22023', 'invalid_reason_code', 'hide only takes hide reasons');
SELECT lives_ok($$ SELECT pg_temp.enf(1, 'hide', 'pending_review', 'enf hide note') $$, 'A hides the post');
SELECT is(pg_temp.mod(pg_temp.t(1)), 'hidden:false', 'post hidden');
SELECT is(pg_temp.st(1), 'reviewing:-:-', 'report stays in review (claimed by A)');
SELECT is(pg_temp.audits(1, 'hide'), 1, 'hide audited once');
SELECT is((pg_temp.view(1) -> 'media' ->> 'in_progress')::int, 1, 'the post image is queued for quarantine (pending)');
SELECT ok(NOT (pg_temp.view(1) -> 'media' ->> 'automatic')::boolean, 'quarantine is reported as not automatic (scheduler off)');
SELECT ok(pg_temp.view(1)::text !~ ('enf-snap|share-snapshots|' || pg_temp.u(4)::text), 'no storage path, bucket or owner id in the view');
SELECT throws_ok($$ SELECT public.admin_report_enforce(pg_temp.r(1), 'remove', (SELECT val #>> '{}' FROM v WHERE k = 'v1'), 'harassment') $$,
  'PT409', 'report_changed', 'remove from the pre-hide screen: report_changed');
SELECT is(pg_temp.mod(pg_temp.t(1)), 'hidden:false', '…and the content is still only hidden');
SELECT is(pg_temp.avail(1, 'hide'), 'already_hidden', 'hide again: already hidden');
SELECT is((pg_temp.view(1) -> 'target' ->> 'other_pending_reports')::int, 1, 'one other pending report on the post');
SELECT lives_ok($$ SELECT pg_temp.enf(1, 'remove', 'harassment', NULL, '{"include_related": true}') $$, 'A removes the post (with related)');
SELECT is(pg_temp.mod(pg_temp.t(1)), 'removed:false', 'post removed');
SELECT is(pg_temp.st(1), 'actioned:content_removed:harassment', 'report actioned');
SELECT is(pg_temp.st(2), 'actioned:content_removed:harassment', 'the related report is actioned too');
SELECT is(pg_temp.audits(1, 'remove') + pg_temp.audits(2, 'remove'), 2, 'one remove audit row per report');
SELECT is(pg_temp.sq(format('SELECT count(*) FROM public.posts WHERE id = %L', pg_temp.t(1))), '1', 'nothing deleted: the post row remains');
SELECT is(pg_temp.avail(1, 'remove'), 'already_resolved', 'remove again: already resolved');
SELECT is(pg_temp.avail(2, 'restore'), 'available', 'the related report links the same restriction');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'restore', 'resolved_in_error') $$, '22023', 'invalid_disposition', 'restore needs a disposition');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'restore', 'resolved_in_error', NULL, '{"disposition": "keep_reviewing"}') $$, '22023', 'invalid_disposition',
  'keep_reviewing is not possible once removed/actioned');
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT pg_temp.enf(1, 'restore', 'resolved_in_error', 'enf restore', '{"disposition": "reopen"}') $$, 'B restores (reopen)');
SELECT is(pg_temp.mod(pg_temp.t(1)), 'none', 'restriction lifted');
SELECT is(pg_temp.st(1) || ' ' || pg_temp.st(2), 'open:-:- open:-:-', 'both linked reports reopened');
SELECT is(pg_temp.sq(format('SELECT q.desired FROM private.media_quarantine q JOIN private.media_quarantine_holds h ON h.quarantine_id = q.id
            JOIN public.moderated_content m ON m.id = h.moderation_id WHERE m.target_id = %L LIMIT 1', pg_temp.t(1))), 'restore',
  'its quarantine job now wants the media restored');
SELECT is(pg_temp.audits(1, 'restore') + pg_temp.audits(2, 'restore'), 2, 'restore audited per linked report');

-- ── 4. Message target: only the reported message ────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT pg_temp.claim(4) $$, 'A claims the DM report');
SELECT lives_ok($$ SELECT pg_temp.enf(4, 'remove', 'harassment') $$, 'A removes the reported DM');
SELECT is(pg_temp.mod(pg_temp.t(4)), 'removed:false', 'the reported message is removed');
SELECT is(pg_temp.sq(format('SELECT count(*) FROM public.moderated_content WHERE target_id = %L', pg_temp.t(5))), (SELECT val #>> '{}' FROM v WHERE k = 'msgs_other'),
  'the other message in the conversation is untouched');
SELECT is(pg_temp.sq(format('SELECT count(*) FROM public.moderated_content WHERE owner_id = %L AND lifted_at IS NULL', pg_temp.u(4))), '1',
  'only one active restriction on the owner (no collateral content)');

-- ── 5. Child safety: second administrator ────────────────────────────────
SELECT lives_ok($$ SELECT pg_temp.claim(3) $$, 'A claims the child-safety comment report');
SELECT lives_ok($$ SELECT pg_temp.enf(3, 'remove', 'child_safety') $$, 'A removes the comment');
SELECT is(pg_temp.mod(pg_temp.t(3)), 'removed:true', 'restriction is child-safety');
SELECT is(pg_temp.avail(3, 'restore'), 'child_safety_second_admin_required', 'A: restore shown as awaiting a second administrator');
SELECT throws_ok($$ SELECT pg_temp.enf(3, 'restore', 'resolved_in_error', NULL, '{"disposition": "reopen"}') $$, '42501', 'child_safety_confirmation_required',
  'ordinary reason refused for a child-safety restriction');
SELECT throws_ok($$ SELECT pg_temp.enf(3, 'restore', 'child_safety_review_cleared', 'enf cs review', '{"disposition": "reopen", "confirm_child_safety": true}') $$,
  '42501', 'child_safety_second_admin_required', 'A cannot reverse their own child-safety removal (self-approval refused)');
SELECT pg_temp.login(pg_temp.u(2));
SELECT is(pg_temp.avail(3, 'restore'), 'available', 'B: restore available');
SELECT throws_ok($$ SELECT pg_temp.enf(3, 'restore', 'child_safety_review_cleared', NULL, '{"disposition": "reopen", "confirm_child_safety": true}') $$,
  '42501', 'child_safety_confirmation_required', 'B: a review note is required');
SELECT throws_ok($$ SELECT pg_temp.enf(3, 'restore', 'child_safety_review_cleared', 'enf cs review', '{"disposition": "reopen"}') $$,
  '42501', 'child_safety_confirmation_required', 'B: explicit confirmation is required');
SELECT is(pg_temp.mod(pg_temp.t(3)), 'removed:true', 'still removed after the refusals');
SELECT lives_ok($$ SELECT pg_temp.enf(3, 'restore', 'child_safety_review_cleared', 'enf cs review', '{"disposition": "overturn", "confirm_child_safety": true}') $$,
  'B completes the second review');
SELECT is(pg_temp.st(3), 'dismissed:no_violation:decision_overturned', 'overturned');

-- ── 6. Profile fields ────────────────────────────────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SELECT is(pg_temp.avail(5, 'hide') || ',' || pg_temp.avail(5, 'remove'), 'unsupported_target,unsupported_target', 'profile: no hide/remove');
SELECT lives_ok($$ SELECT pg_temp.claim(5) $$, 'A claims the profile report');
SELECT is(pg_temp.view(5) -> 'profile' -> 'clearable_fields', '["bio", "display_name", "tagline"]'::jsonb, 'clearable fields are the non-empty ones (names only)');
SELECT throws_ok($$ SELECT pg_temp.enf(5, 'clear_profile_fields', 'harassment', NULL, '{"fields": "bio"}') $$, '22023', 'invalid_argument', 'fields must be an array');
SELECT throws_ok($$ SELECT pg_temp.enf(5, 'clear_profile_fields', 'harassment', NULL, '{"fields": ["email"]}') $$, '22023', 'invalid_fields', 'only profile fields');
SELECT lives_ok($$ SELECT pg_temp.enf(5, 'clear_profile_fields', 'harassment', NULL, '{"fields": ["display_name", "bio"]}') $$, 'A clears display name and bio');
SELECT is(pg_temp.sq(format('SELECT COALESCE(display_name, %L) || %L || COALESCE(bio, %L) || %L || tagline FROM public.profiles WHERE id = %L', '∅', '|', '∅', '|', pg_temp.u(5))), '∅|∅|enf tagline',
  'exactly those fields cleared');
SELECT is(pg_temp.st(5), 'actioned:content_removed:harassment', 'report actioned');
SELECT ok(pg_temp.view(5)::text !~ 'ENF-SECRET', 'the view never returns the original values');
SELECT ok(pg_temp.sq(format('SELECT metadata::text FROM public.moderation_actions WHERE report_id = %L AND action = %L', pg_temp.r(5), 'clear_profile_fields')) !~ 'ENF-SECRET',
  'the audit row names the fields, never the values');
SELECT is((SELECT jsonb_agg(f ->> 'field' ORDER BY f ->> 'field') FROM jsonb_array_elements(pg_temp.view(5) -> 'profile' -> 'restricted_fields') f),
  '["bio", "display_name"]'::jsonb, 'restricted fields listed');
SELECT throws_ok($$ SELECT pg_temp.enf(5, 'restore_profile_fields', 'resolved_in_error', NULL, '{"fields": ["bio"], "disposition": "reopen"}') $$,
  '22023', 'invalid_disposition', 'a disposition only when the last field is restored');
RESET ROLE;
SELECT throws_ok($$ UPDATE public.profiles SET bio = 'enf new bio by owner' WHERE id = pg_temp.u(5) $$, NULL, 'profile_field_locked',
  'a cleared field stays locked: the collector cannot re-set it while restricted');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT pg_temp.enf(5, 'restore_profile_fields', 'resolved_in_error', NULL, '{"fields": ["display_name"]}') $$, 'restore display name only');
SELECT is(pg_temp.sq(format('SELECT display_name FROM public.profiles WHERE id = %L', pg_temp.u(5))), 'ENF-SECRET-NAME', 'display name restored from the server-side original');
SELECT is((pg_temp.view(5) -> 'restriction' ->> 'active')::boolean, true, 'bio is still restricted');

-- ── 7. Suspension ────────────────────────────────────────────────────────
SELECT is(pg_temp.avail(6, 'suspend'), 'cannot_suspend_admin', 'an administrator owner is not offered suspension');
SELECT throws_ok($$ SELECT pg_temp.enf(6, 'suspend', 'spam') $$, '22023', 'cannot_suspend_admin', 'and the server refuses it');
SELECT is(pg_temp.avail(8, 'suspend'), 'owner_unavailable', 'no owner: no suspension');
SELECT throws_ok($$ SELECT pg_temp.enf(8, 'suspend', 'spam') $$, 'PT409', 'owner_unavailable', 'and the server refuses it');
SELECT throws_ok($$ SELECT pg_temp.enf(4, 'suspend', 'spam', NULL, jsonb_build_object('expires_at', now() + interval '10 minutes')) $$,
  '22023', 'invalid_expiry', 'a temporary suspension lasts at least an hour');
SELECT throws_ok($$ SELECT pg_temp.enf(4, 'suspend', 'pending_review') $$, '22023', 'invalid_reason_code', 'suspension reasons only');
INSERT INTO v SELECT 'o_posts', to_jsonb((SELECT count(*) FROM public.posts WHERE user_id = pg_temp.u(4)));
SELECT lives_ok($$ SELECT pg_temp.enf(4, 'suspend', 'harassment', 'enf suspend note', jsonb_build_object('expires_at', now() + interval '7 days')) $$,
  'A suspends O for 7 days from the DM report');
SELECT ok((pg_temp.view(4) -> 'account' ->> 'suspended')::boolean, 'view: suspended');
SELECT is(pg_temp.view(4) -> 'account' -> 'suspension' ->> 'reason_code', 'harassment', 'view: reason');
SELECT ok((pg_temp.view(4) -> 'account' -> 'suspension' ->> 'expires_at')::timestamptz > now() + interval '6 days', 'view: expiry');
SELECT ok((pg_temp.view(4) -> 'account' -> 'suspension' ->> 'from_this_report')::boolean, 'view: linked to this report');
SELECT ok(pg_temp.view(4)::text !~ 'enf suspend note', 'view: the internal note is not returned');
SELECT is(pg_temp.avail(4, 'suspend'), 'already_suspended', 'suspend again: already suspended');
SELECT throws_ok($$ SELECT pg_temp.enf(4, 'suspend', 'spam') $$, 'PT409', 'already_suspended', 'and refused');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.posts WHERE user_id = pg_temp.u(4)), (SELECT (val #>> '{}')::bigint FROM v WHERE k = 'o_posts'), 'suspension deletes no content');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = pg_temp.u(4)), 'suspension starts no account deletion');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE report_id = pg_temp.r(4) AND action = 'suspend'), 1, 'suspension audited against the report');
SET LOCAL ROLE authenticated;
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT pg_temp.enf(4, 'lift_suspension', 'appeal_granted') $$, 'B lifts the (non child-safety) suspension');
SELECT is(pg_temp.view(4) -> 'account' -> 'suspension' ->> 'state', 'lifted', 'view: lifted');
SELECT is(pg_temp.avail(4, 'lift_suspension'), 'not_suspended', 'nothing left to lift');
-- Expired suspension (E).
SELECT is(pg_temp.view(9) -> 'account' -> 'suspension' ->> 'state', 'expired', 'an expired suspension shows as expired');
SELECT ok(NOT (pg_temp.view(9) -> 'account' ->> 'suspended')::boolean, '…and the account is not suspended');
SELECT throws_ok($$ SELECT pg_temp.enf(9, 'lift_suspension', 'appeal_granted') $$, 'PT409', 'not_suspended', 'an expired suspension cannot be lifted');
SELECT is(pg_temp.avail(9, 'suspend'), 'available', 'and a new suspension may be imposed');
-- Child-safety suspension (K, from a child-safety report).
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT pg_temp.enf(7, 'suspend', 'child_safety') $$, 'A suspends K indefinitely (child safety)');
SELECT ok((pg_temp.view(7) -> 'account' -> 'suspension' ->> 'child_safety')::boolean
      AND pg_temp.view(7) -> 'account' -> 'suspension' ->> 'expires_at' IS NULL, 'child-safety, indefinite');
SELECT is(pg_temp.avail(7, 'lift_suspension'), 'second_admin_required', 'A: lifting awaits a second administrator');
SELECT throws_ok($$ SELECT pg_temp.enf(7, 'lift_suspension', 'child_safety_review_cleared', 'enf review', '{"confirm_child_safety": true}') $$,
  '42501', 'second_admin_required', 'A cannot lift their own child-safety suspension');
SELECT pg_temp.login(pg_temp.u(2));
SELECT throws_ok($$ SELECT pg_temp.enf(7, 'lift_suspension', 'child_safety_review_cleared', 'enf review') $$,
  '22023', 'child_safety_confirmation_required', 'B: confirmation required');
SELECT throws_ok($$ SELECT pg_temp.enf(7, 'lift_suspension', 'appeal_granted', 'enf review', '{"confirm_child_safety": true}') $$,
  '22023', 'child_safety_review_required', 'B: the dedicated reason is required');
SELECT lives_ok($$ SELECT pg_temp.enf(7, 'lift_suspension', 'child_safety_review_cleared', 'enf review', '{"confirm_child_safety": true}') $$, 'B lifts after review');
SELECT ok(NOT (pg_temp.view(7) -> 'account' ->> 'suspended')::boolean, 'lifted');

-- ── 8. Legal hold, other reports, bad input ─────────────────────────────
SELECT pg_temp.login(pg_temp.u(1));
SELECT lives_ok($$ SELECT public.admin_place_legal_hold('report', pg_temp.r(9), 'internal_investigation', 'enf hold', now() + interval '30 days') $$, 'legal hold on r9');
SELECT lives_ok($$ SELECT pg_temp.claim(9) $$, 'A claims r9');
SELECT lives_ok($$ SELECT pg_temp.enf(9, 'remove', 'spam') $$, 'A removes the held report''s content');
SELECT ok((pg_temp.view(9) ->> 'legal_hold')::boolean AND pg_temp.sq(format('SELECT evidence IS NOT NULL FROM public.content_reports WHERE id = %L', pg_temp.r(9))) = 'true',
  'the legal hold and the evidence are preserved');
SELECT lives_ok($$ SELECT pg_temp.claim(2) $$, 'A claims r2 (reopened)');
SELECT lives_ok($$ SELECT pg_temp.enf(2, 'hide', 'urgent_risk') $$, 'A hides the post through r2');
SELECT pg_temp.login(pg_temp.u(2));
SELECT lives_ok($$ SELECT pg_temp.claim(1) $$, 'B claims r1 (open, same post)');
SELECT is(pg_temp.avail(1, 'restore'), 'restricted_via_other_report', 'r1: the restriction belongs to r2');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'restore', 'resolved_in_error', NULL, '{"disposition": "reopen"}') $$, 'PT409', 'restricted_via_other_report',
  'restore refused from the other report');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'delete_account', 'spam') $$, '22023', 'invalid_action', 'no other action exists (no deletion)');
SELECT throws_ok($$ SELECT pg_temp.enf(1, 'hide', 'pending_review', NULL, '[1]') $$, '22023', 'invalid_argument', 'options must be an object');
SELECT throws_ok($$ SELECT public.admin_report_enforce(pg_temp.r(1), 'hide', NULL, 'pending_review') $$, '22023', 'invalid_version', 'a version is required');
SELECT throws_ok($$ SELECT public.admin_report_enforce('00000000-0000-4000-8000-000000000bad', 'hide', 'x', 'pending_review') $$, 'PT404', 'not_found', 'unknown report');
SELECT throws_ok($$ SELECT public.admin_report_enforcement('00000000-0000-4000-8000-000000000bad') $$, 'PT404', 'not_found', 'unknown report (view)');

SELECT * FROM finish();
ROLLBACK;

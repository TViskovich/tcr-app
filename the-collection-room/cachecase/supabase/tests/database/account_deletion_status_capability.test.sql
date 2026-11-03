-- pgTAP test for 20261110120000_account_deletion_status_capability.sql:
-- the signed-out deletion status capability — private, hashed, bound to the
-- collector's own job, expiring, rate limited, and identity-free.
-- Run against the LOCAL database only:  supabase test db
-- Everything happens inside one transaction that is rolled back.

BEGIN;
SELECT plan(31);

CREATE FUNCTION pg_temp.h(t text) RETURNS bytea LANGUAGE sql AS $$ SELECT extensions.digest(t, 'sha256') $$;
CREATE FUNCTION pg_temp.check(t text, c text DEFAULT 'client-a') RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.account_deletion_status_by_token(pg_temp.h(t), pg_temp.h(c)) $$;

DELETE FROM private.account_deletion_status_tokens;
DELETE FROM private.account_deletion_status_throttle;
INSERT INTO public.account_deletion_jobs (id, user_id, mode, status) VALUES
  ('00000000-0000-4000-8000-00000c0a0001', '00000000-0000-4000-8000-00000c0a00a1', 'immediate', 'cleaning_storage'),
  ('00000000-0000-4000-8000-00000c0a0002', '00000000-0000-4000-8000-00000c0a00a2', 'immediate', 'queued');

-- ── Privileges ──────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['private.account_deletion_status_tokens', 'private.account_deletion_status_throttle']::regclass[]) t,
  unnest(ARRAY['anon', 'authenticated', 'service_role']) r
  WHERE has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE')), 0,
  'no client (or the service role) can touch capabilities or the throttle directly');
SELECT ok((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('private.account_deletion_status_tokens'::regclass, 'private.account_deletion_status_throttle'::regclass)), 'RLS is on');
SELECT ok(NOT has_function_privilege('anon', 'public.account_deletion_issue_status_token(uuid,bytea)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_deletion_issue_status_token(uuid,bytea)', 'EXECUTE'), 'clients cannot issue capabilities');
SELECT ok(NOT has_function_privilege('anon', 'public.account_deletion_status_by_token(bytea,bytea)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.account_deletion_status_by_token(bytea,bytea)', 'EXECUTE'), 'nor check them directly');
SELECT ok(has_function_privilege('service_role', 'public.account_deletion_issue_status_token(uuid,bytea)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.account_deletion_status_by_token(bytea,bytea)', 'EXECUTE'), 'the service role can');

-- ── Issuing ─────────────────────────────────────────────────────────────
SELECT is(public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00a1', pg_temp.h('tok-a1')), now() + interval '72 hours',
  'a capability for the collector''s job, valid 72 hours');
SELECT is((SELECT job_id FROM private.account_deletion_status_tokens WHERE token_hash = pg_temp.h('tok-a1')), '00000000-0000-4000-8000-00000c0a0001'::uuid,
  'bound to that collector''s own job');
SELECT ok(NOT EXISTS (SELECT 1 FROM private.account_deletion_status_tokens t WHERE t::text LIKE '%tok-a1%'), 'only the hash is stored, never the capability');
SELECT is(public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00ff', pg_temp.h('tok-none')), NULL,
  'no deletion job: no capability');
SELECT throws_ok($$ SELECT public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00a1', '\x00'::bytea) $$, '22023', 'invalid_status_token',
  'only a 32-byte hash is accepted');
SELECT public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00a2', pg_temp.h('tok-a2'));

-- ── Checking ────────────────────────────────────────────────────────────
SELECT is(pg_temp.check('tok-a1'), '{"result": "ok", "state": "processing"}'::jsonb, 'a valid capability: processing');
SELECT is(pg_temp.check('tok-a1'), '{"result": "rate_limited", "retry_after_seconds": 2}'::jsonb, 'a second check within 2 seconds is refused');
UPDATE private.account_deletion_status_tokens SET last_checked_at = now() - interval '3 seconds';
UPDATE public.account_deletion_jobs SET status = 'completed', completed_at = now(), purge_after = now() + interval '30 days'
  WHERE id = '00000000-0000-4000-8000-00000c0a0001';
SELECT is(pg_temp.check('tok-a1'), '{"result": "ok", "state": "completed"}'::jsonb, 'completed once the job is');
UPDATE public.account_deletion_jobs SET status = 'failed', failed_at = now(), last_error_code = 'auth_delete_failed'
  WHERE id = '00000000-0000-4000-8000-00000c0a0002';
SELECT is(pg_temp.check('tok-a2'), '{"result": "ok", "state": "failed"}'::jsonb, 'failed when the job failed (no error code exposed)');
SELECT is((SELECT checks FROM private.account_deletion_status_tokens WHERE token_hash = pg_temp.h('tok-a1')), 2, 'successful checks are counted');

-- Cross-account: each capability only ever reports its own job.
UPDATE private.account_deletion_status_tokens SET last_checked_at = NULL;
SELECT is(pg_temp.check('tok-a1') ->> 'state', 'completed', 'collector 1''s capability: collector 1''s job');
SELECT is(pg_temp.check('tok-a2') ->> 'state', 'failed', 'collector 2''s capability: collector 2''s job');

-- Invalid and expired.
SELECT is(pg_temp.check('guessed'), '{"result": "invalid"}'::jsonb, 'an unknown capability is invalid');
UPDATE private.account_deletion_status_tokens SET expires_at = now() - interval '1 second', last_checked_at = NULL WHERE token_hash = pg_temp.h('tok-a2');
SELECT is(pg_temp.check('tok-a2'), '{"result": "invalid"}'::jsonb, 'an expired capability is invalid — the same answer, nothing distinguishes it');
SELECT is((SELECT failures FROM private.account_deletion_status_throttle WHERE client_hash = pg_temp.h('client-a')), 2, 'failed checks are counted per client');
SELECT ok(NOT EXISTS (SELECT 1 FROM private.account_deletion_status_throttle t WHERE t::text LIKE '%client-a%'), 'clients are stored only as a hash');

-- ── Client limit ────────────────────────────────────────────────────────
SELECT pg_temp.check('guess-' || g) FROM generate_series(1, 18) g;
SELECT is((SELECT failures FROM private.account_deletion_status_throttle WHERE client_hash = pg_temp.h('client-a')), 20, '20 failed checks');
UPDATE private.account_deletion_status_tokens SET last_checked_at = NULL;
SELECT is(pg_temp.check('tok-a1') ->> 'result', 'rate_limited', 'then the client is refused, even with a valid capability');
SELECT ok((pg_temp.check('tok-a1') ->> 'retry_after_seconds')::int BETWEEN 1 AND 600, 'until the 10-minute window ends');
SELECT is(pg_temp.check('tok-a1', 'client-b') ->> 'state', 'completed', 'another client is unaffected');
UPDATE private.account_deletion_status_throttle SET window_start = now() - interval '11 minutes' WHERE client_hash = pg_temp.h('client-a');
UPDATE private.account_deletion_status_tokens SET last_checked_at = NULL;
SELECT is(pg_temp.check('tok-a1') ->> 'state', 'completed', 'after the window the client may check again');

-- ── At most 5 live per job; purged with the job ─────────────────────────
SELECT public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00a1', pg_temp.h('tok-a1-' || g)) FROM generate_series(1, 6) g;
SELECT is((SELECT count(*)::int FROM private.account_deletion_status_tokens WHERE job_id = '00000000-0000-4000-8000-00000c0a0001'), 5,
  'at most 5 live capabilities per job (older ones revoked)');
SELECT is((SELECT count(*)::int FROM private.account_deletion_status_tokens WHERE expires_at <= now()), 0, 'issuing prunes expired capabilities');
DELETE FROM public.account_deletion_jobs WHERE id = '00000000-0000-4000-8000-00000c0a0001';
SELECT is((SELECT count(*)::int FROM private.account_deletion_status_tokens WHERE job_id = '00000000-0000-4000-8000-00000c0a0001'), 0,
  'when job records are purged, their capabilities go too');

-- ── Identity-free answers ───────────────────────────────────────────────
SELECT public.account_deletion_issue_status_token('00000000-0000-4000-8000-00000c0a00a2', pg_temp.h('tok-a2b'));
UPDATE private.account_deletion_status_tokens SET last_checked_at = NULL;
SELECT ok(pg_temp.check('tok-a2b')::text !~ '00000c0a' AND pg_temp.check('tok-a2b', 'client-c')::text !~ 'auth_delete_failed',
  'answers hold no job or account ids and no error codes');
SELECT throws_ok($$ SELECT public.account_deletion_status_by_token(NULL, '\x01'::bytea) $$, '22023', 'invalid_client', 'a client hash is required');

SELECT * FROM finish();
ROLLBACK;

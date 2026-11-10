/// <reference types="node" />
// Profile field moderation (20261117120000_profile_moderation.sql) —
// end-to-end against the LOCAL Supabase stack through PostgREST, GraphQL
// and Storage, as the profile editor, a hostile client or a second admin
// would call them.
//
// Cleanup note: restrictions, reports and the audit trail are append-only
// for every API role, so this script removes ITS OWN fixture rows through a
// local superuser psql session (session_replication_role = replica),
// scoped to reports carrying this script's marker. Field restrictions go
// with their accounts (ON DELETE CASCADE).
//
// Run:  node scripts/integration/profile-moderation.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'profile-moderation-it';
const MARK = 'pm-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const uploaded = new Set<string>(); // avatar object paths this run created
const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'supabase_db_cachecase', 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
}
const step = (s: string) => console.log(`\n${s}`);
const must = <T>(r: { data: T; error: unknown }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
  return r.data;
};

type U = { id: string; username: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `pm${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Pm-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, username, token: s.session!.access_token, db };
}

async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        -- M2.3b: this fixture's quarantine jobs (queued by its restrictions).
        CREATE TEMP TABLE fq ON COMMIT DROP AS SELECT DISTINCT h.quarantine_id AS id FROM private.media_quarantine_holds h
          WHERE h.moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_events WHERE quarantine_id IN (SELECT id FROM fq)
          OR moderation_id IN (SELECT m.id FROM public.moderated_content m WHERE m.report_id IN (SELECT id FROM fx));
        DELETE FROM private.media_quarantine_holds WHERE quarantine_id IN (SELECT id FROM fq);
        DELETE FROM private.media_quarantine WHERE id IN (SELECT id FROM fq);
        DELETE FROM public.moderated_profile_fields WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  if (uploaded.size) await service.storage.from('avatars').remove([...uploaded]);
  for (const id of ids) {
    for (const prefix of [id, `${id}/hero`, `${id}/badge`]) {
      const { data: files } = await service.storage.from('avatars').list(prefix, { limit: 100 });
      const objs = (files ?? []).filter((f) => f.id).map((f) => `${prefix}/${f.name}`);
      if (objs.length) await service.storage.from('avatars').remove(objs);
    }
    await service.auth.admin.deleteUser(id);
  }
  return ids.length;
}

type R = { data: any; error: { message?: string; code?: string; details?: string } | null; status: number };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const refused = (r: { error: { message?: string } | null; status?: number }, token: string, status?: number) =>
  !!r.error && (r.error.message ?? '').includes(token) && (status === undefined || r.status === status);
const profileOf = async (u: { db: SupabaseClient }, id: string) =>
  (await u.db.from('profiles').select('*').eq('id', id).maybeSingle()).data as Record<string, any> | null;
const report = async (u: U, target: string, reason = 'hate') => {
  must(await u.db.rpc('submit_report', { p_target_type: 'profile', p_target_id: target, p_reason: reason, p_details: `${MARK} ${run}` }), 'report');
  return (must(await service.from('content_reports').select('id').eq('target_type', 'profile').eq('target_id', target).eq('reporter_id', u.id).in('status', ['open', 'reviewing']).single(), 'id') as { id: string }).id;
};
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function main() {
  const P = await createUser('p');   // reported collector
  const O = await createUser('o');   // reporter / other collector
  const V = await createUser('v');   // second reporter
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');

  step('0. Fixtures: P sets a full profile with a real avatar');
  const avatarPath = `${P.id}/${Date.now()}.jpg`;
  must(await P.db.storage.from('avatars').upload(avatarPath, jpeg, { contentType: 'image/jpeg' }), 'avatar upload');
  uploaded.add(avatarPath);
  const avatarUrl = P.db.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl;
  must(await P.db.from('profiles').update({ display_name: `PM Bad ${run}`, bio: `pm bad bio ${run}`, location: 'pm place', website: 'pm.example',
    hero_display_name: 'pm hero', tagline: 'pm tag', avatar_url: avatarUrl }).eq('id', P.id), 'profile');
  const r1 = await report(O, P.id, 'hate'), r2 = await report(V, P.id, 'harassment');
  check('fixtures created', true);

  step('1. Authorization and exposure');
  for (const [fn, args] of [['admin_clear_profile_fields', { p_report_id: r1, p_fields: ['bio'], p_reason_code: 'hate' }],
                            ['admin_profile_moderation_status', { p_user_id: P.id }],
                            ['admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['bio'], p_reason_code: 'resolved_in_error' }],
                            ['admin_release_profile_fields', { p_user_id: P.id, p_fields: ['bio'], p_reason_code: 'owner_may_edit' }]] as const) {
    check(`collector: ${fn} → 403 forbidden`, refused(await rpc(P, fn, args), 'forbidden', 403));
    const a = await (anon.rpc(fn, args) as unknown as Promise<R>);
    check(`signed-out: ${fn} refused`, !!a.error && [401, 403].includes(a.status), a.status);
  }
  check('service role cannot call them', !!(await service.rpc('admin_profile_moderation_status', { p_user_id: P.id })).error);
  const tbl = await P.db.from('moderated_profile_fields').select('*').limit(1);
  check('collectors cannot read originals through PostgREST', !!tbl.error || (tbl.data ?? []).length === 0, tbl);
  const stbl = await service.from('moderated_profile_fields').select('*').limit(1);
  check('… nor can the service role', !!stbl.error, stbl.data);
  const gql = await (await fetch(`${st.API_URL}/graphql/v1`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${M1.token}` },
    body: JSON.stringify({ query: '{ moderatedProfileFieldsCollection { edges { node { originalValue } } } }' }) })).json();
  check('GraphQL exposes no originals (even to an admin)', !gql?.data?.moderatedProfileFieldsCollection?.edges?.length, gql?.errors?.[0]?.message ?? gql?.data);

  step('2. Two admins clear concurrently via two reports');
  const [a, b] = await Promise.all([
    rpc(M1, 'admin_clear_profile_fields', { p_report_id: r1, p_fields: ['bio', 'display_name', 'avatar_url'], p_reason_code: 'hate' }),
    rpc(M2, 'admin_clear_profile_fields', { p_report_id: r2, p_fields: ['bio', 'location'], p_reason_code: 'harassment' })]);
  check('both succeed', !a.error && !b.error, [a.error ?? a.data, b.error ?? b.data]);
  const bioRows = Number(psql(`SELECT count(*) FROM public.moderated_profile_fields WHERE user_id = '${P.id}' AND field = 'bio' AND status = 'active'`));
  check('exactly one active restriction for the field both cleared', bioRows === 1, bioRows);
  check('the second clear saw it as already locked (or cleared it first)',
    [a.data, b.data].filter((x) => (x?.cleared ?? []).includes('bio')).length === 1
    && [a.data, b.data].filter((x) => (x?.already_locked ?? []).includes('bio')).length === 1, [a.data, b.data]);
  check('the image clear reports its public URL as still reachable', JSON.stringify(a.data?.public_media_still_reachable) === '["avatar_url"]');
  const retries = await Promise.all(Array.from({ length: 4 }, () =>
    rpc(M1, 'admin_clear_profile_fields', { p_report_id: r1, p_fields: ['bio', 'display_name', 'avatar_url'], p_reason_code: 'hate' })));
  check('4 concurrent retries change nothing', retries.every((r) => !r.error && r.data.changed === false), retries.map((r) => r.error?.message ?? r.data?.changed));

  step('3. Public reads');
  const seen = await profileOf(O, P.id);
  check('O sees the four fields cleared, the rest intact', seen?.bio === null && seen?.display_name === null && seen?.avatar_url === null
    && seen?.location === null && seen?.website === 'pm.example' && seen?.tagline === 'pm tag', seen);
  const pub = await profileOf({ db: anon }, P.id);
  check('signed out: same cleared values', pub?.bio === null && pub?.display_name === null);
  const search = await O.db.from('profiles').select('id').ilike('display_name', `%PM Bad ${run}%`);
  check('search by the cleared display name finds nothing', !search.error && (search.data ?? []).length === 0);
  const publicFetch = await fetch(avatarUrl);
  check('KNOWN (M2.3): the cleared avatar\'s public URL still serves the image', publicFetch.status === 200, publicFetch.status);

  step('4. The lock, through the API');
  const bad = await P.db.from('profiles').update({ bio: 'pm bad bio again' }).eq('id', P.id).select('id');
  check('owner: rewriting the bio → 403 profile_field_locked', refused(bad as any, 'profile_field_locked', 403), bad);
  const repoint = await P.db.from('profiles').update({ avatar_url: avatarUrl }).eq('id', P.id).select('id');
  check('owner: re-pointing the avatar at the same image → refused', refused(repoint as any, 'profile_field_locked'));
  const ups = await P.db.from('profiles').upsert({ id: P.id, username: P.username, display_name: 'Sneaky' }).select('id');
  check('owner: an upsert → refused', !!ups.error, ups);
  const editorSave = await P.db.from('profiles').update({ hero_display_name: 'pm hero 2', display_name: null, bio: null, location: null,
    website: 'pm2.example', tagline: 'pm tag', avatar_url: null }).eq('id', P.id).select('id');
  check('owner: an editor-style whole-profile save (locked fields sent as stored) succeeds', !editorSave.error && editorSave.data?.length === 1, editorSave.error);
  const blankSave = await P.db.from('profiles').update({ bio: '', website: 'pm3.example' }).eq('id', P.id).select('bio, website').single();
  check('owner: a blank re-send of a locked field keeps it cleared and saves the rest',
    !blankSave.error && blankSave.data?.bio === null && blankSave.data?.website === 'pm3.example', blankSave.error ?? blankSave.data);
  const svc = await service.from('profiles').update({ bio: 'by service role' }).eq('id', P.id).select('id');
  check('service role: rewriting a locked field → refused', refused(svc as any, 'profile_field_locked'), svc);
  const mine = await rpc(P, 'my_profile_moderation');
  check('owner contract: field names + dates only', JSON.stringify((mine.data?.locked_fields ?? []).map((f: any) => f.field)) === '["avatar_url","bio","display_name","location"]'
    && (mine.data.locked_fields as any[]).every((f) => JSON.stringify(Object.keys(f).sort()) === '["field","since"]'), mine.data);
  const mineText = JSON.stringify(mine.data);
  check('owner contract: no original, reporter or admin', !mineText.includes('pm bad') && !mineText.includes(O.id) && !mineText.includes(M1.id) && !mineText.includes(avatarPath));
  check('another collector sees no lock state for P', JSON.stringify((await rpc(O, 'my_profile_moderation')).data) === '{"locked_fields":[]}');

  step('5. Admin inspection, restore, release');
  const status = await rpc(M1, 'admin_profile_moderation_status', { p_user_id: P.id });
  check('admin status shows the active originals', (status.data?.fields ?? []).some((f: any) => f.field === 'bio' && f.original_value === `pm bad bio ${run}`), status.error);
  // M2.3b (20261119120000): the cleared avatar is held for quarantine, so the
  // owner can no longer delete the evidence…
  const ownerRemove = await P.db.storage.from('avatars').remove([avatarPath]);
  check('the owner cannot delete their held, cleared avatar (evidence)',
    !ownerRemove.error && (ownerRemove.data ?? []).length === 0
      && (await service.storage.from('avatars').list(P.id)).data?.some((f) => avatarPath.endsWith(f.name)) === true, ownerRemove);
  // …nor can the service role (20261121120000). The object can still
  // disappear outside the app — simulated as a database operator would — and
  // restore must then refuse rather than link nothing.
  check('the service role cannot delete it either', !!(await service.storage.from('avatars').remove([avatarPath])).error);
  if (!/^[A-Za-z0-9._\/-]+$/.test(avatarPath)) throw new Error('unsafe path');
  psql(`BEGIN; SET LOCAL storage.allow_delete_query = 'true'; DELETE FROM storage.objects WHERE bucket_id = 'avatars' AND name = '${avatarPath}'; COMMIT;`);
  execFileSync('docker', ['exec', 'supabase_storage_cachecase', 'rm', '-rf', `/mnt/stub/stub/avatars/${avatarPath}`]);
  check('restore refuses an image whose object is gone',
    refused(await rpc(M1, 'admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['avatar_url'], p_reason_code: 'appeal_granted' }), 'original_media_missing', 409));
  check('release the avatar instead (stays cleared, unlocked)',
    (await rpc(M1, 'admin_release_profile_fields', { p_user_id: P.id, p_fields: ['avatar_url'], p_reason_code: 'owner_may_edit' })).data?.changed === true);
  check('owner can set a new avatar after release', !(await P.db.from('profiles').update({ avatar_url: null }).eq('id', P.id)).error);
  const [x, y] = await Promise.all([
    rpc(M1, 'admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['bio'], p_reason_code: 'appeal_granted' }),
    rpc(M2, 'admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['bio'], p_reason_code: 'appeal_granted' })]);
  check('two concurrent restores of the same field: one change', [x, y].every((r) => !r.error) && [x, y].filter((r) => r.data.changed).length === 1,
    [x.error ?? x.data, y.error ?? y.data]);
  check('the bio is back', (await profileOf(O, P.id))?.bio === `pm bad bio ${run}`);
  check('restoring the last fields without a disposition → refused',
    refused(await rpc(M2, 'admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['display_name', 'location'], p_reason_code: 'appeal_granted' }), 'invalid_disposition', 400));
  const last = await rpc(M2, 'admin_restore_profile_fields', { p_user_id: P.id, p_fields: ['display_name', 'location'], p_reason_code: 'appeal_granted', p_disposition: 'overturn' });
  check('restoring the last fields lifts the restriction', last.data?.profile_restriction === 'lifted', last.error ?? last.data);
  const reps = must(await service.from('content_reports').select('status, resolution_reason').in('id', [r1, r2]), 'reports') as any[];
  check('both reports overturned, none left actioned', reps.length === 2 && reps.every((r) => r.status === 'dismissed' && r.resolution_reason === 'decision_overturned'), reps);
  check('owner can edit every field again', !(await P.db.from('profiles').update({ display_name: 'PM Fine', bio: 'fine' }).eq('id', P.id)).error);

  step('6. Audit and deletion');
  const audit = must(await service.from('moderation_actions').select('action, metadata').in('report_id', [r1, r2]), 'audit') as any[];
  check('every action audited with field names', audit.length >= 4 && audit.every((r) => Array.isArray(r.metadata?.fields) || r.metadata?.via_report), audit.map((r) => r.action));
  check('no audit row contains an original value', !JSON.stringify(audit).includes('pm bad') && !JSON.stringify(audit).includes(avatarPath));
  const r3 = await report(O, P.id, 'spam');
  must(await rpc(M1, 'admin_clear_profile_fields', { p_report_id: r3, p_fields: ['bio'], p_reason_code: 'spam' }), 'clear again');
  must(await service.auth.admin.deleteUser(P.id) as { data: unknown; error: unknown }, 'delete P');
  check('deleting a collector with an active lock works and removes their originals',
    psql(`SELECT count(*) FROM public.moderated_profile_fields WHERE user_id = '${P.id}'`) === '0');
  check('… while reports and restriction history stay (anonymised)',
    psql(`SELECT count(*) FROM public.content_reports WHERE id IN ('${r1}','${r2}','${r3}')`) === '3'
    && psql(`SELECT bool_and(owner_id IS NULL) FROM public.moderated_content WHERE target_type = 'profile' AND target_id = '${P.id}'`) === 't');
}

console.log(`Local Supabase ${st.API_URL} (run ${run})`);
const swept = await sweep();
if (swept) console.log(`Swept ${swept} leftover fixture account(s).`);
let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nAborted: ${(e as Error).message}`);
} finally {
  console.log(`\nCleanup: ${await sweep()} account(s) removed.`);
  console.log(`Fixture rows left: ${psql(`SELECT (SELECT count(*) FROM public.content_reports WHERE details LIKE '${MARK}%') || ' reports, '
    || (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'fixture' = '${FIXTURE}') || ' users, '
    || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'avatars' AND name = ANY (ARRAY[${[...uploaded].map((x) => `'${x}'`).join(',') || "''"}]::text[])) || ' objects'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

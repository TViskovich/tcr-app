/// <reference types="node" />
// Content moderation enforcement (20261116120000_content_moderation.sql) —
// end-to-end against the LOCAL Supabase stack: PostgREST, GraphQL, Storage
// and the (unchanged) image-signing Edge Functions, as the app, a hostile
// client or a second admin would call them.
//
// Cleanup note: restrictions, reports and the audit trail are append-only
// for every API role, so this script removes ITS OWN fixture rows through a
// local superuser psql session (session_replication_role = replica),
// scoped to reports carrying this script's marker.
//
// Prerequisites: local Supabase with the migration applied, and
// `supabase functions serve` running (for the signing checks).
// Run:  node scripts/integration/content-moderation.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'content-moderation-it';
const MARK = 'cm-it fixture';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
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
  const username = `cm${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Cm-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, username, token: s.session!.access_token, db };
}

const conversations = new Set<string>();
const objects: { bucket: string; path: string }[] = [];
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  // Fixture restrictions, audit rows and reports (superuser only — see header).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
        CREATE TEMP TABLE fx ON COMMIT DROP AS SELECT id FROM public.content_reports WHERE details LIKE '${MARK}%';
        DELETE FROM public.moderation_actions WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.moderated_content WHERE report_id IN (SELECT id FROM fx);
        DELETE FROM public.content_reports WHERE id IN (SELECT id FROM fx);
        COMMIT;`);
  for (const o of objects.splice(0)) await service.storage.from(o.bucket).remove([o.path]);
  if (ids.length) {
    const { data: parts } = await service.from('conversation_participants').select('conversation_id').in('user_id', ids);
    for (const p of parts ?? []) conversations.add(p.conversation_id);
    for (const id of ids) {
      for (const b of ['item-images', 'dm-attachments']) {
        const { data: files } = await service.storage.from(b).list(id, { limit: 100 });
        if (files?.length) await service.storage.from(b).remove(files.map((f) => `${id}/${f.name}`));
      }
    }
  }
  for (const c of conversations) {
    const { data: folders } = await service.storage.from('dm-attachments').list(c);
    for (const f of folders ?? []) {
      const { data: files } = await service.storage.from('dm-attachments').list(`${c}/${f.name}`);
      if (files?.length) await service.storage.from('dm-attachments').remove(files.map((x) => `${c}/${f.name}/${x.name}`));
    }
  }
  if (conversations.size) await service.from('conversations').delete().in('id', [...conversations]);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  return ids.length;
}

type R = { data: any; error: { message?: string; code?: string } | null; status: number };
const rpc = (u: { db: SupabaseClient }, fn: string, args: Record<string, unknown> = {}) => u.db.rpc(fn, args) as unknown as Promise<R>;
const refused = (r: { error: { message?: string } | null; status?: number }, token: string, status?: number) =>
  !!r.error && (r.error.message ?? '').includes(token) && (status === undefined || r.status === status);
const count = async (u: { db: SupabaseClient }, table: string, col: string, val: string) =>
  ((await u.db.from(table).select('*', { count: 'exact', head: true }).eq(col, val)).count ?? -1);
const report = async (u: U, type: string, id: string, reason = 'spam') => {
  must(await u.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: `${MARK} ${run}` }), `report ${type}`);
  return (must(await service.from('content_reports').select('id').eq('target_type', type).eq('target_id', id).eq('reporter_id', u.id).single(), 'report id') as { id: string }).id;
};
const fn = async (name: string, token: string | null, body: unknown) => {
  // Signed out = no Authorization header at all (an anon-key bearer is an invalid user JWT → 401).
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: st.ANON_KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const imageStatus = async (token: string | null, imageId: string) =>
  (await fn('get-collection-item-image-signed-url', token, { image_ids: [imageId] })).body?.results?.[0]?.status as string | undefined;
const coverStatus = async (token: string | null, folderId: string) =>
  (await fn('get-folder-cover-signed-url', token, { folder_ids: [folderId] })).body?.results?.[0]?.status as string | undefined;
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function main() {
  const A = await createUser('a');   // owner of everything moderated
  const O = await createUser('o');   // another collector / reporter
  const R = await createUser('r');   // A's DM partner / reporter
  const M1 = await createUser('m1');
  const M2 = await createUser('m2');
  must(await service.from('admin_users').insert([{ user_id: M1.id }, { user_id: M2.id }]), 'admins');
  const fnUp = (await fn('get-collection-item-image-signed-url', null, { image_ids: [randomUUID()] })).status;
  if (fnUp >= 500) throw new Error(`Edge Functions not served (status ${fnUp}) — run supabase functions serve`);

  step('0. Fixtures (A: folder with items and real images, a post, a DM photo to R)');
  const F = randomUUID(), I = randomUUID(), J = randomUUID(), P = randomUUID(), imgI = randomUUID(), imgJ = randomUUID();
  must(await A.db.from('folders').insert({ id: F, user_id: A.id, name: `cm folder ${run}`, is_public: true }), 'folder');
  must(await A.db.from('collection_items').insert([
    { id: I, folder_id: F, user_id: A.id, title: `cmitem${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' },
    { id: J, folder_id: F, user_id: A.id, title: `cmcover${run}`, is_public: true, collection_status: 'active', item_type: 'sports_card' },
  ]), 'items');
  for (const [img, item, name] of [[imgI, I, 'i.jpg'], [imgJ, J, 'j.jpg']] as const) {
    const path = `${A.id}/cm-it/${name}`;
    must(await A.db.storage.from('item-images').upload(path, jpeg, { contentType: 'image/jpeg' }), 'upload');
    objects.push({ bucket: 'item-images', path });
    must(await A.db.from('collection_item_images').insert({ id: img, item_id: item, user_id: A.id, image_url: 'https://x.invalid', storage_path: path, sort_order: 0, is_primary: true }), 'image row');
  }
  must(await A.db.from('folders').update({ cover_source: 'item', cover_item_id: J }).eq('id', F), 'cover');
  must(await A.db.from('posts').insert({ id: P, user_id: A.id, content: `cm post ${run}`, post_type: 'text' }), 'post');
  const conv = must(await A.db.rpc('get_or_create_conversation', { other_user_id: R.id }), 'conversation') as string;
  conversations.add(conv);
  const msg = randomUUID();
  const dmPath = `${conv}/${msg}/image.jpg`;
  must(await A.db.storage.from('dm-attachments').upload(dmPath, jpeg, { contentType: 'image/jpeg' }), 'dm upload');
  must(await A.db.from('messages').insert({ id: msg, conversation_id: conv, sender_id: A.id, body: null, attachment_type: 'image', attachment_storage_path: dmPath, attachment_width: 1, attachment_height: 1 }), 'dm');
  const rPost = await report(O, 'post', P), rPost2 = await report(R, 'post', P), rItem = await report(O, 'collection_item', I);
  const rCover = await report(O, 'collection_item', J), rFolder = await report(O, 'folder', F), rMsg = await report(R, 'message', msg, 'sexual');
  check('before: O sees the post, items and can sign both images',
    (await count(O, 'posts', 'id', P)) === 1 && (await count(O, 'collection_items', 'folder_id', F)) === 2
    && (await imageStatus(O.token, imgI)) === 'ok' && (await imageStatus(null, imgJ)) === 'ok');
  check('before: R can sign the DM photo', !(await R.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);

  step('1. Authorization');
  for (const [name, args] of [['admin_hide_content', { p_report_id: rPost, p_reason_code: 'pending_review' }],
                              ['admin_remove_content', { p_report_id: rPost, p_reason_code: 'spam' }],
                              ['admin_restore_content', { p_moderation_id: randomUUID(), p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }]] as const) {
    check(`collector: ${name} → 403 forbidden`, refused(await rpc(A, name, args), 'forbidden', 403));
    const a = await (anon.rpc(name, args) as unknown as Promise<R>);
    check(`signed-out: ${name} refused`, !!a.error && [401, 403].includes(a.status), a.status);
  }
  check('service role cannot call admin moderation functions', !!(await service.rpc('admin_hide_content', { p_report_id: rPost, p_reason_code: 'pending_review' })).error);
  const direct = await O.db.from('moderated_content').select('id').limit(1);
  check('collectors cannot read moderated_content', !!direct.error || (direct.data ?? []).length === 0, direct);
  const gql = await (await fetch(`${st.API_URL}/graphql/v1`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${M1.token}` },
    body: JSON.stringify({ query: '{ moderatedContentCollection { edges { node { id targetId } } } }' }) })).json();
  check('GraphQL exposes no restrictions (even to an admin)', !gql?.data?.moderatedContentCollection?.edges?.length, gql?.errors?.[0]?.message ?? gql?.data);

  step('2. Posts: hide, through the API');
  const hid = await rpc(M1, 'admin_hide_content', { p_report_id: rPost, p_reason_code: 'pending_review' });
  check('M1 hides the post', hid.data?.state === 'hidden' && hid.data?.report_status === 'reviewing', hid.error ?? hid.data);
  check('O: the post is gone from the feed query', (await count(O, 'posts', 'id', P)) === 0);
  check('signed out: gone too', (await count({ db: anon }, 'posts', 'id', P)) === 0);
  const feed = await O.db.from('posts').select('id, comments(id)').eq('user_id', A.id);
  check('O: an embedded feed read of A\'s posts returns nothing', !feed.error && (feed.data ?? []).length === 0, feed.error);
  check('A: still sees their own post', (await count(A, 'posts', 'id', P)) === 1);
  check('O: liking it → 403 content_unavailable', refused(await O.db.from('likes').insert({ user_id: O.id, post_id: P }) as any, 'content_unavailable', 403));
  check('O: reposting it → 403 content_unavailable',
    refused(await O.db.from('posts').insert({ user_id: O.id, post_type: 'repost', repost_of_post_id: P }) as any, 'content_unavailable', 403));
  const mine = await rpc(A, 'my_moderation_status', { p_target_type: 'post', p_ids: [P] });
  check('owner status: exactly {target_type, target_id, state, since}',
    JSON.stringify(Object.keys(mine.data?.[0] ?? {}).sort()) === JSON.stringify(['since', 'state', 'target_id', 'target_type']) && mine.data[0].state === 'hidden', mine.data);
  check('owner status: no reporter or admin identity', !JSON.stringify(mine.data).includes(O.id) && !JSON.stringify(mine.data).includes(M1.id));
  check('O gets nothing about A\'s content from the status function', JSON.stringify((await rpc(O, 'my_moderation_status', { p_target_type: 'post', p_ids: [P] })).data) === '[]');

  step('3. Concurrency: two admins, two reports, one post, same instant');
  const [x, y] = await Promise.all([
    rpc(M1, 'admin_remove_content', { p_report_id: rPost, p_reason_code: 'spam' }),
    rpc(M2, 'admin_hide_content', { p_report_id: rPost2, p_reason_code: 'pending_review' })]);
  check('both succeed (or the hide sees the removal first)', !x.error && (!y.error || refused(y, 'already_removed', 409) || refused(y, 'already_resolved', 409)), [x.error ?? x.data, y.error ?? y.data]);
  const rows = must(await service.from('moderated_content').select('id, state').eq('target_id', P).is('lifted_at', null), 'rows') as any[];
  check('exactly one active restriction, removed', rows.length === 1 && rows[0].state === 'removed', rows);
  const retries = await Promise.all(Array.from({ length: 4 }, () => rpc(M1, 'admin_remove_content', { p_report_id: rPost, p_reason_code: 'spam' })));
  check('4 concurrent retries of the removal: all succeed, none change anything', retries.every((r) => !r.error && r.data.changed === false), retries.map((r) => r.error?.message ?? r.data?.changed));
  const postMod = rows[0].id as string;

  step('4. Items and images: database and the real signing Edge Function');
  check('item removed', (await rpc(M1, 'admin_remove_content', { p_report_id: rItem, p_reason_code: 'scam_fraud' })).data?.state === 'removed');
  check('O: the item is gone', (await count(O, 'collection_items', 'id', I)) === 0);
  check('O: its image row is gone', (await count(O, 'collection_item_images', 'item_id', I)) === 0);
  const search = await rpc(O, 'search_profile_items', { p_owner_id: A.id, p_query: `cmitem${run}`, p_limit: 20, p_offset: 0 });
  check('O: search no longer finds it', !search.error && (search.data ?? []).length === 0, search.error ?? search.data);
  check('signing (unchanged Edge Function): O → unavailable', (await imageStatus(O.token, imgI)) === 'unavailable');
  check('signing: signed out → unavailable', (await imageStatus(null, imgI)) === 'unavailable');
  check('signing: the owner → ok', (await imageStatus(A.token, imgI)) === 'ok');
  check('owner: re-sharing it in a card share → content_unavailable', refused(await A.db.from('posts').insert({ user_id: A.id, post_type: 'item', item_id: I, image_url: 'https://x.invalid' }) as any, 'content_unavailable'));
  check('owner: may still edit it, and it stays hidden',
    !(await A.db.from('collection_items').update({ title: `cmitem${run} edited` }).eq('id', I)).error && (await count(O, 'collection_items', 'id', I)) === 0);

  step('5. Folder covers (gap closed by M2.3a, 20261118120000_media_signing_moderation.sql)');
  check('cover item removed', (await rpc(M2, 'admin_remove_content', { p_report_id: rCover, p_reason_code: 'hate' })).data?.state === 'removed');
  check('O: the cover item and its image row are hidden in the database',
    (await count(O, 'collection_items', 'id', J)) === 0 && (await imageStatus(O.token, imgJ)) === 'unavailable');
  const cover = await coverStatus(O.token, F);
  check('folder cover: a removed cover item is no longer signed for others', cover === 'unavailable', cover);
  check('folder cover: the owner still gets it', (await coverStatus(A.token, F)) === 'ok');
  check('hiding the folder itself closes the cover', (await rpc(M1, 'admin_hide_content', { p_report_id: rFolder, p_reason_code: 'pending_review' })).data?.state === 'hidden'
    && (await coverStatus(O.token, F)) === 'unavailable' && (await coverStatus(A.token, F)) === 'ok');
  check('owner: moving an item out of the hidden folder → refused',
    refused(await A.db.from('collection_items').update({ folder_id: randomUUID() }).eq('id', J) as any, 'content_unavailable'));

  step('6. DM photo');
  check('M2 removes the DM photo', (await rpc(M2, 'admin_remove_content', { p_report_id: rMsg, p_reason_code: 'sexual' })).data?.state === 'removed');
  const rs = await R.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60);
  check('R: no new signed URL for the photo', !!rs.error, rs.data);
  check('A: the sender can still sign it', !(await A.db.storage.from('dm-attachments').createSignedUrl(dmPath, 60)).error);
  check('R: the message is gone from the conversation', (await count(R, 'messages', 'id', msg)) === 0 && (await count(A, 'messages', 'id', msg)) === 1);

  step('7. Restore');
  const [r1, r2] = await Promise.all([
    rpc(M2, 'admin_restore_content', { p_moderation_id: postMod, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' }),
    rpc(M2, 'admin_restore_content', { p_moderation_id: postMod, p_reason_code: 'resolved_in_error', p_disposition: 'overturn' })]);
  check('two concurrent restores: one change', [r1, r2].filter((r) => !r.error && r.data.changed).length === 1 && [r1, r2].every((r) => !r.error), [r1.error ?? r1.data, r2.error ?? r2.data]);
  check('O sees the post again', (await count(O, 'posts', 'id', P)) === 1);
  // Depending on the race in step 3, the second report was either resolved
  // with the removal (linked) or skipped while M2 held it (left pending).
  const after = must(await service.from('content_reports').select('status, resolution_reason, moderation_id').in('id', [rPost, rPost2]), 'reports') as any[];
  check('linked reports are dismissed (decision_overturned); any unlinked one is still pending; none actioned',
    after.length === 2 && after.every((r) => r.status !== 'actioned')
    && after.filter((r) => r.moderation_id === postMod).every((r) => r.status === 'dismissed' && r.resolution_reason === 'decision_overturned')
    && after.filter((r) => r.moderation_id !== postMod).every((r) => ['open', 'reviewing'].includes(r.status)), after);
  const itemMod = (must(await service.from('content_reports').select('moderation_id').eq('id', rItem).single(), 'item mod') as any).moderation_id;
  must(await rpc(M1, 'admin_restore_content', { p_moderation_id: itemMod, p_reason_code: 'appeal_granted', p_disposition: 'reopen' }), 'restore item');
  check('restored item: still unsignable for O while its folder stays hidden', (await imageStatus(O.token, imgI)) === 'unavailable');
  check('… and the reopened report is back in the queue', (must(await service.from('content_reports').select('status').eq('id', rItem).single(), 's') as any).status === 'open');

  step('8. Audit and deletion');
  const audit = must(await service.from('moderation_actions').select('action, admin_id, metadata').in('report_id', [rPost, rPost2, rItem, rCover, rFolder, rMsg]), 'audit') as any[];
  check('every action is audited with its admin and restriction', audit.length >= 8 && audit.every((a) => a.admin_id && a.metadata?.moderation_id), audit.length);
  check('audit rows are not writable by the service role', !!(await service.from('moderation_actions').delete().eq('admin_id', M1.id).select('id')).error);
  must(await service.auth.admin.deleteUser(A.id) as { data: unknown; error: unknown }, 'delete A');
  const hist = must(await service.from('moderated_content').select('owner_id').eq('report_id', rCover), 'hist') as any[];
  check('deleting the owner works; restriction history stays, anonymised', hist.length === 1 && hist[0].owner_id === null);
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
    || (SELECT count(*) FROM auth.users WHERE raw_app_meta_data->>'fixture' = '${FIXTURE}') || ' users'`)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

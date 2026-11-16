/// <reference types="node" />
// Item-images deletion ledger + worker (P2.3 Issue 1,
// 20261204120000_item_image_deletion_ledger.sql, item-image-cleanup) — end to
// end on an ISOLATED, disposable local stack: real Storage uploads/removals of
// disposable fixtures, the real Edge runtime and the real RPCs.
//
// This script turns the cleanup switch ON on the isolated stack only and
// restores it to OFF before it exits. It refuses to run against the primary
// local stack (and against anything hosted).
//
// Prerequisites (isolated stack, e.g. CACHECASE_STACK_WORKDIR=<workdir>):
//   supabase functions serve --workdir <workdir> --env-file <file> with
//   ITEM_IMAGE_CLEANUP_WORKER_SECRET (≥ 32); the same secret in this process's
//   ITEM_IMAGE_CLEANUP_WORKER_SECRET. The secret is never printed.
// Run:  CACHECASE_STACK_WORKDIR=<workdir> node scripts/integration/item-image-cleanup.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireIsolatedStack } from './local-stack.ts';

const stack = requireIsolatedStack();
const st = stack.st;
const SECRET = process.env.ITEM_IMAGE_CLEANUP_WORKER_SECRET ?? '';
if (SECRET.length < 32) throw new Error('ITEM_IMAGE_CLEANUP_WORKER_SECRET (≥ 32 characters) must be set for this process.');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const FIXTURE = 'item-image-cleanup-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);
const psql = (sql: string) =>
  execFileSync('docker', ['exec', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
// SQL through stdin (keeps values such as the secret out of process arguments).
const psqlIn = (sql: string) =>
  execFileSync('docker', ['exec', '-i', stack.db, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { encoding: 'utf8', input: sql }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type U = { id: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const username = `iic${run}${key}`;
  const email = `${username}@example.test`;
  const password = `Iic-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, db };
}

const exists = (path: string) =>
  psql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'item-images' AND name = ${lit(path)}`) === '1';
const ledger = (path: string) =>
  psql(`SELECT state || '|' || source || '|' || COALESCE(last_reason, '') FROM private.item_image_deletions WHERE path = ${lit(path)} ORDER BY id DESC LIMIT 1`);
const makeDue = (owner: string) =>
  psql(`UPDATE private.item_image_deletions SET not_before = clock_timestamp() - interval '1 second' WHERE owner_id = ${lit(owner)} AND state IN ('pending', 'deferred')`);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

async function upload(u: U, path: string) {
  must(await u.db.storage.from('item-images').upload(path, JPEG, { contentType: 'image/jpeg' }), `upload ${path}`);
}
// fault: local-only fault injection (the served function needs
// CACHECASE_TEST_IIC_FAULTS=1; ignored on any hosted project).
async function worker(secret = SECRET, body: Record<string, unknown> = { trigger: 'operator' }, fault?: string) {
  const res = await fetch(`${st.API_URL}/functions/v1/item-image-cleanup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      ...(fault ? { 'x-cachecase-local-fault': fault } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const users: U[] = [];
try {
  psql(`UPDATE private.item_image_cleanup_config SET enabled = false`);
  const a = await createUser('a');
  users.push(a);

  step('Fixtures: folder, item, three photos (real Storage uploads by the owner)');
  const folder = { id: randomUUID() };
  const item = { id: randomUUID() };
  must(await a.db.from('folders').insert({ id: folder.id, user_id: a.id, name: `IIC ${run}`, is_public: true }), 'folder');
  must(await a.db.from('collection_items').insert({
    id: item.id, folder_id: folder.id, user_id: a.id, title: `IIC item ${run}`, is_public: true, item_type: 'trading_card',
  }), 'item');
  const p = (n: string) => `${a.id}/${item.id}/${n}.jpg`;
  for (const n of ['1', '2', '3']) await upload(a, p(n));
  const rows = ['1', '2', '3'].map((n) => ({ id: randomUUID(), storage_path: p(n) }));
  must(await a.db.from('collection_item_images').insert(rows.map((r, i) => ({
    id: r.id, item_id: item.id, user_id: a.id, image_url: `x-${i}`, storage_path: r.storage_path, sort_order: i, is_primary: i === 0,
  }))), 'image rows');
  const idOf = (n: string) => rows.find((r) => r.storage_path === p(n))!.id;
  check('three objects uploaded', ['1', '2', '3'].every((n) => exists(p(n))));

  step('The original defect: a client-side remove() reports success but deletes nothing');
  const clientRemove = await a.db.storage.from('item-images').remove([p('2')]);
  check('client remove() returns no error…', clientRemove.error === null, clientRemove.error);
  check('…matches 0 objects…', Array.isArray(clientRemove.data) && clientRemove.data.length === 0, clientRemove.data);
  check('…and the object is still there (no SELECT policy — not widened)', exists(p('2')));

  step('Removing a photo records it in the ledger (same transaction)');
  must(await a.db.rpc('remove_item_image', { p_image_id: idOf('2') }), 'remove_item_image');
  check('ledger: pending / image_removed', ledger(p('2')) === 'pending|image_removed|', ledger(p('2')));
  check('the file is untouched during the grace period', exists(p('2')));

  step('Gates');
  const off = await worker();
  check('switch OFF: the worker is skipped (disabled)', off.status === 200 && off.body.reason === 'disabled', off);
  const bad = await worker('x'.repeat(40));
  check('a wrong secret is refused (401)', bad.status === 401, bad.status);
  const badBody = await worker(SECRET, { trigger: 'operator', path: p('1') });
  check('an unexpected body field is refused (no caller-chosen paths)', badBody.status === 400, badBody);
  psql(`UPDATE private.item_image_cleanup_config SET enabled = true`);
  const early = await worker();
  check('switch ON but inside the grace period: nothing claimed', early.body.status === 'ok' && early.body.claimed === 0, early.body);
  check('…the file is still there', exists(p('2')));

  step('Due: the worker deletes it through the Storage API');
  makeDue(a.id);
  const r1 = await worker();
  check('worker run ok, 1 deleted', r1.body.status === 'ok' && r1.body.outcomes?.deleted === 1, r1.body);
  check('the object is gone from Storage', !exists(p('2')));
  check('ledger: deleted', ledger(p('2')).startsWith('deleted|'), ledger(p('2')));
  check('the photos still in use are untouched', exists(p('1')) && exists(p('3')));
  const r1b = await worker();
  check('a second run finds nothing (idempotent)', r1b.body.claimed === 0, r1b.body);

  step('Report evidence defers the deletion');
  psql(`INSERT INTO public.content_reports (reporter_id, target_type, target_id, target_owner_id, reason, evidence)
        SELECT ${lit(a.id)}, 'collection_item', ${lit(item.id)}, ${lit(a.id)}, 'other',
               jsonb_build_object('v', 1, 'image_refs', jsonb_build_array(jsonb_build_object('bucket', 'item-images', 'path', ${lit(p('3'))})))`);
  must(await a.db.rpc('remove_item_image', { p_image_id: idOf('3') }), 'remove_item_image 3');
  makeDue(a.id);
  const r2 = await worker();
  check('nothing deleted', (r2.body.outcomes?.deleted ?? 0) === 0, r2.body);
  check('the evidence file is kept', exists(p('3')));
  check('ledger: deferred / report_evidence', ledger(p('3')) === 'deferred|image_removed|report_evidence', ledger(p('3')));

  step('Deleting a folder releases every photo of every item in it, and its uploaded cover');
  const folder2 = { id: randomUUID() };
  const item2 = { id: randomUUID() };
  must(await a.db.from('folders').insert({ id: folder2.id, user_id: a.id, name: `IIC2 ${run}`, is_public: true }), 'folder2');
  must(await a.db.from('collection_items').insert({
    id: item2.id, folder_id: folder2.id, user_id: a.id, title: `IIC item2 ${run}`, is_public: true, item_type: 'trading_card',
  }), 'item2');
  const q = (n: string) => `${a.id}/${item2.id}/${n}.jpg`;
  const cover = `${a.id}/covers/${run}.jpg`;
  for (const path of [q('a'), q('b'), cover]) await upload(a, path);
  must(await a.db.from('collection_item_images').insert([
    { item_id: item2.id, user_id: a.id, image_url: 'x-a', storage_path: q('a'), sort_order: 0, is_primary: true },
    { item_id: item2.id, user_id: a.id, image_url: 'x-b', storage_path: q('b'), sort_order: 1, is_primary: false },
  ]), 'item2 images');
  must(await a.db.from('folders').update({ cover_source: 'upload', cover_storage_path: cover }).eq('id', folder2.id), 'cover');
  must(await a.db.from('folders').delete().eq('id', folder2.id).select('id'), 'delete folder');
  check('both photos and the cover are recorded',
    ledger(q('a')).startsWith('pending|item_deleted') && ledger(q('b')).startsWith('pending|item_deleted') && ledger(cover).startsWith('pending|folder_deleted'),
    [ledger(q('a')), ledger(q('b')), ledger(cover)]);
  makeDue(a.id);
  const r3 = await worker();
  check('worker deletes all three', r3.body.outcomes?.deleted === 3, r3.body);
  check('all three objects are gone', !exists(q('a')) && !exists(q('b')) && !exists(cover));
  check('the deferred evidence file is still kept', exists(p('3')));

  step('A rejected upload (no row was ever inserted) is cleaned up after 24 h');
  const stray = `${a.id}/${item.id}/stray.jpg`;
  await upload(a, stray);
  const req = must(await a.db.rpc('request_item_upload_cleanup', { p_paths: [stray, `${randomUUID()}/x/y.jpg`] }), 'request cleanup');
  check("only the caller's own upload is accepted", req === 1, req);
  check('ledger: pending / upload_rejected', ledger(stray).startsWith('pending|upload_rejected'), ledger(stray));
  const r4 = await worker();
  check('not deleted inside its 24 h grace', exists(stray) && r4.body.claimed === 0, r4.body);
  makeDue(a.id);
  const r5 = await worker();
  check('deleted once due', !exists(stray) && r5.body.outcomes?.deleted === 1, r5.body);


  step('F1: a delayed worker can never delete a newly referenced live image');
  // Fresh fixture photo D, removed by the owner and due.
  const d = p('delayed');
  await upload(a, d);
  const dId = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: dId, item_id: item.id, user_id: a.id, image_url: 'x-d', storage_path: d, sort_order: 9, is_primary: false }), 'D row');
  must(await a.db.rpc('remove_item_image', { p_image_id: dId }), 'remove D');
  makeDue(a.id);
  // Worker A claims it, then stalls far past its lease (simulated: its lease
  // is moved into the past, as if minutes had gone by).
  const claimA = psql(`SET ROLE service_role; SELECT claim_token FROM public.item_image_deletion_claim(50, 600) WHERE path = ${lit(d)}`).split('\n').pop()!;
  check('worker A holds a claim on D', /^[0-9a-f-]{36}$/.test(claimA), claimA);
  psql(`UPDATE private.item_image_deletions SET lease_expires_at = clock_timestamp() - interval '1 hour' WHERE path = ${lit(d)}`);
  // The owner (or a stale screen) now tries to use D again.
  const reuse = await a.db.from('collection_item_images').insert({ item_id: item.id, user_id: a.id, image_url: 'x-d2', storage_path: d, sort_order: 10, is_primary: false });
  check('re-referencing D after its claim expired is REFUSED', !!reuse.error && /content_unavailable/.test(reuse.error.message), reuse.error);
  const reuseUrl = await a.db.from('collection_items').update({ image_url: `${st.API_URL}/storage/v1/object/public/item-images/${d}` }).eq('id', item.id).select('id');
  check('…also by public URL', !!reuseUrl.error && /content_unavailable/.test(reuseUrl.error.message), reuseUrl.error);
  // …or through a post (post-commit review: a child-safety restriction of a
  // post would hold any item-images URL it names, after D's claim).
  const dUrl = `${st.API_URL}/storage/v1/object/public/item-images/${d}`;
  const postReuse = await a.db.from('posts').insert({ user_id: a.id, post_type: 'text', caption: `IIC ${run} d`, image_url: dUrl }).select('id');
  check('…also in a post (posts.image_url)', !!postReuse.error && /content_unavailable/.test(postReuse.error.message), postReuse.error);
  const parent = must(await a.db.from('posts').insert({ user_id: a.id, post_type: 'text', caption: `IIC ${run} parent` }).select('id').single(), 'parent post') as { id: string };
  const imgReuse = await a.db.from('post_images').insert({ post_id: parent.id, image_url: dUrl, source_type: 'library', sort_order: 0 });
  check('…and in a post photo (post_images.image_url)', !!imgReuse.error && /content_unavailable/.test(imgReuse.error.message), imgReuse.error);
  const snapUrl = `${st.API_URL}/storage/v1/object/public/share-snapshots/${a.id}/card_share/${run}/1.jpg`;
  const normal = await a.db.from('posts').insert({ user_id: a.id, post_type: 'text', caption: `IIC ${run} normal`, image_url: snapUrl }).select('id');
  check('a normal post with a share-snapshots image is unaffected', !normal.error, normal.error);
  // Worker A's stalled Storage call finally lands.
  must(await service.storage.from('item-images').remove([d]), 'late remove');
  check('the late removal deleted D…', !exists(d));
  check('…and NO live row references D (nothing live was lost)',
    psql(`SELECT (SELECT count(*) FROM public.collection_item_images WHERE storage_path = ${lit(d)} OR image_url LIKE ${lit('%' + d)}) + (SELECT count(*) FROM public.collection_items WHERE image_url LIKE ${lit('%' + d)})
               + (SELECT count(*) FROM public.posts WHERE image_url LIKE ${lit('%' + d)} OR folder_cover_snapshot_url LIKE ${lit('%' + d)}) + (SELECT count(*) FROM public.post_images WHERE image_url LIKE ${lit('%' + d)})`) === '0');
  check('…and no moderation hold names D (no evidence could be lost)',
    psql(`SELECT count(*) FROM private.media_quarantine WHERE source_bucket = 'item-images' AND source_path = ${lit(d)}`) === '0');
  // Worker B re-claims the abandoned claim and completes it; A's late completion is a no-op.
  const rB = await worker();
  check('worker B re-claims the expired claim and records it deleted', rB.body.outcomes?.deleted === 1 && ledger(d).startsWith('deleted|'), rB.body);
  const dLedgerId = psql(`SELECT id FROM private.item_image_deletions WHERE path = ${lit(d)} ORDER BY id DESC LIMIT 1`);
  const lateA = psql(`SET ROLE service_role; SELECT public.item_image_deletion_complete(${dLedgerId}, ${lit(claimA)}, NULL)`).split('\n').pop();
  check("worker A's late completion changes nothing (stale_claim)", lateA === 'stale_claim', lateA);
  const after = await a.db.from('collection_item_images').insert({ item_id: item.id, user_id: a.id, image_url: 'x-d3', storage_path: d, sort_order: 11, is_primary: false });
  check('D stays unreferenceable after deletion (no broken gallery row)', !!after.error, after.error);

  step('F2: removing an item\'s LAST photo leaves no stale image to re-create');
  const solo = { id: randomUUID() };
  must(await a.db.from('collection_items').insert({
    id: solo.id, folder_id: folder.id, user_id: a.id, title: `IIC solo ${run}`, is_public: true, item_type: 'trading_card',
  }), 'solo item');
  const sp = `${a.id}/${solo.id}/only.jpg`;
  await upload(a, sp);
  const soloImg = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: soloImg, item_id: solo.id, user_id: a.id, image_url: `${st.API_URL}/storage/v1/object/public/item-images/${sp}`, storage_path: sp, sort_order: 0, is_primary: true }), 'solo row');
  must(await a.db.rpc('set_primary_item_image', { p_item_id: solo.id, p_image_id: soloImg }), 'primary');
  must(await a.db.rpc('remove_item_image', { p_image_id: soloImg }), 'remove solo');
  const server = must(await a.db.from('collection_items').select('image_url').eq('id', solo.id).single(), 'reread') as { image_url: string | null };
  check('the server clears image_url (edit mode re-reads this, so nothing is re-created)', server.image_url === null, server);
  const staleReuse = await a.db.from('collection_item_images').insert({ item_id: solo.id, user_id: a.id, image_url: `${st.API_URL}/storage/v1/object/public/item-images/${sp}`, storage_path: sp, sort_order: 0, is_primary: true });
  check('a stale screen re-creating it inside the grace period only CANCELS the deletion (file kept, nothing broken)',
    !staleReuse.error && ledger(sp).startsWith('cancelled|') && exists(sp), [staleReuse.error, ledger(sp)]);

  step('Storage failure → safe retry');
  const e = p('stfail');
  await upload(a, e);
  const eId = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: eId, item_id: item.id, user_id: a.id, image_url: 'x-e', storage_path: e, sort_order: 12, is_primary: false }), 'E row');
  must(await a.db.rpc('remove_item_image', { p_image_id: eId }), 'remove E');
  makeDue(a.id);
  const rE = await worker(SECRET, { trigger: 'operator' }, 'storage_error');
  check('a Storage error is a retry, not a deletion', rE.body.outcomes?.retry === 1 && exists(e), rE.body);
  check('ledger: pending with the error recorded',
    psql(`SELECT state || '|' || attempts || '|' || last_error_code FROM private.item_image_deletions WHERE path = ${lit(e)}`) === 'pending|1|storage_error');
  makeDue(a.id);
  const rE2 = await worker();
  check('the retry deletes it', rE2.body.outcomes?.deleted === 1 && !exists(e), rE2.body);

  step('Worker deadline: nothing is sent to Storage past the cutoff');
  const g = p('deadline');
  await upload(a, g);
  const gId = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: gId, item_id: item.id, user_id: a.id, image_url: 'x-g', storage_path: g, sort_order: 13, is_primary: false }), 'G row');
  must(await a.db.rpc('remove_item_image', { p_image_id: gId }), 'remove G');
  makeDue(a.id);
  const rG = await worker(SECRET, { trigger: 'operator' }, 'deadline_exceeded');
  check('past the deadline: retried, file untouched', rG.body.outcomes?.retry === 1 && exists(g), rG.body);
  check('…recorded as lease_deadline', psql(`SELECT last_error_code FROM private.item_image_deletions WHERE path = ${lit(g)}`) === 'lease_deadline');

  step('A worker that dies after removing: recovered by the next run');
  makeDue(a.id);
  const rX = await worker(SECRET, { trigger: 'operator' }, 'crash_after_remove');
  check('the crashed run removed the file but completed nothing', rX.body.status === 'interrupted' && !exists(g) && ledger(g).startsWith('claimed|'), rX.body);
  const busy = await worker();
  check('a second run is refused while the first still counts as running', busy.body.reason === 'busy', busy.body);
  psql(`UPDATE private.item_image_cleanup_runs SET started_at = clock_timestamp() - interval '11 minutes' WHERE status = 'running';
        UPDATE private.item_image_deletions SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE path = ${lit(g)}`);
  const rX2 = await worker();
  check('the next run reaps it, re-claims and records the deletion (idempotent)', rX2.body.outcomes?.deleted === 1 && ledger(g).startsWith('deleted|'), rX2.body);

  step('Two workers at once never both run');
  const h1 = p('conc1'); const h2 = p('conc2');
  for (const path of [h1, h2]) await upload(a, path);
  const hIds = [randomUUID(), randomUUID()];
  must(await a.db.from('collection_item_images').insert([
    { id: hIds[0], item_id: item.id, user_id: a.id, image_url: 'x-h1', storage_path: h1, sort_order: 14, is_primary: false },
    { id: hIds[1], item_id: item.id, user_id: a.id, image_url: 'x-h2', storage_path: h2, sort_order: 15, is_primary: false },
  ]), 'H rows');
  for (const id of hIds) must(await a.db.rpc('remove_item_image', { p_image_id: id }), 'remove H');
  makeDue(a.id);
  const [c1, c2] = await Promise.all([worker(), worker()]);
  const ran = [c1, c2].filter((r) => r.body.status === 'ok');
  const deleted = ran.reduce((n, r) => n + (r.body.outcomes?.deleted ?? 0), 0);
  check('both files deleted exactly once in total', deleted === 2 && !exists(h1) && !exists(h2), [c1.body, c2.body]);
  check('no overlap: at most one run is open at any time', psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE status = 'running'`) === '0');

  step('Scheduled path: database → pg_net → function (the cron command), and its authorization');
  const j = p('sched');
  await upload(a, j);
  const jId = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: jId, item_id: item.id, user_id: a.id, image_url: 'x-j', storage_path: j, sort_order: 16, is_primary: false }), 'J row');
  must(await a.db.rpc('remove_item_image', { p_image_id: jId }), 'remove J');
  makeDue(a.id);
  const kong = `http://supabase_kong_${stack.project}:8000`;
  const runsBefore = Number(psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE trigger = 'sweep'`));
  psqlIn(`DELETE FROM vault.secrets WHERE name IN ('project_url', 'item_image_cleanup_worker_secret');
          SELECT vault.create_secret(${lit(kong)}, 'project_url');
          SELECT vault.create_secret(${lit('w'.repeat(40))}, 'item_image_cleanup_worker_secret');
          SELECT private.run_item_image_cleanup();`);
  await sleep(4000);
  check('with the WRONG secret in Vault, the dispatched call opens no run (401)',
    Number(psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE trigger = 'sweep'`)) === runsBefore && exists(j));
  psqlIn(`SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'item_image_cleanup_worker_secret'), ${lit(SECRET)});
          SELECT private.run_item_image_cleanup();`);
  let swept = false;
  for (let i = 0; i < 20 && !swept; i++) {
    await sleep(1000);
    swept = !exists(j) && ledger(j).startsWith('deleted|');
  }
  check('with the right secret, the scheduled sweep deletes it', swept, ledger(j));
  check('…recorded as a completed sweep run',
    psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE trigger = 'sweep' AND status = 'completed'`) !== '0');
  psql(`UPDATE private.item_image_cleanup_config SET enabled = false`);
  const pre = Number(psql(`SELECT count(*) FROM private.item_image_cleanup_runs`));
  psqlIn(`SELECT private.run_item_image_cleanup();`);
  await sleep(2000);
  check('switch OFF: the dispatcher sends nothing', Number(psql(`SELECT count(*) FROM private.item_image_cleanup_runs`)) === pre);
  psql(`UPDATE private.item_image_cleanup_config SET enabled = true`);

  step('F6: an account deletion job takes over that account\'s cleanup');
  const k = p('acct');
  await upload(a, k);
  const kId = randomUUID();
  must(await a.db.from('collection_item_images').insert({ id: kId, item_id: item.id, user_id: a.id, image_url: 'x-k', storage_path: k, sort_order: 17, is_primary: false }), 'K row');
  must(await a.db.rpc('remove_item_image', { p_image_id: kId }), 'remove K');
  check('K is recorded', ledger(k).startsWith('pending|'));
  psql(`INSERT INTO public.account_deletion_jobs (user_id, mode) VALUES (${lit(a.id)}, 'immediate')`);
  check("the job clears the account's ledger rows (no stranded jobs)", psql(`SELECT count(*) FROM private.item_image_deletions WHERE owner_id = ${lit(a.id)}`) === '0');
  psql(`DELETE FROM public.collection_item_images WHERE id = ${lit(idOf('1'))}`);
  check('nothing new is recorded while the job is open (no duplicate cleanup)', psql(`SELECT count(*) FROM private.item_image_deletions WHERE owner_id = ${lit(a.id)}`) === '0');
  psql(`DELETE FROM public.account_deletion_jobs WHERE user_id = ${lit(a.id)}`);

  step('Runs are recorded with counts only');
  const runs = psql(`SELECT count(*) || '|' || count(*) FILTER (WHERE status = 'completed') FROM private.item_image_cleanup_runs`);
  const [total, completed] = runs.split('|');
  const interrupted = psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE status IN ('abandoned')`);
  check('every run completed (except the deliberately crashed one, reaped as abandoned)', Number(total) > 0 && Number(total) === Number(completed) + Number(interrupted), runs);
  check('no run row carries a path', psql(`SELECT count(*) FROM private.item_image_cleanup_runs WHERE outcomes::text LIKE '%/%'`) === '0');
} finally {
  psql(`UPDATE private.item_image_cleanup_config SET enabled = false`);
  psql(`DELETE FROM vault.secrets WHERE name IN ('project_url', 'item_image_cleanup_worker_secret')`);
  psql(`UPDATE private.item_image_cleanup_runs SET status = 'abandoned', finished_at = clock_timestamp() WHERE status = 'running'`);
  for (const u of users) {
    const left = psql(`SELECT string_agg(name, E'\\n') FROM storage.objects WHERE bucket_id = 'item-images' AND name LIKE ${lit(`${u.id}/%`)}`);
    if (left) await service.storage.from('item-images').remove(left.split('\n'));
    psql(`DELETE FROM public.content_reports WHERE reporter_id = ${lit(u.id)}`);
    await service.auth.admin.deleteUser(u.id);
    psql(`DELETE FROM private.item_image_deletions WHERE owner_id = ${lit(u.id)}`);
  }
  console.log(`\nswitch restored: enabled=${psql(`SELECT enabled FROM private.item_image_cleanup_config`)}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

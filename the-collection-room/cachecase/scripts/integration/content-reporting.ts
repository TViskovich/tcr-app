/// <reference types="node" />
// Content reporting (20261114120000_add_content_reports.sql) — end-to-end
// against the LOCAL Supabase stack through PostgREST (and GraphQL), exactly
// as the app or a hostile client would call it. Disposable collectors A, B,
// C (and R for rate limits) are created with the Auth admin API; every
// report and account they produce is removed afterwards.
//
// Prerequisite: local Supabase with the migration applied.
// Run:  node scripts/integration/content-reporting.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(st.API_URL)) throw new Error(`Refusing: ${st.API_URL} is not local.`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const anon = createClient(st.API_URL, st.ANON_KEY, opts);
const FIXTURE = 'content-reporting-it';
const run = randomUUID().replace(/-/g, '').slice(0, 6);

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

type U = { id: string; email: string; password: string; token: string; db: SupabaseClient };
async function createUser(key: string): Promise<U> {
  const email = `cr${run}${key}@example.test`;
  const password = `Cr-${randomBytes(9).toString('base64url')}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { username: `cr${run}${key}` }, app_metadata: { fixture: FIXTURE },
  });
  if (error) throw error;
  const db = createClient(st.API_URL, st.ANON_KEY, opts);
  const { data: s, error: e2 } = await db.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, email, password, token: s.session!.access_token, db };
}
const targets = new Set<string>();
// Conversations this run created — tracked explicitly, because step 7 deletes
// both participants of one (so it can't be found through participants later).
const conversations = new Set<string>();
async function sweep() {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    for (const u of data.users) if (u.app_metadata?.fixture === FIXTURE) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  if (ids.length) {
    await admin.from('content_reports').delete().in('reporter_id', ids);
    await admin.from('content_reports').delete().in('target_owner_id', ids);
    const { data: parts } = await admin.from('conversation_participants').select('conversation_id').in('user_id', ids);
    const convIds = [...new Set([...(parts ?? []).map((r) => r.conversation_id), ...conversations])];
    for (const c of convIds) {
      const { data: folders } = await admin.storage.from('dm-attachments').list(c);
      for (const f of folders ?? []) {
        const { data: files } = await admin.storage.from('dm-attachments').list(`${c}/${f.name}`);
        if (files?.length) await admin.storage.from('dm-attachments').remove(files.map((x) => `${c}/${f.name}/${x.name}`));
      }
    }
    if (convIds.length) await admin.from('conversations').delete().in('id', convIds);
  }
  if (!ids.length && conversations.size) {
    for (const c of conversations) {
      const { data: folders } = await admin.storage.from('dm-attachments').list(c);
      for (const f of folders ?? []) {
        const { data: files } = await admin.storage.from('dm-attachments').list(`${c}/${f.name}`);
        if (files?.length) await admin.storage.from('dm-attachments').remove(files.map((x) => `${c}/${f.name}/${x.name}`));
      }
    }
    await admin.from('conversations').delete().in('id', [...conversations]);
  }
  if (targets.size) await admin.from('content_reports').delete().in('target_id', [...targets]);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
  return ids.length;
}

const report = (u: U, type: string, id: string | null, reason = 'spam', details?: string) =>
  u.db.rpc('submit_report', { p_target_type: type, p_target_id: id, p_reason: reason, p_details: details ?? null });
const received = (r: { data: unknown; error: unknown }, already = false) =>
  !r.error && (r.data as { status?: string; already_reported?: boolean })?.status === 'received'
  && (r.data as { already_reported?: boolean }).already_reported === already;
const refused = (r: { error: { message?: string } | null }, token: string) => !!r.error && (r.error.message ?? '').includes(token);
const stored = async (f: (q: any) => any) => (await f(admin.from('content_reports').select('*', { count: 'exact', head: true }))).count ?? 0;

async function main() {
  const A = await createUser('a'); // reporter
  const B = await createUser('b'); // owner of reported content
  const C = await createUser('c'); // bystander
  const D = await createUser('d'); // second bystander reporter (rate limits are per reporter)
  const R = await createUser('r'); // rate limits
  targets.add(A.id); targets.add(B.id);

  step('0. Fixtures (B\'s content, an A–B and a B–C conversation)');
  const id = () => { const v = randomUUID(); targets.add(v); return v; };
  const fPub = id(), fPriv = id(), iPub = id(), iPriv = id(), pB = id(), pA = id(), cB = id(), icB = id(), icPriv = id(), fcB = id(), gcB = id();
  must(await B.db.from('folders').insert([{ id: fPub, user_id: B.id, name: 'cr pub', is_public: true }, { id: fPriv, user_id: B.id, name: 'cr priv', is_public: false }]), 'folders');
  must(await B.db.from('collection_items').insert([
    { id: iPub, folder_id: fPub, user_id: B.id, title: 'cr pub card', is_public: true, collection_status: 'active', item_type: 'sports_card' },
    { id: iPriv, folder_id: fPriv, user_id: B.id, title: 'cr priv card', is_public: false, collection_status: 'active', item_type: 'sports_card' },
  ]), 'items');
  must(await B.db.from('collection_item_images').insert({ item_id: iPub, user_id: B.id, image_url: 'https://example.invalid/i.jpg', storage_path: `${B.id}/cr/i.jpg` }), 'item image');
  must(await B.db.from('posts').insert({ id: pB, user_id: B.id, content: 'cr post by B', post_type: 'text' }), 'B post');
  must(await A.db.from('posts').insert({ id: pA, user_id: A.id, content: 'cr post by A', post_type: 'text' }), 'A post');
  must(await B.db.from('comments').insert({ id: cB, user_id: B.id, post_id: pA, body: 'cr comment by B on A\'s post' }), 'B comment');
  must(await B.db.from('item_comments').insert([{ id: icB, user_id: B.id, item_id: iPub, body: 'cr item comment' }, { id: icPriv, user_id: B.id, item_id: iPriv, body: 'cr private-item comment' }]), 'item comments');
  must(await B.db.from('folder_comments').insert({ id: fcB, user_id: B.id, folder_id: fPub, body: 'cr folder comment' }), 'folder comment');
  must(await B.db.from('gallery_comments').insert({ id: gcB, user_id: B.id, folder_id: fPub, body: 'cr gallery comment', player_key: 'p' }), 'gallery comment');
  const convAB = must(await A.db.rpc('get_or_create_conversation', { other_user_id: B.id }), 'A–B') as string;
  const convBC = must(await B.db.rpc('get_or_create_conversation', { other_user_id: C.id }), 'B–C') as string;
  conversations.add(convAB); conversations.add(convBC);
  const mB = id(), mA = id(), mBC = id(), mImg = id(), mLong = id();
  must(await B.db.from('messages').insert({ id: mB, conversation_id: convAB, sender_id: B.id, body: 'cr abusive DM from B' }), 'B→A');
  must(await A.db.from('messages').insert({ id: mA, conversation_id: convAB, sender_id: A.id, body: 'cr reply from A (must not leak)' }), 'A→B');
  must(await B.db.from('messages').insert({ id: mBC, conversation_id: convBC, sender_id: B.id, body: 'cr private B→C' }), 'B→C');
  must(await B.db.from('messages').insert({ id: mLong, conversation_id: convBC, sender_id: B.id, body: 'L'.repeat(9000) }), 'long DM');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const imgPath = `${convAB}/${mImg}/image.jpg`; // the app's path shape (lib/dm-images.ts)
  const up = await B.db.storage.from('dm-attachments').upload(imgPath, jpeg, { contentType: 'image/jpeg' });
  const imgMsg = up.error ? null : await B.db.from('messages').insert({ id: mImg, conversation_id: convAB, sender_id: B.id, body: null, attachment_type: 'image', attachment_storage_path: imgPath, attachment_width: 1, attachment_height: 1 });
  check('fixtures created (including a DM photo)', !up.error && !imgMsg?.error, up.error ?? imgMsg?.error);

  step('1. Every report type, through the API');
  // At most 5 new reports per reporter per 10 minutes, so the matrix is spread over A, C and D.
  check('profile → received', received(await report(A, 'profile', B.id, 'impersonation')));
  check('post → received', received(await report(A, 'post', pB, 'spam')));
  check('comment (on A\'s own post, written by B) → received', received(await report(A, 'comment', cB, 'harassment')));
  check('item_comment → received', received(await report(D, 'item_comment', icB, 'hate')));
  check('folder_comment → received', received(await report(D, 'folder_comment', fcB, 'sexual')));
  check('gallery_comment → received', received(await report(D, 'gallery_comment', gcB, 'violence')));
  check('collection_item → received', received(await report(C, 'collection_item', iPub, 'scam_fraud')));
  check('folder → received', received(await report(C, 'folder', fPub, 'intellectual_property')));
  check('message → received (C, a participant of B–C)', received(await report(C, 'message', mBC, 'harassment')));
  check('both participants can report each other\'s messages (B reports A\'s)', received(await report(B, 'message', mA, 'harassment')));
  check('a duplicate is acknowledged as already_reported', received(await report(A, 'post', pB, 'other'), true));
  check('…and stored only once', (await stored((q) => q.eq('target_id', pB).not('reporter_id', 'is', null).eq('reporter_id', A.id))) === 1);

  step('2. Refusals — neutral, nothing stored');
  const before = await stored((q) => q);
  check('someone else\'s DM → not_found', refused(await report(A, 'message', mBC), 'not_found'));
  check('a private item → not_found', refused(await report(A, 'collection_item', iPriv), 'not_found'));
  check('a private folder → not_found', refused(await report(A, 'folder', fPriv), 'not_found'));
  check('a comment on a private item → not_found', refused(await report(A, 'item_comment', icPriv), 'not_found'));
  check('an unknown id → not_found', refused(await report(A, 'post', randomUUID()), 'not_found'));
  check('your own message → cannot_report_self', refused(await report(A, 'message', mA), 'cannot_report_self'));
  check('your own post → cannot_report_self', refused(await report(A, 'post', pA), 'cannot_report_self'));
  check('a malformed id → rejected by the API', !!(await report(A, 'post', 'not-a-uuid')).error);
  check('an unknown type → invalid_target_type', refused(await report(A, 'notification', pB), 'invalid_target_type'));
  check('an unknown reason → invalid_reason', refused(await report(A, 'post', pB, 'rude'), 'invalid_reason'));
  check('details over 500 characters → details_too_long', refused(await report(A, 'folder', fPub, 'spam', 'x'.repeat(501)), 'details_too_long'));
  check('signed out → refused', !!(await anon.rpc('submit_report', { p_target_type: 'post', p_target_id: pB, p_reason: 'spam' })).error);
  check('none of these stored anything', (await stored((q) => q)) === before);

  step('3. No reading, changing or enumerating reports');
  for (const [who, u] of [['A (reporter)', A], ['B (reported)', B], ['C (bystander)', C]] as const) {
    const sel = await u.db.from('content_reports').select('id');
    check(`${who} cannot select reports`, !!sel.error || (sel.data ?? []).length === 0, sel.error?.code);
  }
  check('A cannot insert a forged report', !!(await A.db.from('content_reports').insert({ reporter_id: A.id, target_type: 'post', target_id: pB, target_owner_id: C.id, reason: 'spam' })).error);
  check('A cannot update reports', !!(await A.db.from('content_reports').update({ status: 'dismissed' }).eq('target_id', pB)).error);
  check('A cannot delete reports', !!(await A.db.from('content_reports').delete().eq('target_id', pB)).error);
  const helper = await A.db.rpc('file_content_report', { p_target_type: 'message', p_target_id: mBC, p_reason: 'spam', p_details: null });
  check('the private filing helper is not reachable through the API', !!helper.error, helper.error?.code);
  const gql = await (await fetch(`${st.API_URL}/graphql/v1`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: st.ANON_KEY, Authorization: `Bearer ${A.token}` },
    body: JSON.stringify({ query: '{ contentReportsCollection { edges { node { id reason } } } }' }) })).json();
  check('GraphQL exposes no reports', !gql?.data?.contentReportsCollection?.edges?.length, gql?.errors?.[0]?.message ?? gql?.data);
  check('the receipt carries no report id, owner or evidence',
    JSON.stringify(Object.keys(((await report(A, 'post', pB)).data ?? {}) as object).sort()) === JSON.stringify(['already_reported', 'status']));

  step('4. Evidence: only the reported content, bounded, references only');
  const ev = async (type: string, target: string) => (await admin.from('content_reports').select('evidence, target_owner_id, reporter_id, priority')
    .eq('target_type', type).eq('target_id', target).limit(1).single()).data!;
  const msgEv = await ev('message', mA);
  check('message evidence: just that message, no other messages, no conversation id',
    msgEv.evidence.body === 'cr reply from A (must not leak)' && !JSON.stringify(msgEv.evidence).includes('abusive DM from B') && !('conversation_id' in msgEv.evidence));
  check('owner derived on the server (A for A\'s message)', msgEv.target_owner_id === A.id);
  check('a long message is capped at 2,000 characters', received(await report(C, 'message', mLong, 'spam'))
    && (await ev('message', mLong)).evidence.body.length === 2000);
  if (imgMsg && !imgMsg.error) {
    check('a DM photo report is received', received(await report(A, 'message', mImg, 'sexual')));
    const img = await ev('message', mImg);
    check('…stored as a bucket/path reference only (no copy, no link)', img.evidence.attachment_ref?.bucket === 'dm-attachments'
      && img.evidence.attachment_ref?.path === imgPath && !JSON.stringify(img.evidence).includes('http'), img.evidence);
    const { data: copies } = await admin.storage.from('dm-attachments').list(convAB);
    const { data: inMsg } = await admin.storage.from('dm-attachments').list(`${convAB}/${mImg}`);
    check('…and no duplicate image was written', (copies ?? []).length === 1 && (inMsg ?? []).length === 1);
  }
  check('item evidence carries image references', (await ev('collection_item', iPub)).evidence.image_refs?.[0]?.bucket === 'item-images');
  check('violence is urgent; sexual content is normal priority',
    (await ev('folder_comment', fcB)).priority === 'normal' && (await ev('gallery_comment', gcB)).priority === 'urgent');
  check('B got no notification about any report',
    ((await admin.from('notifications').select('type').eq('user_id', B.id)).data ?? []).every((n) => n.type === 'message'));

  step('5. Blocking compatibility');
  must(await A.db.rpc('block_collector', { p_user_id: B.id }), 'A blocks B');
  check('A can still report B\'s historical DM after blocking', received(await report(A, 'message', mB, 'harassment')));
  check('A (blocker) can still report B\'s profile — already reported → acknowledged', received(await report(A, 'profile', B.id, 'impersonation'), true));
  check('B\'s posts are hidden by the block → not_found (report before blocking)', refused(await report(A, 'post', pB, 'hate'), 'not_found'));
  check('B (blocked) cannot see or report A\'s profile', refused(await report(B, 'profile', A.id), 'not_found'));
  check('B can still report A\'s DM in their shared history', received(await report(B, 'message', mA, 'spam'), true));
  must(await A.db.rpc('unblock_collector', { p_user_id: B.id }), 'unblock');

  step('6. Rate limits and duplicates under concurrency');
  const many = Array.from({ length: 8 }, () => id());
  must(await C.db.from('posts').insert(many.map((pid, i) => ({ id: pid, user_id: C.id, content: `cr rate ${i}`, post_type: 'text' }))), 'C posts');
  const parallel = await Promise.all(many.map((pid) => report(R, 'post', pid)));
  const ok = parallel.filter((r) => received(r)).length;
  const limited = parallel.filter((r) => refused(r, 'rate_limited')).length;
  check(`8 concurrent reports: exactly 5 received, 3 rate_limited (got ${ok}/${limited})`, ok === 5 && limited === 3);
  check('exactly 5 stored for R', (await stored((q) => q.eq('reporter_id', R.id))) === 5);
  const dup = await Promise.all(Array.from({ length: 6 }, () => report(C, 'post', pA, 'spam')));
  check('6 concurrent duplicates: one stored, the rest acknowledged', dup.every((r) => !r.error)
    && (await stored((q) => q.eq('reporter_id', C.id).eq('target_id', pA))) === 1);

  step('7. Deletion: reports outlive content and accounts');
  must(await B.db.from('comments').delete().eq('id', cB), 'B deletes comment');
  check('a report outlives its deleted comment, evidence kept', (await ev('comment', cB)).evidence.body === 'cr comment by B on A\'s post');
  await admin.auth.admin.deleteUser(B.id);
  const orphan = await ev('item_comment', icB);
  check('deleting the reported account keeps the report (owner → NULL) and its evidence', orphan.target_owner_id === null && orphan.evidence.body === 'cr item comment');
  await admin.auth.admin.deleteUser(A.id);
  check('deleting the reporter anonymises their reports (reporter → NULL), evidence kept',
    (await ev('comment', cB)).reporter_id === null && (await ev('comment', cB)).evidence.body === 'cr comment by B on A\'s post');
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
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fatal ? ' (aborted early)' : ''}.`);
for (const f of failed) console.log(`  FAIL ${f.name}`);
process.exitCode = failed.length || fatal ? 1 : 0;

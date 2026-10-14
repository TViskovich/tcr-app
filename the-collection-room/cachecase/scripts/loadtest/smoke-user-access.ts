/// <reference types="node" />
// Staging-only authentication and read-access smoke test, run exactly as the
// app would: the public anon key plus a real sign-in, so every query goes
// through RLS. The service-role key is never loaded (loadStagingUserConfig
// doesn't read it).
//
//   node scripts/loadtest/smoke-user-access.ts
//
// Accounts (all must carry app_metadata.seed = loadtest-v1, or the run
// stops before any test):
//   lt_user_01 — owner of the pilot data
//   lt_user_02 — another signed-in viewer
//   lt_user_03 — outsider to the lt_user_01 ↔ lt_user_02 conversation
//
// Read-only: no insert/update/delete, no Storage writes, no RPCs. The only
// server-side effect is Auth's own bookkeeping for each sign-in (a session
// and refresh token, last_sign_in_at); each session is signed out (local
// scope, revoking just that refresh token) at the end.
//
// Every check is tagged auth / rls / edge-function / storage, and a summary
// groups failures by that area. Exit code 1 if anything failed.

import type { SupabaseClient } from '@supabase/supabase-js';
import { SEED_TAG, createUserClient, loadStagingUserConfig, requireSetting, runMain } from './staging.ts';

type Area = 'auth' | 'rls' | 'edge-function' | 'storage';
type Status = 'pass' | 'fail' | 'skip';
type Result = { area: Area; name: string; status: Status; detail: string };

// Pilot seed shape (seed-pilot.ts). Reads use >=, so data a tester added
// through the app doesn't count as a failure.
const PILOT = { folders: 4, items: 10, posts: 3, messages: 10 };
const FEED_POST_TYPES = ['item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'];
const FEED_PAGE_SIZE = 20;
// Paging cap for the feed check: 15 pages = 300 posts, twice the full
// 30-user dataset's 150, so a missing pilot post fails instead of looping.
const MAX_FEED_PAGES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const results: Result[] = [];

function record(area: Area, name: string, status: Status, detail: string) {
  results.push({ area, name, status, detail });
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`  [${mark}] ${area.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Runs one check; an unexpected throw is a failure of that check only.
async function check(area: Area, name: string, fn: () => Promise<{ status: Status; detail: string }>) {
  try {
    const { status, detail } = await fn();
    record(area, name, status, detail);
  } catch (e) {
    record(area, name, 'fail', e instanceof Error ? e.message : 'unexpected error');
  }
}

const pass = (detail = '') => ({ status: 'pass' as const, detail });
const fail = (detail: string) => ({ status: 'fail' as const, detail });
const skip = (detail: string) => ({ status: 'skip' as const, detail });

// "at least" check on a query result.
function atLeast(label: string, rows: unknown[] | null, error: { message: string } | null, min: number) {
  if (error) return fail(`query error: ${error.message}`);
  const n = rows?.length ?? 0;
  return n >= min ? pass(`${n} ${label}`) : fail(`${n} ${label}, expected at least ${min}`);
}

// A denial must come back as zero rows (RLS filters), not as data. A query
// error is also a failure: it means the test didn't prove anything.
function denied(label: string, rows: unknown[] | null, error: { message: string } | null) {
  if (error) return fail(`query error (inconclusive): ${error.message}`);
  const n = rows?.length ?? 0;
  return n === 0 ? pass(`0 ${label} visible`) : fail(`${n} ${label} visible — RLS leak`);
}

// Fetches a URL and confirms the body is a real image by its magic bytes.
// The URL itself (it carries a signing token) is never printed.
async function fetchImage(url: string): Promise<{ status: Status; detail: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return fail(`image fetch returned HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const format =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
    : bytes[0] === 0x89 && ascii(1, 4) === 'PNG' ? 'png'
    : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'webp'
    : ascii(4, 8) === 'ftyp' ? 'avif/heif'
    : null;
  const type = res.headers.get('content-type') ?? 'unknown';
  if (!format) return fail(`HTTP 200 but body is not an image (content-type ${type}, ${bytes.length} bytes)`);
  return pass(`HTTP 200, ${format}, ${bytes.length} bytes`);
}

type SignedResult = { id: string; status: 'ok'; signed_url: string; tier: string } | { id: string; status: 'unavailable' };

// The app's own transport (hooks/use-signed-item-images.ts and
// use-signed-folder-covers.ts): direct POST with the anon apikey and the
// user's access token.
async function callSigningFunction(
  config: { url: string; anonKey: string },
  fn: 'get-collection-item-image-signed-url' | 'get-folder-cover-signed-url',
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; result: SignedResult } | { ok: false; detail: string }> {
  const res = await fetch(`${config.url}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}${res.status === 401 ? ' (gateway JWT check or invalid token)' : ''}` };
  const json = (await res.json()) as { results?: SignedResult[] };
  const result = json.results?.[0];
  return result ? { ok: true, result } : { ok: false, detail: 'response had no results' };
}

type Session = { client: SupabaseClient; userId: string; accessToken: string };

async function main() {
  const config = loadStagingUserConfig();
  const emailDomain = requireSetting(config, 'LOADTEST_EMAIL_DOMAIN').toLowerCase();
  const defaultPassword = requireSetting(config, 'LOADTEST_USER_PASSWORD');
  // lt_user_01 predates the 30-account run; if its password differs, set
  // LOADTEST_USER_01_PASSWORD.
  const passwordFor = (n: string) => config.settings[`LOADTEST_USER_${n}_PASSWORD`]?.trim() || defaultPassword;

  console.log(`Target project: ${config.ref} (staging) — anon key + user sign-in only`);
  console.log('');

  // ── Auth ───────────────────────────────────────────────────────────────
  const sessions = new Map<string, Session>();
  for (const n of ['01', '02', '03']) {
    const username = `lt_user_${n}`;
    await check('auth', `sign in as ${username}`, async () => {
      const client = createUserClient(config);
      const { data, error } = await client.auth.signInWithPassword({
        email: `lt-user-${n}@${emailDomain}`,
        password: passwordFor(n),
      });
      if (error || !data.session) return fail(`sign-in failed: ${error?.message ?? 'no session'}`);
      if (data.user.app_metadata?.seed !== SEED_TAG) {
        await client.auth.signOut({ scope: 'local' });
        throw new Error(`${username} is not tagged seed=${SEED_TAG}; refusing to test with it`);
      }
      sessions.set(username, { client, userId: data.user.id, accessToken: data.session.access_token });
      return pass();
    });
  }

  const owner = sessions.get('lt_user_01');
  const viewer = sessions.get('lt_user_02');
  const outsider = sessions.get('lt_user_03');

  try {
    // Never test as (or alongside) an account this seed didn't create.
    if (results.some((r) => r.area === 'auth' && r.detail.includes('refusing'))) return;

    // ── lt_user_01 reads own data ──────────────────────────────────────
    let ownItemIds: string[] = [];
    let ownImageIds: string[] = [];
    let conversationId: string | null = null;
    let ownNotificationCount = 0;

    if (owner) {
      console.log('');
      console.log('lt_user_01 — own data');
      const db = owner.client;

      await check('rls', 'read own profile', async () => {
        const { data, error } = await db.from('profiles').select('id, username, account_number').eq('id', owner.userId).maybeSingle();
        if (error) return fail(`query error: ${error.message}`);
        if (!data) return fail('own profile not visible');
        return data.username === 'lt_user_01' ? pass(`account ${data.account_number}`) : fail(`username is ${data.username}`);
      });

      await check('rls', 'read own folders (incl. nested)', async () => {
        const { data, error } = await db.from('folders').select('id, parent_folder_id').eq('user_id', owner.userId);
        const r = atLeast('folders', data, error, PILOT.folders);
        if (r.status === 'pass' && !data!.some((f) => f.parent_folder_id)) return fail('no nested folder visible');
        return r;
      });

      await check('rls', 'read own items', async () => {
        const { data, error } = await db
          .from('collection_items')
          .select('id')
          .eq('user_id', owner.userId)
          .eq('collection_status', 'active');
        ownItemIds = (data ?? []).map((i) => i.id);
        return atLeast('items', data, error, PILOT.items);
      });

      await check('rls', 'read own item image rows', async () => {
        if (!ownItemIds.length) return skip('no items to look up');
        const { data, error } = await db.from('collection_item_images').select('id, storage_path').in('item_id', ownItemIds);
        ownImageIds = (data ?? []).filter((i) => i.storage_path).map((i) => i.id);
        return atLeast('image rows', data, error, PILOT.items);
      });

      await check('rls', 'paginated feed shows both pilot users', async () => {
        // Same query and paging as app/(tabs)/index.tsx: queryFeed's filters
        // and 30-day window (recomputed per call), page n = range(n*20,
        // n*20+19), and loadMore stops once a page returns fewer than 20.
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        let mine = 0;
        let theirs = viewer ? 0 : PILOT.posts;
        let pagesRead = 0;
        for (let page = 0; page < MAX_FEED_PAGES; page++) {
          const now = Date.now();
          const windowStart = now - 30 * DAY_MS;
          const from = page * FEED_PAGE_SIZE;
          const { data, error } = await db
            .from('posts')
            .select('id, user_id, post_type, created_at')
            .in('post_type', FEED_POST_TYPES)
            .gte('created_at', new Date(windowStart).toISOString())
            .order('created_at', { ascending: false })
            .range(from, from + FEED_PAGE_SIZE - 1);
          if (error) return fail(`page ${page + 1} query error: ${error.message}`);
          pagesRead++;

          if (page === 0 && data.length === 0) return fail('first feed page is empty');
          // Every row must be a feed post type, inside the window (allowing
          // a minute of clock skew), and in descending created_at order.
          for (const [i, p] of data.entries()) {
            const at = Date.parse(p.created_at);
            if (!FEED_POST_TYPES.includes(p.post_type)) return fail(`page ${page + 1}: post ${p.id} has type ${p.post_type}`);
            if (!(at >= windowStart && at <= now + 60_000)) return fail(`page ${page + 1}: post ${p.id} is outside the 30-day window`);
            if (i > 0 && at > Date.parse(data[i - 1].created_at)) return fail(`page ${page + 1}: posts are not in descending date order`);
          }

          for (const p of data) {
            if (seen.has(p.id)) duplicates.add(p.id);
            seen.add(p.id);
            if (p.user_id === owner.userId) mine++;
            if (viewer && p.user_id === viewer.userId) theirs++;
          }
          if (mine >= PILOT.posts && theirs >= PILOT.posts) break; // confirmed
          if (data.length < FEED_PAGE_SIZE) break; // end of feed (app's hasMore = false)
        }

        if (duplicates.size) return fail(`${duplicates.size} post id(s) repeated across feed pages`);
        const summary = `${seen.size} posts over ${pagesRead} page(s): ${mine} lt_user_01, ${theirs} lt_user_02`;
        return mine >= PILOT.posts && theirs >= PILOT.posts
          ? pass(summary)
          : fail(`${summary}; expected at least ${PILOT.posts} each within ${MAX_FEED_PAGES} pages`);
      });

      await check('rls', 'read own conversation messages', async () => {
        if (!viewer) return skip('lt_user_02 not signed in');
        const { data: mine, error } = await db.from('conversation_participants').select('conversation_id').eq('user_id', owner.userId);
        if (error) return fail(`query error: ${error.message}`);
        const { data: shared, error: sharedError } = await db
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', viewer.userId)
          .in('conversation_id', (mine ?? []).map((m) => m.conversation_id));
        if (sharedError) return fail(`query error: ${sharedError.message}`);
        conversationId = shared?.[0]?.conversation_id ?? null;
        if (!conversationId) return fail('no conversation with lt_user_02 visible');
        const { data: messages, error: msgError } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId);
        return atLeast('messages', messages, msgError, PILOT.messages);
      });

      await check('rls', 'read own notifications', async () => {
        const { data, error } = await db.from('notifications').select('id').eq('user_id', owner.userId);
        ownNotificationCount = data?.length ?? 0;
        if (error) return fail(`query error: ${error.message}`);
        return pass(`${ownNotificationCount} notifications`);
      });
    }

    // ── lt_user_02 reads lt_user_01's public data ──────────────────────
    let snapshotUrl: string | null = null;
    if (owner && viewer) {
      console.log('');
      console.log("lt_user_02 — lt_user_01's public data");
      const db = viewer.client;

      await check('rls', "read lt_user_01's profile", async () => {
        const { data, error } = await db.from('profiles').select('username').eq('id', owner.userId).maybeSingle();
        if (error) return fail(`query error: ${error.message}`);
        return data?.username === 'lt_user_01' ? pass() : fail('profile not visible');
      });

      await check('rls', "read lt_user_01's public folders", async () => {
        const { data, error } = await db.from('folders').select('id').eq('user_id', owner.userId).eq('is_public', true);
        return atLeast('folders', data, error, PILOT.folders);
      });

      await check('rls', "read lt_user_01's public items", async () => {
        const { data, error } = await db
          .from('collection_items')
          .select('id')
          .eq('user_id', owner.userId)
          .eq('is_public', true);
        return atLeast('items', data, error, PILOT.items);
      });

      await check('rls', "read lt_user_01's item image rows", async () => {
        if (!ownItemIds.length) return skip('owner item ids unavailable');
        const { data, error } = await db.from('collection_item_images').select('id').in('item_id', ownItemIds);
        return atLeast('image rows', data, error, PILOT.items);
      });

      await check('rls', "read lt_user_01's posts and Share Card rows", async () => {
        const { data: posts, error } = await db
          .from('posts')
          .select('id, post_type')
          .eq('user_id', owner.userId)
          .in('post_type', FEED_POST_TYPES)
          .gte('created_at', new Date(Date.now() - 30 * DAY_MS).toISOString());
        const r = atLeast('posts', posts, error, PILOT.posts);
        if (r.status !== 'pass') return r;
        const shareIds = posts!.filter((p) => p.post_type === 'card_share').map((p) => p.id);
        const { data: cards, error: cardError } = await db
          .from('card_share_items')
          .select('snapshot_image_url')
          .in('post_id', shareIds);
        if (cardError) return fail(`card_share_items query error: ${cardError.message}`);
        snapshotUrl = cards?.find((c) => c.snapshot_image_url)?.snapshot_image_url ?? null;
        return pass(`${posts!.length} posts, ${cards?.length ?? 0} Share Card rows`);
      });

      await check('storage', 'public Share Card snapshot loads', async () => {
        if (!snapshotUrl) return skip('no snapshot URL found');
        return fetchImage(snapshotUrl);
      });

      // ── Edge Functions ──────────────────────────────────────────────
      console.log('');
      console.log('Edge Functions');

      for (const [label, session, tier] of [
        ['lt_user_02 signs lt_user_01 image (detail tier)', viewer, 'detail'],
        ['lt_user_01 signs own image (original)', owner, 'original'],
      ] as const) {
        let signedUrl: string | null = null;
        await check('edge-function', `get-collection-item-image-signed-url: ${label}`, async () => {
          if (!ownImageIds.length) return skip('no seeded image id available');
          const body = tier === 'original' ? { image_ids: [ownImageIds[0]] } : { image_ids: [ownImageIds[0]], tier };
          const res = await callSigningFunction(config, 'get-collection-item-image-signed-url', session.accessToken, body);
          if (!res.ok) return fail(res.detail);
          if (res.result.status !== 'ok') return fail('returned "unavailable" for a public seeded image');
          signedUrl = res.result.signed_url;
          return pass(`signed (${res.result.tier} tier)`);
        });
        await check('storage', `signed URL returns an image: ${label}`, async () => {
          if (!signedUrl) return skip('no signed URL (see previous check)');
          return fetchImage(signedUrl);
        });
      }

      // Only a folder with an actual cover is testable: an uploaded cover,
      // a chosen cover item, or first_card. The pilot folders keep the
      // default cover_source 'upload' with no uploaded file, so this is
      // expected to skip until a seed sets covers.
      let coverUrl: string | null = null;
      await check('edge-function', 'get-folder-cover-signed-url', async () => {
        const { data: folders, error } = await db
          .from('folders')
          .select('id, cover_source, cover_storage_path, cover_item_id')
          .eq('user_id', owner.userId);
        if (error) return fail(`folders query error: ${error.message}`);
        const covered = (folders ?? []).find(
          (f) =>
            (f.cover_source === 'upload' && f.cover_storage_path) ||
            (f.cover_source === 'item' && f.cover_item_id) ||
            f.cover_source === 'first_card',
        );
        if (!covered) return skip('no seeded folder has a cover configured');
        const res = await callSigningFunction(config, 'get-folder-cover-signed-url', viewer.accessToken, {
          folder_ids: [covered.id],
          tier: 'preview',
        });
        if (!res.ok) return fail(res.detail);
        if (res.result.status !== 'ok') return fail(`returned "unavailable" for a public folder with cover_source ${covered.cover_source}`);
        coverUrl = res.result.signed_url;
        return pass(`signed (${covered.cover_source} cover)`);
      });
      if (coverUrl) await check('storage', 'folder cover URL returns an image', async () => fetchImage(coverUrl!));
    }

    // ── Privacy: other users must NOT see private data ─────────────────
    console.log('');
    console.log('Privacy');

    await check('rls', 'outsider (lt_user_03) cannot read the 01↔02 messages', async () => {
      if (!outsider) return skip('lt_user_03 not signed in');
      if (!conversationId) return skip('conversation id unknown (see earlier check)');
      const { data, error } = await outsider.client.from('messages').select('id').eq('conversation_id', conversationId);
      return denied('messages', data, error);
    });

    await check('rls', 'outsider (lt_user_03) cannot read the conversation or its participants', async () => {
      if (!outsider) return skip('lt_user_03 not signed in');
      if (!conversationId) return skip('conversation id unknown');
      const { data: conv, error: convError } = await outsider.client.from('conversations').select('id').eq('id', conversationId);
      if (convError || (conv?.length ?? 0) > 0) return denied('conversations', conv, convError);
      const { data, error } = await outsider.client
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId);
      return denied('conversation/participant rows', data, error);
    });

    await check('rls', 'signed-out client cannot read the 01↔02 messages', async () => {
      if (!conversationId) return skip('conversation id unknown');
      const anonymous = createUserClient(config);
      const { data, error } = await anonymous.from('messages').select('id').eq('conversation_id', conversationId);
      // anon's EXECUTE on is_conversation_participant was revoked on purpose
      // (20260725120000_secure_dm_direct_access.sql), and messages_select
      // still applies to anon, so Postgres refuses the whole query before
      // reading any row — a fail-closed denial, same outcome as zero rows.
      // Only that exact error qualifies; any other error stays inconclusive.
      if (error?.code === '42501' && /permission denied for function is_conversation_participant/.test(error.message)) {
        return pass('denied: 42501 permission denied for function is_conversation_participant');
      }
      return denied('messages', data, error);
    });

    await check('rls', "lt_user_02 cannot read lt_user_01's notifications", async () => {
      if (!owner || !viewer) return skip('both users must be signed in');
      if (ownNotificationCount === 0) return skip('lt_user_01 has no notifications, so a denial proves nothing');
      const { data, error } = await viewer.client.from('notifications').select('id').eq('user_id', owner.userId);
      return denied('notifications', data, error);
    });

    // The pilot seed is all public, so private collection data can only be
    // tested if some exists (e.g. created in the app). Never created here.
    await check('rls', "lt_user_02 cannot read lt_user_01's private collection data", async () => {
      if (!owner || !viewer) return skip('both users must be signed in');
      const [{ data: privFolders, error: fErr }, { data: privItems, error: iErr }] = await Promise.all([
        owner.client.from('folders').select('id').eq('user_id', owner.userId).eq('is_public', false),
        owner.client.from('collection_items').select('id').eq('user_id', owner.userId).eq('is_public', false),
      ]);
      if (fErr || iErr) return fail(`owner query error: ${(fErr ?? iErr)!.message}`);
      const folderIds = (privFolders ?? []).map((f) => f.id);
      const itemIds = (privItems ?? []).map((i) => i.id);
      if (!folderIds.length && !itemIds.length) {
        return skip('no private folder or item exists in the pilot data — needs a private seed to test');
      }
      const [{ data: seenFolders, error: sfErr }, { data: seenItems, error: siErr }] = await Promise.all([
        viewer.client.from('folders').select('id').in('id', folderIds.length ? folderIds : ['00000000-0000-0000-0000-000000000000']),
        viewer.client.from('collection_items').select('id').in('id', itemIds.length ? itemIds : ['00000000-0000-0000-0000-000000000000']),
      ]);
      if (sfErr || siErr) return fail(`query error (inconclusive): ${(sfErr ?? siErr)!.message}`);
      const leaked = (seenFolders?.length ?? 0) + (seenItems?.length ?? 0);
      return leaked === 0
        ? pass(`${folderIds.length} private folders and ${itemIds.length} private items hidden`)
        : fail(`${leaked} private rows visible — RLS leak`);
    });
  } finally {
    for (const session of sessions.values()) await session.client.auth.signOut({ scope: 'local' }).catch(() => {});
    summarize();
  }
}

function summarize() {
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  console.log('');
  console.log(`Summary: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const area of ['auth', 'rls', 'edge-function', 'storage'] as const) {
    const inArea = failed.filter((r) => r.area === area);
    if (inArea.length) console.log(`  ${area} failures: ${inArea.map((r) => r.name).join('; ')}`);
  }
  if (failed.length) process.exitCode = 1;
}

runMain(main);

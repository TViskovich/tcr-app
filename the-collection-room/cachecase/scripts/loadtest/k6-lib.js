// Shared module for the CacheCase k6 scripts (k6-read-workload.js,
// k6-mixed-workload.js): staging-only configuration and safeguards,
// request helpers, the app's feed / item-detail reads, and checked
// sign-in. Everything at module level runs in k6's init context, before any
// traffic.
//
// Configuration comes ONLY from scripts/loadtest/.env.k6.local (git-ignored),
// an allowlist of the staging URL, the staging anon key and the synthetic
// users' credentials — never the shared .env.staging.local, so no privileged
// key is ever loaded.

/* global __ENV */
/* eslint-disable import/no-unresolved -- k6 built-in modules, resolved by the k6 runtime */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { Counter, Rate, Trend } from 'k6/metrics';
/* eslint-enable import/no-unresolved */

export const STAGING_REF = 'ickqkzvqddkhqyxnbzox';
export const PRODUCTION_REF = 'izlrxenomerfeqhmlyre';
export const SEED_TAG = 'loadtest-v1';
export const ALLOWED_VUS = [5, 15, 30];

// ── Configuration ───────────────────────────────────────────────────────

const CONFIG_FILE = 'scripts/loadtest/.env.k6.local';
const REQUIRED_SETTINGS = ['STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY', 'LOADTEST_EMAIL_DOMAIN', 'LOADTEST_USER_PASSWORD'];
const OPTIONAL_SETTINGS = ['LOADTEST_USER_01_PASSWORD'];

// Reads the k6-only config. It is an allowlist: any other setting in the
// file stops the run (only its NAME is reported, never a value), so a
// privileged key can't be loaded by accident.
function readConfig() {
  const raw = open('./.env.k6.local');
  const allowed = [...REQUIRED_SETTINGS, ...OPTIONAL_SETTINGS];
  const config = {};
  const unexpected = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error(`${CONFIG_FILE} has a line that is not KEY=value.`);
    const [, key, rawValue] = match;
    if (!allowed.includes(key)) {
      unexpected.push(key);
      continue;
    }
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (value) config[key] = value;
  }
  if (unexpected.length) {
    throw new Error(`${CONFIG_FILE} may only contain ${allowed.join(', ')}; remove: ${unexpected.join(', ')}.`);
  }
  for (const key of REQUIRED_SETTINGS) {
    if (!config[key]) throw new Error(`${key} is not set in ${CONFIG_FILE}.`);
  }
  return config;
}

export function jwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(encoding.b64decode(parts[1], 'rawurl', 's'));
  } catch {
    return null;
  }
}

// Same rules as staging.ts: exactly https://<staging-ref>.supabase.co, and
// an anon/publishable key that belongs to staging.
function assertStagingTarget(config) {
  const url = config.STAGING_SUPABASE_URL;
  if (url.includes(PRODUCTION_REF)) throw new Error('Refusing to run: STAGING_SUPABASE_URL points at the PRODUCTION project.');
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url.toLowerCase());
  if (!match || match[1] !== STAGING_REF) throw new Error(`Refusing to run: STAGING_SUPABASE_URL is not the staging project (${STAGING_REF}).`);

  const key = config.STAGING_SUPABASE_ANON_KEY;
  if (key.startsWith('sb_secret_')) throw new Error('STAGING_SUPABASE_ANON_KEY is a secret key; k6 must only use the anon key.');
  if (!key.startsWith('sb_publishable_')) {
    const claims = jwtClaims(key);
    if (!claims) throw new Error('STAGING_SUPABASE_ANON_KEY is not a recognised Supabase key format.');
    if (claims.ref === PRODUCTION_REF) throw new Error('Refusing to run: the anon key belongs to the PRODUCTION project.');
    if (claims.ref !== STAGING_REF) throw new Error('Refusing to run: the anon key does not belong to the staging project.');
    if (claims.role !== 'anon') throw new Error(`STAGING_SUPABASE_ANON_KEY has role "${claims.role}", expected anon.`);
  }
  return url.replace(/\/$/, '');
}

export const CONFIG = readConfig();
export const BASE_URL = assertStagingTarget(CONFIG);
export const ANON_KEY = CONFIG.STAGING_SUPABASE_ANON_KEY;

export const VUS = Number(__ENV.VUS || 5);
if (!ALLOWED_VUS.includes(VUS)) throw new Error(`VUS must be one of ${ALLOWED_VUS.join(', ')}.`);

// ── Metrics shared by both scripts ──────────────────────────────────────

export const authSigninDuration = new Trend('auth_signin_duration', true);
export const authErrors = new Counter('unexpected_auth_errors');
export const rateLimited = new Counter('rate_limited_responses');
export const serverErrors = new Counter('server_errors');
export const signUnavailable = new Rate('sign_unavailable_rate');

// ── Request helpers ─────────────────────────────────────────────────────

export const DAY_MS = 24 * 60 * 60 * 1000;
export const inList = (ids) => `in.(${ids.join(',')})`;
export const uniq = (values) => [...new Set(values.filter(Boolean))];
export const pick = (values) => values[Math.floor(Math.random() * values.length)];
export const pause = (min, max) => sleep(min + Math.random() * (max - min));

export function restUrl(table, query) {
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${BASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`;
}

// Every workload request: anon key + the user's own token (RLS applies),
// tagged by operation and by read/write kind.
export function params(session, op, name, extraHeaders, kind = 'read') {
  return {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.token}`, ...extraHeaders },
    tags: { phase: 'workload', op, name, kind },
  };
}

// Classifies every workload response. Auth errors and rate limits stop the
// test at once — either means the workload is no longer measuring what it
// should, and continuing would only add load.
export function track(res, label) {
  const ok = res.status >= 200 && res.status < 300;
  check(res, { [`${label} 2xx`]: () => ok }, { phase: 'workload' });
  if (res.status === 401 || res.status === 403) {
    authErrors.add(1);
    exec.test.abort(`Unexpected authorization error (HTTP ${res.status}) on ${label}`);
  } else if (res.status === 429) {
    rateLimited.add(1);
    exec.test.abort(`Rate limited (HTTP 429) on ${label}`);
  } else if (res.status >= 500 || res.status === 0) {
    serverErrors.add(1);
  }
  return ok;
}

// Parsed from the raw body, not res.json(): res.json() returns a Go-backed
// value that rejects new properties ("Can't set property … on Go slice").
// JSON.parse yields plain JavaScript arrays and objects that are safe to use
// like any other.
export function rows(res) {
  if (!(res.status >= 200 && res.status < 300)) return [];
  try {
    const body = JSON.parse(res.body);
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

// GET (or HEAD for count-only reads), batched in parallel like the app's
// Promise.all. Each entry: [table, query, op, name, kind?]; kind 'count'
// sends Prefer: count=exact as a HEAD request, 'single' asks for one object.
export function batch(session, entries) {
  const requests = entries.map(([table, query, op, name, kind]) => {
    const headers = kind === 'count' ? { Prefer: 'count=exact' } : kind === 'single' ? { Accept: 'application/vnd.pgrst.object+json' } : {};
    return [kind === 'count' ? 'HEAD' : 'GET', restUrl(table, query), null, params(session, op, name, headers)];
  });
  const responses = http.batch(requests);
  responses.forEach((res, i) => track(res, entries[i][3]));
  return responses;
}

// The app's own signing transport (hooks/use-signed-item-images.ts,
// use-signed-folder-covers.ts): POST with apikey + the user's token. Only
// the URLs are requested — image bytes are never downloaded.
export function sign(session, fn, key, ids, tier, op) {
  if (!ids.length) return;
  const res = http.post(
    `${BASE_URL}/functions/v1/${fn}`,
    JSON.stringify({ [key]: ids.slice(0, 50), tier }),
    params(session, op, `${fn}:${tier}`, { 'Content-Type': 'application/json' }),
  );
  if (!track(res, `${fn}:${tier}`)) return;
  try {
    for (const r of res.json().results || []) signUnavailable.add(r.status !== 'ok');
  } catch {
    signUnavailable.add(true);
  }
}

// ── App reads shared by both workloads ──────────────────────────────────

export const FEED_PAGE_SIZE = 20;
export const FEED_POST_TYPES = ['item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'];
// components/feed/post-card.tsx FEED_POST_SELECT
export const FEED_POST_SELECT =
  'id,user_id,item_id,post_type,image_url,content,caption,created_at,folder_id,folder_name,folder_item_count,folder_cover_snapshot_url,repost_of_post_id,quote_of_post_id';

// app/(tabs)/index.tsx queryFeed + hydrateFeedPosts (post-card.tsx), plus
// the tab's unread-badge count (hooks/use-unread-count.ts) on page 1.
// Returns { posts, cardItemIds }: the page's posts and the Share Card items'
// collection item ids (for opening Item Detail from the feed).
export function loadFeedPage(session, page) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [pageRes] = batch(session, [
    [
      'posts',
      { select: FEED_POST_SELECT, post_type: inList(FEED_POST_TYPES), created_at: `gte.${since}`, order: 'created_at.desc', offset: page * FEED_PAGE_SIZE, limit: FEED_PAGE_SIZE },
      'feed',
      'feed:posts_page',
    ],
  ]);
  const posts = rows(pageRes);
  if (!posts.length) return { posts, cardItemIds: [] };

  const ids = posts.map((p) => p.id);
  const byType = (type) => posts.filter((p) => p.post_type === type).map((p) => p.id);
  const itemIds = uniq(posts.map((p) => p.item_id));
  const entries = [
    ['profiles', { select: 'id,username,display_name,hero_display_name,avatar_url', id: inList(uniq(posts.map((p) => p.user_id))) }, 'feed', 'feed:profiles'],
    ['likes', { select: 'post_id,user_id', post_id: inList(ids) }, 'feed', 'feed:likes'],
    ['comments', { select: 'post_id', post_id: inList(ids) }, 'feed', 'feed:comments'],
    ['follows', { select: 'following_id', follower_id: `eq.${session.userId}` }, 'feed', 'feed:viewer_follows'],
    ['posts', { select: 'user_id,repost_of_post_id', repost_of_post_id: inList(posts.filter((p) => p.post_type !== 'repost').map((p) => p.id)) }, 'feed', 'feed:repost_counts'],
  ];
  if (itemIds.length) entries.push(['collection_items', { select: 'id,title,image_url,user_id', id: inList(itemIds) }, 'feed', 'feed:items']);
  const cardIndex = entries.length;
  if (byType('card_share').length) {
    entries.push([
      'card_share_items',
      { select: 'id,post_id,item_id,snapshot_image_url,snapshot_title,snapshot_subtitle,display_order', post_id: inList(byType('card_share')), order: 'display_order.asc' },
      'feed',
      'feed:card_share_items',
    ]);
  }
  if (byType('text').length) {
    entries.push(['post_images', { select: 'id,post_id,item_id,image_url,source_type,sort_order', post_id: inList(byType('text')), order: 'sort_order.asc' }, 'feed', 'feed:post_images']);
  }
  if (page === 0) entries.push(['notifications', { select: '*', user_id: `eq.${session.userId}`, read: 'eq.false' }, 'feed', 'feed:unread_badge', 'count']);
  const responses = batch(session, entries);
  const cardItemIds = byType('card_share').length ? uniq(rows(responses[cardIndex]).map((c) => c.item_id)) : [];
  return { posts, cardItemIds };
}

// app/item/[id].tsx: the detail row, useItemLikes, useItemComments,
// useItemGrailMembership (viewer's slots), useRegisteredCardForItem,
// useItemImages, then detail-tier signing for the gallery.
export function loadItem(session, itemId) {
  const i = 'item';
  const eq = `eq.${itemId}`;
  const responses = batch(session, [
    [
      'collection_items',
      {
        select: '*,owner:profiles!collection_items_user_id_fkey(username,display_name,avatar_url),pokemon_details:pokemon_card_details(*),comic_details:comic_book_details(*),trading_details:trading_card_details(*)',
        id: eq,
      },
      i,
      'item:row',
      'single',
    ],
    ['collection_items', { select: 'like_count:item_likes(count),viewer_like:item_likes(user_id)', id: eq, 'viewer_like.user_id': `eq.${session.userId}`, 'viewer_like.limit': 1 }, i, 'item:likes'],
    ['item_comments', { select: 'id,user_id,body,created_at', item_id: eq, order: 'created_at.asc' }, i, 'item:comments'],
    ['profile_grail_slots', { select: 'id,slot_index,entry_type,item_id,collection_id', user_id: `eq.${session.userId}`, order: 'slot_index.asc' }, i, 'item:viewer_grail_slots'],
    ['registered_cards', { select: '*', collection_item_id: eq }, i, 'item:registered_card'],
    ['collection_item_images', { select: '*', item_id: eq, order: 'sort_order.asc' }, i, 'item:images'],
  ]);
  const images = rows(responses[5]);
  sign(session, 'get-collection-item-image-signed-url', 'image_ids', images.map((img) => img.id), 'detail', 'sign_images');
}

// ── Auth (setup / teardown only — outside the measured workload) ────────

export const usernameFor = (n) => `lt_user_${String(n).padStart(2, '0')}`;

// Confirms the anon key works against this staging host, then signs each
// account in and checks that the session was issued by staging, belongs to
// a seed-tagged synthetic account, and lives long enough for the test.
// Any failure stops setup — and therefore the whole test — before a single
// workload request is sent.
export function signInAccounts(numbers, minTokenSeconds) {
  const settings = http.get(`${BASE_URL}/auth/v1/settings`, { headers: { apikey: ANON_KEY }, tags: { phase: 'setup', name: 'auth:settings' } });
  if (settings.status !== 200) fail(`Staging identity check failed: auth settings returned HTTP ${settings.status}.`);

  const sessions = [];
  for (const n of numbers) {
    const username = usernameFor(n);
    const password = (n === 1 && CONFIG.LOADTEST_USER_01_PASSWORD) || CONFIG.LOADTEST_USER_PASSWORD;
    const res = http.post(
      `${BASE_URL}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email: `lt-user-${String(n).padStart(2, '0')}@${CONFIG.LOADTEST_EMAIL_DOMAIN.toLowerCase()}`, password }),
      { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, tags: { phase: 'setup', name: 'auth:signin' } },
    );
    authSigninDuration.add(res.timings.duration);
    if (res.status !== 200) fail(`Sign-in failed for ${username} (HTTP ${res.status}); no workload traffic was sent.`);
    const body = res.json();
    const claims = jwtClaims(body.access_token) || {};
    if (!String(claims.iss || '').includes(`${STAGING_REF}.supabase.co`)) fail(`${username}'s session was not issued by the staging project.`);
    if (body.user?.app_metadata?.seed !== SEED_TAG) fail(`${username} is not tagged seed=${SEED_TAG}; refusing to load-test with it.`);
    if (Number(body.expires_in) < minTokenSeconds) fail(`Access tokens expire in ${body.expires_in}s — too short for this test.`);
    sessions.push({ n, username, userId: body.user.id, token: body.access_token });
  }
  return sessions;
}

export function signOutAll(sessions) {
  for (const session of sessions) {
    http.post(`${BASE_URL}/auth/v1/logout?scope=local`, null, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.token}` },
      tags: { phase: 'teardown', name: 'auth:signout' },
    });
  }
}

// ── Summary helper ──────────────────────────────────────────────────────

export function trend(metric) {
  if (!metric) return null;
  const v = metric.values;
  return { p50: v.med, p95: v['p(95)'], p99: v['p(99)'], avg: v.avg, max: v.max, count: v.count };
}

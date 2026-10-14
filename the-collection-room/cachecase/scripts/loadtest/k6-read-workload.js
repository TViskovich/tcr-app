// CacheCase STAGING read-only load test (Grafana k6).
//
// Run from the cachecase directory:
//   k6 run -e VUS=5 scripts/loadtest/k6-read-workload.js
// (VUS may be 5, 15 or 30 — one synthetic account per virtual user,
// lt_user_01 … lt_user_NN. Default 5.)
//
// Every request mirrors a real app read (file references below), sent as
// that user would send it: the public anon key as `apikey` plus the user's
// own access token, so every query goes through RLS. k6 reads its own
// config file, scripts/loadtest/.env.k6.local (git-ignored), which may hold
// ONLY the staging URL, the anon key and the synthetic-user credentials —
// never the shared .env.staging.local, so no privileged key is ever loaded.
//
// One VU = one synthetic collector browsing in a loop with human-paced
// pauses: feed (page 1, then page 2) → an author's profile → one of their
// folders → one item → repeat. No inserts, updates, deletes or RPC writes.
// Signed image URLs are requested from the Edge Function, but the image
// bytes are NOT downloaded, so the test causes no Storage egress or image
// transformations.
//
// Sign-in happens once per account in setup() (tagged phase:setup, its own
// `auth_signin_duration` metric) and is excluded from the workload
// latency/failure thresholds; sessions are signed out in teardown().
//
// Safety: refuses to start unless the URL and anon key both belong to the
// staging project (production is rejected outright) and every account
// signs in to staging and carries app_metadata.seed = loadtest-v1. Any 401,
// 403 or 429 aborts the run immediately; 5+ server errors, >2% failed
// requests or a request rate above the cap abort it via thresholds.
//
// Results: a machine-readable summary is written to
// scripts/loadtest/results/k6-read-<VUS>vu-<timestamp>.json (git-ignored)
// for comparison between the 5-, 15- and 30-user runs.

/* global __VU */
import {
  STAGING_REF,
  VUS,
  FEED_POST_SELECT,
  FEED_POST_TYPES,
  batch,
  inList,
  loadFeedPage,
  loadItem,
  pause,
  pick,
  rows,
  sign,
  signInAccounts,
  signOutAll,
  trend,
  uniq,
} from './k6-lib.js';

// Staging-only config, safeguards, request helpers, the feed and item-detail
// reads and checked sign-in live in ./k6-lib.js (shared with
// k6-mixed-workload.js).

// Conservative for the Free plan. Each VU averages ~2 requests/s with its
// pauses; the cap aborts the run if the sustained workload rate ever
// exceeds 4 requests/s per VU (20/s at 5 VUs).
const RATE_CAP = 4 * VUS;
const RAMP_UP = '1m';
const STEADY = '5m';
const RAMP_DOWN = '30s';

// ── Metrics and thresholds ──────────────────────────────────────────────

const OPS = ['feed', 'profile', 'collection', 'item', 'sign_images', 'sign_covers'];

export const options = {
  scenarios: {
    collectors: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: VUS },
        { duration: STEADY, target: VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '20s',
      gracefulStop: '20s',
    },
  },
  // Parallel requests per VU (the app's Promise.all batches), capped.
  batch: 10,
  batchPerHost: 6,
  setupTimeout: '60s',
  teardownTimeout: '60s',
  userAgent: 'cachecase-loadtest/1 (staging; k6)',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds: {
    // Stop conditions.
    unexpected_auth_errors: [{ threshold: 'count<1', abortOnFail: true }],
    rate_limited_responses: [{ threshold: 'count<1', abortOnFail: true }],
    server_errors: [{ threshold: 'count<5', abortOnFail: true }],
    'http_req_failed{phase:workload}': [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '30s' }],
    'http_reqs{phase:workload}': [{ threshold: `rate<${RATE_CAP}`, abortOnFail: true, delayAbortEval: '30s' }],
    // Reported targets (no abort).
    'http_req_duration{phase:workload}': ['p(95)<2000', 'p(99)<4000'],
    'checks{phase:workload}': ['rate>0.98'],
    sign_unavailable_rate: ['rate<0.05'],
    auth_signin_duration: ['p(95)<3000'],
    // One sub-metric per operation, so the summary has p50/p95/p99 for each.
    ...Object.fromEntries(OPS.map((op) => [`http_req_duration{op:${op}}`, ['p(95)<3000']])),
  },
};

// ── Workload: the app's real reads (feed + item detail: ./k6-lib.js) ───

// components/profile-v2/profile-v2-screen.tsx viewing another collector:
// useProfile (7 parallel reads), useGrailSlots, useFolders (public
// top-level folders + covers, counts, per-folder previews, child-folder
// previews), useAllItems, fetchUserPosts, and preview-tier signing.
function loadProfile(session, userId) {
  const eq = `eq.${userId}`;
  const p = 'profile';
  const [, , , , , , , , foldersRes] = batch(session, [
    ['profiles', { select: '*', id: eq }, p, 'profile:row', 'single'],
    ['folders', { select: '*', user_id: eq }, p, 'profile:count_folders', 'count'],
    ['collection_items', { select: '*', user_id: eq, collection_status: 'eq.active' }, p, 'profile:count_items', 'count'],
    ['posts', { select: '*', user_id: eq }, p, 'profile:count_posts', 'count'],
    ['follows', { select: '*', following_id: eq }, p, 'profile:count_followers', 'count'],
    ['follows', { select: '*', follower_id: eq }, p, 'profile:count_following', 'count'],
    ['collection_items', { select: '*', user_id: eq, collection_status: 'eq.active', grade: 'not.is.null' }, p, 'profile:count_graded', 'count'],
    [
      'profile_grail_slots',
      {
        select: '*,item:collection_items(*,primary_image:collection_item_images(id)),collection:folders(*,preview_items:collection_items!collection_items_folder_id_fkey(id,primary_image:collection_item_images(id)))',
        user_id: eq,
        'item.primary_image.is_primary': 'eq.true',
        'collection.preview_items.collection_status': 'eq.active',
        'collection.preview_items.primary_image.is_primary': 'eq.true',
        order: 'slot_index.asc',
        'collection.preview_items.order': 'sort_order.asc',
      },
      p,
      'profile:grail_slots',
    ],
    ['folders', { select: '*', user_id: eq, parent_folder_id: 'is.null', is_public: 'eq.true', order: 'created_at.desc' }, p, 'profile:folders'],
    ['collection_items', { select: '*,folders!collection_items_folder_id_fkey(is_public)', user_id: eq, collection_status: 'eq.active', is_public: 'eq.true', order: 'created_at.desc' }, p, 'profile:all_items'],
    ['posts', { select: FEED_POST_SELECT, user_id: eq, post_type: inList(FEED_POST_TYPES), order: 'created_at.desc' }, p, 'profile:posts'],
    ['saved_grails', { select: 'owner_id', user_id: `eq.${session.userId}`, owner_id: eq }, p, 'profile:saved_grails'],
  ]);

  // hooks/use-collection.ts useFolders: covers, counts, then per-folder
  // previews (one request per folder, as the app does).
  const folders = rows(foldersRes);
  const folderIds = folders.map((f) => f.id);
  if (!folderIds.length) return folders;
  const firstCard = folders.filter((f) => f.cover_source === 'first_card').map((f) => f.id);
  const entries = [['collection_items', { select: 'folder_id', collection_status: 'eq.active', folder_id: inList(folderIds) }, p, 'profile:folder_counts']];
  if (firstCard.length) {
    entries.push(['collection_items', { select: 'folder_id,image_url', collection_status: 'eq.active', folder_id: inList(firstCard), order: 'created_at.desc' }, p, 'profile:first_card_covers']);
  }
  for (const id of folderIds) {
    entries.push(['collection_items', { select: '*', folder_id: `eq.${id}`, collection_status: 'eq.active', order: 'sort_order.asc', limit: 10 }, p, 'profile:folder_preview_items']);
    entries.push([
      'folders',
      {
        select: '*,collection_items!collection_items_folder_id_fkey(id,collection_item_images(id))',
        parent_folder_id: `eq.${id}`,
        'collection_items.collection_status': 'eq.active',
        'collection_items.collection_item_images.is_primary': 'eq.true',
        'collection_items.order': 'sort_order.asc',
        'collection_items.limit': 1,
        order: 'created_at.desc',
        limit: 10,
      },
      p,
      'profile:child_folder_previews',
    ]);
  }
  const responses = batch(session, entries);
  const previewItemIds = uniq(responses.filter((_, i) => entries[i][3] === 'profile:folder_preview_items').flatMap((r) => rows(r).map((it) => it.id)));
  if (previewItemIds.length) {
    const [primaries] = batch(session, [['collection_item_images', { select: 'id,item_id', is_primary: 'eq.true', item_id: inList(previewItemIds) }, p, 'profile:primary_image_ids']]);
    sign(session, 'get-collection-item-image-signed-url', 'image_ids', rows(primaries).map((r) => r.id), 'preview', 'sign_images');
  }
  sign(session, 'get-folder-cover-signed-url', 'folder_ids', folderIds, 'preview', 'sign_covers');
  return folders;
}

// app/collection/[folderId].tsx: useItems (+ attachPrimaryImageIds),
// useChildFolders, grid signing (preview) and the header cover (detail).
function loadFolder(session, folderId) {
  const c = 'collection';
  const [itemsRes] = batch(session, [
    ['collection_items', { select: '*', folder_id: `eq.${folderId}`, collection_status: 'eq.active', order: 'sort_order.asc' }, c, 'folder:items'],
    [
      'folders',
      {
        select: '*,collection_items!collection_items_folder_id_fkey(id,collection_item_images(id))',
        parent_folder_id: `eq.${folderId}`,
        'collection_items.collection_status': 'eq.active',
        'collection_items.collection_item_images.is_primary': 'eq.true',
        'collection_items.order': 'sort_order.asc',
        'collection_items.limit': 1,
        order: 'name.asc',
      },
      c,
      'folder:child_folders',
    ],
  ]);
  const items = rows(itemsRes);
  if (items.length) {
    const [primaries] = batch(session, [['collection_item_images', { select: 'id,item_id', is_primary: 'eq.true', item_id: inList(items.map((i) => i.id)) }, c, 'folder:primary_image_ids']]);
    sign(session, 'get-collection-item-image-signed-url', 'image_ids', rows(primaries).map((r) => r.id), 'preview', 'sign_images');
  }
  sign(session, 'get-folder-cover-signed-url', 'folder_ids', [folderId], 'detail', 'sign_covers');
  return items;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

// Signs every account in once, outside the measured workload (see
// signInAccounts in ./k6-lib.js for the identity checks).
export function setup() {
  return { sessions: signInAccounts(Array.from({ length: VUS }, (_, i) => i + 1), 15 * 60) };
}

export default function (data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];

  const { posts: page1 } = loadFeedPage(session, 0);
  pause(3, 6); // reading the feed
  const { posts: page2 } = loadFeedPage(session, 1);
  pause(3, 6);

  // Tap an author from the feed (not yourself), as a viewer would.
  const authors = uniq([...page1, ...page2].map((p) => p.user_id)).filter((id) => id !== session.userId);
  if (!authors.length) {
    pause(5, 10);
    return;
  }
  const folders = loadProfile(session, pick(authors));
  pause(4, 8); // browsing the profile

  if (!folders.length) return;
  const items = loadFolder(session, pick(folders).id);
  pause(3, 6); // scanning the folder grid

  if (!items.length) return;
  loadItem(session, pick(items).id);
  pause(5, 10); // looking at the item
}

export function teardown(data) {
  signOutAll(data.sessions);
}

// ── Results ─────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const m = data.metrics;
  const thresholds = {};
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) thresholds[`${name}: ${expr}`] = result.ok;
  }
  const summary = {
    test: 'cachecase-read-workload',
    schema: 1,
    project_ref: STAGING_REF,
    vus: VUS,
    stages: { ramp_up: RAMP_UP, steady: STEADY, ramp_down: RAMP_DOWN },
    finished_at: new Date().toISOString(),
    duration_ms: data.state.testRunDurationMs,
    throughput: {
      workload_requests: m['http_reqs{phase:workload}']?.values.count ?? null,
      workload_rps: m['http_reqs{phase:workload}']?.values.rate ?? null,
      iterations: m.iterations?.values.count ?? null,
    },
    failures: {
      http_req_failed_rate: m['http_req_failed{phase:workload}']?.values.rate ?? null,
      checks_pass_rate: m['checks{phase:workload}']?.values.rate ?? null,
      unexpected_auth_errors: m.unexpected_auth_errors?.values.count ?? 0,
      rate_limited_responses: m.rate_limited_responses?.values.count ?? 0,
      server_errors: m.server_errors?.values.count ?? 0,
      sign_unavailable_rate: m.sign_unavailable_rate?.values.rate ?? null,
    },
    latency_ms: {
      workload: trend(m['http_req_duration{phase:workload}']),
      ...Object.fromEntries(OPS.map((op) => [op, trend(m[`http_req_duration{op:${op}}`])])),
      auth_signin: trend(m.auth_signin_duration),
    },
    thresholds_passed: Object.values(thresholds).every(Boolean),
    thresholds,
  };

  const stamp = summary.finished_at.replace(/[:.]/g, '-');
  const file = `scripts/loadtest/results/k6-read-${VUS}vu-${stamp}.json`;
  const fmt = (t) => (t ? `p50 ${t.p50?.toFixed(0)} ms  p95 ${t.p95?.toFixed(0)} ms  p99 ${t.p99?.toFixed(0)} ms  (n=${t.count})` : 'n/a');
  const lines = [
    '',
    `CacheCase read workload — ${VUS} VUs on ${STAGING_REF} (staging)`,
    `  requests: ${summary.throughput.workload_requests} (${summary.throughput.workload_rps?.toFixed(2)}/s), iterations: ${summary.throughput.iterations}`,
    `  failed requests: ${((summary.failures.http_req_failed_rate ?? 0) * 100).toFixed(2)}%  auth errors: ${summary.failures.unexpected_auth_errors}  429s: ${summary.failures.rate_limited_responses}  5xx: ${summary.failures.server_errors}`,
    `  workload latency: ${fmt(summary.latency_ms.workload)}`,
    ...OPS.map((op) => `    ${op.padEnd(12)} ${fmt(summary.latency_ms[op])}`),
    `  sign-in (setup, excluded): ${fmt(summary.latency_ms.auth_signin)}`,
    `  thresholds: ${summary.thresholds_passed ? 'all passed' : 'FAILED — see JSON'}`,
    `  results: ${file}`,
    '',
  ];
  return { [file]: JSON.stringify(summary, null, 2), stdout: lines.join('\n') };
}

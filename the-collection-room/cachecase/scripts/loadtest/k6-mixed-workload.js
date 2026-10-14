// CacheCase STAGING mixed read/write load test (Grafana k6).
//
// Run from the cachecase directory:
//   k6 run -e VUS=5 -e RUN_ID=mx-20261013-1 scripts/loadtest/k6-mixed-workload.js
// RUN_ID is required (6–40 lowercase letters, digits, hyphens; used once).
// VUS may be 5, 15 or 30 (one synthetic account each, lt_user_01 … NN).
// Optional limits (defaults are conservative for the Free plan; each has a
// hard ceiling the script refuses to exceed):
//   -e STEADY_MINUTES=5            sustained phase (1–10)
//   -e MAX_MESSAGES_PER_USER=12    (≤ 40)
//   -e MAX_COMMENTS_PER_USER=4     (≤ 15)
//   -e MAX_LIKE_MUTATIONS_PER_USER=8    likes + unlikes (≤ 25)
//   -e MAX_FOLLOW_MUTATIONS_PER_USER=3  follows + unfollows (≤ 10)
//   -e MAX_TOTAL_WRITES=<40×VUS>   every write request incl. RPCs (≤ 60×VUS)
//   -e MARK_READ=1                 also send the Notifications screen's
//                                  "mark all read" update (off by default:
//                                  it rewrites seed notifications' read flag)
//
// Same staging-only config and safeguards as k6-read-workload.js
// (./k6-lib.js): only the staging URL, the anon key and the synthetic users'
// credentials are ever loaded; production URLs/keys are refused; every
// account must sign in to staging and carry app_metadata.seed=loadtest-v1.
//
// What one virtual user does (each is one synthetic collector), mirroring
// the app's real requests:
//   feed → open another tester's RUN post (post detail) → maybe like/unlike
//   it → maybe comment → inbox → open its RUN conversation and stay ~20–30 s
//   polling every 5 s, maybe sending a message → unread badges → maybe
//   follow/unfollow → maybe Item Detail → maybe the Notifications screen.
//
// Dedicated, distinguishable data. setup() first checks (before any write)
// that RUN_ID is unused and that every pair's existing conversation, if
// any, holds only mixed-run messages, then:
//   - creates one text post per user through the app's create_text_post RPC,
//     content "[lt-mixed:<RUN_ID>] …" — all likes and comments target only
//     these run posts;
//   - opens one conversation per user pair through get_or_create_conversation
//     for pairs the seed never connects — all messages go there and start
//     with "[lt-mixed:<RUN_ID>]";
//   - follow/unfollow targets lt_user_(n+15 mod 30), a synthetic account the
//     seed graph never follows from n.
// Nothing is sent to a non-synthetic account; no Storage uploads, no Edge
// Function writes, no email.
//
// Runaway protection: per-user caps (above), a per-user share of
// MAX_TOTAL_WRITES enforced locally before every write, a global
// db_writes threshold that aborts the run, a VU stops writing after 3
// consecutive failed writes, and the run aborts on 10 failed writes, any
// 401/403/429, 5 server errors, >2% failed requests or a request rate above
// 4/s per VU.
//
// Results: scripts/loadtest/results/k6-mixed-<VUS>vu-<RUN_ID>.json (git-
// ignored) — a status (passed / failed / aborted / setup_failed: only
// "passed" is a clean, complete run), latency per operation and read vs
// write, error counts, write counters and a deterministic manifest (users,
// conversation pairs, follow targets) that verify-mixed-run.ts checks
// against the database.

/* global __ENV, __VU */
/* eslint-disable import/no-unresolved -- k6 built-in modules, resolved by the k6 runtime */
import http from 'k6/http';
import { fail } from 'k6';
import crypto from 'k6/crypto';
import { Counter, Trend } from 'k6/metrics';
/* eslint-enable import/no-unresolved */
import {
  ANON_KEY,
  STAGING_REF,
  VUS,
  batch,
  inList,
  loadFeedPage,
  loadItem,
  params,
  pause,
  pick,
  restUrl,
  rows,
  signInAccounts,
  signOutAll,
  track,
  trend,
  uniq,
  usernameFor,
} from './k6-lib.js';

// ── Limits (validated in init: an out-of-range value stops the run) ─────

function intSetting(name, fallback, min, max) {
  const raw = __ENV[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

const LIMITS = {
  steadyMinutes: intSetting('STEADY_MINUTES', 5, 1, 10),
  messagesPerUser: intSetting('MAX_MESSAGES_PER_USER', 12, 0, 40),
  commentsPerUser: intSetting('MAX_COMMENTS_PER_USER', 4, 0, 15),
  likeMutationsPerUser: intSetting('MAX_LIKE_MUTATIONS_PER_USER', 8, 0, 25),
  followMutationsPerUser: intSetting('MAX_FOLLOW_MUTATIONS_PER_USER', 3, 0, 10),
  totalWrites: intSetting('MAX_TOTAL_WRITES', 40 * VUS, 1, 60 * VUS),
  markRead: intSetting('MARK_READ', 0, 0, 1) === 1,
};
// The run id is supplied explicitly (never generated in setup), so the
// results file, the run tag and handleSummary all agree without relying on
// setup data reaching handleSummary. Lowercase letters, digits and hyphens
// only — no LIKE wildcards (_ %) can end up in cleanup's tag match.
const RUN_ID = String(__ENV.RUN_ID || '');
if (!/^[a-z0-9][a-z0-9-]{5,39}$/.test(RUN_ID)) {
  throw new Error('Pass -e RUN_ID=<6–40 lowercase letters, digits or hyphens> (e.g. -e RUN_ID=mx-20261013-1); it names this run\'s records and results file.');
}
const WRITES_PER_USER = Math.floor(LIMITS.totalWrites / VUS);
const MAX_CONSECUTIVE_WRITE_FAILURES = 3;
const RATE_CAP = 4 * VUS;
const RAMP_UP = '1m';
const RAMP_DOWN = '30s';

// Interaction frequencies per loop (one loop ≈ 50–70 s of a user's time).
const P = { like: 0.5, comment: 0.25, sendMessage: 0.7, follow: 0.15, item: 0.3, notifications: 0.15 };
const POLL_INTERVAL_S = 5; // app/conversation/[id].tsx and app/(tabs)/messages.tsx
const POLLS_PER_VISIT = [4, 6];

// ── Metrics ─────────────────────────────────────────────────────────────

// Workload writes only; setup's run posts and conversations are counted
// separately so they never eat into the workload's MAX_TOTAL_WRITES budget.
const dbWrites = new Counter('db_writes');
const setupWrites = new Counter('setup_writes');
const writeFailures = new Counter('write_failures');
const writesSkipped = new Counter('writes_skipped_by_limit');
const messagesSent = new Counter('messages_sent');
const commentsCreated = new Counter('comments_created');
const likeInserts = new Counter('like_inserts');
const likeDeletes = new Counter('like_deletes');
const followInserts = new Counter('follow_inserts');
const followDeletes = new Counter('follow_deletes');
const notificationRpcs = new Counter('notification_rpcs');
const readCursorUpdates = new Counter('read_cursor_updates');
// Run facts handleSummary needs, carried as metrics (always present in the
// summary data): setup finished, when it started, and how many follow
// edges already existed.
const setupCompleted = new Counter('setup_completed');
const setupStartedAt = new Trend('setup_started_at_ms');
const initialFollowEdges = new Counter('initial_follow_edges');

const READ_OPS = ['feed', 'post_detail', 'inbox_poll', 'conversation_poll', 'unread_poll', 'item', 'follow_state', 'notifications'];
const WRITE_OPS = ['message_send', 'read_cursor', 'like', 'unlike', 'comment', 'follow', 'unfollow', 'notification_rpc', 'notification_delete', 'mark_read'];

export const options = {
  scenarios: {
    collectors: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: VUS },
        { duration: `${LIMITS.steadyMinutes}m`, target: VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
      gracefulStop: '30s',
    },
  },
  batch: 10,
  batchPerHost: 6,
  setupTimeout: '120s',
  teardownTimeout: '60s',
  userAgent: 'cachecase-loadtest/1 (staging; k6 mixed)',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds: {
    // Stop conditions.
    unexpected_auth_errors: [{ threshold: 'count<1', abortOnFail: true }],
    rate_limited_responses: [{ threshold: 'count<1', abortOnFail: true }],
    server_errors: [{ threshold: 'count<5', abortOnFail: true }],
    // Abort at 10 failed writes; ANY failed write still fails the run.
    write_failures: [{ threshold: 'count<10', abortOnFail: true }, 'count<1'],
    db_writes: [{ threshold: `count<=${LIMITS.totalWrites}`, abortOnFail: true }],
    // Abort above 2%; ANY failed workload request still fails the run.
    'http_req_failed{phase:workload}': [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '30s' }, 'rate==0'],
    // Fails the run if setup never finished.
    setup_completed: ['count>=1'],
    sign_unavailable_rate: ['rate<0.05'],
    'http_reqs{phase:workload}': [{ threshold: `rate<${RATE_CAP}`, abortOnFail: true, delayAbortEval: '30s' }],
    // Reported targets (no abort).
    'http_req_duration{phase:workload}': ['p(95)<2000', 'p(99)<4000'],
    'http_req_duration{kind:read}': ['p(95)<2000'],
    'http_req_duration{kind:write}': ['p(95)<2000'],
    'checks{phase:workload}': ['rate>0.98'],
    auth_signin_duration: ['p(95)<3000'],
    // Materialise the per-status sub-metrics reported in the summary (the
    // stop conditions above already abort on any of them).
    'http_reqs{status:401}': ['count>=0'],
    'http_reqs{status:403}': ['count>=0'],
    'http_reqs{status:429}': ['count>=0'],
    // Per-operation sub-metrics, so the summary has p50/p95/p99 for each.
    ...Object.fromEntries([...READ_OPS, ...WRITE_OPS].map((op) => [`http_req_duration{op:${op}}`, ['p(95)<3000']])),
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

const runTag = (runId) => `[lt-mixed:${runId}]`;

function uuidv4() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Setup-time request (signed-in, not part of the measured workload).
function setupRequest(method, url, body, token, label) {
  const res = http.request(method, url, body === null ? null : JSON.stringify(body), {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags: { phase: 'setup', name: label },
  });
  if (res.status < 200 || res.status >= 300) fail(`Setup step "${label}" failed (HTTP ${res.status}); no workload traffic was sent.`);
  return res;
}

// Unique conversation pairs among the active users that the seed never
// connects (seed pairs differ by 1 or 5): offset 2 for 5 users, 7 for 15,
// 15 for 30.
function conversationPairs(count) {
  const shift = Math.floor(count / 2);
  const pairs = new Map();
  for (let i = 0; i < count; i++) {
    const j = (i + shift) % count;
    if (i === j) continue;
    const [a, b] = [i, j].sort((x, y) => x - y);
    pairs.set(`${a}+${b}`, [a, b]);
  }
  return [...pairs.values()];
}

// The follow target for user n: n+15 (mod 30). The seed graph only follows
// the next 6–10 users, so these edges never exist in the seed.
const followTargetNumber = (n) => ((n - 1 + 15) % 30) + 1;

// ── Setup: sign in, create the run's dedicated records ──────────────────

export function setup() {
  const runId = RUN_ID;
  setupStartedAt.add(Date.now());
  const sessions = signInAccounts(Array.from({ length: VUS }, (_, i) => i + 1), 20 * 60);
  const [first] = sessions;

  // ── Checks first: nothing below writes until every check has passed. ──

  // A run id is used once: its tag must not exist yet (posts are public).
  const reused = rows(setupRequest('GET', restUrl('posts', { select: 'id', content: `like.${runTag(runId)}*`, limit: 1 }), null, first.token, 'setup:run_id_unused'));
  if (reused.length) fail(`RUN_ID ${runId} was already used; pick a new one so this run's records stay separable.`);

  // Follow targets: synthetic usernames (only the seed scripts create
  // lt_user_NN accounts; for VUS=30 every target also signed in above).
  const targetNumbers = sessions.map((s) => followTargetNumber(s.n));
  const targetRes = setupRequest('GET', restUrl('profiles', { select: 'id,username', username: inList(uniq(targetNumbers.map(usernameFor))) }), null, first.token, 'setup:follow_targets');
  const targetIds = new Map(rows(targetRes).map((p) => [p.username, p.id]));
  const followTargets = {};
  for (const s of sessions) {
    const id = targetIds.get(usernameFor(followTargetNumber(s.n)));
    if (!id) fail(`Follow target ${usernameFor(followTargetNumber(s.n))} not found; seed the 30 accounts first.`);
    followTargets[s.n] = { n: followTargetNumber(s.n), id };
  }

  // Conversations, checked BEFORE get_or_create_conversation is called: a
  // pair may share no conversation (one will be created) or exactly one
  // whose messages ALL come from earlier mixed runs (reused). Anything else
  // — a seed conversation, a real one, an empty one of unknown origin, or
  // several — stops the run before any write.
  const pairs = conversationPairs(VUS).map(([i, j]) => [sessions[i], sessions[j]]);
  for (const [a, b] of pairs) {
    const shared = rows(setupRequest('GET', restUrl('conversation_participants', { select: 'conversation_id', user_id: `eq.${b.userId}` }), null, a.token, 'setup:shared_conversations'));
    if (shared.length > 1) fail(`${a.username}↔${b.username} share ${shared.length} conversations; refusing.`);
    if (shared.length === 1) {
      const id = shared[0].conversation_id;
      const anyMessage = rows(setupRequest('GET', restUrl('messages', { select: 'id', conversation_id: `eq.${id}`, limit: 1 }), null, a.token, 'setup:conversation_has_messages'));
      const foreign = rows(setupRequest('GET', restUrl('messages', { select: 'id', conversation_id: `eq.${id}`, body: 'not.like.[lt-mixed:*', limit: 1 }), null, a.token, 'setup:conversation_is_mixed_only'));
      if (!anyMessage.length || foreign.length) {
        fail(`${a.username}↔${b.username} already share a conversation that is not a mixed-run conversation (seed, real or empty); refusing to use it. If it is an empty leftover, run cleanup-mixed-run.ts --all-runs.`);
      }
    }
  }

  // Follow state at the start, so verification can compute the expected end state.
  for (const s of sessions) {
    const res = setupRequest('GET', restUrl('follows', { select: 'following_id', follower_id: `eq.${s.userId}`, following_id: `eq.${followTargets[s.n].id}` }), null, s.token, 'setup:follow_state');
    if (rows(res).length > 0) initialFollowEdges.add(1);
  }

  // ── Writes: the run's dedicated records. ───────────────────────────────

  // One run post per user (the app's create_text_post RPC).
  const posts = {};
  for (const s of sessions) {
    const res = setupRequest('POST', restUrl('rpc/create_text_post', {}), { p_content: `${runTag(runId)} Load test post by ${s.username}`, p_attachments: [] }, s.token, 'setup:create_text_post');
    setupWrites.add(1);
    const id = res.json();
    if (typeof id !== 'string') fail('create_text_post did not return a post id.');
    posts[s.n] = id;
  }

  // One conversation per pair (the app's get_or_create_conversation: it
  // returns the pair's existing conversation — verified above to be a
  // mixed-run one — or creates a new one; it never modifies an existing one).
  const conversations = [];
  for (const [a, b] of pairs) {
    const res = setupRequest('POST', restUrl('rpc/get_or_create_conversation', {}), { other_user_id: b.userId }, a.token, 'setup:get_or_create_conversation');
    setupWrites.add(1);
    const id = res.json();
    if (typeof id !== 'string') fail('get_or_create_conversation did not return a conversation id.');
    conversations.push({ id, users: [a.n, b.n] });
  }

  setupCompleted.add(1);
  console.log(`RUN_ID=${runId}: ${VUS} users, ${conversations.length} conversations. After the run: node scripts/loadtest/verify-mixed-run.ts --summary scripts/loadtest/results/k6-mixed-${VUS}vu-${runId}.json`);
  return { runId, sessions, posts, conversations, followTargets };
}

// ── Per-VU state (each VU is one user, so these are per-user limits) ────

const state = {
  writes: 0,
  messages: 0,
  comments: 0,
  likeMutations: 0,
  followMutations: 0,
  consecutiveWriteFailures: 0,
  writesDisabled: false,
  seq: 0,
  following: null,
};

// Gate for every write: per-user caps and the user's share of the total.
function canWrite(kind) {
  const caps = { message: [state.messages, LIMITS.messagesPerUser], comment: [state.comments, LIMITS.commentsPerUser], like: [state.likeMutations, LIMITS.likeMutationsPerUser], follow: [state.followMutations, LIMITS.followMutationsPerUser] };
  const [used, cap] = caps[kind] || [0, Infinity];
  if (state.writesDisabled || used >= cap || state.writes >= WRITES_PER_USER) {
    writesSkipped.add(1, { kind });
    return false;
  }
  return true;
}

// Sends one write and does the bookkeeping. 3 consecutive failures disable
// this user's writes for the rest of the run (reads continue).
function write(method, url, body, session, op, extraHeaders) {
  if (state.writes >= WRITES_PER_USER || state.writesDisabled) {
    writesSkipped.add(1, { kind: op });
    return null;
  }
  state.writes++;
  dbWrites.add(1, { op });
  const res = http.request(method, url, body === null ? null : JSON.stringify(body), params(session, op, `write:${op}`, { 'Content-Type': 'application/json', ...extraHeaders }, 'write'));
  if (track(res, `write:${op}`)) {
    state.consecutiveWriteFailures = 0;
    return res;
  }
  writeFailures.add(1, { op });
  if (++state.consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) state.writesDisabled = true;
  return null;
}

// ── Workload steps (the app's requests) ─────────────────────────────────

// app/post/[id].tsx: the post row, author profile, likes, comments
// (fetchComments) and repost count; then the commenters' profiles.
function loadPostDetail(session, postId, authorId) {
  const d = 'post_detail';
  const [, , likesRes, commentsRes] = batch(session, [
    ['posts', { select: 'id,user_id,item_id,post_type,image_url,content,caption,created_at,folder_id,folder_name,folder_item_count,folder_cover_snapshot_url,repost_of_post_id,quote_of_post_id', id: `eq.${postId}` }, d, 'post:row', 'single'],
    ['profiles', { select: 'id,username,display_name,avatar_url', id: `eq.${authorId}` }, d, 'post:author'],
    ['likes', { select: 'user_id', post_id: `eq.${postId}` }, d, 'post:likes'],
    ['comments', { select: 'id,user_id,body,created_at', post_id: `eq.${postId}`, order: 'created_at.asc' }, d, 'post:comments'],
    ['posts', { select: 'user_id', repost_of_post_id: `eq.${postId}` }, d, 'post:reposts'],
  ]);
  const commenters = uniq(rows(commentsRes).map((c) => c.user_id));
  if (commenters.length) batch(session, [['profiles', { select: 'id,username,display_name,avatar_url', id: inList(commenters) }, d, 'post:commenter_profiles']]);
  return { liked: rows(likesRes).some((l) => l.user_id === session.userId) };
}

// Feed / post-detail like toggle: likes insert/delete, then the app's
// create_or_refresh_like_notification RPC — or, on unlike, its delete of
// the like notification.
function toggleLike(session, postId, liked) {
  if (!canWrite('like')) return;
  state.likeMutations++;
  if (liked) {
    if (write('DELETE', restUrl('likes', { user_id: `eq.${session.userId}`, post_id: `eq.${postId}` }), null, session, 'unlike')) {
      likeDeletes.add(1);
      write('DELETE', restUrl('notifications', { actor_id: `eq.${session.userId}`, post_id: `eq.${postId}`, type: 'eq.like' }), null, session, 'notification_delete');
    }
  } else if (write('POST', restUrl('likes', {}), { user_id: session.userId, post_id: postId }, session, 'like', { Prefer: 'return=minimal' })) {
    likeInserts.add(1);
    if (write('POST', restUrl('rpc/create_or_refresh_like_notification', {}), { p_post_id: postId }, session, 'notification_rpc')) notificationRpcs.add(1, { type: 'like' });
  }
}

// app/post/[id].tsx handleSubmitComment: insert … select id,created_at
// single, then create_comment_notification (always another user's post).
function addComment(session, runId, postId) {
  if (!canWrite('comment')) return;
  state.comments++;
  const res = write('POST', restUrl('comments', { select: 'id,created_at' }), { user_id: session.userId, post_id: postId, body: `${runTag(runId)} comment from ${session.username}` }, session, 'comment', {
    Prefer: 'return=representation',
    Accept: 'application/vnd.pgrst.object+json',
  });
  if (!res) return;
  commentsCreated.add(1);
  const commentId = res.json().id;
  if (write('POST', restUrl('rpc/create_comment_notification', {}), { p_post_id: postId, p_comment_id: commentId }, session, 'notification_rpc')) notificationRpcs.add(1, { type: 'comment' });
}

// lib/dm-inbox.ts loadInbox (the 5-second inbox poll's request set).
function pollInbox(session) {
  const op = 'inbox_poll';
  const [mine] = batch(session, [['conversation_participants', { select: 'conversation_id,last_read_at', user_id: `eq.${session.userId}`, hidden_at: 'is.null' }, op, 'inbox:my_rows']]);
  const convIds = rows(mine).map((r) => r.conversation_id);
  if (!convIds.length) return;
  const [participants] = batch(session, [
    ['conversation_participants', { select: 'conversation_id,user_id', conversation_id: inList(convIds) }, op, 'inbox:participants'],
    ['conversations', { select: 'id,last_message_at', id: inList(convIds) }, op, 'inbox:conversations'],
    ['messages', { select: 'conversation_id,sender_id,body,created_at,attachment_type', conversation_id: inList(convIds), order: 'created_at.desc', limit: 200 }, op, 'inbox:latest_messages'],
  ]);
  const others = uniq(rows(participants).map((p) => p.user_id)).filter((id) => id !== session.userId);
  if (others.length) batch(session, [['profiles', { select: 'id,username,display_name,avatar_url', id: inList(others) }, op, 'inbox:profiles']]);
}

// app/conversation/[id].tsx loadMessages: full message list + the peer's
// read cursor (2 parallel reads per 5-second poll).
function pollConversation(session, conversationId) {
  const [messagesRes] = batch(session, [
    ['messages', { select: 'id,sender_id,body,created_at,attachment_type,attachment_item_id,attachment_storage_path,attachment_width,attachment_height', conversation_id: `eq.${conversationId}`, order: 'created_at.asc,id.asc' }, 'conversation_poll', 'conversation:messages'],
    ['conversation_participants', { select: 'last_read_at', conversation_id: `eq.${conversationId}`, user_id: `neq.${session.userId}` }, 'conversation_poll', 'conversation:peer_cursor'],
  ]);
  return rows(messagesRes);
}

// lib/dm-send.ts writeDmMessage (client-generated id, insert … select
// single) + stampSenderReadCursor.
function sendMessage(session, runId, conversationId) {
  if (!canWrite('message')) return false;
  state.messages++;
  state.seq++;
  const res = write(
    'POST',
    restUrl('messages', { select: 'id,sender_id,body,created_at,attachment_type,attachment_item_id,attachment_storage_path,attachment_width,attachment_height' }),
    { id: uuidv4(), conversation_id: conversationId, sender_id: session.userId, body: `${runTag(runId)} ${session.username} #${state.seq}` },
    session,
    'message_send',
    { Prefer: 'return=representation', Accept: 'application/vnd.pgrst.object+json' },
  );
  if (!res) return false;
  messagesSent.add(1);
  const createdAt = res.json().created_at;
  if (write('PATCH', restUrl('conversation_participants', { conversation_id: `eq.${conversationId}`, user_id: `eq.${session.userId}` }), { last_read_at: createdAt }, session, 'read_cursor')) readCursorUpdates.add(1);
  return true;
}

// One visit to a conversation screen: poll every 5 s; advance the read
// cursor only when a poll surfaces a new incoming message (the app's rule);
// maybe send one message during the visit.
function visitConversation(session, runId, conversationId) {
  let known = pollConversation(session, conversationId).length;
  const polls = POLLS_PER_VISIT[0] + Math.floor(Math.random() * (POLLS_PER_VISIT[1] - POLLS_PER_VISIT[0] + 1));
  const sendAt = Math.random() < P.sendMessage ? Math.floor(Math.random() * polls) : -1;
  for (let i = 0; i < polls; i++) {
    pause(POLL_INTERVAL_S - 0.25, POLL_INTERVAL_S + 0.25);
    // Our own message comes back in the next poll; don't count it as incoming.
    if (i === sendAt && sendMessage(session, runId, conversationId)) known++;
    const messages = pollConversation(session, conversationId);
    const fresh = messages.slice(known);
    known = messages.length;
    if (fresh.some((m) => m.sender_id !== session.userId) && canWrite('cursor')) {
      if (write('PATCH', restUrl('conversation_participants', { conversation_id: `eq.${conversationId}`, user_id: `eq.${session.userId}` }), { last_read_at: messages[messages.length - 1].created_at }, session, 'read_cursor')) readCursorUpdates.add(1);
    }
  }
}

// Tab badges: hooks/use-unread-count.ts (notifications) and
// hooks/use-unread-messages.ts (participants + conversations).
function pollBadges(session) {
  const [mine] = batch(session, [
    ['conversation_participants', { select: 'conversation_id,last_read_at', user_id: `eq.${session.userId}`, hidden_at: 'is.null' }, 'unread_poll', 'badge:my_conversations'],
    ['notifications', { select: '*', user_id: `eq.${session.userId}`, read: 'eq.false' }, 'unread_poll', 'badge:notifications', 'count'],
  ]);
  const ids = rows(mine).map((r) => r.conversation_id);
  if (ids.length) batch(session, [['conversations', { select: 'id,last_message_at', id: inList(ids) }, 'unread_poll', 'badge:conversations']]);
}

// hooks/use-follow.ts: follows insert + create_or_refresh_follow_notification,
// or follows delete. The current state is read first, as the profile does.
function toggleFollow(session, target) {
  if (!canWrite('follow')) return;
  if (state.following === null) {
    const [res] = batch(session, [['follows', { select: 'following_id', follower_id: `eq.${session.userId}`, following_id: `eq.${target.id}` }, 'follow_state', 'follow:state']]);
    state.following = rows(res).length > 0;
  }
  state.followMutations++;
  if (state.following) {
    if (write('DELETE', restUrl('follows', { follower_id: `eq.${session.userId}`, following_id: `eq.${target.id}` }), null, session, 'unfollow')) {
      followDeletes.add(1);
      state.following = false;
    }
  } else if (write('POST', restUrl('follows', {}), { follower_id: session.userId, following_id: target.id }, session, 'follow', { Prefer: 'return=minimal' })) {
    followInserts.add(1);
    state.following = true;
    if (write('POST', restUrl('rpc/create_or_refresh_follow_notification', {}), { p_followed_user_id: target.id }, session, 'notification_rpc')) notificationRpcs.add(1, { type: 'follow' });
  }
}

// app/(tabs)/notifications.tsx: the list; "mark all read" only if enabled.
function openNotifications(session) {
  batch(session, [['notifications', { select: 'id,type,read,created_at,post_id,conversation_id,actor_id,rating_score,transfer_id,registered_card_id', user_id: `eq.${session.userId}`, order: 'created_at.desc', limit: 100 }, 'notifications', 'notifications:list']]);
  if (LIMITS.markRead && canWrite('mark_read')) {
    write('PATCH', restUrl('notifications', { user_id: `eq.${session.userId}`, read: 'eq.false' }), { read: true }, session, 'mark_read');
  }
}

// ── One loop of one user ────────────────────────────────────────────────

export default function (data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length];
  const runId = RUN_ID;

  const feed = loadFeedPage(session, 0);
  pause(3, 6);

  // Another tester's run post: open it, maybe like/unlike, maybe comment.
  const others = data.sessions.filter((s) => s.n !== session.n);
  const author = pick(others);
  const postId = data.posts[author.n];
  const { liked } = loadPostDetail(session, postId, author.userId);
  pause(2, 4);
  if (Math.random() < P.like) toggleLike(session, postId, liked);
  if (Math.random() < P.comment) {
    pause(4, 8); // typing
    addComment(session, runId, postId);
  }
  pause(2, 4);

  // Messages tab, then one of this user's run conversations.
  pollInbox(session);
  pause(2, 4);
  const mine = data.conversations.filter((c) => c.users.includes(session.n));
  if (mine.length) visitConversation(session, runId, pick(mine).id);
  pause(2, 4);

  pollBadges(session);
  if (Math.random() < P.follow) toggleFollow(session, data.followTargets[session.n]);
  if (Math.random() < P.item && feed.cardItemIds.length) {
    loadItem(session, pick(feed.cardItemIds));
    pause(3, 6);
  }
  if (Math.random() < P.notifications) openNotifications(session);
  pause(4, 8);
}

export function teardown(data) {
  signOutAll(data.sessions);
}

// ── Results ─────────────────────────────────────────────────────────────

// Built only from __ENV and metrics — never from setup data — so the run id
// and manifest are always present, even when setup failed. The manifest is
// deterministic (user numbers, conversation pairs, follow targets); the
// verifier resolves the actual rows from the run tag.
export function handleSummary(data) {
  const m = data.metrics;
  const count = (name) => m[name]?.values.count ?? 0;
  const thresholds = {};
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) thresholds[`${name}: ${expr}`] = result.ok;
  }
  const thresholdsPassed = Object.keys(thresholds).length > 0 && Object.values(thresholds).every(Boolean);
  const failedRequests = m['http_req_failed{phase:workload}']?.values.passes ?? 0;
  const startedMs = m.setup_started_at_ms?.values.max ?? null;
  const plannedMs = (60 + LIMITS.steadyMinutes * 60 + 30) * 1000;

  // Only "passed" means a clean, complete run; everything else is unusable
  // for consistency verification (verify-mixed-run.ts refuses it).
  let status = 'passed';
  const reasons = [];
  if (count('setup_completed') < 1) {
    status = 'setup_failed';
    reasons.push('setup did not complete');
  } else if (data.state.testRunDurationMs < plannedMs - 5000) {
    status = 'aborted';
    reasons.push(`ran ${Math.round(data.state.testRunDurationMs / 1000)}s of a planned ${plannedMs / 1000}s`);
  }
  if (!thresholdsPassed) reasons.push('one or more thresholds failed');
  if (failedRequests > 0) reasons.push(`${failedRequests} failed workload requests`);
  if (count('write_failures') > 0) reasons.push(`${count('write_failures')} failed writes`);
  for (const name of ['unexpected_auth_errors', 'rate_limited_responses', 'server_errors']) if (count(name) > 0) reasons.push(`${count(name)} ${name}`);
  if (status === 'passed' && reasons.length) status = 'failed';

  const httpStatus = (s) => m[`http_reqs{status:${s}}`]?.values.count ?? 0;
  const users = Array.from({ length: VUS }, (_, i) => ({ n: i + 1, username: usernameFor(i + 1) }));

  const summary = {
    test: 'cachecase-mixed-workload',
    schema: 2,
    status,
    status_reasons: reasons,
    project_ref: STAGING_REF,
    run_id: RUN_ID,
    run_tag: runTag(RUN_ID),
    vus: VUS,
    limits: LIMITS,
    started_at: startedMs ? new Date(startedMs).toISOString() : null,
    finished_at: new Date().toISOString(),
    duration_ms: data.state.testRunDurationMs,
    planned_duration_ms: plannedMs,
    manifest: {
      users,
      conversation_pairs: conversationPairs(VUS).map(([i, j]) => [i + 1, j + 1]),
      follow_targets: Object.fromEntries(users.map((u) => [u.n, followTargetNumber(u.n)])),
      initial_follow_edges: count('initial_follow_edges'),
    },
    writes: {
      setup: count('setup_writes'),
      total: count('db_writes'),
      failed: count('write_failures'),
      skipped_by_limit: count('writes_skipped_by_limit'),
      messages_sent: count('messages_sent'),
      comments_created: count('comments_created'),
      like_inserts: count('like_inserts'),
      like_deletes: count('like_deletes'),
      follow_inserts: count('follow_inserts'),
      follow_deletes: count('follow_deletes'),
      notification_rpcs: count('notification_rpcs'),
      read_cursor_updates: count('read_cursor_updates'),
    },
    throughput: {
      workload_requests: m['http_reqs{phase:workload}']?.values.count ?? 0,
      workload_rps: m['http_reqs{phase:workload}']?.values.rate ?? 0,
      iterations: m.iterations?.values.count ?? 0,
    },
    failures: {
      failed_workload_requests: failedRequests,
      http_req_failed_rate: m['http_req_failed{phase:workload}']?.values.rate ?? null,
      checks_pass_rate: m['checks{phase:workload}']?.values.rate ?? null,
      unexpected_auth_errors: count('unexpected_auth_errors'),
      rate_limited_responses: count('rate_limited_responses'),
      server_errors: count('server_errors'),
      http_401: httpStatus(401),
      http_403: httpStatus(403),
      http_429: httpStatus(429),
    },
    latency_ms: {
      workload: trend(m['http_req_duration{phase:workload}']),
      read: trend(m['http_req_duration{kind:read}']),
      write: trend(m['http_req_duration{kind:write}']),
      ...Object.fromEntries([...READ_OPS, ...WRITE_OPS].map((op) => [op, trend(m[`http_req_duration{op:${op}}`])])),
      auth_signin: trend(m.auth_signin_duration),
    },
    consistency: status === 'passed' ? 'not yet verified — run verify-mixed-run.ts with this file' : 'not verifiable — the run did not pass',
    thresholds_passed: thresholdsPassed,
    thresholds,
  };

  const file = `scripts/loadtest/results/k6-mixed-${VUS}vu-${RUN_ID}.json`;
  const fmt = (t) => (t ? `p50 ${t.p50?.toFixed(0)} ms  p95 ${t.p95?.toFixed(0)} ms  p99 ${t.p99?.toFixed(0)} ms  (n=${t.count})` : 'n/a');
  const w = summary.writes;
  const lines = [
    '',
    `CacheCase mixed workload — ${VUS} VUs on ${STAGING_REF} (staging), run ${RUN_ID}`,
    `  STATUS: ${status.toUpperCase()}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`,
    `  requests: ${summary.throughput.workload_requests} (${summary.throughput.workload_rps.toFixed(2)}/s), iterations: ${summary.throughput.iterations}`,
    `  failed requests: ${failedRequests}  auth errors: ${summary.failures.unexpected_auth_errors}  429s: ${summary.failures.rate_limited_responses}  5xx: ${summary.failures.server_errors}`,
    `  writes: ${w.total} (+${w.setup} setup; failed ${w.failed}, skipped by limits ${w.skipped_by_limit}) — messages ${w.messages_sent}, comments ${w.comments_created}, likes +${w.like_inserts}/−${w.like_deletes}, follows +${w.follow_inserts}/−${w.follow_deletes}, notification RPCs ${w.notification_rpcs}`,
    `  overall: ${fmt(summary.latency_ms.workload)}`,
    `  reads:   ${fmt(summary.latency_ms.read)}`,
    `  writes:  ${fmt(summary.latency_ms.write)}`,
    ...[...READ_OPS, ...WRITE_OPS].map((op) => `    ${op.padEnd(20)} ${fmt(summary.latency_ms[op])}`),
    `  sign-in (setup, excluded): ${fmt(summary.latency_ms.auth_signin)}`,
    `  results: ${file}`,
    status === 'passed'
      ? `  next: node scripts/loadtest/verify-mixed-run.ts --summary ${file}`
      : `  cleanup: node scripts/loadtest/cleanup-mixed-run.ts --run-id ${RUN_ID} --dry-run`,
    '',
  ];
  return { [file]: JSON.stringify(summary, null, 2), stdout: lines.join('\n') };
}

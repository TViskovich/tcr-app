/// <reference types="node" />
// Read-only consistency check for one k6-mixed-workload.js run.
//
//   node scripts/loadtest/verify-mixed-run.ts --summary scripts/loadtest/results/k6-mixed-<VUS>vu-<RUN_ID>.json
//
// Accepts only a summary whose status is "passed" (a complete, clean run);
// --allow-incomplete checks any other status for diagnosis, with the status
// reported as a failure.
//
// Resolves the run's rows from its tag and the summary's deterministic
// manifest (see mixed-run-lib.ts), then checks: run posts; the pair
// conversations (exactly one per pair, never a seed conversation, holding
// only mixed-run messages); messages (count, conversation, sender, no
// duplicates); comments; likes and follows (no duplicates, net counts);
// notifications (message — exact per-message match; comment; like; follow);
// and RLS (an outsider and a signed-out client see nothing).
//
// Database reads use the service role (staging only, via staging.ts); the
// RLS checks use the anon key and one synthetic sign-in, exactly like the
// app. Nothing is written except the results file
// scripts/loadtest/results/verify-mixed-<RUN_ID>.json (git-ignored).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { MAX_USERS, usernamesFor } from './dataset-plan.ts';
import {
  RUN_ID_PATTERN,
  conversationsForPairs,
  matchMessageNotifications,
  runTag,
  seedConversationIds,
  selectIn,
  selectLike,
} from './mixed-run-lib.ts';
import { fetchAllPages, loadSeedUsers } from './seed-lib.ts';
import { SEED_TAG, createAdminClient, createUserClient, loadStagingConfig, loadStagingUserConfig, requireSetting, runMain } from './staging.ts';

type Summary = {
  test: string;
  schema: number;
  status: string;
  status_reasons?: string[];
  run_id: string;
  vus: number;
  limits: Record<string, number | boolean>;
  manifest: {
    users: { n: number; username: string }[];
    conversation_pairs: [number, number][];
    follow_targets: Record<string, number>;
    initial_follow_edges: number;
  };
  writes: Record<string, number>;
};
type Result = { area: string; check: string; status: 'pass' | 'fail' | 'warn'; detail: string };

const results: Result[] = [];
function record(area: string, check: string, ok: boolean | 'warn', detail: string) {
  const status = ok === 'warn' ? 'warn' : ok ? 'pass' : 'fail';
  results.push({ area, check, status, detail });
  console.log(`  [${status.toUpperCase()}] ${area.padEnd(13)} ${check} — ${detail}`);
}

function readSummary(): { summary: Summary; allowIncomplete: boolean } {
  const at = process.argv.indexOf('--summary');
  const path = at === -1 ? undefined : process.argv[at + 1];
  if (!path) throw new Error('Pass --summary <path to k6-mixed-…json>.');
  const summary = JSON.parse(readFileSync(path, 'utf8')) as Summary;
  if (summary.test !== 'cachecase-mixed-workload' || summary.schema !== 2 || !RUN_ID_PATTERN.test(summary.run_id ?? '') || !summary.manifest?.users?.length) {
    throw new Error(`${basename(path)} is not a k6-mixed-workload summary (schema 2).`);
  }
  const allowIncomplete = process.argv.includes('--allow-incomplete');
  if (summary.status !== 'passed' && !allowIncomplete) {
    throw new Error(`Run ${summary.run_id} has status "${summary.status}" (${(summary.status_reasons ?? []).join('; ')}); its data is not a valid consistency baseline. Use --allow-incomplete only for diagnosis.`);
  }
  return { summary, allowIncomplete };
}

async function main() {
  const { summary } = readSummary();
  const { manifest, writes } = summary;
  const tag = runTag(summary.run_id);

  const config = loadStagingConfig();
  const admin = createAdminClient(config);
  console.log(`Target project: ${config.ref} (staging) — verifying run ${summary.run_id} (${summary.vus} users, status ${summary.status})`);
  console.log('');
  record('run', 'k6 run status is "passed"', summary.status === 'passed', `${summary.status}${summary.status_reasons?.length ? ` — ${summary.status_reasons.join('; ')}` : ''}`);

  // Users: the manifest's numbers, resolved and seed-tag checked.
  const allUsers = await loadSeedUsers(admin, usernamesFor(MAX_USERS));
  const byN = new Map(allUsers.map((u) => [Number(u.n), u]));
  const runUsers = manifest.users.map((u) => byN.get(u.n)!);
  const runUserIds = new Set(runUsers.map((u) => u.id));
  const userById = new Map(allUsers.map((u) => [u.id, u]));

  // ── Run posts ──────────────────────────────────────────────────────────
  const posts = await selectLike(admin, 'posts', 'id, user_id, content, created_at', 'content', tag);
  const postAuthor = new Map(posts.map((p) => [p.id as string, p.user_id as string]));
  const authors = new Set(posts.map((p) => p.user_id as string));
  record(
    'posts',
    'one run post per run user',
    posts.length === runUsers.length && authors.size === runUsers.length && [...authors].every((id) => runUserIds.has(id)),
    `${posts.length} run posts by ${authors.size} authors (expected ${runUsers.length})`,
  );
  const postIds = [...postAuthor.keys()];

  // ── Pair conversations ─────────────────────────────────────────────────
  const seedConversations = seedConversationIds(allUsers);
  const pairIds = manifest.conversation_pairs.map(([a, b]) => [byN.get(a)!.id, byN.get(b)!.id] as [string, string]);
  const found = await conversationsForPairs(admin, pairIds);
  const conversations = new Map<string, Set<string>>();
  let badPairs = 0;
  for (const [a, b] of pairIds) {
    const ids = found.get([a, b].sort().join('|')) ?? [];
    if (ids.length !== 1 || seedConversations.has(ids[0])) badPairs++;
    else conversations.set(ids[0], new Set([a, b]));
  }
  record('conversations', 'exactly one non-seed conversation per pair', badPairs === 0, `${conversations.size}/${pairIds.length} pairs resolved, ${badPairs} missing, duplicated or seed`);
  const convIds = [...conversations.keys()];
  const foreignMessages = (await selectIn(admin, 'messages', 'id, body', 'conversation_id', convIds, ['id'])).filter((m) => !String(m.body ?? '').startsWith('[lt-mixed:'));
  record('conversations', 'run conversations hold only mixed-run messages', foreignMessages.length === 0, `${foreignMessages.length} other messages`);

  // ── Messages ───────────────────────────────────────────────────────────
  const messages = await selectLike(admin, 'messages', 'id, conversation_id, sender_id, body, created_at', 'body', tag);
  record('messages', 'tagged messages = messages_sent', messages.length === writes.messages_sent, `${messages.length} found, ${writes.messages_sent} sent`);
  const wrongConversation = messages.filter((m) => !conversations.has(m.conversation_id as string)).length;
  const wrongSender = messages.filter((m) => !conversations.get(m.conversation_id as string)?.has(m.sender_id as string)).length;
  const wrongName = messages.filter((m) => !String(m.body).startsWith(`${tag} ${userById.get(m.sender_id as string)?.username ?? '\u0000'} #`)).length;
  record('messages', 'each in a run conversation', wrongConversation === 0, `${wrongConversation} outside`);
  record('messages', 'sender is a participant and matches the body', wrongSender === 0 && wrongName === 0, `${wrongSender} non-participant senders, ${wrongName} body/sender mismatches`);
  const ids = new Set(messages.map((m) => m.id));
  const sends = new Set(messages.map((m) => String(m.body).slice(tag.length + 1)));
  record('messages', 'no duplicate ids or sends', ids.size === messages.length && sends.size === messages.length, `${messages.length - ids.size} duplicate ids, ${messages.length - sends.size} duplicate "<user> #<n>" bodies`);

  // ── Comments ───────────────────────────────────────────────────────────
  const comments = await selectLike(admin, 'comments', 'id, user_id, post_id, body', 'body', tag);
  record('comments', 'tagged comments = comments_created', comments.length === writes.comments_created, `${comments.length} found, ${writes.comments_created} created`);
  const badComments = comments.filter((c) => {
    const author = postAuthor.get(c.post_id as string);
    return !author || !runUserIds.has(c.user_id as string) || c.user_id === author || !String(c.body).endsWith(` ${userById.get(c.user_id as string)?.username ?? '\u0000'}`);
  }).length;
  record('comments', 'user and post relationships', badComments === 0, `${badComments} on a non-run post, by a non-run user, on their own post, or with the wrong name`);

  // ── Likes ──────────────────────────────────────────────────────────────
  const likes = await selectIn(admin, 'likes', 'user_id, post_id', 'post_id', postIds, ['post_id', 'user_id']);
  const likeKeys = new Set(likes.map((l) => `${l.user_id}|${l.post_id}`));
  record('likes', 'no duplicate likes', likeKeys.size === likes.length, `${likes.length - likeKeys.size} duplicates`);
  record('likes', 'net likes = inserts − deletes', likes.length === writes.like_inserts - writes.like_deletes, `${likes.length} on run posts, expected ${writes.like_inserts - writes.like_deletes}`);
  const strangeLikes = likes.filter((l) => !runUserIds.has(l.user_id as string) || l.user_id === postAuthor.get(l.post_id as string)).length;
  record('likes', 'only run users, never on their own post', strangeLikes === 0, `${strangeLikes} unexpected`);

  // ── Follows ────────────────────────────────────────────────────────────
  const edgeWanted = new Map(manifest.users.map((u) => [byN.get(u.n)!.id, byN.get(manifest.follow_targets[u.n])!.id]));
  const followRows = await selectIn(admin, 'follows', 'follower_id, following_id', 'follower_id', [...edgeWanted.keys()], ['follower_id', 'following_id']);
  const runEdges = followRows.filter((f) => edgeWanted.get(f.follower_id as string) === f.following_id);
  const edgeKeys = new Set(runEdges.map((f) => `${f.follower_id}|${f.following_id}`));
  record('follows', 'no duplicate follows', edgeKeys.size === runEdges.length, `${runEdges.length - edgeKeys.size} duplicates`);
  const expectedEdges = manifest.initial_follow_edges + writes.follow_inserts - writes.follow_deletes;
  record('follows', 'net follows = initial + inserts − deletes', runEdges.length === expectedEdges, `${runEdges.length} edges, expected ${manifest.initial_follow_edges} + ${writes.follow_inserts} − ${writes.follow_deletes}`);

  // ── Notifications ──────────────────────────────────────────────────────
  const match = await matchMessageNotifications(admin, messages);
  const misaddressed = [...match.matched.entries()].filter(([messageId, n]) => {
    const m = messages.find((x) => x.id === messageId)!;
    const members = conversations.get(m.conversation_id as string);
    return !members?.has(n.user_id as string) || n.user_id === m.sender_id;
  }).length;
  record('notifications', 'every message has exactly one notification (trigger)', match.missing.length === 0 && match.ambiguous.length === 0, `${match.matched.size} matched, ${match.missing.length} missing, ${match.ambiguous.length} ambiguous`);
  record('notifications', 'message notifications go to the other participant', misaddressed === 0, `${misaddressed} misaddressed`);

  const postNotifs = await selectIn(admin, 'notifications', 'id, user_id, actor_id, type, post_id', 'post_id', postIds, ['id']);
  const commentNotifs = postNotifs.filter((n) => n.type === 'comment');
  record('notifications', 'one comment notification per comment (RPC)', commentNotifs.length === comments.length, `${commentNotifs.length} for ${comments.length} comments`);
  const likeNotifs = postNotifs.filter((n) => n.type === 'like');
  const likeNotifKeys = new Set(likeNotifs.map((n) => `${n.actor_id}|${n.post_id}`));
  const likesWithout = likes.filter((l) => !likeNotifKeys.has(`${l.user_id}|${l.post_id}`)).length;
  const orphanLikeNotifs = likeNotifs.filter((n) => !likeKeys.has(`${n.actor_id}|${n.post_id}`)).length;
  record('notifications', 'every like has a like notification; none without a like', likesWithout === 0 && orphanLikeNotifs === 0, `${likesWithout} likes without, ${orphanLikeNotifs} notifications without a like`);
  const wrongRecipient = postNotifs.filter((n) => n.user_id !== postAuthor.get(n.post_id as string) || !runUserIds.has(n.actor_id as string)).length;
  record('notifications', 'post notifications: author is the recipient, a run user the actor', wrongRecipient === 0, `${wrongRecipient} unexpected`);

  const targetIds = [...new Set(edgeWanted.values())];
  const followNotifs = await fetchAllPages((from, to) =>
    admin.from('notifications').select('user_id, actor_id').eq('type', 'follow').in('user_id', targetIds).in('actor_id', [...edgeWanted.keys()]).order('user_id').order('actor_id').range(from, to),
  );
  const followNotifKeys = new Set(followNotifs.map((n) => `${n.actor_id}|${n.user_id}`));
  const edgesWithout = runEdges.filter((f) => !followNotifKeys.has(`${f.follower_id}|${f.following_id}`)).length;
  record('notifications', 'every follow has a follow notification', edgesWithout === 0, `${edgesWithout} of ${runEdges.length} follows without one`);

  // A run that wrote nothing would pass the count checks trivially.
  const activity = writes.messages_sent + writes.comments_created + writes.like_inserts + writes.like_deletes + writes.follow_inserts + writes.follow_deletes;
  record('run', 'the run produced activity to verify', activity > 0 ? true : 'warn', `${activity} message/comment/like/follow writes`);

  // ── RLS (anon key + one synthetic sign-in, exactly like the app) ───────
  const userConfig = loadStagingUserConfig();
  const domain = requireSetting(userConfig, 'LOADTEST_EMAIL_DOMAIN').toLowerCase();
  const [conversationId, members] = [...conversations][0] ?? [];
  const outsider = runUsers.find((u) => members && !members.has(u.id));
  const member = members ? userById.get([...members][0]) : undefined;
  if (!conversationId || !outsider || !member) {
    record('rls', 'outsider checks', false, 'need a resolved run conversation and a run user outside it');
  } else {
    const client = createUserClient(userConfig);
    const password = userConfig.settings[`LOADTEST_USER_${outsider.n}_PASSWORD`]?.trim() || requireSetting(userConfig, 'LOADTEST_USER_PASSWORD');
    const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email: `lt-user-${outsider.n}@${domain}`, password });
    if (signInError || !signIn.session) {
      record('rls', `sign in as ${outsider.username}`, false, signInError?.message ?? 'no session');
    } else if (signIn.user.app_metadata?.seed !== SEED_TAG) {
      record('rls', `sign in as ${outsider.username}`, false, 'account is not seed-tagged; RLS checks not run');
    } else {
      const zero = async (label: string, query: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) => {
        const { data, error } = await query;
        record('rls', label, !error && (data?.length ?? 0) === 0, error ? `query error: ${error.message}` : `${data?.length ?? 0} rows visible`);
      };
      await zero(`${outsider.username} cannot read a run conversation's messages`, client.from('messages').select('id').eq('conversation_id', conversationId));
      await zero(`${outsider.username} cannot read that conversation's participants`, client.from('conversation_participants').select('user_id').eq('conversation_id', conversationId));
      await zero(`${outsider.username} cannot read ${member.username}'s notifications`, client.from('notifications').select('id').eq('user_id', member.id));
      await client.auth.signOut({ scope: 'local' });
    }
    // Signed out: zero rows, or the intended 42501 on is_conversation_participant
    // (docs/security-follow-ups.md). Anything else fails.
    const anonymous = createUserClient(userConfig);
    const { data, error } = await anonymous.from('messages').select('id').eq('conversation_id', conversationId);
    const denied = error ? error.code === '42501' && /is_conversation_participant/.test(error.message) : (data?.length ?? 0) === 0;
    record('rls', 'signed-out client cannot read a run conversation', denied, error ? `${error.code} ${error.message}` : `${data?.length ?? 0} rows visible`);
  }

  // ── Report ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const passed = failed === 0;
  console.log('');
  console.log(`Consistency: ${results.length - failed - warned} passed, ${failed} failed, ${warned} warnings — ${passed ? 'VERIFIED' : 'NOT VERIFIED'}`);
  const file = `scripts/loadtest/results/verify-mixed-${summary.run_id}.json`;
  writeFileSync(file, JSON.stringify({ run_id: summary.run_id, run_status: summary.status, verified_at: new Date().toISOString(), passed, results }, null, 2));
  console.log(`Saved ${file}`);
  if (!passed) process.exitCode = 1;
}

runMain(main);


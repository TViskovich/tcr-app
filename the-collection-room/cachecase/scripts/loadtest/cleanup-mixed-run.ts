/// <reference types="node" />
// Removes data created by k6-mixed-workload.js — one run, or every mixed
// run — while preserving the original seed dataset, the 30 synthetic
// accounts and their profiles, and every notification not attributable to
// the requested run.
//
//   node scripts/loadtest/cleanup-mixed-run.ts --run-id <RUN_ID> --dry-run
//   node scripts/loadtest/cleanup-mixed-run.ts --summary <k6-mixed-…json> --dry-run
//   node scripts/loadtest/cleanup-mixed-run.ts --all-runs --dry-run
//   … then the same with --cleanup --confirm=ickqkzvqddkhqyxnbzox
// (--run-id works even when the run failed or wrote no summary.)
//
// What is deleted, and how each record is identified (mixed-run-lib.ts):
//   1. message notifications — only those matched EXACTLY to one of the
//      run's messages (conversation, sender, identical created_at);
//   2. the run's messages — body "[lt-mixed:<RUN_ID>] …";
//   3. pair conversations left with no messages — never a seed conversation,
//      only seed-tagged participants, and (single run) created within the
//      run's time window;
//   4. the run's posts — content "[lt-mixed:<RUN_ID>] …" by a seed-tagged
//      account; deleting them cascades their likes, comments and like/comment
//      notifications, all of which belong to mixed runs (run posts are
//      dedicated);
//   5. follow notifications and 6. follow edges of the pattern
//      lt_user_n → lt_user_(n+15 mod 30) (never in the seed graph) — for a
//      single run only those created within its time window.
//
// It REFUSES (deletes nothing) rather than guess when:
//   - a run message sits in a seed conversation or one with a non-synthetic
//     participant;
//   - a run post has a like, comment, notification, repost or quote from a
//     non-synthetic account (the cascade would remove their data);
//   - a run message matches more than one notification;
//   - (single run) another mixed run's posts fall inside this run's time
//     window, so follow/conversation attribution would be ambiguous — use
//     --all-runs instead.
// Not reverted: notifications marked read by a run started with MARK_READ=1.
//
// Retry-safe: every invocation re-reads the current state and deletes by id
// or exact key.

import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_USERS, usernamesFor } from './dataset-plan.ts';
import {
  MIXED_TAG_PREFIX,
  MIXED_VUS,
  RUN_ID_PATTERN,
  conversationsForPairs,
  followTargetNumber,
  matchMessageNotifications,
  mixedPairs,
  runTag,
  seedConversationIds,
  selectIn,
  selectLike,
} from './mixed-run-lib.ts';
import { chunks, loadSeedUsers, type SeedUser } from './seed-lib.ts';
import { STAGING_PROJECT_REF, createAdminClient, loadStagingConfig, runMain } from './staging.ts';

type Scope = { label: string; prefix: string; runId: string | null; summaryWindow: [number, number] | null };

function parseArgs() {
  const args = process.argv.slice(2);
  const modes = ['--dry-run', '--cleanup'].filter((m) => args.includes(m));
  if (modes.length !== 1) throw new Error('Pass exactly one of --dry-run or --cleanup.');
  if (modes[0] === '--cleanup' && !args.includes(`--confirm=${STAGING_PROJECT_REF}`)) {
    throw new Error(`--cleanup deletes data: add --confirm=${STAGING_PROJECT_REF} to proceed.`);
  }
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const selectors = ['--run-id', '--summary', '--all-runs'].filter((f) => args.includes(f));
  if (selectors.length !== 1) throw new Error('Pass exactly one of --run-id <id>, --summary <file> or --all-runs.');

  let scope: Scope;
  if (args.includes('--all-runs')) {
    scope = { label: 'all mixed runs', prefix: MIXED_TAG_PREFIX, runId: null, summaryWindow: null };
  } else {
    let runId = value('--run-id');
    let summaryWindow: [number, number] | null = null;
    if (args.includes('--summary')) {
      const summary = JSON.parse(readFileSync(value('--summary')!, 'utf8'));
      if (summary.test !== 'cachecase-mixed-workload') throw new Error('Not a k6-mixed-workload summary.');
      runId = summary.run_id;
      if (summary.started_at && summary.finished_at) summaryWindow = [Date.parse(summary.started_at), Date.parse(summary.finished_at)];
    }
    if (!runId || !RUN_ID_PATTERN.test(runId)) throw new Error('RUN_ID must be 6–40 lowercase letters, digits or hyphens.');
    scope = { label: `run ${runId}`, prefix: runTag(runId), runId, summaryWindow };
  }
  return { mode: modes[0], scope };
}

type Plan = {
  messageNotifications: string[];
  messages: string[];
  conversations: string[];
  posts: string[];
  postCascades: { likes: number; comments: number; notifications: number };
  followNotifications: string[];
  follows: { follower_id: string; following_id: string }[];
  kept: string[];
  refusals: string[];
  window: [number, number] | null;
};

// fixedWindow: reuse an earlier window (the post-cleanup re-check, after the
// records the window was derived from are gone).
async function plan(admin: SupabaseClient, users: SeedUser[], scope: Scope, fixedWindow?: [number, number] | null): Promise<Plan> {
  const U = new Set(users.map((u) => u.id));
  const byN = new Map(users.map((u) => [Number(u.n), u]));
  const seedConversations = seedConversationIds(users);
  const refusals: string[] = [];
  const kept: string[] = [];

  // Posts and messages carrying the tag.
  const taggedPosts = await selectLike(admin, 'posts', 'id, user_id, created_at', 'content', scope.prefix);
  const posts = taggedPosts.filter((p) => U.has(p.user_id as string));
  if (posts.length < taggedPosts.length) kept.push(`${taggedPosts.length - posts.length} tagged posts by non-synthetic accounts (never deleted)`);
  const messages = await selectLike(admin, 'messages', 'id, conversation_id, sender_id, created_at', 'body', scope.prefix);

  // Every run message must be in a non-seed conversation of synthetic users.
  const messageConversations = [...new Set(messages.map((m) => m.conversation_id as string))];
  const participants = await selectIn(admin, 'conversation_participants', 'conversation_id, user_id', 'conversation_id', messageConversations, ['conversation_id', 'user_id']);
  const unsafe = messageConversations.filter((id) => seedConversations.has(id) || participants.some((p) => p.conversation_id === id && !U.has(p.user_id as string)));
  if (unsafe.length) refusals.push(`${unsafe.length} conversation(s) with run messages are seed conversations or include a non-synthetic participant`);

  // Run-scope time window: from the run's own records (and summary, if given).
  let window: [number, number] | null = fixedWindow ?? null;
  if (scope.runId && fixedWindow === undefined) {
    const times = [...posts, ...messages].map((r) => Date.parse(r.created_at as string));
    if (scope.summaryWindow) times.push(...scope.summaryWindow);
    if (times.length) window = [Math.min(...times) - 2 * 60 * 1000, Math.max(...times) + 10 * 60 * 1000];
    if (window) {
      const others = (await selectLike(admin, 'posts', 'id, content, created_at', 'content', MIXED_TAG_PREFIX)).filter((p) => {
        const t = Date.parse(p.created_at as string);
        return !String(p.content).startsWith(scope.prefix) && t >= window![0] && t <= window![1];
      });
      if (others.length) refusals.push(`another mixed run overlaps this run's time window (${others.length} posts); follow/conversation attribution is ambiguous — use --all-runs`);
    }
  }
  const inWindow = (at: unknown) => !scope.runId || (window !== null && Date.parse(at as string) >= window[0] && Date.parse(at as string) <= window[1]);

  // Non-synthetic data that deleting run posts would cascade away.
  const postIds = posts.map((p) => p.id as string);
  const likes = await selectIn(admin, 'likes', 'user_id, post_id', 'post_id', postIds, ['post_id', 'user_id']);
  const comments = await selectIn(admin, 'comments', 'id, user_id', 'post_id', postIds, ['id']);
  const postNotifications = await selectIn(admin, 'notifications', 'id, user_id, actor_id', 'post_id', postIds, ['id']);
  const reposts = await selectIn(admin, 'posts', 'id, user_id', 'repost_of_post_id', postIds, ['id']);
  const quotes = await selectIn(admin, 'posts', 'id, user_id', 'quote_of_post_id', postIds, ['id']);
  const foreign =
    likes.filter((r) => !U.has(r.user_id as string)).length +
    comments.filter((r) => !U.has(r.user_id as string)).length +
    postNotifications.filter((r) => !U.has(r.user_id as string) || !U.has(r.actor_id as string)).length +
    reposts.length +
    quotes.length;
  if (foreign) refusals.push(`${foreign} like/comment/notification/repost/quote row(s) on run posts are not from mixed-run activity`);

  // Message notifications: exact matches only.
  const match = await matchMessageNotifications(admin, messages);
  if (match.ambiguous.length) refusals.push(`${match.ambiguous.length} run message(s) match more than one notification`);
  if (match.missing.length) kept.push(`${match.missing.length} run messages had no notification to remove`);

  // Pair conversations that will hold no messages afterwards.
  const pairs: [string, string][] = [];
  for (const vus of MIXED_VUS) for (const [a, b] of mixedPairs(vus)) pairs.push([byN.get(a)!.id, byN.get(b)!.id]);
  const pairConversations = [...new Set([...(await conversationsForPairs(admin, pairs)).values()].flat())].filter((id) => !seedConversations.has(id));
  const candidates = [...new Set([...pairConversations, ...messageConversations])].filter((id) => !unsafe.includes(id) && !seedConversations.has(id));
  const runMessageIds = new Set(messages.map((m) => m.id as string));
  const remaining = await selectIn(admin, 'messages', 'id, conversation_id', 'conversation_id', candidates, ['id']);
  const stillUsed = new Set(remaining.filter((m) => !runMessageIds.has(m.id as string)).map((m) => m.conversation_id as string));
  const convRows = await selectIn(admin, 'conversations', 'id, created_at', 'id', candidates, ['id']);
  const conversations = convRows.filter((c) => !stillUsed.has(c.id as string) && inWindow(c.created_at)).map((c) => c.id as string);

  // Follow edges and notifications of the n → n+15 pattern.
  const patternKeys = new Set(users.map((u) => `${u.id}|${byN.get(followTargetNumber(Number(u.n)))!.id}`));
  const follows = (await selectIn(admin, 'follows', 'follower_id, following_id, created_at', 'follower_id', [...U], ['follower_id', 'following_id']))
    .filter((f) => patternKeys.has(`${f.follower_id}|${f.following_id}`) && inWindow(f.created_at))
    .map((f) => ({ follower_id: f.follower_id as string, following_id: f.following_id as string }));
  const followNotifications = (await selectIn(admin, 'notifications', 'id, user_id, actor_id, type, created_at', 'actor_id', [...U], ['id']))
    .filter((n) => n.type === 'follow' && patternKeys.has(`${n.actor_id}|${n.user_id}`) && inWindow(n.created_at))
    .map((n) => n.id as string);

  return {
    messageNotifications: [...match.matched.values()].map((n) => n.id as string),
    messages: messages.map((m) => m.id as string),
    conversations,
    posts: postIds,
    postCascades: { likes: likes.length, comments: comments.length, notifications: postNotifications.length },
    followNotifications,
    follows,
    kept,
    refusals,
    window,
  };
}

function report(p: Plan) {
  console.log('');
  console.log('  Mixed-run data, in deletion order:');
  console.log(`    1. message notifications (exact match)   ${p.messageNotifications.length}`);
  console.log(`    2. run messages                          ${p.messages.length}`);
  console.log(`    3. emptied pair conversations            ${p.conversations.length}  (cascades participants)`);
  console.log(`    4. run posts                             ${p.posts.length}  (cascades ${p.postCascades.likes} likes, ${p.postCascades.comments} comments, ${p.postCascades.notifications} notifications)`);
  console.log(`    5. follow notifications (n→n+15)         ${p.followNotifications.length}`);
  console.log(`    6. follow edges (n→n+15)                 ${p.follows.length}`);
  for (const k of p.kept) console.log(`    kept: ${k}`);
  for (const r of p.refusals) console.log(`    REFUSED: ${r}`);
}

async function deleteIds(admin: SupabaseClient, table: string, ids: string[]) {
  for (const chunk of chunks(ids, 100)) {
    const { error } = await admin.from(table).delete().in('id', chunk);
    if (error) throw new Error(`Deleting from ${table} failed: ${error.message}`);
  }
}

async function main() {
  const { mode, scope } = parseArgs();
  const config = loadStagingConfig();
  console.log(`Target project: ${config.ref} (staging) — ${mode}, ${scope.label}`);
  const admin = createAdminClient(config);
  const users = await loadSeedUsers(admin, usernamesFor(MAX_USERS));

  const p = await plan(admin, users, scope);
  report(p);
  console.log('');
  if (p.refusals.length) {
    if (mode === '--dry-run') {
      console.log('--cleanup would REFUSE (see above). Nothing was deleted.');
      process.exitCode = 1;
      return;
    }
    throw new Error('Refusing to clean up (see above). Nothing was deleted.');
  }
  if (mode === '--dry-run') {
    console.log('Dry run only — nothing was deleted. Seed records, accounts and profiles are never in scope.');
    return;
  }

  console.log('Cleaning up…');
  // Notifications are matched through their messages, so they go first.
  await deleteIds(admin, 'notifications', p.messageNotifications);
  await deleteIds(admin, 'messages', p.messages);
  await deleteIds(admin, 'conversations', p.conversations);
  await deleteIds(admin, 'posts', p.posts);
  await deleteIds(admin, 'notifications', p.followNotifications);
  for (const f of p.follows) {
    const { error } = await admin.from('follows').delete().eq('follower_id', f.follower_id).eq('following_id', f.following_id);
    if (error) throw new Error(`Deleting follows failed: ${error.message}`);
  }

  const after = await plan(admin, users, scope, p.window);
  const left = after.posts.length + after.messages.length + after.messageNotifications.length + after.follows.length + after.followNotifications.length;
  report(after);
  console.log('');
  if (left) {
    process.exitCode = 1;
    console.log('Cleanup incomplete — rerun the same command (it is retry-safe).');
  } else {
    console.log('Clean. Confirm the seed dataset is intact with: node scripts/loadtest/seed-dataset.ts --users 30 --verify');
  }
}

runMain(main);


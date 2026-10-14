/// <reference types="node" />
// STAGING ONLY — verifies 20261020120000_delete_like_notification_on_unlike.sql
// end to end, through the app's own path, after the migration is applied:
//
//   node scripts/loadtest/test-like-notification-trigger.ts
//
// As synthetic lt_user_02 (anon key + sign-in, so RLS applies exactly as in
// the app), on a post by another synthetic user that lt_user_02 has neither
// liked nor has a like notification on:
//   1. like it and call create_or_refresh_like_notification (app's like path)
//      → exactly one like notification exists;
//   2. unlike it (app's unlike path: DELETE likes)
//      → the like notification is gone (the trigger), the like is gone;
//   3. every non-like notification of the liker and the post author is
//      unchanged (same ids before and after).
// Writes: one like, one RPC, one unlike — net zero. If a step fails, the
// like is removed again so staging is left as found. Reads use the service
// role (staging only).

import { MAX_USERS, usernamesFor } from './dataset-plan.ts';
import { loadSeedUsers } from './seed-lib.ts';
import { SEED_TAG, createAdminClient, createUserClient, loadStagingConfig, loadStagingUserConfig, requireSetting, runMain } from './staging.ts';

const LIKER = 'lt_user_02';

async function main() {
  const config = loadStagingConfig();
  const admin = createAdminClient(config);
  console.log(`Target project: ${config.ref} (staging) — like-notification trigger test`);
  const users = await loadSeedUsers(admin, usernamesFor(MAX_USERS));
  const liker = users.find((u) => u.username === LIKER)!;
  const others = users.filter((u) => u.id !== liker.id).map((u) => u.id);

  // A post by another synthetic user with no like and no like notification
  // from the liker.
  const { data: posts, error: postsError } = await admin.from('posts').select('id, user_id').in('user_id', others).order('created_at', { ascending: false }).limit(50);
  if (postsError) throw new Error(postsError.message);
  const postIds = (posts ?? []).map((p) => p.id);
  const { data: likes } = await admin.from('likes').select('post_id').eq('user_id', liker.id).in('post_id', postIds);
  const { data: likeNotifs } = await admin.from('notifications').select('post_id').eq('actor_id', liker.id).eq('type', 'like').in('post_id', postIds);
  const taken = new Set([...(likes ?? []), ...(likeNotifs ?? [])].map((r) => r.post_id));
  const post = (posts ?? []).find((p) => !taken.has(p.id));
  if (!post) throw new Error('No suitable synthetic post found for the test.');

  const snapshot = async () => {
    const { data, error } = await admin.from('notifications').select('id').neq('type', 'like').in('user_id', [liker.id, post.user_id]).order('id');
    if (error) throw new Error(error.message);
    return (data ?? []).map((n) => n.id).join(',');
  };
  const likeNotificationCount = async () => {
    const { count, error } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('type', 'like').eq('actor_id', liker.id).eq('post_id', post.id);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const before = await snapshot();

  // Sign in as the liker (anon key; RLS applies).
  const userConfig = loadStagingUserConfig();
  const client = createUserClient(userConfig);
  const password = userConfig.settings.LOADTEST_USER_02_PASSWORD?.trim() || requireSetting(userConfig, 'LOADTEST_USER_PASSWORD');
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({
    email: `lt-user-02@${requireSetting(userConfig, 'LOADTEST_EMAIL_DOMAIN').toLowerCase()}`,
    password,
  });
  if (signInError || !signIn.session) throw new Error(`Sign-in failed: ${signInError?.message ?? 'no session'}`);
  if (signIn.user.app_metadata?.seed !== SEED_TAG) throw new Error(`${LIKER} is not seed-tagged; refusing.`);

  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    results.push([name, ok, detail]);
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  };

  try {
    const { error: likeError } = await client.from('likes').insert({ user_id: liker.id, post_id: post.id });
    if (likeError) throw new Error(`like failed: ${likeError.message}`);
    const { error: rpcError } = await client.rpc('create_or_refresh_like_notification', { p_post_id: post.id });
    if (rpcError) throw new Error(`notification RPC failed: ${rpcError.message}`);
    check('like creates exactly one like notification', (await likeNotificationCount()) === 1, `${await likeNotificationCount()} found`);

    const { error: unlikeError } = await client.from('likes').delete().eq('user_id', liker.id).eq('post_id', post.id);
    if (unlikeError) throw new Error(`unlike failed: ${unlikeError.message}`);
    const { count: likeLeft } = await admin.from('likes').select('user_id', { count: 'exact', head: true }).eq('user_id', liker.id).eq('post_id', post.id);
    check('unlike removes the like', (likeLeft ?? 0) === 0, `${likeLeft ?? 0} left`);
    check('unlike removes its like notification (trigger)', (await likeNotificationCount()) === 0, `${await likeNotificationCount()} left`);
    check('non-like notifications of liker and author unchanged', (await snapshot()) === before, 'same ids before and after');
  } finally {
    // Leave staging as found, even if a step failed.
    await client.from('likes').delete().eq('user_id', liker.id).eq('post_id', post.id);
    await client.auth.signOut({ scope: 'local' });
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log('');
  console.log(failed ? `${failed} check(s) FAILED.` : 'Trigger verified on staging.');
  if (failed) process.exitCode = 1;
}

runMain(main);

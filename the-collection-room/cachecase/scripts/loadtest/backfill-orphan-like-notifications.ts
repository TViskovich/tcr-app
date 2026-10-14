/// <reference types="node" />
// STAGING ONLY — one-off cleanup of orphan like notifications left by the
// unlike bug that 20261020120000_delete_like_notification_on_unlike.sql
// fixes going forward. Not part of any migration; run only with explicit
// approval, after that migration is applied.
//
//   node scripts/loadtest/backfill-orphan-like-notifications.ts --dry-run
//   node scripts/loadtest/backfill-orphan-like-notifications.ts --delete --confirm=ickqkzvqddkhqyxnbzox
//   (add --include-non-synthetic to also remove orphans involving accounts
//    that are not seed-tagged load-test users)
//
// Deletion criteria — a notification is removed only if ALL hold:
//   - type = 'like' and post_id IS NOT NULL;
//   - there is NO likes row with user_id = notification.actor_id AND
//     post_id = notification.post_id (re-checked immediately before delete);
//   - by default: BOTH actor_id and user_id are seed-tagged synthetic
//     accounts (app_metadata.seed = loadtest-v1).
// Every other notification — comment, follow, message, rating, transfer,
// and any like notification whose like still exists — is never selected.

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunks, fetchAllPages, type Row } from './seed-lib.ts';
import { SEED_TAG, STAGING_PROJECT_REF, createAdminClient, loadStagingConfig, runMain } from './staging.ts';

async function syntheticUserIds(admin: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Listing users failed: ${error.message}`);
    for (const u of data.users) if (u.app_metadata?.seed === SEED_TAG) ids.add(u.id);
    if (data.users.length < 200) return ids;
  }
}

async function findOrphans(admin: SupabaseClient): Promise<Row[]> {
  const notifications = await fetchAllPages((from, to) =>
    admin.from('notifications').select('id, user_id, actor_id, post_id, created_at').eq('type', 'like').not('post_id', 'is', null).order('id').range(from, to),
  );
  const liked = new Set<string>();
  for (const postIds of chunks([...new Set(notifications.map((n) => n.post_id as string))], 100)) {
    const likes = await fetchAllPages((from, to) => admin.from('likes').select('user_id, post_id').in('post_id', postIds).order('post_id').order('user_id').range(from, to));
    for (const l of likes) liked.add(`${l.user_id}|${l.post_id}`);
  }
  return notifications.filter((n) => !liked.has(`${n.actor_id}|${n.post_id}`));
}

async function main() {
  const args = process.argv.slice(2);
  const modes = ['--dry-run', '--delete'].filter((m) => args.includes(m));
  if (modes.length !== 1) throw new Error('Pass exactly one of --dry-run or --delete.');
  if (modes[0] === '--delete' && !args.includes(`--confirm=${STAGING_PROJECT_REF}`)) {
    throw new Error(`--delete removes data: add --confirm=${STAGING_PROJECT_REF} to proceed.`);
  }
  const includeNonSynthetic = args.includes('--include-non-synthetic');

  const config = loadStagingConfig();
  console.log(`Target project: ${config.ref} (staging) — ${modes[0]}${includeNonSynthetic ? ', including non-synthetic accounts' : ''}`);
  const admin = createAdminClient(config);
  const synthetic = await syntheticUserIds(admin);

  const orphans = await findOrphans(admin);
  const isSynthetic = (n: Row) => synthetic.has(n.actor_id as string) && synthetic.has(n.user_id as string);
  const selected = orphans.filter((n) => includeNonSynthetic || isSynthetic(n));
  console.log('');
  console.log(`  orphan like notifications: ${orphans.length} (${orphans.filter(isSynthetic).length} between synthetic accounts, ${orphans.length - orphans.filter(isSynthetic).length} involving other accounts)`);
  console.log(`  selected for deletion:     ${selected.length}`);
  for (const n of selected) console.log(`    ${n.id}  actor ${n.actor_id} → recipient ${n.user_id}  post ${n.post_id}  ${n.created_at}`);

  if (modes[0] === '--dry-run') {
    console.log('');
    console.log('Dry run only — nothing was deleted.');
    return;
  }

  // Re-check right before deleting: a like created since the scan keeps its
  // notification.
  const recheck = new Set((await findOrphans(admin)).map((n) => n.id as string));
  const toDelete = selected.filter((n) => recheck.has(n.id as string)).map((n) => n.id as string);
  for (const ids of chunks(toDelete, 100)) {
    const { error } = await admin.from('notifications').delete().in('id', ids).eq('type', 'like');
    if (error) throw new Error(`Deleting notifications failed: ${error.message}`);
  }
  const left = (await findOrphans(admin)).filter((n) => includeNonSynthetic || isSynthetic(n)).length;
  console.log('');
  console.log(`Deleted ${toDelete.length}. Remaining in scope: ${left}.`);
  if (left) process.exitCode = 1;
}

runMain(main);

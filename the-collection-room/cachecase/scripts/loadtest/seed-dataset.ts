/// <reference types="node" />
// Full load-test dataset for CacheCase STAGING: lt_user_01 … lt_user_NN.
//
//   node scripts/loadtest/seed-dataset.ts --users 5 --dry-run   offline: counts, exact image bytes,
//                                                                request estimate; no network, no config
//   node scripts/loadtest/seed-dataset.ts --users 5 --verify    read-only: expected vs actual
//   node scripts/loadtest/seed-dataset.ts --users 5 --seed      write missing data, then verify
//   (--users 30 for the full beta-sized dataset)
//
// Per user: 5 folders — 3 top-level public, 1 public nested in the first,
// 1 private top-level "LT Private Vault" — 25 sports cards (20 public, the 5
// in the vault private), 38 generated JPEGs (every card has one, every
// other card a second), real uploaded covers on "LT Showcase" (public) and
// the vault (private), first_card covers elsewhere, and 5 posts from the
// last 21 days (3 Share Cards of 2 public cards each, 2 text posts).
// Socially: each user follows 6–10 others, likes most of their posts,
// comments on a few, and has text conversations (8–20 messages) with 2–4
// others.
//
// The pilot data (seed-pilot.ts / pilot-plan.ts) is included as-is: the
// pilot plan is merged FIRST and both use the same keys, so lt_user_01/02's
// existing folders, items, posts and conversation are reused, never
// duplicated. Their pilot folders were created with the app-invalid cover
// state (cover_source 'upload', no file); this seed fixes exactly those
// rows (see seed-lib.ts applyFolderCoverFixes).
//
// Safety: staging-only config (staging.ts); every account must carry
// app_metadata.seed = loadtest-v1; buckets are checked, never created; the
// plan is validated in memory (ownership, nesting, public-only Share Cards,
// a Storage object behind every image row, feed-window dates) before any
// write; and a hard budget stops the run if uploads would exceed
// MAX_UPLOAD_BYTES or MAX_OBJECTS. Uploads skip objects that already exist.
// No email, invitation or auth call is made; messages create in-app
// notification rows through the existing trigger only.
//
// Cleanup: every row is owned by or keyed to a seed-tagged account, ids are
// reproducible UUIDv5s, and every Storage file name contains SEED_TAG.

import { MAX_USERS, buildFullPlan, usernamesFor } from './dataset-plan.ts';
import {
  assertNoForeignConversations,
  describePlan,
  loadSeedUsers,
  missingBuckets,
  offlinePublicUrl,
  seedId,
  seedPlan,
  validatePlan,
  verifyPlan,
  type Plan,
  type PublicUrl,
  type SeedUser,
} from './seed-lib.ts';
import { createAdminClient, loadStagingConfig, runMain } from './staging.ts';

// Hard stop for --seed (staging is on the Free plan: 1 GB Storage).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_OBJECTS = 2000;

function parseArgs() {
  const args = process.argv.slice(2);
  const modes = ['--dry-run', '--verify', '--seed'].filter((m) => args.includes(m));
  if (modes.length !== 1) throw new Error('Pass exactly one of --dry-run (offline), --verify (read-only) or --seed.');

  const inline = args.find((a) => a.startsWith('--users='));
  const raw = inline ? inline.slice('--users='.length) : args[args.indexOf('--users') + 1];
  const users = Number(raw);
  if (!args.some((a) => a === '--users' || a.startsWith('--users=')) || !Number.isInteger(users) || users < 2 || users > MAX_USERS) {
    throw new Error(`Pass --users N with N between 2 and ${MAX_USERS} (e.g. --users 5 or --users 30).`);
  }
  return { mode: modes[0], users };
}

function assertValid(plan: Plan, users: SeedUser[], publicUrl: PublicUrl, now: number) {
  const problems = validatePlan(plan, users, publicUrl, now);
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.error(`  invalid: ${p}`);
    throw new Error(`Plan failed validation (${problems.length} problem(s)); nothing was written.`);
  }
  console.log('  plan validation: ownership, nesting, Share Card privacy, Storage objects and post dates OK');
}

async function main() {
  const { mode, users: userCount } = parseArgs();
  const usernames = usernamesFor(userCount);
  const now = Date.now();

  if (mode === '--dry-run') {
    // Fully offline: placeholder ids (paths differ from the real run; counts
    // and bytes do not). No config is read and nothing is contacted.
    console.log(`Dry run for ${userCount} users (offline — no Supabase project contacted)`);
    const users = usernames.map((username, index) => ({ username, id: seedId(`dry-run-user/${username}`), n: username.slice(-2), index }));
    const plan = buildFullPlan(users, offlinePublicUrl, now);
    assertValid(plan, users, offlinePublicUrl, now);
    const { totalBytes } = describePlan(plan);
    const overBudget = totalBytes > MAX_UPLOAD_BYTES || plan.uploads.length > MAX_OBJECTS;
    console.log('');
    console.log(overBudget ? 'Over the seed budget — --seed would refuse.' : 'Within the seed budget (50 MB, 2,000 objects).');
    console.log('Totals include the existing pilot rows; --seed writes only what is missing.');
    return;
  }

  const config = loadStagingConfig();
  console.log(`Target project: ${config.ref} (staging) — ${mode}, ${userCount} users`);
  const admin = createAdminClient(config);

  const missing = await missingBuckets(admin);
  if (missing.length) {
    // Reported, never created.
    throw new Error(`Missing Storage bucket(s): ${missing.join(', ')}. Create them via migrations first.`);
  }

  const users = await loadSeedUsers(admin, usernames);
  const publicUrl: PublicUrl = (bucket, path) => admin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  const plan = buildFullPlan(users, publicUrl, now);
  assertValid(plan, users, publicUrl, now);

  if (mode === '--seed') {
    const { totalBytes } = describePlan(plan);
    if (totalBytes > MAX_UPLOAD_BYTES || plan.uploads.length > MAX_OBJECTS) {
      throw new Error('Planned uploads exceed the seed budget (50 MB / 2,000 objects); nothing was written.');
    }
    await assertNoForeignConversations(admin, plan);
    console.log('');
    console.log('Seeding (only missing rows and objects)…');
    await seedPlan(admin, plan, now);
  }

  const complete = await verifyPlan(admin, plan, now);
  if (mode === '--seed' && !complete) process.exitCode = 1;
}

runMain(main);

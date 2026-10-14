/// <reference types="node" />
// Pilot data seed for the CacheCase STAGING load test — two synthetic users
// only (lt_user_01, lt_user_02). For the full 5/30-user dataset, which
// includes this pilot data, use seed-dataset.ts.
//
// Modes (exactly one is required):
//   node scripts/loadtest/seed-pilot.ts --verify    read-only: expected vs actual counts
//   node scripts/loadtest/seed-pilot.ts --seed      write the pilot data, then verify
//   node scripts/loadtest/seed-pilot.ts --preview   write the placeholder JPEGs to a
//                                                   local temp folder; no network at all
//
// Per pilot user: 3 top-level folders + 1 nested folder, 10 public sports
// cards spread across them, one generated JPEG per item in `item-images`
// (with its collection_item_images row), and 3 feed posts in the last 30
// days (2 Share Card posts of 2 cards each, with snapshots in
// `share-snapshots`, and 1 text post). Between the two users: mutual
// follows, likes and comments on each other's posts, and one conversation
// with 10 text messages. The plan itself lives in pilot-plan.ts.
//
// Idempotent: every row id is a UUIDv5 derived from SEED_TAG + a stable
// key, inserts are ON CONFLICT DO NOTHING (existing rows are never
// updated), and Storage objects at fixed paths are uploaded only if
// missing. The one deliberate update: a seed post that has aged past ~25
// days is moved back to its planned date, so the data stays in the feed's
// rolling 30-day window.
//
// Tracking for cleanup: everything is owned by (or keyed to) the two
// seed-tagged accounts, ids are reproducible from pilot-plan.ts, and every
// Storage object's file name contains SEED_TAG.
//
// Notifications: each seeded message fires the existing
// messages_create_message_notification trigger, which inserts an in-app
// notifications row for the recipient. Nothing external — no email, no push
// — exists in that path. Likes/comments/follows are inserted directly, so
// their notification RPCs are not called.

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PILOT_ITEMS_PER_USER, PILOT_USERNAMES, buildPilotPlan } from './pilot-plan.ts';
import { assertNoForeignConversations, loadSeedUsers, missingBuckets, seedPlan, verifyPlan } from './seed-lib.ts';
import { createAdminClient, loadStagingConfig, runMain } from './staging.ts';
import { renderPlaceholderCard } from './synthetic-jpeg.ts';

function preview() {
  const dir = join(tmpdir(), 'cachecase-loadtest-preview');
  mkdirSync(dir, { recursive: true });
  for (const [index, username] of PILOT_USERNAMES.entries()) {
    const n = username.slice(-2);
    for (let i = 0; i < PILOT_ITEMS_PER_USER; i++) {
      const label = `${n}-${String(i + 1).padStart(2, '0')}`;
      writeFileSync(join(dir, `${label}.jpg`), renderPlaceholderCard(label, index * PILOT_ITEMS_PER_USER + i));
    }
  }
  console.log(`Wrote ${PILOT_USERNAMES.length * PILOT_ITEMS_PER_USER} placeholder JPEGs to ${dir}`);
}

async function main() {
  const modes = ['--verify', '--seed', '--preview'].filter((m) => process.argv.includes(m));
  if (modes.length !== 1) {
    throw new Error('Pass exactly one of --verify (read-only), --seed, or --preview (local images only).');
  }
  if (modes[0] === '--preview') return preview();

  const config = loadStagingConfig();
  console.log(`Target project: ${config.ref} (staging) — mode ${modes[0]}`);
  const admin = createAdminClient(config);

  const missing = await missingBuckets(admin);
  if (missing.length) {
    // Reported, never created.
    throw new Error(`Missing Storage bucket(s): ${missing.join(', ')}. Create them via migrations first.`);
  }

  const users = await loadSeedUsers(admin, PILOT_USERNAMES);
  const publicUrl = (bucket: string, path: string) => admin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  const now = Date.now();
  const plan = buildPilotPlan(users, publicUrl, now);

  if (modes[0] === '--seed') {
    await assertNoForeignConversations(admin, plan);
    console.log('Seeding pilot data…');
    await seedPlan(admin, plan, now);
  }

  const complete = await verifyPlan(admin, plan, now);
  if (modes[0] === '--seed' && !complete) process.exitCode = 1;
}

runMain(main);

/// <reference types="node" />
// Unit tests for the Stack feed window (30 → 90 days) and the guarantees
// around it. Run: node --test lib/stack-feed-window.test.ts
//
// The window helpers are pure and tested directly. The query wiring in
// app/(tabs)/index.tsx and lib/home-tab-activity.ts imports React Native, so
// it is checked at source level: both must use the shared window, and the
// Stack query must keep its post types, ordering and paging and add nothing
// that would bypass RLS.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isWithinStackWindow,
  sortPostsByCreatedAtDesc,
  STACK_PAGE_SIZE,
  stackPageRange,
  STACK_WINDOW_DAYS,
  STACK_WINDOW_MS,
  stackWindowStartIso,
} from './stack-feed-window.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ago = (days: number, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString();

// ── The window ────────────────────────────────────────────────────────────
test('the Stack window is 90 days, and the millisecond value is derived from it', () => {
  assert.equal(STACK_WINDOW_DAYS, 90);
  assert.equal(STACK_WINDOW_MS, 90 * DAY);
  assert.equal(stackWindowStartIso(NOW), '2026-08-18T12:00:00.000Z');
});

test('posts within 90 days qualify (including the boundary instant)', () => {
  for (const days of [0, 1, 7, 29, 30, 31, 60, 89]) assert.ok(isWithinStackWindow(ago(days), NOW), `${days} days old`);
  assert.ok(isWithinStackWindow(ago(90), NOW), 'exactly 90 days: included (created_at >= window start)');
});

test('posts older than 90 days do not qualify', () => {
  assert.equal(isWithinStackWindow(ago(90, 1), NOW), false, '90 days + 1 ms');
  for (const days of [91, 120, 365]) assert.equal(isWithinStackWindow(ago(days), NOW), false, `${days} days old`);
  assert.equal(isWithinStackWindow('not a date', NOW), false);
});

test('a post 31–90 days old, previously outside the 30-day window, now qualifies', () => {
  assert.ok(isWithinStackWindow(ago(45), NOW));
});

// ── Paging and ordering (unchanged) ───────────────────────────────────────
test('pagination stays 20 posts per page with the same inclusive ranges', () => {
  assert.equal(STACK_PAGE_SIZE, 20);
  assert.deepEqual(stackPageRange(0), { from: 0, to: 19 });
  assert.deepEqual(stackPageRange(1), { from: 20, to: 39 });
  assert.deepEqual(stackPageRange(4), { from: 80, to: 99 });
});

test('ordering stays newest first by the post record\'s created_at, malformed last, input untouched', () => {
  const input = [
    { id: 'old', created_at: ago(80) },
    { id: 'none', created_at: null },
    { id: 'new', created_at: ago(0) },
    { id: 'mid', created_at: ago(40) },
  ];
  const copy = structuredClone(input);
  assert.deepEqual(sortPostsByCreatedAtDesc(input).map((p) => p.id), ['new', 'mid', 'old', 'none']);
  assert.deepEqual(input, copy, 'does not mutate');
});

// ── Wiring: feed and activity dot share one duration ──────────────────────
const feed = src('app/(tabs)/index.tsx');
const activity = src('lib/home-tab-activity.ts');
const queryFeed = feed.slice(feed.indexOf('async function queryFeed'), feed.indexOf('// Home\'s three tabs'));

test('the Stack feed and the activity dot both filter by the shared window start', () => {
  assert.match(feed, /from '@\/lib\/stack-feed-window'/);
  assert.match(activity, /from '@\/lib\/stack-feed-window'/);
  assert.match(queryFeed, /\.gte\('created_at', windowStart\)/);
  assert.match(queryFeed, /const windowStart = stackWindowStartIso\(\);/);
  assert.match(activity, /\.gte\('created_at', stackWindowStartIso\(\)\)/);
});

test('no local window duration remains in either file (nothing to drift)', () => {
  for (const [name, text] of [['index.tsx', feed], ['home-tab-activity.ts', activity]] as const) {
    assert.doesNotMatch(text, /24 \* 60 \* 60 \* 1000/, `${name}: no inline day arithmetic`);
    assert.doesNotMatch(text, /STACK_WINDOW_MS\s*=/, `${name}: no local window constant`);
    assert.doesNotMatch(text, /sevenDaysAgo/, `${name}: misleading name gone`);
  }
});

test('the Stack query keeps all seven post types, newest-first order and 20-per-page range', () => {
  assert.match(queryFeed, /\.in\('post_type', \[\.\.\.FEED_POST_TYPES\]\)/);
  assert.match(queryFeed, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(queryFeed, /\.range\(from, to\)/);
  assert.match(queryFeed, /stackPageRange\(page\)/);
  assert.match(queryFeed, /return sortPostsByCreatedAtDesc\(posts\);/);
  assert.match(feed, /const PAGE_SIZE = STACK_PAGE_SIZE;/);
  const types = src('components/feed/post-card.tsx').match(/export const FEED_POST_TYPES = \[([^\]]*)\]/);
  assert.ok(types);
  assert.deepEqual(
    types[1].split(',').map((s) => s.trim().replace(/'/g, '')),
    ['item', 'text', 'rate_my_grails', 'card_share', 'folder_share', 'repost', 'quote'],
  );
});

// ── Visibility restrictions are untouched ─────────────────────────────────
test('the Stack query still goes through the RLS-bound app client with no extra filters', () => {
  // The window adds a created_at bound only; block, moderation and
  // hidden-account rules are restrictive RLS on public.posts.
  assert.match(queryFeed, /await supabase\s*\n\s*\.from\('posts'\)/);
  const filters = queryFeed.match(/\.(eq|neq|in|gte|lte|gt|lt|or|not|is|filter|match)\(/g) ?? [];
  assert.deepEqual(filters, ['.in(', '.gte('], 'only the post-type and window filters');
  assert.match(src('lib/supabase.ts'), /createClient\(supabaseUrl, supabaseAnonKey/);
  assert.doesNotMatch(feed + activity, /service_role|SERVICE_ROLE/);
});

test('the posts RLS restrictions are still defined in the migrations', () => {
  const dir = join(ROOT, 'supabase/migrations');
  const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.match(all, /CREATE POLICY user_block_read_guard ON public\.posts AS RESTRICTIVE FOR SELECT/, 'block guard');
  assert.match(all, /'posts',\s+'NOT private\.account_is_hidden\(user_id\)'/, 'hidden-account guard');
  assert.match(all, /\('posts', format\('NOT COALESCE\(id = ANY/, 'moderation guard');
});

// ── Out of scope: other post surfaces have no window ──────────────────────
test('profile Posts history and direct post links stay unwindowed', () => {
  const card = src('components/feed/post-card.tsx');
  const userPosts = card.slice(card.indexOf('export async function fetchUserPosts'), card.indexOf('function formatAge'));
  assert.doesNotMatch(userPosts, /\.(gte|gt|lte|lt)\('created_at'/, 'profile history: no created_at filter');
  assert.doesNotMatch(userPosts, /stack-feed-window|stackWindowStartIso/);
  assert.doesNotMatch(src('app/post/[id].tsx'), /stackWindowStartIso|\.gte\('created_at'/, 'direct link: by id only');
});

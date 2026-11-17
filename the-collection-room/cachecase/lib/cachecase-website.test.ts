/// <reference types="node" />
// Unit tests for the app's cachecase.com page links (Dashboard → How
// CacheCase Works). Run: node --test lib/cachecase-website.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CACHECASE_FEATURES_URL, CACHECASE_WEBSITE_ORIGIN } from './cachecase-website.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = readFileSync(join(ROOT, 'app/(tabs)/dashboard.tsx'), 'utf8');

test('the Features page is https://cachecase.com/features', () => {
  assert.equal(CACHECASE_WEBSITE_ORIGIN, 'https://cachecase.com');
  assert.equal(CACHECASE_FEATURES_URL, 'https://cachecase.com/features');
  assert.equal(new URL(CACHECASE_FEATURES_URL).protocol, 'https:');
});

test('the Dashboard links How CacheCase Works to the shared URL through the in-app browser', () => {
  assert.match(dashboard, /from '@\/lib\/cachecase-website'/);
  assert.match(dashboard, /onPress=\{\(\) => openUrl\(CACHECASE_FEATURES_URL\)\}/);
  assert.match(dashboard, /<Text style=\{styles\.navRowTitle\}>How CacheCase Works<\/Text>/);
  assert.match(dashboard, /<Text style=\{styles\.navRowDetail\}>Explore features and guides<\/Text>/);
  // openUrl = expo-web-browser (Done returns to the app) with a failure alert.
  assert.match(dashboard, /await WebBrowser\.openBrowserAsync\(url\);\s*\} catch \{\s*Alert\.alert\('Couldn’t open link'/);
});

test('the URL is not duplicated anywhere in the Dashboard', () => {
  assert.doesNotMatch(dashboard, /cachecase\.com\/features/);
});

test('the old in-app guides accordion is gone (no internal knowledge-base navigation left)', () => {
  assert.doesNotMatch(dashboard, /GUIDES|openGuide|guideHeader/);
});

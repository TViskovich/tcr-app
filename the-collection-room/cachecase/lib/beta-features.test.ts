/// <reference types="node" />
// Unit tests for the release-scope switch (Release Readiness R2).
// Run: node --test lib/beta-features.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BETA_FEATURES, FEATURE_ROUTES, hiddenNotificationTypes, isExcludedPath, TRANSFER_NOTIFICATION_TYPES } from './beta-features.ts';

test('first-submission scope: Registry, Transfers, Group Messaging and Figurine creation are off', () => {
  assert.deepEqual(BETA_FEATURES, { registry: false, transfers: false, groupMessaging: false, figurineItems: false });
});

test('every route of an excluded feature is refused, in every link form', () => {
  const id = '6f1c2a3e-1111-4222-8333-944445555666';
  for (const seg of [...FEATURE_ROUTES.registry, ...FEATURE_ROUTES.transfers, ...FEATURE_ROUTES.groupMessaging]) {
    for (const link of [
      `/${seg}/${id}`,
      `${seg}/${id}`,
      `cachecase://${seg}/${id}`,
      `cachecase:///${seg}/${id}`,
      `cachecase-preview://${seg}/${id}?x=1#y`,
      `exp://192.168.1.20:8081/--/${seg}/${id}`,
      `https://cachecase.app/${seg}/${id}`,
      `/${seg.toUpperCase()}/${id}`,
      `/${encodeURIComponent(seg)}/${id}`,
    ]) {
      assert.equal(isExcludedPath(link), true, link);
    }
  }
});

test('everything in scope still opens', () => {
  for (const link of [
    '/', '/(tabs)', '/item/abc', '/post/abc', '/conversation/abc', '/user/sam', '/account/delete', '/account/export',
    '/admin/reports', '/admin/report/abc', 'cachecase://item/abc', 'cachecase://conversation/abc',
    'exp://192.168.1.20:8081/--/item/abc', 'https://cachecase.app/post/abc',
    '/registryx/abc', '/my-registry', '/item/registry', // only the exact first segment matters
  ]) {
    assert.equal(isExcludedPath(link), false, link);
  }
});

test('a malformed escape is refused rather than guessed', () => {
  assert.equal(isExcludedPath('/%E0%A4%A/abc'), true);
});

test('transfer notifications are hidden while transfers are out of scope', () => {
  assert.deepEqual(hiddenNotificationTypes(), [...TRANSFER_NOTIFICATION_TYPES]);
});

/// <reference types="node" />
// Unit tests for the global tab bar's navigation (pre-build-23 tap fix), run
// against the INSTALLED Expo Router stack router, so a router upgrade that
// changes these semantics fails here.
// Run: node --test lib/global-tab-navigation.test.ts
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { GLOBAL_TAB_HREF, GLOBAL_TAB_METHOD } from './global-tab-navigation.ts';

const require = createRequire(import.meta.url);
// The pure core router Expo Router's root Stack delegates REPLACE / POP_TO to
// (its own override only intercepts PUSH / NAVIGATE / PRELOAD).
const { StackRouter } = require('expo-router/build/react-navigation/routers/StackRouter');

type Route = { key: string; name: string; params?: Record<string, unknown> };
const routeNames = ['(tabs)', 'post/[id]', 'item/[id]'];
const options = { routeNames, routeParamList: {}, routeGetIdList: {} };

// A collector on a stack screen: the tabs underneath, then a post and an item.
function rootState() {
  return {
    type: 'stack',
    key: 'root',
    index: 2,
    stale: false,
    routeNames,
    preloadedRoutes: [],
    routes: [
      { key: 'tabs-original', name: '(tabs)', params: { screen: 'index' } },
      { key: 'post-1', name: 'post/[id]', params: { id: '1' } },
      { key: 'item-1', name: 'item/[id]', params: { id: '2' } },
    ] as Route[],
  };
}
const act = (state: ReturnType<typeof rootState>, type: string, screen: string) =>
  StackRouter({}).getStateForAction(state, { type, target: 'root', payload: { name: '(tabs)', params: { screen } } }, options);
const tabsCount = (s: { routes: Route[] }) => s.routes.filter((r) => r.name === '(tabs)').length;

test('the global bar returns to the existing tabs with dismissTo', () => {
  assert.equal(GLOBAL_TAB_METHOD, 'dismissTo');
});

test('every global-bar destination lives inside the (tabs) group', () => {
  assert.deepEqual(Object.keys(GLOBAL_TAB_HREF).sort(), ['dashboard', 'index', 'messages', 'profile', 'search']);
  assert.equal(GLOBAL_TAB_HREF.index, '/');
  assert.equal(GLOBAL_TAB_HREF.profile, '/(tabs)/profile');
});

test('dismissTo (POP_TO) reuses the ONE mounted tabs navigator and selects the tab', () => {
  for (const screen of ['index', 'profile', 'dashboard']) {
    const next = act(rootState(), 'POP_TO', screen);
    assert.equal(next.routes.length, 1, `${screen}: the stack screens above the tabs are dismissed`);
    assert.equal(next.routes[0].key, 'tabs-original', `${screen}: the existing tabs navigator is reused, not remounted`);
    assert.deepEqual(next.routes[0].params, { screen }, `${screen}: the nested tab navigator is told which tab to show`);
    assert.equal(next.index, 0);
  }
});

test('a repeated (rapid) tap stays on the same single tabs navigator', () => {
  const once = act(rootState(), 'POP_TO', 'profile');
  const twice = StackRouter({}).getStateForAction(once, { type: 'POP_TO', target: 'root', payload: { name: '(tabs)', params: { screen: 'profile' } } }, options);
  assert.equal(tabsCount(twice), 1);
  assert.equal(twice.routes[0].key, 'tabs-original');
});

test('regression: the old replace() mounted a SECOND tabs navigator and kept the first', () => {
  const next = act(rootState(), 'REPLACE', 'profile');
  assert.equal(tabsCount(next), 2, 'replace leaves the original tabs underneath and adds a new one');
  assert.notEqual(next.routes[next.index].key, 'tabs-original', 'the visible tabs are a fresh, unmounted instance');
});

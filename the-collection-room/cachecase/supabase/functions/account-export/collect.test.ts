// Unit tests for imageRef (Download My Data, posts.json image references).
// Run: deno test --no-lock supabase/functions/account-export/collect.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1';

import { accountMetadata, collectData, dmPhotoName, EXPORTED_NOTIFICATION_TYPES, hiddenAccounts, imageRef } from './collect.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HOST = 'https://ref.supabase.co/storage/v1/object';
const owned = new Map([
  [`share-snapshots/${ME}/post-upload/a b.jpg`, 'media/share-snapshots/post-upload/a b.jpg'],
  [`item-images/${ME}/item/photo.jpg`, 'media/item-images/item/photo.jpg'],
]);

Deno.test('nothing referenced → unavailable', () => {
  for (const v of [null, undefined, '', '   ', 42]) assertEquals(imageRef(v, ME, owned), { status: 'unavailable', file: null, url: null });
});

Deno.test('own public file in the archive → included, URL-encoded path decoded', () => {
  assertEquals(imageRef(`${HOST}/public/share-snapshots/${ME}/post-upload/a%20b.jpg`, ME, owned), {
    status: 'included', file: 'media/share-snapshots/post-upload/a b.jpg', url: `${HOST}/public/share-snapshots/${ME}/post-upload/a%20b.jpg`,
  });
});

Deno.test('own signed private file → included, token never kept', () => {
  const r = imageRef(`${HOST}/sign/item-images/${ME}/item/photo.jpg?token=abc.def.ghi`, ME, owned);
  assertEquals(r, { status: 'included', file: 'media/item-images/item/photo.jpg', url: `${HOST}/sign/item-images/${ME}/item/photo.jpg` });
});

Deno.test('own file that no longer exists → unavailable', () => {
  assertEquals(imageRef(`${HOST}/public/share-snapshots/${ME}/gone.jpg`, ME, owned), { status: 'unavailable', file: null, url: null });
});

Deno.test('another collector: public file → not_included with url; private file → url dropped', () => {
  assertEquals(imageRef(`${HOST}/public/share-snapshots/${OTHER}/x.jpg?v=1`, ME, owned),
    { status: 'not_included', file: null, url: `${HOST}/public/share-snapshots/${OTHER}/x.jpg` });
  assertEquals(imageRef(`${HOST}/sign/item-images/${OTHER}/x.jpg?token=t`, ME, owned), { status: 'not_included', file: null, url: null });
  assertEquals(imageRef(`${HOST}/public/registry-images/card/x.jpg`, ME, owned), { status: 'not_included', file: null, url: null });
});

Deno.test('own path in a bucket the export does not include → not_included, url dropped', () => {
  assertEquals(imageRef(`${HOST}/sign/dm-attachments/${ME}/x.jpg?token=t`, ME, owned), { status: 'not_included', file: null, url: null });
});

Deno.test('outside https address → not_included, kept as stored', () => {
  assertEquals(imageRef('https://images.example.org/a.jpg?w=200', ME, owned), { status: 'not_included', file: null, url: 'https://images.example.org/a.jpg?w=200' });
});

Deno.test('bare storage path: own exported file → included; own missing → unavailable; anything else hidden', () => {
  assertEquals(imageRef(`${ME}/item/photo.jpg`, ME, owned), { status: 'included', file: 'media/item-images/item/photo.jpg', url: null });
  assertEquals(imageRef(`${ME}/nope.jpg`, ME, owned), { status: 'unavailable', file: null, url: null });
  assertEquals(imageRef(`${OTHER}/item/photo.jpg`, ME, owned), { status: 'not_included', file: null, url: null });
});

Deno.test('non-http schemes and malformed encodings are never copied', () => {
  assertEquals(imageRef('file:///Users/me/a.jpg', ME, owned), { status: 'not_included', file: null, url: null });
  assertEquals(imageRef('data:image/png;base64,AAAA', ME, owned), { status: 'not_included', file: null, url: null });
  assertEquals(imageRef(`${HOST}/public/share-snapshots/${ME}/%E0%A4%A.jpg`, ME, owned), { status: 'not_included', file: null, url: null });
});

// ── accountMetadata (account/profile.json "account" sign-in facts) ──
const EMPTY = { email_confirmed_at: null, last_sign_in_at: null, phone: null, phone_confirmed_at: null, sign_in_methods: [], two_step_verification: [] };

Deno.test('account metadata: no auth record → every field null or empty', () => {
  assertEquals(accountMetadata(null), EMPTY);
  assertEquals(accountMetadata(undefined), EMPTY);
  assertEquals(accountMetadata({}), EMPTY);
});

Deno.test('account metadata: only safe facts survive a full auth record', () => {
  const full = {
    id: OTHER, aud: 'authenticated', role: 'authenticated', email: 'a@example.test', encrypted_password: '$2a$10$hash',
    email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-02-01T00:00:00Z', phone: '15550100', phone_confirmed_at: '2026-01-02T00:00:00Z',
    confirmation_token: 'TOKEN-CONFIRM', recovery_token: 'TOKEN-RECOVERY', email_change_token_new: 'TOKEN-EMAIL', banned_until: null,
    app_metadata: { provider: 'email', providers: ['email', 'apple', 'Bad Provider!', 7], fixture: 'x' },
    user_metadata: { username: 'u', secret_note: 's' },
    identities: [{ identity_data: { sub: 'x', email: 'a@example.test' }, provider: 'email' }],
    factors: [{ id: 'f1', friendly_name: 'My phone', factor_type: 'totp', status: 'verified', created_at: '2026-03-01T00:00:00Z', secret: 'FACTOR-SECRET' }],
  };
  const out = accountMetadata(full as never);
  assertEquals(out, {
    email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-02-01T00:00:00Z', phone: '15550100', phone_confirmed_at: '2026-01-02T00:00:00Z',
    sign_in_methods: ['email', 'apple'],
    two_step_verification: [{ type: 'totp', status: 'verified', added_at: '2026-03-01T00:00:00Z' }],
  });
  const text = JSON.stringify(out);
  for (const leak of ['$2a$', 'TOKEN-', 'identity', 'f1', 'My phone', 'FACTOR-SECRET', 'secret', 'fixture', 'authenticated', OTHER]) assertEquals(text.includes(leak), false, leak);
});

Deno.test('account metadata: legacy single provider; empty phone string is null', () => {
  assertEquals(accountMetadata({ app_metadata: { provider: 'email' }, phone: '' }).sign_in_methods, ['email']);
  assertEquals(accountMetadata({ phone: '', phone_confirmed_at: '2026-01-01T00:00:00Z' }).phone_confirmed_at, null);
});

// ── Sent DM photos ──
Deno.test('a sent DM photo is named by its message id only (no conversation id, no stored path)', () => {
  const msg = '33333333-3333-4333-8333-333333333333';
  assertEquals(dmPhotoName(msg), `media/dm-attachments/${msg}.jpg`);
});

Deno.test('a DM photo path never resolves as a post image (separate from owned media)', () => {
  const conv = '44444444-4444-4444-8444-444444444444';
  const dm = `${HOST}/sign/dm-attachments/${conv}/55555555-5555-4555-8555-555555555555/image.jpg?token=t`;
  assertEquals(imageRef(dm, ME, owned), { status: 'not_included', file: null, url: null });
});

// ── Fail-closed visibility and the notification allow-list ──────────────
// collectData()/hiddenAccounts() run against an in-memory fake client: the
// real exporter code, with the database's answers controlled per test.
const U = ME;
const O = OTHER; // a visible-or-not other collector
const P = '66666666-6666-4666-8666-666666666666'; // a pending-deletion collector
const O_NAME = 'OTHER_COLLECTOR_NAME';
const P_NAME = 'PENDING_COLLECTOR_NAME';
type FakeRow = Record<string, unknown>;
type Lifecycle = 'ok' | 'error' | 'missing_table' | 'undefined_table' | 'no_data';

function fakeClient(opts: { lifecycle?: Lifecycle; visibility?: 'ok' | 'error'; pending?: string[]; notifications?: FakeRow[] } = {}) {
  const lifecycle = opts.lifecycle ?? 'ok';
  const tables: Record<string, FakeRow[]> = {
    profiles: [{ id: U, username: 'me_user' }, { id: O, username: O_NAME }, { id: P, username: P_NAME }],
    account_lifecycle: (opts.pending ?? []).map((id) => ({ user_id: id, state: 'pending_deletion' })),
    follows: [{ follower_id: O, following_id: U, created_at: '2026-01-01T00:00:00Z' }, { follower_id: P, following_id: U, created_at: '2026-01-01T00:00:01Z' }],
    posts: [{ id: 'p-other', user_id: O }],
    likes: [{ user_id: U, post_id: 'p-other', created_at: '2026-01-02T00:00:00Z' }],
    saved_grails: [{ user_id: U, owner_id: O, created_at: '2026-01-03T00:00:00Z' }],
    collection_items: [{ id: 'i-other', user_id: O }, { id: 'i-mine', user_id: U, title: 'mine' }],
    collection_item_tags: [
      { item_id: 'i-other', tagged_user_id: U, tagged_by: O, created_at: '2026-01-04T00:00:00Z' },
      { item_id: 'i-mine', tagged_user_id: O, tagged_by: U, created_at: '2026-01-05T00:00:00Z' },
    ],
    notifications: opts.notifications ?? [
      { id: 'n1', user_id: U, actor_id: O, type: 'follow', read: false, created_at: '2026-01-06T00:00:00Z' },
      { id: 'n2', user_id: U, actor_id: O, type: 'item_tag', item_id: 'i-other', read: false, created_at: '2026-01-07T00:00:00Z' },
    ],
    conversations: [{ id: 'c1', created_at: '2026-01-08T00:00:00Z', last_message_at: '2026-01-09T00:00:00Z' }],
    conversation_participants: [{ conversation_id: 'c1', user_id: U }, { conversation_id: 'c1', user_id: O }],
    messages: [{ id: 'm1', conversation_id: 'c1', sender_id: U, body: 'hi', created_at: '2026-01-08T00:00:00Z' }],
  };
  const lifecycleError: Record<string, { code: string; message: string } | null> = {
    ok: null, no_data: null,
    error: { code: 'XX000', message: 'lookup failed' },
    missing_table: { code: 'PGRST205', message: "Could not find the table 'public.account_lifecycle'" },
    undefined_table: { code: '42P01', message: 'relation "account_lifecycle" does not exist' },
  };
  const calls: { table: string; inSize: number }[] = [];
  const query = (table: string) => {
    const filters: ((r: FakeRow) => boolean)[] = [];
    let range: [number, number] | null = null;
    let inSize = 0;
    const result = () => {
      if (table === 'account_lifecycle') {
        calls.push({ table, inSize });
        if (lifecycleError[lifecycle]) return { data: null, error: lifecycleError[lifecycle] };
        if (lifecycle === 'no_data') return { data: null, error: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: rows, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b, order: () => b, limit: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      in: (c: string, v: unknown[]) => ((inSize = v.length), filters.push((r) => v.includes(r[c])), b),
      range: (f: number, t: number) => ((range = [f, t]), b),
      maybeSingle: () => Promise.resolve({ data: ((result().data ?? []) as FakeRow[])[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return b;
  };
  const client = {
    from: query,
    rpc: (name: string, args?: { p_user_ids?: string[] }) => {
      // Phase 2B M3: hidden accounts (pending deletion or suspended) come from
      // the account_hidden_ids RPC, with the same failure modes as the table.
      if (name === 'account_hidden_ids') {
        const ids = args?.p_user_ids ?? [];
        calls.push({ table: 'account_lifecycle', inSize: ids.length });
        if (lifecycleError[lifecycle]) return Promise.resolve({ data: null, error: lifecycleError[lifecycle] });
        if (lifecycle === 'no_data') return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: tables.account_lifecycle.map((r) => r.user_id as string).filter((id) => ids.includes(id)), error: null });
      }
      return Promise.resolve(
        name === '_item_visible_to' || name === '_folder_visible_to'
          ? (opts.visibility === 'error' ? { data: null, error: { code: 'XX000', message: 'boom' } } : { data: true, error: null })
          : { data: null, error: { code: 'PGRST202', message: 'unknown rpc' } });
    },
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: { id: U, email: 'u@example.test', created_at: '2026-01-01T00:00:00Z' } } }) } },
  };
  return { client: client as never, calls };
}
const run = async (opts: Parameters<typeof fakeClient>[0]) => {
  const r = await collectData(fakeClient(opts).client, U, []);
  return { r, t: Object.fromEntries(r.files.map((f) => [f.name, new TextDecoder().decode(f.bytes)])) };
};
const quiet = async <T>(fn: () => Promise<T>) => { // the lookup logs its failure; keep test output clean
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

Deno.test('hiddenAccounts: successful lookup returns exactly the lifecycle accounts', async () => {
  assertEquals(await hiddenAccounts(fakeClient({ pending: [P] }).client, [O, P]), new Set([P]));
  assertEquals(await hiddenAccounts(fakeClient().client, [O]), new Set());
  assertEquals(await hiddenAccounts(fakeClient({ lifecycle: 'error' }).client, []), new Set()); // nothing to check, no query
});

Deno.test('hiddenAccounts: every failure — error, missing table (PGRST205 / 42P01), no data — returns null', async () => {
  for (const lifecycle of ['error', 'missing_table', 'undefined_table', 'no_data'] as const) {
    assertEquals(await quiet(() => hiddenAccounts(fakeClient({ lifecycle }).client, [O])), null, lifecycle);
  }
});

Deno.test('hiddenAccounts: long lists are checked in chunks', async () => {
  const fake = fakeClient();
  const ids = Array.from({ length: 450 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assertEquals(await hiddenAccounts(fake.client, ids), new Set());
  assertEquals(fake.calls.map((c) => c.inSize), [200, 200, 50]);
});

Deno.test('export, lookup succeeds: a visible collector is named; a pending one is not', async () => {
  const { t } = await run({ pending: [P] });
  const followers = JSON.parse(t['social/followers.json']);
  assertEquals(followers.collectors.map((c: FakeRow) => c.username), [O_NAME]);
  assertEquals(followers.unavailable_accounts, 1);
  const all = Object.values(t).join('\n');
  assert(!all.includes(P_NAME) && !all.includes(P), 'the pending collector is never named or identified');
  assertEquals(JSON.parse(t['activity/saved.json']).grails_showcases[0].target_username, O_NAME);
});

for (const lifecycle of ['error', 'missing_table', 'undefined_table', 'no_data'] as const) {
  Deno.test(`export, lookup fails (${lifecycle}): no other collector is named or identified anywhere`, async () => {
    const { t } = await quiet(() => run({ lifecycle }));
    const all = Object.values(t).join('\n');
    for (const leak of [O_NAME, P_NAME, O, P]) assert(!all.includes(leak), `${lifecycle}: ${leak} leaked`);
    assertEquals(JSON.parse(t['social/followers.json']).unavailable_accounts, 2);
    assertEquals(JSON.parse(t['activity/likes.json']).posts[0].target_status, 'unavailable');
    const tags = JSON.parse(t['activity/tags.json']);
    assertEquals(tags.tags_created[0].tagged_collector_status, 'unavailable');
    assertEquals(tags.tags_received[0].tagged_by_username, null);
    for (const n of JSON.parse(t['notifications/notifications.json'])) assertEquals(n.actor_status, 'unavailable');
    assertEquals(JSON.parse(t['messages/conversations.json'])[0].other_participants, [{ username: null, status: 'unavailable' }]);
    assertEquals(JSON.parse(t['messages/sent_messages.json'])[0].to_usernames, [null]);
    // Own references stay: the collector's own item id in their own tag.
    assertEquals(tags.tags_created[0].target_id, 'i-mine');
  });
}

Deno.test('export, visibility RPC fails: tags and tag notifications on others’ content are withheld, only counted', async () => {
  const { r, t } = await run({ visibility: 'error' });
  assertEquals(JSON.parse(t['activity/tags.json']).tags_received.length, 0);
  assertEquals(r.withheld.tags_received_not_visible_omitted, 1);
  assert(!JSON.parse(t['notifications/notifications.json']).some((n: FakeRow) => n.type === 'item_tag'));
  assertEquals(r.withheld.notifications_not_visible_content, 1);
  assert(!t['activity/tags.json'].includes('i-other') && !t['notifications/notifications.json'].includes('i-other'));
});

Deno.test('notifications: an allow-list of released types; unreleased and unknown types are only counted', async () => {
  assertEquals([...EXPORTED_NOTIFICATION_TYPES].sort(), ['comment', 'folder_tag', 'follow', 'grail_rating', 'item_tag', 'like', 'message']);
  const n = (id: string, type: string, extra: FakeRow = {}) => ({ id, user_id: U, actor_id: O, type, read: false, created_at: `2026-02-01T00:00:0${id.length}Z`, ...extra });
  const { r, t } = await run({
    notifications: [
      n('a', 'follow'), n('bb', 'like', { post_id: 'p1' }), n('ccc', 'grail_rating', { post_id: 'p1', rating_score: 7 }),
      n('d', 'ownership_transfer_requested', { transfer_id: 'tr-1', registered_card_id: 'rc-1' }),
      n('e', 'ownership_transfer_accepted'),
      n('f', 'group_invite', { conversation_id: 'g-1' }), // unknown / future type
      n('g', 'registry_claim'), // unknown / future type
    ],
  });
  const notes = JSON.parse(t['notifications/notifications.json']);
  assertEquals(notes.map((x: FakeRow) => x.type).sort(), ['follow', 'grail_rating', 'like']);
  assertEquals([r.withheld.notifications_unreleased_features, r.withheld.notifications_other_types], [2, 2]);
  for (const leak of ['ownership_transfer', 'tr-1', 'rc-1', 'group_invite', 'g-1', 'registry_claim', 'transfer_id', 'registered_card_id']) {
    assert(!t['notifications/notifications.json'].includes(leak), leak);
  }
  assertEquals(r.counts.notifications, 3);
});

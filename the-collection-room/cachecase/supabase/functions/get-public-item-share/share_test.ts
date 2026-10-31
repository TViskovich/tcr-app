// Unit tests for get-public-item-share's pure request/response shaping.
// Run: deno test supabase/functions/get-public-item-share/share_test.ts
// The authorization matrix itself is tested in SQL, against
// resolve_public_item_share (supabase/tests/database/public_item_share.test.sql).

import { assertEquals } from 'jsr:@std/assert@1';

import { parseShareRequest, shareableImageType, toPublicItemShare, type ResolvedShareRow } from './share.ts';

const ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';

Deno.test('parseShareRequest: metadata by default, preview_image on request', () => {
  assertEquals(parseShareRequest({ item_id: ID }), { itemId: ID, asset: 'metadata' });
  assertEquals(parseShareRequest({ item_id: ID, asset: 'metadata' }), { itemId: ID, asset: 'metadata' });
  assertEquals(parseShareRequest({ item_id: ID, asset: 'preview_image' }), { itemId: ID, asset: 'preview_image' });
});

Deno.test('parseShareRequest: trims and lowercases the id', () => {
  assertEquals(parseShareRequest({ item_id: `  ${ID.toUpperCase()} ` }), { itemId: ID, asset: 'metadata' });
});

Deno.test('parseShareRequest: rejects anything that is not exactly an item UUID', () => {
  for (const body of [
    null,
    'x',
    [ID],
    {},
    { item_id: '' },
    { item_id: 123 },
    { item_id: 'not-a-uuid' },
    { item_id: `${ID}/../x` },
    { item_id: 'CC-375X-X37T' },
    { item_id: ID, asset: 'original' },
    { item_id: ID, asset: 'detail' },
    { image_ids: [ID] },
  ]) {
    assertEquals(parseShareRequest(body), null, JSON.stringify(body));
  }
});

const ROW: ResolvedShareRow = {
  item_type: 'pokemon',
  title: 'Charizard',
  subtitle: 'Base Set · #4/102',
  owner_username: 'ash',
  owner_display_name: 'Ash K',
  image_storage_path: '00000000-0000-4000-8000-000000000001/items/abc.jpg',
};

Deno.test('toPublicItemShare: returns exactly the approved fields', () => {
  assertEquals(toPublicItemShare(ROW, true), {
    item_type: 'pokemon',
    title: 'Charizard',
    subtitle: 'Base Set · #4/102',
    owner: { username: 'ash', display_name: 'Ash K' },
    has_image: true,
  });
});

Deno.test('toPublicItemShare: never includes the storage path or unknown row fields', () => {
  const row = { ...ROW, description: 'private notes', estimated_value: 1200, user_id: 'u', image_id: 'i' };
  const json = JSON.stringify(toPublicItemShare(row as ResolvedShareRow, true));
  for (const leaked of ['abc.jpg', 'storage', '00000000-0000-4000-8000-000000000001', 'private notes', '1200', 'user_id', 'image_id']) {
    assertEquals(json.includes(leaked), false, leaked);
  }
});

Deno.test('toPublicItemShare: no image and no owner profile degrade cleanly', () => {
  assertEquals(
    toPublicItemShare({ ...ROW, image_storage_path: null, owner_username: null, owner_display_name: null }, false),
    { item_type: 'pokemon', title: 'Charizard', subtitle: 'Base Set · #4/102', owner: null, has_image: false },
  );
});

Deno.test('shareableImageType: only jpeg/png/webp, parameters stripped', () => {
  assertEquals(shareableImageType('image/jpeg'), 'image/jpeg');
  assertEquals(shareableImageType('IMAGE/PNG; charset=binary'), 'image/png');
  assertEquals(shareableImageType('image/webp'), 'image/webp');
  for (const type of [null, '', 'image/heic', 'image/svg+xml', 'text/html', 'application/json']) {
    assertEquals(shareableImageType(type), null, String(type));
  }
});

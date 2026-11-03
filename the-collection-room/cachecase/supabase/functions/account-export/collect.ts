// Collects one collector's data for their export (service role). Every
// query is scoped to rows the collector OWNS or that point at them; nothing
// of another collector is read beyond their public username where a
// relationship needs it (follows, conversation partners). Other collectors'
// message content, private collections and items are never read.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { hiddenAccountIds } from '../_shared/registry-image.ts';

const encoder = new TextEncoder();
const PAGE = 1000;
const ID_CHUNK = 200;

export type DataFile = { name: string; bytes: Uint8Array };
export type OwnedObject = { bucket: string; path: string; size: number; archiveName: string };

// Archive path of an owned Storage object: media/<bucket>/<path after the
// collector's own folder>.
export const mediaName = (userId: string, bucket: string, path: string) =>
  `media/${bucket}/${path.slice(userId.length + 1)}`;

type Row = Record<string, unknown>;

async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`collect_failed: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function fetchByIds(client: SupabaseClient, table: string, column: string, ids: string[], select = '*'): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    rows.push(...(await fetchAll((from, to) => client.from(table).select(select).in(column, chunk).range(from, to))));
  }
  return rows;
}

const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2) + '\n');

function csv(headers: string[], rows: Row[]): Uint8Array {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))];
  // BOM so spreadsheet apps read UTF-8 (accents, Pokémon) correctly.
  return encoder.encode('﻿' + lines.join('\r\n') + '\r\n');
}

const DETAIL_TABLES: Record<string, string> = {
  trading_card_details: 'trading_card',
  pokemon_card_details: 'pokemon',
  comic_book_details: 'comic_book',
  other_item_details: 'other',
};

export async function collectData(
  client: SupabaseClient,
  userId: string,
  owned: OwnedObject[],
): Promise<{ files: DataFile[]; counts: Record<string, number> }> {
  const ownedPaths = new Map<string, string>(); // "bucket/path" -> archive name
  for (const o of owned) ownedPaths.set(`${o.bucket}/${o.path}`, o.archiveName);
  const media = (bucket: string, path: unknown) =>
    typeof path === 'string' && path ? (ownedPaths.get(`${bucket}/${path}`) ?? null) : null;

  // ── Account ──
  const { data: authUser } = await client.auth.admin.getUserById(userId);
  const { data: profile, error: profileError } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (profileError) throw new Error(`collect_failed: ${profileError.message}`);

  // ── Collections ──
  const folders = await fetchAll((f, t) => client.from('folders').select('*').eq('user_id', userId).order('created_at').order('id').range(f, t));
  const folderById = new Map(folders.map((f) => [f.id as string, f]));
  const pathOf = (id: string): { path: string; effectivelyPublic: boolean } => {
    const names: string[] = [];
    let isPublic = true;
    const seen = new Set<string>();
    let at: Row | undefined = folderById.get(id);
    while (at && !seen.has(at.id as string)) {
      seen.add(at.id as string);
      names.unshift(String(at.name ?? ''));
      if (at.is_public === false) isPublic = false;
      at = at.parent_folder_id ? folderById.get(at.parent_folder_id as string) : undefined;
    }
    return { path: names.join(' / '), effectivelyPublic: isPublic };
  };

  // ── Items and every category's metadata ──
  const items = await fetchAll((f, t) => client.from('collection_items').select('*').eq('user_id', userId).order('created_at').order('id').range(f, t));
  const itemIds = items.map((i) => i.id as string);
  const details = new Map<string, Record<string, Row>>();
  for (const table of [...Object.keys(DETAIL_TABLES), 'collection_item_private_details']) {
    for (const row of await fetchByIds(client, table, 'item_id', itemIds)) {
      const { item_id, ...rest } = row;
      const entry = details.get(item_id as string) ?? {};
      entry[table] = rest;
      details.set(item_id as string, entry);
    }
  }
  const images = await fetchAll((f, t) => client.from('collection_item_images').select('*').eq('user_id', userId).order('item_id').order('sort_order').range(f, t));
  const imagesByItem = new Map<string, Row[]>();
  for (const img of images) {
    const list = imagesByItem.get(img.item_id as string) ?? [];
    list.push(img);
    imagesByItem.set(img.item_id as string, list);
  }
  const itemCounts = new Map<string, number>();
  for (const i of items) itemCounts.set(i.folder_id as string, (itemCounts.get(i.folder_id as string) ?? 0) + 1);

  const collectionsJson = folders.map((f) => {
    const { path, effectivelyPublic } = pathOf(f.id as string);
    return {
      id: f.id,
      parent_id: f.parent_folder_id ?? null,
      path,
      name: f.name,
      is_public: f.is_public,
      effectively_public: effectivelyPublic,
      description: f.description ?? null,
      collection_type: f.collection_type ?? null,
      genre: f.genre ?? null,
      collection_year: f.collection_year ?? null,
      color: f.color ?? null,
      sort_order: f.sort_order ?? null,
      item_count: itemCounts.get(f.id as string) ?? 0,
      cover_item_id: f.cover_item_id ?? null,
      cover_file: media('item-images', f.cover_storage_path),
      created_at: f.created_at,
    };
  });

  const itemsJson = items.map((i) => {
    const folder = pathOf(i.folder_id as string);
    const d = details.get(i.id as string) ?? {};
    const privateDetails = d.collection_item_private_details as Row | undefined;
    const categoryDetails = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'collection_item_private_details'));
    return {
      id: i.id,
      collection_id: i.folder_id,
      collection_path: folder.path,
      title: i.title,
      item_type: i.item_type ?? null,
      is_public: i.is_public,
      collection_status: i.collection_status,
      year: i.year ?? null,
      brand: i.brand ?? null,
      player: i.player ?? null,
      team: i.team ?? null,
      grade: i.grade ?? null,
      grading_company: i.grading_company ?? null,
      serial_number: i.serial_number ?? null,
      estimated_value: i.estimated_value ?? null,
      purchase_price: privateDetails?.purchase_price ?? null,
      description: i.description ?? null,
      category_details: categoryDetails,
      photos: (imagesByItem.get(i.id as string) ?? []).map((img) => ({
        file: media('item-images', img.storage_path),
        is_primary: img.is_primary,
        sort_order: img.sort_order,
      })),
      created_at: i.created_at,
      transferred_out_at: i.transferred_out_at ?? null,
    };
  });

  // Flattened category columns for the CSV: every field that appears.
  const detailColumns = new Set<string>();
  for (const it of itemsJson) {
    for (const [table, row] of Object.entries(it.category_details)) {
      for (const k of Object.keys(row as Row)) {
        if (!['created_at', 'updated_at', 'search_identifier_normalized'].includes(k)) detailColumns.add(`${DETAIL_TABLES[table]}.${k}`);
      }
    }
  }
  const itemCsvBase = ['id', 'collection_id', 'collection_path', 'title', 'item_type', 'is_public', 'collection_status', 'year', 'brand',
    'player', 'team', 'grade', 'grading_company', 'serial_number', 'estimated_value', 'purchase_price', 'description', 'created_at'];
  const itemCsvDetail = [...detailColumns].sort();
  const itemCsvRows = itemsJson.map((it) => {
    const row: Row = { ...it, photo_files: it.photos.map((p) => p.file).filter(Boolean).join('; ') };
    for (const [table, d] of Object.entries(it.category_details)) {
      for (const [k, v] of Object.entries(d as Row)) row[`${DETAIL_TABLES[table]}.${k}`] = v;
    }
    return row;
  });

  // ── Grails ──
  const grails = await fetchAll((f, t) => client.from('profile_grail_slots').select('*').eq('user_id', userId).order('slot_index').range(f, t));
  const itemTitle = new Map(items.map((i) => [i.id as string, i.title]));
  const grailsJson = grails.map((g) => ({
    position: (g.slot_index as number) + 1,
    type: g.entry_type,
    item_id: g.item_id ?? null,
    item_title: g.item_id ? (itemTitle.get(g.item_id as string) ?? null) : null,
    collection_id: g.collection_id ?? null,
    collection_name: g.collection_id ? (folderById.get(g.collection_id as string)?.name ?? null) : null,
    added_at: g.created_at,
  }));

  // ── Posts (own) and comments (own) ──
  const posts = await fetchAll((f, t) => client.from('posts').select('*').eq('user_id', userId).order('created_at').range(f, t));
  const postIds = posts.map((p) => p.id as string);
  const postImages = await fetchByIds(client, 'post_images', 'post_id', postIds);
  const postsJson = posts.map((p) => ({
    id: p.id,
    type: p.post_type,
    content: p.content ?? null,
    caption: p.caption ?? null,
    item_id: p.item_id ?? null,
    collection_id: p.folder_id ?? null,
    reposted_post_id: p.repost_of_post_id ?? null,
    quoted_post_id: p.quote_of_post_id ?? null,
    images: postImages.filter((pi) => pi.post_id === p.id).map((pi) => ({ item_id: pi.item_id ?? null, url: pi.image_url })),
    created_at: p.created_at,
  }));
  const commentSets: [string, string, string][] = [
    ['comments', 'post', 'post_id'],
    ['item_comments', 'item', 'item_id'],
    ['folder_comments', 'collection', 'folder_id'],
    ['gallery_comments', 'collection_gallery', 'folder_id'],
  ];
  const commentsJson: Row[] = [];
  for (const [table, on, column] of commentSets) {
    const rows = await fetchAll((f, t) => client.from(table).select('*').eq('user_id', userId).order('created_at').range(f, t));
    for (const c of rows) commentsJson.push({ id: c.id, on, target_id: c[column], body: c.body, created_at: c.created_at });
  }

  // ── Messages: only what the collector SENT ──
  const sent = await fetchAll((f, t) => client.from('messages')
    .select('id, conversation_id, body, attachment_type, attachment_item_id, created_at')
    .eq('sender_id', userId).order('created_at').order('id').range(f, t));
  const convIds = [...new Set(sent.map((m) => m.conversation_id as string))];
  const participants = await fetchByIds(client, 'conversation_participants', 'conversation_id', convIds, 'conversation_id, user_id');

  // ── Follows: public usernames only ──
  const followers = await fetchAll((f, t) => client.from('follows').select('follower_id, created_at').eq('following_id', userId).range(f, t));
  const following = await fetchAll((f, t) => client.from('follows').select('following_id, created_at').eq('follower_id', userId).range(f, t));

  const otherIds = [...new Set([
    ...followers.map((r) => r.follower_id as string),
    ...following.map((r) => r.following_id as string),
    ...participants.map((r) => r.user_id as string).filter((id) => id !== userId),
  ])];
  const hidden = (await hiddenAccountIds(client, otherIds)) ?? new Set(otherIds);
  const usernames = new Map<string, string>();
  for (const p of await fetchByIds(client, 'profiles', 'id', otherIds.filter((id) => !hidden.has(id)), 'id, username')) {
    usernames.set(p.id as string, p.username as string);
  }
  const name = (id: string) => usernames.get(id) ?? null; // null: account unavailable or deleted

  const conversationPartners = new Map<string, (string | null)[]>();
  for (const p of participants) {
    if (p.user_id === userId) continue;
    const list = conversationPartners.get(p.conversation_id as string) ?? [];
    list.push(name(p.user_id as string));
    conversationPartners.set(p.conversation_id as string, list);
  }
  const sentJson = sent.map((m) => ({
    id: m.id,
    conversation_id: m.conversation_id,
    to_usernames: conversationPartners.get(m.conversation_id as string) ?? [],
    body: m.body ?? null,
    attachment: m.attachment_type ? { type: m.attachment_type, item_id: m.attachment_item_id ?? null } : null,
    sent_at: m.created_at,
  }));
  const followList = (rows: Row[], column: string) => {
    const visible = rows.filter((r) => name(r[column] as string));
    return {
      collectors: visible.map((r) => ({ username: name(r[column] as string), since: r.created_at })),
      unavailable_accounts: rows.length - visible.length,
    };
  };

  const profileJson = {
    account: {
      id: userId,
      email: authUser?.user?.email ?? null,
      created_at: authUser?.user?.created_at ?? null,
    },
    profile: profile ?? null,
    photos: owned.filter((o) => o.bucket === 'avatars').map((o) => o.archiveName),
  };

  const files: DataFile[] = [
    { name: 'account/profile.json', bytes: json(profileJson) },
    { name: 'collections/collections.json', bytes: json(collectionsJson) },
    {
      name: 'collections/collections.csv',
      bytes: csv(['id', 'parent_id', 'path', 'name', 'is_public', 'effectively_public', 'description', 'collection_type', 'genre',
        'collection_year', 'color', 'sort_order', 'item_count', 'cover_item_id', 'cover_file', 'created_at'], collectionsJson as Row[]),
    },
    { name: 'items/items.json', bytes: json(itemsJson) },
    { name: 'items/items.csv', bytes: csv([...itemCsvBase, ...itemCsvDetail, 'photo_files'], itemCsvRows) },
    { name: 'grails/grails.json', bytes: json(grailsJson) },
    { name: 'posts/posts.json', bytes: json(postsJson) },
    { name: 'comments/comments.json', bytes: json(commentsJson) },
    { name: 'messages/sent_messages.json', bytes: json(sentJson) },
    { name: 'social/followers.json', bytes: json(followList(followers, 'follower_id')) },
    { name: 'social/following.json', bytes: json(followList(following, 'following_id')) },
  ];
  return {
    files,
    counts: {
      collections: folders.length,
      items: items.length,
      item_photos: images.length,
      grails: grails.length,
      posts: posts.length,
      comments: commentsJson.length,
      sent_messages: sent.length,
      followers: followers.length,
      following: following.length,
    },
  };
}

export const README = (generatedAt: string) => `CacheCase — your data
Generated ${generatedAt}

account/profile.json         Your account email, profile and profile photos
collections/collections.*    Your collections (JSON and CSV). "path" shows nesting; parent_id links to the parent collection
items/items.*                Your items with all category details and photo file names (JSON and CSV)
grails/grails.json           Your Top 9 Grails by position
posts/posts.json             Your posts
comments/comments.json       Comments you wrote
messages/sent_messages.json  Messages you sent (messages you received belong to their senders and are not included)
social/                      Collectors you follow and who follow you (public usernames)
media/                       Your original photos
manifest.json                What this archive contains

CSV files are UTF-8 and open in spreadsheet apps.
`;

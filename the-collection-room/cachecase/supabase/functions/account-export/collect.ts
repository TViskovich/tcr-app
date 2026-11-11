// Collects one collector's data for their export (service role). Every
// query is scoped to rows the collector OWNS or that point at them; nothing
// of another collector is read beyond their public username where a
// relationship needs it (follows, conversation partners). Other collectors'
// message content, private collections and items are never read.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';


const encoder = new TextEncoder();
const PAGE = 1000;
const ID_CHUNK = 200;

export type DataFile = { name: string; bytes: Uint8Array };
export type OwnedObject = { bucket: string; path: string; size: number; archiveName: string };
// A photo the collector sent in a direct message (export_sent_message_attachments).
export type DmPhoto = OwnedObject & { messageId: string };
// Its archive name comes from the message id only — never from the stored
// path — so it can't carry a conversation id or any path trick.
export const dmPhotoName = (messageId: string) => `media/dm-attachments/${messageId}.jpg`;

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

// Collectors hidden from everyone else: pending deletion, being deleted, or
// (Phase 2B M3) suspended — exactly private.account_is_hidden, via the
// service-role-only account_hidden_ids RPC.
// Export-local and strict: ANY failure — an error, a missing or inaccessible
// table, no data — returns null, and hiddenOrAll then treats EVERY other
// collector as hidden, so no one is ever named because a check could not run.
// (The shared registry helper treats a missing table as "nobody hidden"; the
// export deliberately does not use it.) Chunked, so a long follower list
// can't fail on request size.
export async function hiddenAccounts(client: SupabaseClient, userIds: string[]): Promise<Set<string> | null> {
  const ids = [...new Set(userIds)];
  const hidden = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await client.rpc('account_hidden_ids', { p_user_ids: ids.slice(i, i + ID_CHUNK) });
    if (error || !Array.isArray(data)) {
      console.error('[account-export] visibility lookup failed:', error?.code ?? 'no_data');
      return null;
    }
    for (const id of data as string[]) hidden.add(id);
  }
  return hidden;
}
const hiddenOrAll = async (client: SupabaseClient, userIds: string[]) => (await hiddenAccounts(client, userIds)) ?? new Set(userIds);

// An image referenced by one of the collector's posts, described honestly:
//   included      file = the archive entry (media/…) that is in this export
//   not_included  a reference to something that isn't the collector's own
//                 file (another collector's or an outside address); url is
//                 kept only when it is public, never a private storage path
//   unavailable   nothing referenced, or the collector's own file no longer
//                 exists (e.g. removed when its source was deleted)
// Storage URLs are matched to the collector's own exported objects; signed-
// URL tokens are never copied into the archive.
export type ImageRef = { status: 'included' | 'not_included' | 'unavailable'; file: string | null; url: string | null };
const EXPORTED_BUCKETS = ['avatars', 'item-images', 'share-snapshots'];
const PUBLIC_BUCKETS = ['avatars', 'share-snapshots'];
const STORAGE_URL = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/;

export function imageRef(url: unknown, userId: string, owned: Map<string, string>): ImageRef {
  if (typeof url !== 'string' || !url.trim()) return { status: 'unavailable', file: null, url: null };
  const value = url.trim();
  const own = (bucket: string, path: string) => owned.get(`${bucket}/${path}`) ?? null;
  const m = value.match(STORAGE_URL);
  if (m) {
    const bucket = m[1];
    let path: string;
    try {
      path = decodeURIComponent(m[2]);
    } catch {
      return { status: 'not_included', file: null, url: null };
    }
    const bare = value.split(/[?#]/)[0];
    if (path.startsWith(`${userId}/`) && EXPORTED_BUCKETS.includes(bucket)) {
      const file = own(bucket, path);
      return file ? { status: 'included', file, url: bare } : { status: 'unavailable', file: null, url: null };
    }
    return { status: 'not_included', file: null, url: PUBLIC_BUCKETS.includes(bucket) ? bare : null };
  }
  if (/^https?:\/\//i.test(value)) return { status: 'not_included', file: null, url: value };
  // A bare storage path (no bucket): only ever matched against the
  // collector's own exported files; anything else is not exposed.
  if (value.startsWith(`${userId}/`)) {
    for (const bucket of EXPORTED_BUCKETS) {
      const file = own(bucket, value);
      if (file) return { status: 'included', file, url: null };
    }
    return { status: 'unavailable', file: null, url: null };
  }
  return { status: 'not_included', file: null, url: null };
}

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

// The collector's own likes, saves and Grail ratings (activity/*.json).
type TargetClass = { target_owner: 'you' | 'other_collector' | null; target_status: 'available' | 'unavailable' };

async function collectActivity(client: SupabaseClient, userId: string) {
  const mine = (table: string, select: string, column: string, tiebreak: string) =>
    fetchAll((f, t) => client.from(table).select(select).eq(column, userId).order('created_at').order(tiebreak).range(f, t));
  const likedPosts = await mine('likes', 'post_id, created_at', 'user_id', 'post_id');
  const likedItems = await mine('item_likes', 'item_id, created_at', 'user_id', 'item_id');
  const likedCollections = await mine('folder_likes', 'folder_id, created_at', 'user_id', 'folder_id');
  const savedItems = await mine('saved_cards', 'item_id, created_at', 'user_id', 'item_id');
  const savedCollections = await mine('saved_folders', 'folder_id, created_at', 'user_id', 'folder_id');
  const savedGrails = await mine('saved_grails', 'owner_id, created_at', 'user_id', 'owner_id');
  const ratings = await mine('grail_ratings', 'post_id, score, created_at, updated_at', 'rater_user_id', 'post_id');

  // Owner of each target (to classify it only; never exported).
  const ownersOf = async (table: string, ids: unknown[]) => {
    const owner = new Map<string, string>();
    for (const r of await fetchByIds(client, table, 'id', [...new Set(ids as string[])], 'id, user_id')) owner.set(r.id as string, r.user_id as string);
    return owner;
  };
  const postOwner = await ownersOf('posts', [...likedPosts.map((r) => r.post_id), ...ratings.map((r) => r.post_id)]);
  const itemOwner = await ownersOf('collection_items', [...likedItems.map((r) => r.item_id), ...savedItems.map((r) => r.item_id)]);
  const folderOwner = await ownersOf('folders', [...likedCollections.map((r) => r.folder_id), ...savedCollections.map((r) => r.folder_id)]);
  const others = [...new Set([...postOwner.values(), ...itemOwner.values(), ...folderOwner.values(), ...savedGrails.map((r) => r.owner_id as string)])]
    .filter((id) => id !== userId);
  // Fails closed: if visibility can't be checked, every other collector is unavailable.
  const hidden = await hiddenOrAll(client, others);
  const classify = (owner: string | undefined): TargetClass =>
    !owner ? { target_owner: null, target_status: 'unavailable' }
      : owner === userId ? { target_owner: 'you', target_status: 'available' }
      : { target_owner: 'other_collector', target_status: hidden.has(owner) ? 'unavailable' : 'available' };

  const visibleGrailOwners = savedGrails.map((r) => r.owner_id as string).filter((id) => id === userId || !hidden.has(id));
  const usernames = new Map<string, string>();
  for (const p of await fetchByIds(client, 'profiles', 'id', [...new Set(visibleGrailOwners)], 'id, username')) usernames.set(p.id as string, p.username as string);

  const entries = (rows: Row[], type: string, idColumn: string, owners: Map<string, string>, at: string) =>
    rows.map((r) => ({ target_type: type, target_id: r[idColumn], ...classify(owners.get(r[idColumn] as string)), [at]: r.created_at ?? null }));

  const likes = {
    posts: entries(likedPosts, 'post', 'post_id', postOwner, 'liked_at'),
    items: entries(likedItems, 'item', 'item_id', itemOwner, 'liked_at'),
    collections: entries(likedCollections, 'collection', 'folder_id', folderOwner, 'liked_at'),
  };
  const saved = {
    items: entries(savedItems, 'item', 'item_id', itemOwner, 'saved_at'),
    collections: entries(savedCollections, 'collection', 'folder_id', folderOwner, 'saved_at'),
    // The target is a collector: identified by public username only (as in
    // social/*.json), never by account id; nothing at all when unavailable.
    grails_showcases: savedGrails.map((r) => {
      const owner = r.owner_id as string;
      const c = classify(owner);
      return { target_type: 'grails_showcase', target_username: c.target_status === 'available' ? (usernames.get(owner) ?? null) : null, ...c, saved_at: r.created_at ?? null };
    }),
  };
  const rated = {
    grail_ratings: ratings.map((r) => ({
      target_type: 'post', target_id: r.post_id, score: r.score, ...classify(postOwner.get(r.post_id as string)),
      rated_at: r.created_at ?? null, updated_at: r.updated_at ?? null,
    })),
  };
  return {
    likes,
    saved,
    ratings: rated,
    counts: {
      liked_posts: likes.posts.length, liked_items: likes.items.length, liked_collections: likes.collections.length,
      saved_items: saved.items.length, saved_collections: saved.collections.length, saved_grails_showcases: saved.grails_showcases.length,
      grail_ratings: rated.grail_ratings.length,
    },
  };
}

// Collector tagging (activity/tags.json). The tag tables
// (collection_item_tags / folder_tags) hold one row per tagged collector
// per item/collection: tagged_by is always the content's owner, tagged_user_id
// the collector tagged, and the database forbids self-tags (CHECK
// tagged_user_id <> tagged_by) — so a row is either created by the exporter
// or received by them, never both. Rows go with their item/collection and
// with either account (ON DELETE CASCADE).
//   tags_created   tagged_by = the exporter
//   tags_received  tagged_user_id = the exporter
// Another collector appears by public username only, and only while their
// account is visible. A received tag on content the exporter can't see
// (the app never shows it to them) is not listed at all — no target, tagger
// or time — only counted (receivedNotVisible), for the manifest's
// transparency note. Every check fails closed.
type TagRow = { target_type: 'item' | 'collection'; target_id: string; tagged_user_id: string; tagged_by: string; created_at: string | null };

async function collectTags(client: SupabaseClient, userId: string) {
  const read = async (column: 'tagged_by' | 'tagged_user_id') => {
    const rows: TagRow[] = [];
    for (const [table, idColumn, type] of [['collection_item_tags', 'item_id', 'item'], ['folder_tags', 'folder_id', 'collection']] as const) {
      const page = await fetchAll((f, t) => {
        let q = client.from(table).select(`${idColumn}, tagged_user_id, tagged_by, created_at`).eq(column, userId);
        // Belt and braces with the self-tag CHECK: a received tag is never also a created one.
        if (column === 'tagged_user_id') q = q.neq('tagged_by', userId);
        return q.order('created_at').order(idColumn).range(f, t);
      });
      for (const r of page) {
        rows.push({ target_type: type, target_id: r[idColumn] as string, tagged_user_id: r.tagged_user_id as string, tagged_by: r.tagged_by as string, created_at: (r.created_at as string) ?? null });
      }
    }
    return rows.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.target_type.localeCompare(b.target_type) || a.target_id.localeCompare(b.target_id));
  };
  const created = await read('tagged_by');
  const received = await read('tagged_user_id');

  const owners = new Map<string, string>(); // "type:id" -> owner (classification only)
  for (const [table, type] of [['collection_items', 'item'], ['folders', 'collection']] as const) {
    const ids = [...new Set([...created, ...received].filter((r) => r.target_type === type).map((r) => r.target_id))];
    for (const r of await fetchByIds(client, table, 'id', ids, 'id, user_id')) owners.set(`${type}:${r.id}`, r.user_id as string);
  }
  const others = [...new Set([
    ...created.map((r) => r.tagged_user_id), ...received.map((r) => r.tagged_by), ...owners.values(),
  ])].filter((id) => id !== userId);
  const hidden = await hiddenOrAll(client, others);
  const visibleOthers = others.filter((id) => !hidden.has(id));
  const usernames = new Map<string, string>();
  for (const p of await fetchByIds(client, 'profiles', 'id', visibleOthers, 'id, username')) usernames.set(p.id as string, p.username as string);
  const person = (id: string) => {
    const username = hidden.has(id) ? null : (usernames.get(id) ?? null);
    return { username, status: (username ? 'available' : 'unavailable') as 'available' | 'unavailable' };
  };
  const classify = (r: TagRow): TargetClass => {
    const owner = owners.get(`${r.target_type}:${r.target_id}`);
    return !owner ? { target_owner: null, target_status: 'unavailable' }
      : owner === userId ? { target_owner: 'you', target_status: 'available' }
      : { target_owner: 'other_collector', target_status: hidden.has(owner) ? 'unavailable' : 'available' };
  };

  // Can the exporter see this item/collection right now? Same rule as the
  // app's Tagged tab (the server-only helpers its tag notifications use).
  // An error counts as "no".
  const canSee = async (r: TagRow) => {
    const { data, error } = r.target_type === 'item'
      ? await client.rpc('_item_visible_to', { p_item_id: r.target_id, p_viewer: userId })
      : await client.rpc('_folder_visible_to', { p_folder_id: r.target_id, p_user: userId });
    return !error && data === true;
  };

  const tagsCreated = created.map((r) => {
    const tagged = person(r.tagged_user_id);
    return {
      direction: 'created', target_type: r.target_type, target_id: r.target_id, ...classify(r),
      tagged_collector_username: tagged.username, tagged_collector_status: tagged.status, tagged_at: r.created_at,
    };
  });
  const tagsReceived = [];
  let receivedNotVisible = 0;
  for (const r of received) {
    const c = classify(r);
    const tagger = person(r.tagged_by);
    if (c.target_status === 'available' && tagger.status === 'available' && !(await canSee(r))) {
      receivedNotVisible++;
      continue;
    }
    tagsReceived.push({
      direction: 'received', target_type: r.target_type, target_id: r.target_id, ...c,
      ...(tagger.status === 'unavailable' ? { target_status: 'unavailable' as const } : {}),
      tagged_by_username: tagger.username, tagged_by_status: tagger.status, tagged_at: r.created_at,
    });
  }
  return {
    tags: { tags_created: tagsCreated, tags_received: tagsReceived },
    counts: {
      tags_created: tagsCreated.length,
      tags_received: tagsReceived.length,
    },
    // Withheld, not exported (see manifest.json excluded_records).
    receivedNotVisible,
  };
}

// The collector's own waitlist signup (account/waitlist.json). The table
// has no client access at all (RLS, no policies, no grants); this reads it
// with the service role, ONLY through onboarded_user_id = the account: the
// invite this account redeemed (unique; set only by redeem_waitlist_invite;
// cleared if that account is deleted). An email address alone never links a
// signup to an account — addresses change hands — so an unredeemed signup is
// not exported to anyone, nor counted. Never exported: the row id,
// access_code (an invite-code digest) and access_code_expires_at.
export async function collectWaitlist(client: SupabaseClient, userId: string) {
  const rows = await fetchAll((f, t) => client.from('waitlist_signups')
    .select('name, email, reserved_username, status, created_at, access_granted_at, onboarded_at')
    .eq('onboarded_user_id', userId).order('created_at').range(f, t));
  return rows.map((r) => ({
    name: r.name ?? null, email: r.email ?? null, reserved_username: r.reserved_username ?? null, status: r.status ?? null,
    signed_up_at: r.created_at ?? null, access_granted_at: r.access_granted_at ?? null, onboarded_at: r.onboarded_at ?? null,
  }));
}

// Sign-in facts about the account, from Supabase Auth. Only what describes
// the collector's own account: never password hashes, identities, provider
// or session tokens, recovery/confirmation tokens or MFA secrets.
type AuthUserFull = {
  email_confirmed_at?: string | null; last_sign_in_at?: string | null; phone?: string | null; phone_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown>; factors?: { factor_type?: string; status?: string; created_at?: string }[] | null;
} | null | undefined;
export function accountMetadata(u: AuthUserFull) {
  const providers = Array.isArray(u?.app_metadata?.providers) ? u!.app_metadata!.providers as unknown[]
    : typeof u?.app_metadata?.provider === 'string' ? [u!.app_metadata!.provider] : [];
  return {
    email_confirmed_at: u?.email_confirmed_at ?? null,
    last_sign_in_at: u?.last_sign_in_at ?? null,
    phone: u?.phone ? u.phone : null,
    phone_confirmed_at: u?.phone ? (u.phone_confirmed_at ?? null) : null,
    sign_in_methods: [...new Set(providers.filter((p): p is string => typeof p === 'string' && /^[a-z0-9_]{1,32}$/.test(p)))],
    two_step_verification: (u?.factors ?? []).map((f) => ({ type: f.factor_type ?? null, status: f.status ?? null, added_at: f.created_at ?? null })),
  };
}

// The collector's notifications (notifications/notifications.json): rows
// whose recipient (user_id) is the collector — the same rows the app shows
// them. The other collector who caused one (actor) appears by public
// username only while their account is visible; otherwise the actor is
// "unavailable" with nothing identifying. Every target (post, comment,
// conversation, item, collection) and the actor's account are ON DELETE
// CASCADE, so notifications about deleted things are already gone.
// Only notification types of RELEASED features are exported (an allow-list:
// a type added later is left out until it is reviewed and added here).
// Not listed, only counted (manifest excluded_records.notifications_omitted):
//   * unreleased_features  Registry / Transfers (ownership_transfer_*);
//   * other_types          any type not on the list below;
//   * not_visible_content  a tag notification whose item/collection the
//                          collector can no longer see (as in activity/tags.json).
export const EXPORTED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'follow', 'like', 'comment', 'message', 'grail_rating', 'item_tag', 'folder_tag',
]);
const UNRELEASED_NOTIFICATION = /^ownership_transfer_/;

async function collectNotifications(client: SupabaseClient, userId: string) {
  const rows = await fetchAll((f, t) => client.from('notifications')
    .select('id, type, read, created_at, actor_id, post_id, comment_id, conversation_id, item_id, folder_id, rating_score')
    .eq('user_id', userId).order('created_at').order('id').range(f, t));
  const actors = [...new Set(rows.map((r) => r.actor_id as string))].filter((id) => id !== userId);
  const hidden = await hiddenOrAll(client, actors); // fails closed
  const usernames = new Map<string, string>();
  for (const p of await fetchByIds(client, 'profiles', 'id', actors.filter((id) => !hidden.has(id)), 'id, username')) usernames.set(p.id as string, p.username as string);
  const canSee = async (r: Row) => {
    const { data, error } = r.type === 'item_tag'
      ? await client.rpc('_item_visible_to', { p_item_id: r.item_id, p_viewer: userId })
      : await client.rpc('_folder_visible_to', { p_folder_id: r.folder_id, p_user: userId });
    return !error && data === true;
  };
  const out = [];
  let unreleased = 0;
  let otherTypes = 0;
  let notVisible = 0;
  for (const r of rows) {
    if (!EXPORTED_NOTIFICATION_TYPES.has(r.type as string)) {
      if (UNRELEASED_NOTIFICATION.test(String(r.type))) unreleased++;
      else otherTypes++;
      continue;
    }
    const actor = r.actor_id as string;
    const username = hidden.has(actor) ? null : (usernames.get(actor) ?? null);
    if ((r.type === 'item_tag' || r.type === 'folder_tag') && username && !(await canSee(r))) { notVisible++; continue; }
    out.push({
      id: r.id, type: r.type, created_at: r.created_at ?? null, read: r.read === true,
      actor_username: username, actor_status: username ? 'available' : 'unavailable',
      post_id: r.post_id ?? null, comment_id: r.comment_id ?? null, conversation_id: r.conversation_id ?? null,
      item_id: r.item_id ?? null, collection_id: r.folder_id ?? null,
      rating_score: r.type === 'grail_rating' ? (r.rating_score ?? null) : null,
    });
  }
  return { notifications: out, unreleased, otherTypes, notVisible };
}

// Conversations the collector is a participant in (messages/conversations.json):
// only the collector's own membership (last read, hidden) and the
// conversation's own dates. Other participants appear by public username
// while visible, else "unavailable"; their read/hidden state and their
// messages are never included. A direct conversation with fewer than two
// participants left (someone deleted their account) takes no new messages:
// "read_only" true — the same rule as private.reject_message_to_closed_conversation.
async function collectConversations(client: SupabaseClient, userId: string, sentByConversation: Map<string, number>) {
  const mine = await fetchAll((f, t) => client.from('conversation_participants')
    .select('conversation_id, last_read_at, hidden_at').eq('user_id', userId).order('conversation_id').range(f, t));
  const ids = mine.map((r) => r.conversation_id as string);
  const convs = new Map<string, Row>();
  for (const c of await fetchByIds(client, 'conversations', 'id', ids, 'id, created_at, last_message_at')) convs.set(c.id as string, c);
  const members = await fetchByIds(client, 'conversation_participants', 'conversation_id', ids, 'conversation_id, user_id');
  const others = [...new Set(members.map((m) => m.user_id as string))].filter((id) => id !== userId);
  const hidden = await hiddenOrAll(client, others); // fails closed
  const usernames = new Map<string, string>();
  for (const p of await fetchByIds(client, 'profiles', 'id', others.filter((id) => !hidden.has(id)), 'id, username')) usernames.set(p.id as string, p.username as string);
  const byConversation = new Map<string, string[]>();
  for (const m of members) {
    const list = byConversation.get(m.conversation_id as string) ?? [];
    list.push(m.user_id as string);
    byConversation.set(m.conversation_id as string, list);
  }
  const out = mine.map((me) => {
    const id = me.conversation_id as string;
    const c = convs.get(id);
    const participants = byConversation.get(id) ?? [];
    const otherUsers = participants.filter((u) => u !== userId).map((u) => {
      const username = hidden.has(u) ? null : (usernames.get(u) ?? null);
      return { username, status: username ? 'available' : 'unavailable' };
    });
    return {
      conversation_id: id, created_at: c?.created_at ?? null, last_activity_at: c?.last_message_at ?? null,
      your_last_read_at: me.last_read_at ?? null, hidden_by_you: me.hidden_at != null, hidden_at: me.hidden_at ?? null,
      other_participants: otherUsers, read_only: participants.length < 2,
      messages_you_sent: sentByConversation.get(id) ?? 0,
    };
  }).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.conversation_id.localeCompare(b.conversation_id));
  return out;
}

export async function collectData(
  client: SupabaseClient,
  userId: string,
  owned: OwnedObject[],
  dmPhotos: DmPhoto[] = [],
): Promise<{ files: DataFile[]; counts: Record<string, number>; withheld: { tags_received_not_visible_omitted: number; notifications_unreleased_features: number; notifications_other_types: number; notifications_not_visible_content: number } }> {
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
  // Everything stored on the collector's own posts: the post row, its photos
  // (post_images), and the item snapshots attached to card-share,
  // collection-share and Rate-My-Grails posts. Only the posts' own rows are
  // read — never the referenced items, collections or posts of others.
  const posts = await fetchAll((f, t) => client.from('posts').select('*').eq('user_id', userId).order('created_at').order('id').range(f, t));
  const postIds = posts.map((p) => p.id as string);
  const byPost = (rows: Row[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(r.post_id as string, [...(m.get(r.post_id as string) ?? []), r]);
    return m;
  };
  const postImages = byPost(await fetchByIds(client, 'post_images', 'post_id', postIds));
  const attachedSets: [string, Map<string, Row[]>][] = [
    ['card_share', byPost(await fetchByIds(client, 'card_share_items', 'post_id', postIds))],
    ['collection_share', byPost(await fetchByIds(client, 'folder_share_items', 'post_id', postIds))],
    ['rate_my_grails', byPost(await fetchByIds(client, 'rate_my_grail_cards', 'post_id', postIds))],
  ];
  const ownItemIds = new Set(itemIds);
  const ownFolderIds = new Set(folderById.keys());
  const ref = (url: unknown) => imageRef(url, userId, ownedPaths);
  const itemStatus = (id: unknown) => (!id ? 'deleted' : ownItemIds.has(id as string) ? 'yours' : 'other_collector');
  const postsJson = posts.map((p) => {
    const attached = attachedSets.flatMap(([kind, rows]) =>
      (rows.get(p.id as string) ?? []).map((s) => ({
        kind,
        item_id: s.item_id ?? null,
        item_status: itemStatus(s.item_id),
        title: s.snapshot_title ?? null,
        subtitle: s.snapshot_subtitle ?? null,
        display_order: s.display_order ?? null,
        image: ref(s.snapshot_image_url),
        added_at: s.created_at ?? null,
      })));
    attached.sort((a, b) => (a.kind === b.kind ? Number(a.display_order ?? 0) - Number(b.display_order ?? 0) : a.kind < b.kind ? -1 : 1));
    const isCollectionShare = p.post_type === 'folder_share';
    return {
      id: p.id,
      type: p.post_type,
      content: p.content ?? null,
      caption: p.caption ?? null,
      item_id: p.item_id ?? null,
      item_status: p.item_id ? itemStatus(p.item_id) : p.post_type === 'item' ? 'deleted' : null,
      collection_id: p.folder_id ?? null,
      collection_status: p.folder_id ? (ownFolderIds.has(p.folder_id as string) ? 'yours' : 'other_collector') : isCollectionShare ? 'deleted' : null,
      collection_name: p.folder_name ?? null,
      collection_item_count: p.folder_item_count ?? null,
      collection_cover: isCollectionShare || p.folder_cover_snapshot_url ? ref(p.folder_cover_snapshot_url) : null,
      image: p.post_type === 'item' || p.image_url ? ref(p.image_url) : null,
      reposted_post_id: p.repost_of_post_id ?? null,
      quoted_post_id: p.quote_of_post_id ?? null,
      images: (postImages.get(p.id as string) ?? [])
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
        .map((pi) => ({
          sort_order: pi.sort_order ?? null,
          source_type: pi.source_type ?? null,
          item_id: pi.item_id ?? null,
          ...ref(pi.image_url),
        })),
      attached_items: attached,
      created_at: p.created_at,
    };
  });
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
  const hidden = await hiddenOrAll(client, otherIds);
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
  // Sent DM photos: the exact archive file when it is in this export, else
  // "unavailable" (e.g. the file no longer exists). Only the collector's own
  // messages are listed here, so only their own photos can be referenced.
  const dmByMessage = new Map(dmPhotos.map((d) => [d.messageId, d.archiveName]));
  const sentPhoto = (messageId: string) => {
    const file = dmByMessage.get(messageId) ?? null;
    return { status: file ? 'included' : 'unavailable', file };
  };
  const sentPhotoMessages = sent.filter((m) => m.attachment_type === 'image').length;
  const sentPhotosIncluded = sent.filter((m) => m.attachment_type === 'image' && dmByMessage.has(m.id as string)).length;
  const sentByConversation = new Map<string, number>();
  for (const m of sent) sentByConversation.set(m.conversation_id as string, (sentByConversation.get(m.conversation_id as string) ?? 0) + 1);
  const conversationsJson = await collectConversations(client, userId, sentByConversation);
  const notified = await collectNotifications(client, userId);
  const sentJson = sent.map((m) => ({
    id: m.id,
    conversation_id: m.conversation_id,
    to_usernames: conversationPartners.get(m.conversation_id as string) ?? [],
    body: m.body ?? null,
    attachment: !m.attachment_type ? null
      : m.attachment_type === 'image'
        ? { type: 'image', item_id: null, ...sentPhoto(m.id as string) }
        : { type: m.attachment_type, item_id: m.attachment_item_id ?? null },
    sent_at: m.created_at,
  }));
  const followList = (rows: Row[], column: string) => {
    const visible = rows.filter((r) => name(r[column] as string));
    return {
      collectors: visible.map((r) => ({ username: name(r[column] as string), since: r.created_at })),
      unavailable_accounts: rows.length - visible.length,
    };
  };

  // ── Activity: what the collector liked, saved and rated ──
  // Only the collector's own rows (user_id / rater_user_id = them). Every
  // target is ON DELETE CASCADE, so activity on a deleted target is already
  // gone; a target whose owner is hidden (pending deletion / being deleted)
  // is reported as "unavailable" with nothing about that collector. Targets'
  // owners are read only to classify them — no owner id, username or
  // content of another collector is written, except the public username of
  // a visible collector whose Grails showcase was saved.
  const activity = await collectActivity(client, userId);
  const tagging = await collectTags(client, userId);
  const waitlist = await collectWaitlist(client, userId);

  const profileJson = {
    account: {
      id: userId,
      email: authUser?.user?.email ?? null,
      created_at: authUser?.user?.created_at ?? null,
      ...accountMetadata(authUser?.user as AuthUserFull),
    },
    profile: profile ?? null,
    photos: owned.filter((o) => o.bucket === 'avatars').map((o) => o.archiveName),
  };

  const files: DataFile[] = [
    { name: 'account/profile.json', bytes: json(profileJson) },
    { name: 'account/waitlist.json', bytes: json(waitlist) },
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
    { name: 'messages/conversations.json', bytes: json(conversationsJson) },
    { name: 'notifications/notifications.json', bytes: json(notified.notifications) },
    { name: 'social/followers.json', bytes: json(followList(followers, 'follower_id')) },
    { name: 'social/following.json', bytes: json(followList(following, 'following_id')) },
    { name: 'activity/likes.json', bytes: json(activity.likes) },
    { name: 'activity/saved.json', bytes: json(activity.saved) },
    { name: 'activity/ratings.json', bytes: json(activity.ratings) },
    { name: 'activity/tags.json', bytes: json(tagging.tags) },
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
      sent_message_photos: sentPhotosIncluded,
      sent_message_photos_unavailable: sentPhotoMessages - sentPhotosIncluded,
      conversations: conversationsJson.length,
      notifications: notified.notifications.length,
      notifications_unread: notified.notifications.filter((n) => !n.read).length,
      followers: followers.length,
      following: following.length,
      ...activity.counts,
      ...tagging.counts,
      waitlist_records: waitlist.length,
    },
    withheld: {
      tags_received_not_visible_omitted: tagging.receivedNotVisible,
      notifications_unreleased_features: notified.unreleased,
      notifications_other_types: notified.otherTypes,
      notifications_not_visible_content: notified.notVisible,
    },
  };
}

// What the archive deliberately leaves out — one list for manifest.json
// (not_included) and README.txt, so the two always agree. reason:
//   other_collector  belongs to another collector, not to you
//   not_yet_included your data that this version of the export does not yet contain
//   unreleased       records of features that are not released
//   not_linked       not linked to your account, so not exported to anyone
//   internal         derived or operational records, not personal content
export const NOT_INCLUDED: { category: string; reason: string; description: string }[] = [
  { category: 'other_collectors_messages', reason: 'other_collector',
    description: 'Messages other collectors sent you, anything attached to them, and their own read or hidden state in your conversations' },
  { category: 'other_collectors_content', reason: 'other_collector',
    description: 'Other collectors’ posts (including posts you reposted or quoted), comments, items, collections, private content, and their likes, saves, ratings and comments on your content. Your own activity on their content is included and refers to it by ID only' },
  { category: 'registry_and_transfers', reason: 'unreleased',
    description: 'Registry and Transfers records and their notifications (unreleased features). How many exist for you is in excluded_records' },
  { category: 'unlinked_waitlist_signups', reason: 'not_linked',
    description: 'Waitlist signups not linked to this account by an invite it redeemed. An email address alone never links a signup to an account' },
  { category: 'derived_and_internal', reason: 'internal',
    description: 'Search indexes and normalised search fields, view counts and analytics, and internal security and operational records (sign-in sessions and tokens, password data, rate limits, account lifecycle, export and deletion job records)' },
];

export const README = (generatedAt: string) => `CacheCase — your data
Generated ${generatedAt}

This archive contains the CacheCase data listed below, which you can also see in manifest.json
("files" lists every file and which part holds it; "counts" how many records each file has).
It is not a copy of every record CacheCase systems hold: some data is deliberately left out
(see "Not included" below and manifest.json "not_included" and "excluded_records").

YOUR FILES
account/profile.json         Your account and profile. "account" has your email, when the account was
                             created, when its email was confirmed, the last sign-in, any phone number on the
                             account, how you sign in ("sign_in_methods") and any two-step verification methods
                             (type, status and date added only). "photos" lists your profile photos in media/
account/waitlist.json        The CacheCase waitlist signup linked to this account by the invite it redeemed:
                             name, email, reserved username, status and dates. Invite codes are never included.
                             An empty list means no signup is linked to this account
collections/collections.*    Your collections (JSON and CSV). "path" shows nesting; parent_id links to the parent
items/items.*                Your items with all category details and photo file names (JSON and CSV)
grails/grails.json           Your Top 9 Grails by position
posts/posts.json             Your posts with their text, photos, the items and collections attached to them and
                             their saved snapshots (titles, images). Reposted or quoted posts by other
                             collectors are referred to by ID only
comments/comments.json       Comments you wrote on posts, items, collections and galleries
messages/conversations.json  Your conversations: when each started, its last activity, when you last read it, whether
                             you hid it, how many messages you sent, and the other participants' public usernames.
                             "read_only" is true when the other participant has deleted their account
notifications/notifications.json  Your notifications: type, date, whether you read it, who caused it (public
                             username) and what it is about (post, conversation, item or collection ID; the score
                             for a Grails rating). Message text is never included
messages/sent_messages.json  Messages you sent, with recipients' public usernames. A photo you attached is in
                             media/dm-attachments/ ("attachment": "status" "included" with its "file"), or
                             "unavailable" if it no longer exists. Photos other collectors sent you are not included
social/                      Collectors you follow and who follow you (public usernames)
activity/likes.json          Posts, items and collections you liked
activity/saved.json          Items, collections and Grails showcases you saved
activity/ratings.json        Your Rate My Grails scores
activity/tags.json           Collectors you tagged in your items and collections ("tags_created") and items and
                             collections other collectors tagged you in ("tags_received")
media/                       Your files stored under your account: profile photos, item photos, collection
                             covers, post photos and share snapshots, and photos you sent in direct messages
manifest.json                What this archive contains, what it leaves out, and how it is split into parts

IMAGE REFERENCES (posts/posts.json)
Every image a post refers to has a "status":
  included      the file is in this archive; "file" is its media/ path
  not_included  it exists outside this archive (another collector's photo or an outside web address);
                "url" is kept only when it is a public address, never a private storage link
  unavailable   nothing is there any more (for example your file was removed when its source was
                deleted), or nothing was referenced

ACTIVITY AND TAGS (activity/)
Each entry names its target ("target_type", "target_id") and whose it is ("target_owner": you /
other_collector). A saved Grails showcase is named by the collector's public "target_username".
In tags, the other collector appears by public username only ("tagged_collector_username",
"tagged_by_username"). Other collectors' account IDs, emails and content are never included.
Tags someone added to content you cannot see are not listed at all; manifest.json only counts
them (excluded_records.tags_received_not_visible_omitted).

HIDDEN AND DELETED ACCOUNTS
- A collector whose account is no longer visible (for example while it is being deleted) is never
  named: usernames are null, "target_status" / "*_status" / "status" is "unavailable", and followers or
  following are counted as "unavailable_accounts".
- When an account is deleted, notifications it caused are deleted with it, and conversations with it
  become read-only.
- When content or an account is deleted, likes, saves, ratings and tags that pointed at it are
  deleted with it, so they no longer appear here.

DATES
Dates are UTC (ISO 8601). A date is null when it was never recorded or has not happened: some older
likes have no time ("liked_at"), and "email_confirmed_at", "last_sign_in_at", "phone_confirmed_at",
the waitlist "access_granted_at" / "onboarded_at", and a conversation's "your_last_read_at" /
"hidden_at" may be null. Missing values are never filled in.

NOT INCLUDED
${NOT_INCLUDED.map((n) => `- ${n.description}.`).join('\n')}

CSV files are UTF-8 and open in spreadsheet apps.
`;

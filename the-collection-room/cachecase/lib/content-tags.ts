import type { Recipient } from '@/components/share/recipient-list';
import { supabase } from '@/lib/supabase';

// Collector tagging — the client half of supabase/migrations/
// 20261102120000_add_collector_tagging.sql. A content owner tags other
// collectors in one of their Items or Collections. Every rule (owner-only
// adds, no self-tagging, the 20-collector cap, who may remove what, and
// that a tag is only visible where its item/collection is) is enforced by
// the database; this module only reads/writes through the signed-in client
// (RLS applies) and turns the server's error tokens into words.
//
// Not bookmarking: saved_cards / saved_folders are a separate feature.

export type TagTarget = { kind: 'item' | 'collection'; id: string };

export type TaggedCollector = Recipient & { taggedAt: string };

export type TagResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export const TAG_LIMIT = 20;

const TABLE = { item: 'collection_item_tags', collection: 'folder_tags' } as const;
const COLUMN = { item: 'item_id', collection: 'folder_id' } as const;

// ── Schema compatibility ─────────────────────────────────────────────────
// The app can run against a database without the tagging migration (e.g. a
// dev build on production before it is applied). There the tag tables don't
// exist: the first check learns that, remembers it for the session, and the
// Tag actions stay hidden — no repeated failing requests, nothing logged as
// an error. Not persisted: applying the migration needs only an app restart.
let taggingSchema: boolean | null = null;

const TAG_TABLES = /(collection_item_tags|folder_tags)/;

export function isMissingTagTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // PostgREST: table not in its schema cache; Postgres: undefined table.
  return (error.code === 'PGRST205' || error.code === '42P01') && TAG_TABLES.test(error.message ?? '');
}

// True only once a request has confirmed the tag tables exist.
export function taggingAvailable(): boolean {
  return taggingSchema === true;
}

// Settles taggingAvailable(): one zero-row probe per session. Any other
// failure (offline, …) leaves it unknown, so a later screen tries again.
export async function checkTaggingAvailable(): Promise<boolean> {
  if (taggingSchema !== null) return taggingSchema;
  try {
    const { error } = await supabase.from(TABLE.item).select('item_id').limit(0);
    if (isMissingTagTable(error)) {
      taggingSchema = false;
      if (__DEV__) console.info('[content-tags] tag tables not in this database yet — Tag actions hidden.');
    } else if (!error) {
      taggingSchema = true;
    } else if (__DEV__) {
      console.warn('[content-tags] tagging check failed:', error.message);
    }
  } catch (e) {
    if (__DEV__) console.warn('[content-tags] tagging check threw:', e);
  }
  return taggingSchema === true;
}

// ── Errors ───────────────────────────────────────────────────────────────
const ERROR_COPY: Record<string, string> = {
  tag_not_owner: 'Only the owner can tag collectors here.',
  tag_self: 'You can’t tag yourself.',
  tag_user_not_found: 'Someone you picked is no longer available.',
  tag_limit_reached: `Up to ${TAG_LIMIT} collectors can be tagged.`,
};

export function tagErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (isMissingTagTable(error)) return 'Tagging isn’t available yet.';
  const token = error?.message?.trim() ?? '';
  if (ERROR_COPY[token]) return ERROR_COPY[token];
  if (error?.code === '23505') return 'Someone you picked is already tagged.';
  if (error?.code === '42501') return 'You can’t change the tags here.';
  return 'Something went wrong. Please try again.';
}

// ── Reads / writes ───────────────────────────────────────────────────────

// Everyone tagged in the item/collection that the signed-in user can see
// (RLS: none at all when the content itself isn't visible to them), oldest
// tag first. Throws on a request failure.
export async function loadTags(target: TagTarget, signal?: AbortSignal): Promise<TaggedCollector[]> {
  let query = supabase
    .from(TABLE[target.kind])
    .select('tagged_user_id, created_at')
    .eq(COLUMN[target.kind], target.id)
    .order('created_at', { ascending: true });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) {
    if (isMissingTagTable(error)) taggingSchema = false;
    throw error;
  }
  const rows = (data ?? []) as { tagged_user_id: string; created_at: string }[];
  if (rows.length === 0) return [];

  let profilesQuery = supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in(
      'id',
      rows.map((r) => r.tagged_user_id),
    );
  if (signal) profilesQuery = profilesQuery.abortSignal(signal);
  const { data: profiles, error: profilesError } = await profilesQuery;
  if (profilesError) throw profilesError;
  const byId = new Map(
    ((profiles ?? []) as { id: string; username: string; display_name: string | null; avatar_url: string | null }[]).map(
      (p) => [p.id, p],
    ),
  );
  // A deleted account's tags are removed with it; a missing profile here is
  // only a race with that deletion, so it's skipped.
  return rows.flatMap((r) => {
    const p = byId.get(r.tagged_user_id);
    return p ? [{ id: p.id, username: p.username, displayName: p.display_name, avatarUrl: p.avatar_url, taggedAt: r.created_at }] : [];
  });
}

// Owner only (the server checks). All-or-nothing: a pick that would pass
// the cap, or includes someone already tagged, adds nobody.
export async function addTags(target: TagTarget, userIds: string[]): Promise<TagResult<number>> {
  if (userIds.length === 0) return { ok: true, value: 0 };
  try {
    const { error } = await supabase
      .from(TABLE[target.kind])
      .insert(userIds.map((id) => ({ [COLUMN[target.kind]]: target.id, tagged_user_id: id })));
    if (error) {
      if (__DEV__) console.warn('[content-tags] add failed:', error.code, error.message);
      return { ok: false, message: tagErrorMessage(error) };
    }
    return { ok: true, value: userIds.length };
  } catch (e) {
    if (__DEV__) console.warn('[content-tags] add threw:', e);
    return { ok: false, message: tagErrorMessage(null) };
  }
}

// The owner removes anyone's tag; a tagged collector removes their own. A
// tag that is already gone counts as removed.
export async function removeTag(target: TagTarget, userId: string): Promise<TagResult> {
  try {
    const { error } = await supabase
      .from(TABLE[target.kind])
      .delete()
      .eq(COLUMN[target.kind], target.id)
      .eq('tagged_user_id', userId);
    if (error) {
      if (__DEV__) console.warn('[content-tags] remove failed:', error.code, error.message);
      return { ok: false, message: tagErrorMessage(error) };
    }
    return { ok: true, value: undefined };
  } catch (e) {
    if (__DEV__) console.warn('[content-tags] remove threw:', e);
    return { ok: false, message: tagErrorMessage(null) };
  }
}

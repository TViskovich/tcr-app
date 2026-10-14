/// <reference types="node" />
// Shared by verify-mixed-run.ts and cleanup-mixed-run.ts: how a
// k6-mixed-workload.js run's records are identified. Keep in step with the
// k6 script (pairs, follow targets, run tag).
//
// Identification is exact wherever the schema allows it:
//   - run posts / messages / comments: the "[lt-mixed:<RUN_ID>]" prefix
//     (RUN_ID has no LIKE wildcards: lowercase letters, digits, hyphens);
//   - like and comment notifications: post_id of a run post (run posts are
//     dedicated, so every notification on one belongs to mixed runs);
//   - message notifications: they carry no message id, but the
//     messages_create_message_notification trigger runs inside the message's
//     own INSERT transaction, so the notification's created_at (DEFAULT now())
//     is identical to the message's created_at (DEFAULT now()). A notification
//     is attributed to a message only on an exact (conversation_id, actor_id =
//     sender_id, created_at) match; more than one match is ambiguous.
//   - follow edges / follow notifications: the pattern lt_user_n →
//     lt_user_(n+15 mod 30), which the seed graph never contains.

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFullPlan } from './dataset-plan.ts';
import { chunks, fetchAllPages, mergePlans, type Row, type SeedUser } from './seed-lib.ts';

export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,39}$/;
export const MIXED_TAG_PREFIX = '[lt-mixed:';
export const runTag = (runId: string) => `${MIXED_TAG_PREFIX}${runId}]`;
export const MIXED_VUS = [5, 15, 30];

// k6-mixed-workload.js conversationPairs, as 1-based user numbers.
export function mixedPairs(count: number): [number, number][] {
  const shift = Math.floor(count / 2);
  const pairs = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const j = (i + shift) % count;
    if (i === j) continue;
    const [a, b] = [i, j].sort((x, y) => x - y);
    pairs.set(`${a}+${b}`, [a + 1, b + 1]);
  }
  return [...pairs.values()];
}

export const followTargetNumber = (n: number) => ((n - 1 + 15) % 30) + 1;

// Every conversation id the seed scripts can generate (--users 2…30).
export function seedConversationIds(users: SeedUser[]): Set<string> {
  const now = Date.now();
  const plan = mergePlans(...Array.from({ length: users.length - 1 }, (_, i) => buildFullPlan(users.slice(0, i + 2), () => '', now)));
  return new Set(plan.conversations.map((c) => c.id as string));
}

export async function selectIn(admin: SupabaseClient, table: string, columns: string, column: string, values: string[], order: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunks([...new Set(values)], 100)) {
    out.push(
      ...(await fetchAllPages((from, to) => {
        let q = admin.from(table).select(columns).in(column, chunk);
        for (const o of order) q = q.order(o);
        return q.range(from, to);
      })),
    );
  }
  return out;
}

export async function selectLike(admin: SupabaseClient, table: string, columns: string, column: string, prefix: string): Promise<Row[]> {
  return fetchAllPages((from, to) => admin.from(table).select(columns).like(column, `${prefix}%`).order('id').range(from, to));
}

// Conversation ids shared by exactly the two users of each pair.
export async function conversationsForPairs(admin: SupabaseClient, pairs: [string, string][]): Promise<Map<string, string[]>> {
  const userIds = [...new Set(pairs.flat())];
  const mine = await selectIn(admin, 'conversation_participants', 'conversation_id', 'user_id', userIds, ['conversation_id']);
  const all = await selectIn(admin, 'conversation_participants', 'conversation_id, user_id', 'conversation_id', mine.map((r) => r.conversation_id as string), ['conversation_id', 'user_id']);
  const members = new Map<string, string[]>();
  for (const r of all) members.set(r.conversation_id as string, [...(members.get(r.conversation_id as string) ?? []), r.user_id as string]);
  const result = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    const key = [a, b].sort().join('|');
    result.set(key, [...members].filter(([, ids]) => ids.length === 2 && [...ids].sort().join('|') === key).map(([id]) => id));
  }
  return result;
}

export type NotificationMatch = { matched: Map<string, Row>; missing: string[]; ambiguous: string[] };

// Message → its trigger-created notification, by exact key (see header).
export async function matchMessageNotifications(admin: SupabaseClient, messages: Row[]): Promise<NotificationMatch> {
  const conversationIds = [...new Set(messages.map((m) => m.conversation_id as string))];
  const notifications = (await selectIn(admin, 'notifications', 'id, user_id, actor_id, type, conversation_id, created_at', 'conversation_id', conversationIds, ['id'])).filter(
    (n) => n.type === 'message',
  );
  const byKey = new Map<string, Row[]>();
  for (const n of notifications) {
    const key = `${n.conversation_id}|${n.actor_id}|${n.created_at}`;
    byKey.set(key, [...(byKey.get(key) ?? []), n]);
  }
  const result: NotificationMatch = { matched: new Map(), missing: [], ambiguous: [] };
  for (const m of messages) {
    const hits = byKey.get(`${m.conversation_id}|${m.sender_id}|${m.created_at}`) ?? [];
    if (hits.length === 1) result.matched.set(m.id as string, hits[0]);
    else if (hits.length === 0) result.missing.push(m.id as string);
    else result.ambiguous.push(m.id as string);
  }
  return result;
}

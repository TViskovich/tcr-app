// ONE-TIME ADMIN MIGRATION — item-images beta privacy hardening, Phase 3E.
// Copies the 43 historical feed/share snapshot references (posts.image_url,
// card_share_items.snapshot_image_url, rate_my_grail_cards.snapshot_image_url)
// that still point at the live item-images bucket into the durable,
// always-public share-snapshots bucket, preserving the EXACT historical
// object each row's URL already points to — never the source item's
// current primary image (that would silently change what a "snapshot"
// shows, defeating the point of one).
//
// This is NOT a normal app feature and is not meant to be called from the
// client. It discovers every eligible row itself, server-side — it never
// accepts a caller-supplied URL, path, or row id. There is nothing here an
// ordinary authenticated user can exploit to copy an arbitrary historical
// URL: the request body is ignored entirely (see the empty-body handling
// below).
//
// SECURITY — no admin-role concept exists anywhere in this codebase today
// (no profiles.is_admin, no allowlist table, confirmed by repo-wide grep
// before writing this), so nothing here invents one out of a
// client-controlled flag. Access is gated by TWO layers, both required:
//   1. Deploy this function WITHOUT --no-verify-jwt (the default —
//      opposite of every other function in this project) — the Supabase
//      gateway itself rejects any request lacking a valid Authorization
//      bearer before this code ever runs.
//   2. A required `x-backfill-secret` header, compared against the
//      BACKFILL_ADMIN_SECRET Edge Function secret — set this via
//      `supabase secrets set BACKFILL_ADMIN_SECRET=<a long random value>`
//      before deploying, never commit it, never put it in client code.
//      Layer 1 alone isn't sufficient (any signed-in app user has a valid
//      JWT); this second, deliberately-manual-only secret is what
//      actually restricts this to you.
// Invoke it yourself, once, via curl or Postman — never from the app:
//   curl -X POST https://<project-ref>.supabase.co/functions/v1/backfill-share-snapshots \
//     -H "Authorization: Bearer <any valid Supabase JWT — e.g. the service-role key>" \
//     -H "x-backfill-secret: <the BACKFILL_ADMIN_SECRET value>" \
//     -H "Content-Type: application/json" -d '{}'
//
// IDEMPOTENT BY CONSTRUCTION: eligibility is `<url column> LIKE
// '%/storage/v1/object/public/item-images/%'` — a row already migrated to
// share-snapshots no longer matches that filter, so a rerun's discovery
// query naturally excludes it without a separate "already done" check.
// Destination paths are deterministic per row (the row's own primary key,
// never a random UUID), and the underlying copy always upserts (see
// ../_shared/share-snapshot.ts's copyHistoricalUrlIntoShareSnapshots) — a
// rerun for a row whose upload succeeded but whose UPDATE didn't on a
// prior pass safely re-uploads the same bytes to the same path rather
// than failing as a collision.
//
// One durable object per logical row, deliberately not deduplicated
// across rows that happen to share a source URL — simpler, fully
// row-local retry behavior; see the Phase 3E report for the full
// rationale.
//
// Never deletes the source item-images object — it may still be
// referenced by the live collection item during this pre-cutover phase.

import { jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';
import { copyHistoricalUrlIntoShareSnapshots } from '../_shared/share-snapshot.ts';

const ITEM_IMAGES_URL_PATTERN = '%/storage/v1/object/public/item-images/%';
const CONCURRENCY_LIMIT = 5;

type RowOutcome = { id: string; outcome: 'migrated' | 'failed'; reason?: string };
type TableSummary = { scanned: number; migrated: number; skipped: number; failed: number };

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function processRow(
  client: ReturnType<typeof serviceRoleClient>,
  table: string,
  idColumn: string,
  urlColumn: string,
  row: any,
  destinationPath: string,
): Promise<RowOutcome> {
  const currentUrl = row[urlColumn] as string;
  const rowId = row[idColumn] as string;

  const result = await copyHistoricalUrlIntoShareSnapshots(client, currentUrl, destinationPath);
  if (!result.ok) {
    return { id: rowId, outcome: 'failed', reason: 'copy_failed' };
  }

  // Guarded by the URL still matching what was just read — defends
  // against this row's value changing between the discovery SELECT and
  // this UPDATE (e.g. the owner editing/removing the post concurrently).
  // A failed/no-op UPDATE here leaves the DB value exactly as it was
  // before this backfill touched it, per the "leave the existing DB URL
  // untouched on failure" requirement.
  //
  // Reporting bug fix (confirmed against a real production run): a prior
  // version of this check used
  // `.select('*', { count: 'exact', head: true })` to detect whether the
  // UPDATE actually matched a row, without requesting any row body back.
  // For a mutation (as opposed to a plain SELECT), head: true does not
  // reliably populate `count` from Content-Range — every one of the 43
  // historical rows was correctly copied and updated in production, but
  // this check's `count` came back null/falsy for all of them, so every
  // single successful update was misreported as 'update_matched_no_row'.
  // Requesting the real updated row back (.select('id').maybeSingle(),
  // no head/count) is what actually forces PostgREST's
  // return=representation semantics and lets this distinguish "matched
  // and updated" (data is the row) from "matched nothing" (data is null,
  // no error) from "a real database error" (error is set) reliably.
  const { data: updated, error: updateError } = await client
    .from(table)
    .update({ [urlColumn]: result.publicUrl })
    .eq(idColumn, rowId)
    .eq(urlColumn, currentUrl)
    .select('id')
    .maybeSingle();

  if (updateError || !updated) {
    return { id: rowId, outcome: 'failed', reason: updateError ? 'update_failed' : 'update_matched_no_row' };
  }

  return { id: rowId, outcome: 'migrated' };
}

// The posts!inner(user_id) embed is a to-one relation (many card_share_items/
// rate_my_grail_cards rows reference one post), so PostgREST normally
// returns it as a single object — but this codebase already defensively
// handles the same embed shape elsewhere (see app/(tabs)/search.tsx's own
// `Array.isArray(item.folders) ? item.folders[0] : item.folders`), so this
// mirrors that rather than assuming.
function postOwnerId(row: { posts: { user_id: string } | { user_id: string }[] }): string | null {
  const posts = row.posts;
  const post = Array.isArray(posts) ? posts[0] : posts;
  return post?.user_id ?? null;
}

function summarize(scanned: number, outcomes: RowOutcome[]): TableSummary {
  const migrated = outcomes.filter((o) => o.outcome === 'migrated').length;
  const failed = outcomes.filter((o) => o.outcome === 'failed').length;
  return { scanned, migrated, skipped: scanned - migrated - failed, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const providedSecret = req.headers.get('x-backfill-secret');
  const requiredSecret = Deno.env.get('BACKFILL_ADMIN_SECRET');
  if (!requiredSecret || !providedSecret || providedSecret !== requiredSecret) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  // Request body is intentionally never read for input — every eligible
  // row is discovered server-side below. Accepting (and ignoring) an
  // empty/absent JSON body just keeps this a normal POST call.

  const client = serviceRoleClient();
  const failures: { table: string; id: string; reason: string }[] = [];

  // ---- posts.image_url ----------------------------------------------
  const { data: posts } = await client
    .from('posts')
    .select('id, user_id, image_url')
    .like('image_url', ITEM_IMAGES_URL_PATTERN);

  const postOutcomes = await mapWithConcurrency(posts ?? [], CONCURRENCY_LIMIT, (row: any) =>
    processRow(
      client,
      'posts',
      'id',
      'image_url',
      row,
      `${row.user_id}/historical-post/${row.id}`,
    ),
  );
  for (const o of postOutcomes) {
    if (o.outcome === 'failed') failures.push({ table: 'posts', id: o.id, reason: o.reason ?? 'unknown' });
  }

  // ---- card_share_items.snapshot_image_url ---------------------------
  const { data: cardShareItems } = await client
    .from('card_share_items')
    .select('id, post_id, item_id, snapshot_image_url, posts!inner(user_id)')
    .like('snapshot_image_url', ITEM_IMAGES_URL_PATTERN);

  const cardShareOutcomes = await mapWithConcurrency(
    cardShareItems ?? [],
    CONCURRENCY_LIMIT,
    async (row: any) => {
      const ownerId = postOwnerId(row);
      if (!ownerId) return { id: row.id, outcome: 'failed' as const, reason: 'owner_unresolved' };
      return processRow(
        client,
        'card_share_items',
        'id',
        'snapshot_image_url',
        row,
        `${ownerId}/historical-card-share/${row.post_id}/${row.id}`,
      );
    },
  );
  for (const o of cardShareOutcomes) {
    if (o.outcome === 'failed') failures.push({ table: 'card_share_items', id: o.id, reason: o.reason ?? 'unknown' });
  }

  // ---- rate_my_grail_cards.snapshot_image_url -------------------------
  const { data: grailCards } = await client
    .from('rate_my_grail_cards')
    .select('id, post_id, item_id, snapshot_image_url, posts!inner(user_id)')
    .like('snapshot_image_url', ITEM_IMAGES_URL_PATTERN);

  const grailOutcomes = await mapWithConcurrency(
    grailCards ?? [],
    CONCURRENCY_LIMIT,
    async (row: any) => {
      const ownerId = postOwnerId(row);
      if (!ownerId) return { id: row.id, outcome: 'failed' as const, reason: 'owner_unresolved' };
      return processRow(
        client,
        'rate_my_grail_cards',
        'id',
        'snapshot_image_url',
        row,
        `${ownerId}/historical-rate-my-grails/${row.post_id}/${row.id}`,
      );
    },
  );
  for (const o of grailOutcomes) {
    if (o.outcome === 'failed') failures.push({ table: 'rate_my_grail_cards', id: o.id, reason: o.reason ?? 'unknown' });
  }

  const postsSummary = summarize((posts ?? []).length, postOutcomes);
  const cardShareSummary = summarize((cardShareItems ?? []).length, cardShareOutcomes);
  const grailSummary = summarize((grailCards ?? []).length, grailOutcomes);

  return jsonResponse(
    {
      posts: postsSummary,
      card_share_items: cardShareSummary,
      rate_my_grail_cards: grailSummary,
      total: {
        scanned: postsSummary.scanned + cardShareSummary.scanned + grailSummary.scanned,
        migrated: postsSummary.migrated + cardShareSummary.migrated + grailSummary.migrated,
        skipped: postsSummary.skipped + cardShareSummary.skipped + grailSummary.skipped,
        failed: postsSummary.failed + cardShareSummary.failed + grailSummary.failed,
      },
      failures,
    },
    200,
  );
});

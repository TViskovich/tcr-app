// Public Registry QR Experience v1 — the single, narrow read surface for
// the future public web page at https://<public-domain>/registry/<cc_id>
// (a separate web deployment, NOT this Expo app's own app/registry/[id].tsx
// route — see the architecture decision this function implements).
//
// Fully anonymous by design: no Authorization header is expected or
// inspected at all. Deployed with gateway JWT verification disabled
// (`supabase functions deploy get-public-registry-card --no-verify-jwt`),
// matching get-registry-snapshot-image-url's precedent.
//
// Request:  POST { cc_id: string }
// Response: { status: 'ok', data: PublicRegistryCard } | { status: 'not_found' }
//
// Looked up by cc_id only — never a registered_cards.id UUID, and the
// response never includes one. The signed snapshot image URL is resolved
// and generated INSIDE this function (service-role Storage access), so the
// client never needs the internal id to fetch the image separately.
//
// Deliberately does NOT reuse canViewRegisteredCard from
// ../_shared/registry-image.ts (that helper's owner/creator bypass exists
// for the in-app authenticated screens; this endpoint has no caller
// identity concept at all — every visitor sees exactly the same view, and
// only visibility = 'public' rows are ever returned, full stop).
//
// Every field below is deliberately narrow. Never returned: registered_cards.id,
// current_owner_id, created_by, actor_id, from_owner_id, to_owner_id,
// snapshot_image_storage_path, snapshot_image_error_code, metadata, any
// ownership_transfers row/count derived from that table (the count here
// comes only from completed 'ownership_transferred' registry_events rows,
// which is itself already public-safe), or any collection_item data.

import { CORS_HEADERS, handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

const SIGNED_URL_TTL_SECONDS = 300;

// Only these event types are ever surfaced publicly — item_linked/
// item_unlinked are owner-specific organizational actions, not public
// provenance, and are excluded even though they're readable at the RLS
// row level (see the Phase 1 audit: RLS restricts rows, not columns/event
// types — this allowlist is the actual safety boundary).
const PUBLIC_EVENT_TYPES = new Set(['registered', 'ownership_transferred', 'status_changed', 'grading_updated']);

// Deliberately duplicated from lib/registry-custody-status.ts rather than
// imported — that module imports the Expo app's Supabase client (AsyncStorage,
// React Native specifics), which isn't available in the Deno Edge Function
// runtime. Same "kept in sync deliberately, not shared across the Deno/Expo
// boundary" convention already used for SnapshotImageErrorCode
// (types/index.ts) and the identity-builder helpers (app/registry/[id].tsx
// / app/registry-history/[id].tsx).
const CUSTODY_STATUS_LABEL: Record<string, string> = {
  owned: 'Owned',
  in_transfer: 'In Transfer',
  on_loan: 'On Loan',
  submitted_for_grading: 'Submitted for Grading',
  missing: 'Missing',
  stolen: 'Stolen',
  destroyed: 'Destroyed',
  archived: 'Archived',
};

function formatCustodyStatus(status: string): string {
  return CUSTODY_STATUS_LABEL[status] ?? status;
}

// Mirrors buildSnapshotTitle/buildSnapshotSubtitle in app/registry/[id].tsx
// and app/registry-history/[id].tsx exactly (same precedence, same
// dedup-against-title rule for the subtitle) — duplicated for the same
// Deno/Expo boundary reason as the custody-status labels above. Snapshot
// fields only — never falls back to a linked collection_item, since the
// public page must not depend on the owner's mutable personal data.
function buildTitle(card: Record<string, unknown>): string | null {
  const player = (card.snapshot_player as string | null)?.trim();
  const title = (card.snapshot_title as string | null)?.trim();
  return player || title || null;
}

function buildSubtitle(card: Record<string, unknown>): string | null {
  const mainTitle = buildTitle(card);
  const brand = (card.snapshot_brand as string | null)?.trim() || null;
  const snapshotTitle = (card.snapshot_title as string | null)?.trim() || null;
  const year = card.snapshot_year as number | null;

  if (year == null && !brand && !snapshotTitle) return null;

  const parts: (string | null)[] = [year != null ? String(year) : null, brand];
  if (snapshotTitle && snapshotTitle !== mainTitle) {
    parts.push(snapshotTitle);
  }
  return parts.filter(Boolean).join(' ') || null;
}

type NameMap = Record<string, { username: string; display_name: string | null }>;

function resolveName(names: NameMap, userId: string | null): string | null {
  if (!userId) return null;
  const profile = names[userId];
  if (!profile) return null;
  return profile.display_name || profile.username || null;
}

// Plain-text equivalent of app/registry-history/[id].tsx's getEventDetail —
// same wording, same precedence, same graceful-omit-on-unresolved-name
// behavior — but returns a plain string (no tappable ProfileNameLink;
// this is a read-only public API response, not interactive UI) and only
// for the PUBLIC_EVENT_TYPES allowlist (item_linked/item_unlinked never
// reach this function's caller at all — filtered out before this runs).
function buildDisplayDetail(
  event: { event_type: string; actor_id: string | null; from_owner_id: string | null; to_owner_id: string | null; old_custody_status: string | null; new_custody_status: string | null },
  names: NameMap,
): string | null {
  if (event.event_type === 'registered') {
    const name = resolveName(names, event.actor_id) ?? resolveName(names, event.to_owner_id);
    return name ? `Registered by ${name}` : null;
  }

  if (event.event_type === 'ownership_transferred') {
    const fromName = resolveName(names, event.from_owner_id);
    const toName = resolveName(names, event.to_owner_id);
    if (fromName && toName) return `From ${fromName} → ${toName}`;
    if (toName) return `To ${toName}`;
    if (fromName) return `From ${fromName}`;
    return null;
  }

  if (event.event_type === 'status_changed') {
    const oldLabel = event.old_custody_status ? formatCustodyStatus(event.old_custody_status) : null;
    const newLabel = event.new_custody_status ? formatCustodyStatus(event.new_custody_status) : null;
    if (oldLabel && newLabel) return `${oldLabel} → ${newLabel}`;
    if (newLabel) return `To ${newLabel}`;
    if (oldLabel) return `From ${oldLabel}`;
    return null;
  }

  // grading_updated is in the allowlist for forward-compatibility but no
  // RPC in this codebase currently ever writes one — no wording is
  // invented for an event type that doesn't exist in practice.
  return null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ status: 'not_found' }, 405);
  }

  let body: { cc_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ status: 'not_found' }, 400);
  }

  const ccId = typeof body.cc_id === 'string' ? body.cc_id.trim() : null;
  if (!ccId) {
    return jsonResponse({ status: 'not_found' }, 400);
  }

  const client = serviceRoleClient();

  // visibility = 'public' is enforced explicitly here, in addition to (not
  // instead of) the existing RLS condition — defense in depth, matching
  // this codebase's established convention (e.g. every ownership-transfer
  // RPC re-verifies ownership after locking rather than trusting RLS
  // alone). This is also the ONLY authorization check this function has;
  // there is no owner/creator bypass.
  const { data: card, error: cardError } = await client
    .from('registered_cards')
    .select(
      'id, cc_id, created_at, custody_status, current_owner_id, visibility, ' +
        'snapshot_title, snapshot_player, snapshot_year, snapshot_brand, snapshot_set_name, snapshot_team, ' +
        'snapshot_image_url, snapshot_image_status, snapshot_image_storage_path',
    )
    .eq('cc_id', ccId)
    .eq('visibility', 'public')
    .maybeSingle();

  if (cardError || !card) {
    // Identical response whether the cc_id doesn't exist at all or exists
    // but is private — never distinguishes the two.
    return jsonResponse({ status: 'not_found' }, 200);
  }

  // Current owner's public-safe display info only (username/display_name —
  // both already fully public columns; never current_owner_id itself).
  let currentOwner: { display_name: string | null; username: string | null } | null = null;
  if (card.current_owner_id) {
    const { data: profile } = await client
      .from('profiles')
      .select('username, display_name')
      .eq('id', card.current_owner_id)
      .maybeSingle();
    if (profile) {
      currentOwner = { display_name: profile.display_name, username: profile.username };
    }
  }

  // Public-safe event subset only. Ordered oldest-first, matching
  // app/registry-history/[id].tsx's existing convention.
  const { data: eventRows } = await client
    .from('registry_events')
    .select('event_type, actor_id, from_owner_id, to_owner_id, old_custody_status, new_custody_status, created_at')
    .eq('registered_card_id', card.id)
    .order('created_at', { ascending: true });

  const allEvents = (eventRows ?? []) as {
    event_type: string;
    actor_id: string | null;
    from_owner_id: string | null;
    to_owner_id: string | null;
    old_custody_status: string | null;
    new_custody_status: string | null;
    created_at: string;
  }[];
  const publicEvents = allEvents.filter((e) => PUBLIC_EVENT_TYPES.has(e.event_type));

  // One batched, deduplicated name resolution across every event actually
  // being returned — same pattern as hooks/use-registry-events.ts, never
  // one profiles query per event.
  const referencedIds = [
    ...new Set(
      publicEvents
        .flatMap((e) => [e.actor_id, e.from_owner_id, e.to_owner_id])
        .filter((v): v is string => !!v),
    ),
  ];
  const names: NameMap = {};
  if (referencedIds.length > 0) {
    const { data: profiles } = await client.from('profiles').select('id, username, display_name').in('id', referencedIds);
    for (const p of (profiles ?? []) as { id: string; username: string; display_name: string | null }[]) {
      names[p.id] = { username: p.username, display_name: p.display_name };
    }
  }

  const ownershipTransferCount = publicEvents.filter((e) => e.event_type === 'ownership_transferred').length;

  // Durable signed image URL, resolved and generated here — the client
  // never receives (or needs) the internal registered_cards.id to fetch
  // this itself. Falls back to the provisional legacy snapshot_image_url
  // (still safe to expose — it points at the already-public item-images
  // bucket) only when the durable copy isn't ready yet; never falls
  // further to a linked collection_item's image, which doesn't exist in
  // this query at all.
  let snapshotImageUrl: string | null = null;
  if (card.snapshot_image_status === 'ready' && card.snapshot_image_storage_path) {
    const { data: signed } = await client.storage
      .from('registry-images')
      .createSignedUrl(card.snapshot_image_storage_path as string, SIGNED_URL_TTL_SECONDS);
    snapshotImageUrl = signed?.signedUrl ?? null;
  }
  if (!snapshotImageUrl) {
    snapshotImageUrl = (card.snapshot_image_url as string | null) ?? null;
  }

  return jsonResponse(
    {
      status: 'ok',
      data: {
        cc_id: card.cc_id,
        title: buildTitle(card),
        subtitle: buildSubtitle(card),
        snapshot_image_url: snapshotImageUrl,
        registered_at: card.created_at,
        current_owner: currentOwner,
        custody_status: card.custody_status,
        ownership_transfer_count: ownershipTransferCount,
        events: publicEvents.map((e) => ({
          event_type: e.event_type,
          created_at: e.created_at,
          display_detail: buildDisplayDetail(e, names),
        })),
      },
    },
    200,
  );
});

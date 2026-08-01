// Server-only data access for the public registry site. This is the ONLY
// place in this project that talks to the backend — every registry page
// goes through fetchPublicRegistryCard, which goes through the existing
// get-public-registry-card Edge Function. Nothing in this project queries
// registered_cards, registry_events, profiles, storage, or
// ownership_transfers directly, and there is no Supabase client here at
// all (browser or server) — a plain fetch() to the Edge Function's HTTP
// endpoint is the entire integration surface.
import 'server-only';
import { cache } from 'react';

// The exact shape returned by supabase/functions/get-public-registry-card
// (tcr-real-sdk54 repo) as of its current deployment. Duplicated here
// deliberately — this is a separate deployable project with no shared
// build step with the Expo app or the Edge Function's Deno runtime, same
// "kept in sync deliberately, not shared across a runtime boundary"
// convention already used inside that function itself (e.g. its own
// locally-duplicated custody-status label map).
export type PublicRegistryEvent = {
  event_type: string;
  created_at: string;
  display_detail: string | null;
};

export type PublicRegistryCard = {
  cc_id: string;
  title: string | null;
  subtitle: string | null;
  snapshot_image_url: string | null;
  registered_at: string;
  current_owner: { display_name: string | null; username: string | null } | null;
  custody_status: string;
  ownership_transfer_count: number;
  events: PublicRegistryEvent[];
};

export type RegistryFetchResult =
  | { status: 'ok'; data: PublicRegistryCard }
  | { status: 'not_found' }
  | { status: 'unavailable' };

// Matches registered_cards_cc_id_format_check exactly (see
// supabase/migrations/20260725160000_align_card_registry_with_live_foundation.sql
// in the main app repo): CC- followed by two 4-character groups drawn from
// generate_cc_id()'s Crockford-like alphabet (excludes I, L, O, U — the
// visually-ambiguous/profanity-adjacent characters). No cc_id stored in
// the database can ever look different from this.
const CC_ID_PATTERN = /^CC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

// Normalizes without changing canonical spelling: trims incidental
// whitespace and uppercases (the stored form is always uppercase, so
// upper-casing a lowercase URL reaches the SAME canonical value rather
// than a different one). Does not strip characters, reorder segments, or
// guess at a "close enough" match — anything that still fails the exact
// stored-format check after that is simply invalid, not fixable.
export function normalizeCcId(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  return CC_ID_PATTERN.test(normalized) ? normalized : null;
}

function getFunctionsBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL;
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

// Defensive runtime validation of the Edge Function's response — this
// project never trusts a network response's shape just because it parsed
// as JSON. Deliberately hand-rolled rather than adding a schema-validation
// dependency (zod, etc.): the shape is small, fixed, and owned by this
// same codebase's Edge Function, so a few explicit checks are simpler and
// lighter than a new dependency for a "minimal dependencies" project.
function isValidCard(value: unknown): value is PublicRegistryCard {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.cc_id !== 'string') return false;
  if (v.title !== null && typeof v.title !== 'string') return false;
  if (v.subtitle !== null && typeof v.subtitle !== 'string') return false;
  if (v.snapshot_image_url !== null && typeof v.snapshot_image_url !== 'string') return false;
  if (typeof v.registered_at !== 'string') return false;
  if (typeof v.custody_status !== 'string') return false;
  if (typeof v.ownership_transfer_count !== 'number') return false;
  if (!Array.isArray(v.events)) return false;
  if (v.current_owner !== null) {
    if (typeof v.current_owner !== 'object') return false;
    const owner = v.current_owner as Record<string, unknown>;
    if (owner.display_name !== null && typeof owner.display_name !== 'string') return false;
    if (owner.username !== null && typeof owner.username !== 'string') return false;
  }
  return v.events.every((e) => {
    if (!e || typeof e !== 'object') return false;
    const ev = e as Record<string, unknown>;
    return (
      typeof ev.event_type === 'string' &&
      typeof ev.created_at === 'string' &&
      (ev.display_detail === null || typeof ev.display_detail === 'string')
    );
  });
}

const FETCH_TIMEOUT_MS = 8000;

// React's request-level cache() — not a data cache, just de-duplication.
// generateMetadata and the page component both need this card; without
// this they'd each trigger their own network call for the same request.
export const fetchPublicRegistryCard = cache(
  async (ccId: string): Promise<RegistryFetchResult> => {
    const base = getFunctionsBaseUrl();
    if (!base) {
      console.error('NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL is not configured');
      return { status: 'unavailable' };
    }

    let response: Response;
    try {
      response = await fetch(`${base}/get-public-registry-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cc_id: ccId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (err) {
      // Network failure, timeout, DNS, etc. Never surfaced to the visitor —
      // only a generic status is returned up the call chain. Full detail is
      // logged server-side only outside production (see the no-full-body
      // logging requirement below).
      if (process.env.NODE_ENV !== 'production') {
        console.error('get-public-registry-card request failed', err);
      } else {
        console.error('get-public-registry-card request failed');
      }
      return { status: 'unavailable' };
    }

    if (!response.ok) {
      console.error(`get-public-registry-card returned HTTP ${response.status}`);
      return { status: 'unavailable' };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      console.error('get-public-registry-card returned invalid JSON');
      return { status: 'unavailable' };
    }

    if (!body || typeof body !== 'object') {
      return { status: 'unavailable' };
    }
    const parsed = body as { status?: unknown; data?: unknown };

    if (parsed.status === 'not_found') {
      return { status: 'not_found' };
    }

    if (parsed.status === 'ok' && isValidCard(parsed.data)) {
      return { status: 'ok', data: parsed.data };
    }

    // Anything else (missing status field, status:'ok' with a malformed
    // data payload, an unrecognized status value) is treated as a service
    // problem, not as "this card doesn't exist" — those are different
    // facts and must not be conflated.
    console.error('get-public-registry-card returned an unrecognized response shape');
    return { status: 'unavailable' };
  },
);

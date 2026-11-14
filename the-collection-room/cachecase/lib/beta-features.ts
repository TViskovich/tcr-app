// Release scope for the first App Store submission (Release Readiness R2).
//
// One place decides which unreleased features the app exposes. A feature
// switched off here has every entry point hidden AND its routes removed from
// the navigator (app/_layout.tsx, Stack.Protected) and rewritten away from
// incoming deep links (app/+native-intent.tsx), so it cannot be reached by
// typing or opening a URL either.
//
// This is a release-scope switch, not a deletion: the screens, components,
// hooks, RPCs, tables, migrations and existing data stay exactly as they are,
// and turning a feature back on is a one-line change here. It is also NOT a
// security boundary — the backend for these features is still deployed and
// still enforces its own authorization (see the R2 report for which APIs
// remain callable).
//
// Pure module (no React Native imports) so it is unit-tested with Node
// (lib/beta-features.test.ts).

export const BETA_FEATURES = {
  /** CacheCase Registry: CacheCase ID, registration, registry pages and history. */
  registry: false,
  /** Ownership transfers: the profile Transfers section, transfer screens and notifications. */
  transfers: false,
  /** Group messaging: creating groups and Group Info. Existing group threads stay readable. */
  groupMessaging: false,
  /** Figurine as a new-item type (its details form cannot save yet). */
  figurineItems: false,
} as const;

export type BetaFeature = keyof typeof BETA_FEATURES;
export const isEnabled = (feature: BetaFeature): boolean => BETA_FEATURES[feature];

// Top-level route segments owned by each excluded feature.
export const FEATURE_ROUTES: Record<Exclude<BetaFeature, 'figurineItems'>, string[]> = {
  registry: ['registry', 'registry-history', 'claim-card'],
  transfers: ['transactions'],
  groupMessaging: ['group-info'],
};

// Notification types that only transfers produce.
export const TRANSFER_NOTIFICATION_TYPES = [
  'ownership_transfer_requested',
  'ownership_transfer_accepted',
  'ownership_transfer_declined',
  'ownership_transfer_cancelled',
] as const;

// Notification types hidden from the list and the unread badge right now.
export function hiddenNotificationTypes(): string[] {
  return isEnabled('transfers') ? [] : [...TRANSFER_NOTIFICATION_TYPES];
}

// Is this path (from a deep link or URL, with or without scheme/host,
// query or fragment) inside a feature that is switched off?
export function isExcludedPath(path: string): boolean {
  let p = path.trim();
  const devSeparator = p.indexOf('/--/');
  if (devSeparator >= 0) {
    // Expo development links: exp://host:port/--/registry/x
    p = p.slice(devSeparator + 3);
  } else {
    // scheme://host/... → for http(s) keep the path; for a custom scheme
    // the first segment after // is the route (cachecase://registry/x).
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?<rest>.*)$/i.exec(p);
    if (scheme) {
      const rest = scheme.groups!.rest;
      p = /^https?:/i.test(p) ? rest.replace(/^[^/]*/, '') : `/${rest}`;
    }
  }
  p = p.split(/[?#]/)[0];
  let first = '';
  try {
    first = decodeURIComponent(p.replace(/^\/+/, '').split('/')[0] ?? '').toLowerCase();
  } catch {
    return true; // malformed escape: refuse rather than guess
  }
  return (Object.keys(FEATURE_ROUTES) as (keyof typeof FEATURE_ROUTES)[])
    .some((f) => !isEnabled(f) && FEATURE_ROUTES[f].includes(first));
}

// Where an excluded deep link lands instead.
export const EXCLUDED_ROUTE_FALLBACK = '/';

import { EXCLUDED_ROUTE_FALLBACK, isExcludedPath } from '@/lib/beta-features';

// Incoming system links (cachecase://…, notifications, Spotlight) are
// rewritten before Expo Router navigates. A link into a feature switched off
// for this release (lib/beta-features.ts) lands on Home instead of a screen
// that isn't in the build's scope. app/_layout.tsx also removes those routes
// from the navigator (Stack.Protected), so this is the first of two guards.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return isExcludedPath(path) ? EXCLUDED_ROUTE_FALLBACK : path;
  } catch {
    return EXCLUDED_ROUTE_FALLBACK;
  }
}

// Shared route-ownership rules for the CacheCase (Collection) bottom-nav
// tab — used by both floating-bar implementations (app/(tabs)/_layout.tsx
// for the 5 tab screens, components/navigation/global-floating-tab-bar.tsx
// for every screen pushed outside the tabs group) so the center button
// lights up consistently across the whole collection-browsing hierarchy,
// not just on the exact /collection tab route.

// app/(tabs)/collection.tsx — the real Collection tab root.
export const COLLECTION_ROOT_ROUTE = '/collection';

// Every route prefix that counts as "inside the CacheCase hierarchy".
// Centralized here so a new collection-related screen only needs one
// addition to light up the tab correctly.
const CACHECASE_ROUTE_PREFIXES = [
  '/collection/', // app/collection/[folderId].tsx — folder gallery view
  '/category/', // future category-grouping screens (not yet built)
  '/folder/', // app/folder/[id].tsx — folder/player detail
  '/item/', // app/item/[id].tsx, app/item/new.tsx — item detail/creation
];

// app/cachecase-id.tsx — a flat, non-prefixed route (no trailing slash to
// match against), so it's checked by exact equality alongside
// COLLECTION_ROOT_ROUTE rather than added to the prefix list above.
const CACHECASE_ID_ROUTE = '/cachecase-id';

export function isCacheCaseRoute(pathname: string): boolean {
  return (
    pathname === COLLECTION_ROOT_ROUTE ||
    pathname === CACHECASE_ID_ROUTE ||
    CACHECASE_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

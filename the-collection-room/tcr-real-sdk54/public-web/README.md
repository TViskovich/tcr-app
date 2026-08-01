# CacheCase Public Registry (public-web)

Anonymous, read-only public website for CacheCase registry lookups. Serves
`https://cachecase.app/registry/<cc-id>` as a **separate deployment** from
the Expo app — it does not share code, a route, or a database connection
with `app/registry/[id].tsx` in the main repo. Every piece of registry data
this site ever shows comes from one source: the `get-public-registry-card`
Supabase Edge Function (`../supabase/functions/get-public-registry-card`).
This project never queries `registered_cards`, `registry_events`,
`profiles`, Storage, or `ownership_transfers` directly, and has no
Supabase client (browser or server) at all — just a `fetch()` call to that
one Edge Function's HTTP endpoint.

## Setup

```bash
npm install
cp .env.local.example .env.local
# then fill in NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL in .env.local
```

`NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL` is the Supabase Functions namespace
base URL for the project (e.g.
`https://izlrxenomerfeqhmlyre.supabase.co/functions/v1`), **not** the full
URL of one function — `get-public-registry-card` is appended in
`lib/registry-api.ts`. This value is public configuration, not a
credential (the same category as `EXPO_PUBLIC_SUPABASE_URL` in the Expo
app); the Edge Function is intentionally callable without a user
authentication token.

## Local development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Try:

- A known public `cc_id`, e.g. `/registry/CC-375X-X37T`
- An unknown `cc_id`, e.g. `/registry/CC-0000-0000` → "Registry record not found"
- A card whose `snapshot_title`/`snapshot_player`/etc. are all null → identity section still renders cleanly
- A card with no ready snapshot image → placeholder tile, no broken image
- Custody statuses, especially `on_loan` (neutral badge) and `stolen`/`missing`/`destroyed` (warning badge)

## Validation

```bash
npm run lint
npm run build
```

`next build` will NOT attempt to prerender `/registry/[ccId]` pages ahead
of time — `cc_id` values are created dynamically at runtime and there is
no `generateStaticParams`, so the route is served dynamically per request
(SSR), never as a static export.

## Deploying to Vercel

1. In the Vercel dashboard, **Add New Project** → import this Git repository.
2. Set **Root Directory** to `public-web` (this is a subdirectory of the
   `tcr-real-sdk54` repo, not its own repo — Vercel's Root Directory
   setting is what scopes the build to this folder).
3. Framework preset: Next.js (auto-detected).
4. Add the environment variable `NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL` with
   the same value as `.env.local`, for the Production/Preview/Development
   environments as needed.
5. Deploy. Vercel assigns a `*.vercel.app` URL immediately — the site is
   fully functional there without any custom domain.
6. **Once `cachecase.app` ownership/DNS is confirmed** (not yet verified —
   see the project's root README/CLAUDE.md audit notes): in this Vercel
   project's Settings → Domains, add `cachecase.app`, then add the DNS
   records Vercel provides (typically an `A`/`ALIAS` record for the apex
   domain, or a `CNAME` if using a subdomain) at whatever registrar/DNS
   provider controls `cachecase.app`. This is a manual step in the DNS
   provider's dashboard — nothing in this repo changes DNS automatically.
7. Do **not** attach this project to any existing/unrelated Vercel
   project — it is a new, standalone Vercel project.

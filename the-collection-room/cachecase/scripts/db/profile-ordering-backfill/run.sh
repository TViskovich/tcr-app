#!/usr/bin/env bash
# Profile ordering backfill regression test — LOCAL Supabase only.
#
# Proves 20261026120000_add_profile_ordering.sql's backfill keeps every
# existing order exactly as the app showed it (collections per sibling
# group, the Items tab per owner — including 1,500 items, past one API
# page — and each collection's own item order):
#   1. reset the LOCAL database to the migration just before it,
#   2. seed known data and snapshot today's newest-first order (seed.sql),
#   3. apply the pending migration,
#   4. compare (check.sql) — exits non-zero on any difference.
#
# DESTROYS the local database's data (that's what `db reset --local` does).
# Every Supabase command passes --local, so the linked project is never
# touched. Run `npx supabase db reset --local` afterwards for a clean DB.
set -euo pipefail

cd "$(dirname "$0")/../../.."
here="scripts/db/profile-ordering-backfill"
db_container="supabase_db_$(sed -n 's/^project_id = "\(.*\)"/\1/p' supabase/config.toml)"

echo "== 1. reset LOCAL db to the version before the ordering migration"
npx supabase db reset --local --no-seed --version 20261025120000

echo "== 2. seed + snapshot the pre-migration order"
docker exec -i "$db_container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$here/seed.sql"

echo "== 3. apply pending migrations (LOCAL)"
npx supabase migration up --local

echo "== 4. compare"
docker exec -i "$db_container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$here/check.sql"

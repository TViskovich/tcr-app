# Group Messaging M1 — on hold

Group Messaging is complete but **not approved for production**. Its database
migration and pgTAP test are kept here, outside `supabase/`, so that
`supabase db push` and `supabase test db` cannot pick them up. Nothing here has
ever been applied to production.

| File | Was | Purpose |
| --- | --- | --- |
| `migrations/20261101130000_add_group_conversations.sql` | `supabase/migrations/` | Group conversations schema, RLS, server functions |
| `tests/group_conversations.test.sql` | `supabase/tests/database/` | pgTAP security tests for it (110 tests) |

Moved unchanged (same SHA-256 before and after).

Everything else for Group Messaging stays in place and is dormant without this
migration: the app code (`lib/group-chat.ts`, `app/group-info/`, the
conversation/inbox changes) detects the missing schema and hides all group
features, and the integration tests (`scripts/integration/group-messaging.ts`,
`scripts/integration/ui/group-messaging-ui.mjs`) need the migration to pass.

## Resuming

Production has since gained `20261102120000_add_collector_tagging.sql`, so a
migration dated 2026-11-01 would be older than the last applied one. To resume
without `--include-all` or any history repair:

1. Copy the migration back into `supabase/migrations/` under a **new timestamp
   later than every applied migration** (it has never been applied anywhere
   that matters, so renaming it is forward-only safe). Check first that no
   other environment has `20261101130000` recorded in its history.
2. Copy the test back into `supabase/tests/database/`.
3. `supabase db reset` (local), `supabase test db`, and rerun both group
   integration tests.
4. `supabase db push --linked --dry-run` must list only the group migration.

The migration is independent of collector tagging (no shared objects); it only
needs the schema that production already has.

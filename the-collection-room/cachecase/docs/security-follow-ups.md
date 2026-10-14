# Security follow-ups

Open items found during audits that are recorded here and not yet fixed.

## SF-1: Conversation membership can be probed by any signed-in user

**Status:** Open, not yet verified against a live database. Found 2026-10-11 during the staging load-test smoke test investigation.
**Severity:** Low.

### What is exposed

`public.is_conversation_participant(conv_id uuid, uid uuid)` is a `SECURITY DEFINER` function with EXECUTE granted to `authenticated` (see `20260725120000_secure_dm_direct_access.sql`). Because it takes the user to check as an argument, a signed-in user can call it directly through PostgREST (`POST /rest/v1/rpc/is_conversation_participant`) with any conversation id and any user id. The answer reveals whether that user belongs to that conversation, even when the caller is not a participant.

No message content, participant list or conversation metadata is exposed. The caller must already know the conversation's UUID, which is random and not guessable. It is the same pattern `20261018120000_harden_function_execute_grants.sql` closed for `_folder_is_effectively_visible_for`.

### Why authenticated still has EXECUTE

The function backs these RLS policies, which run as the querying user and therefore need it: `messages_select`, `messages_insert`, `conversations_select`, `conversations_update`, `participants_select`, and the `dm_attachments_select_participant` / `dm_attachments_insert_participant` Storage policies. Revoking EXECUTE from `authenticated` alone would break all signed-in messaging.

### Possible fix (not implemented)

Have the policies call a helper that takes only the conversation id and checks `auth.uid()` internally, e.g. `is_my_conversation(conv_id uuid)`. Then revoke EXECUTE on the two-argument function from `authenticated`, keeping it for `service_role` only. A caller could then ask only about their own membership.

In the same migration, consider adding `TO authenticated` to `messages_select`, `conversations_select` and `participants_select`. Signed-out queries would then return zero rows instead of failing with `42501 permission denied for function is_conversation_participant`. That error is a fail-closed denial and not a leak; the smoke test accepts it, see `scripts/loadtest/smoke-user-access.ts`.

### Before fixing

1. Confirm on staging, read-only: signed in as `lt_user_03`, call the RPC with the `lt_user_01`↔`lt_user_02` conversation id and `lt_user_01`'s id. A `true` result confirms the leak.
2. Re-run `scripts/loadtest/smoke-user-access.ts` after the migration. All messaging checks must still pass.

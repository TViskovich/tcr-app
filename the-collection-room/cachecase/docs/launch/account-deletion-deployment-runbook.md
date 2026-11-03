# Account deletion: production deployment runbook

Dashboard Milestone 2, Checkpoints 1–5. Draft for review. Nothing here has been run against production or staging.

**Audience:** the operator deploying the account lifecycle, Download My Data and permanent deletion to production.

**Rule:** run every step in order. Do not continue past a failed check. Steps marked **APPROVAL** need explicit sign-off from the project owner before they run.

## Design of the order

The order guarantees that no scheduled or user-triggered deletion can run before everything it depends on exists:

1. **Secrets come first.** They are inert until code reads them.
2. **Migrations come next,** and they are safe for the current app and functions:
   - no account is in `account_lifecycle`, so the new guards hide nothing;
   - the maintenance cron job is created **inactive** (migration `20261107120000`).
3. **Functions come after the migrations.** Every function imports `_shared/registry-image.ts`, whose `resolveCaller` now reads `account_lifecycle`.
4. **The scheduler is activated only after the worker has been called by hand and verified.** Delete Now is offered only when `account_deletion_preflight()` reports `ready`:
   - the username key is present (32 characters or more);
   - the Vault `project_url` and `account_maintenance_secret` (32 characters or more) are present;
   - the cron job is active.
5. **The app ships last.** It only shows Delete Now when the server says it is available.

---

## 0. Pre-flight (read-only)

| # | Check | How | Pass when |
|---|---|---|---|
| 0.1 | Backups | Dashboard → Database → Backups | A daily backup from the last 24 h exists. Note the retention (currently 7 days, PITR off). |
| 0.2 | Storage upload limit | Dashboard → Storage → Settings → Global file size limit | **Record the value.** It is needed for step 1.4. It must be ≥ 46 MiB for the default part size. |
| 0.3 | Extensions available | Dashboard → Database → Extensions | `pg_cron` and `pg_net` are listed. The migration enables them. |
| 0.4 | Pending migrations | `supabase migration list --linked` | The only remote-missing entries are the expected ones (see step 2). |
| 0.5 | Schema preconditions | SQL editor, read-only queries below | All return the expected result. |
| 0.6 | Direct conversations with fewer than 2 participants | Query below | Note the count. These become read-only "Deleted account" threads after migration. Expected: 0. |

```sql
-- 0.5 (expect: 1 row, 'posts_item_requires_image')
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.posts'::regclass
  AND pg_get_constraintdef(oid) = 'CHECK (((post_type <> ''item''::text) OR (image_url IS NOT NULL)))';
-- expect 0 rows each
SELECT 1 FROM pg_namespace WHERE nspname = 'private';
SELECT name FROM vault.secrets
WHERE name IN ('username_reservation_key', 'project_url', 'account_maintenance_secret');

-- 0.6
SELECT count(*) FROM public.conversations c
WHERE (SELECT count(*) FROM public.conversation_participants p WHERE p.conversation_id = c.id) < 2;
```

## 1. Secrets and configuration — **APPROVAL**

1. **Generate two secrets.** Generate them on a trusted machine and store both in the team password manager *before* using them:

   ```sh
   openssl rand -hex 32   # username reservation key
   openssl rand -hex 32   # maintenance secret
   ```

   > **The username reservation key must never be lost or rotated while reservations exist (up to 90 days after the last deletion).**
   > - **If it is lost or changed:** existing reservations can no longer be matched. Sign-up then fails closed (`username_reservation_unavailable`) until it is restored, or until every reservation has expired.
   > - **If it is deleted:** sign-up is refused while reservations exist, and deletion processing stops.

2. **Create the Vault secrets** (SQL editor, run as postgres):

   ```sql
   SELECT vault.create_secret('<username key>', 'username_reservation_key');
   SELECT vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   SELECT vault.create_secret('<maintenance secret>', 'account_maintenance_secret');
   ```

3. **Set the Edge Function secrets:**

   ```sh
   supabase secrets set ACCOUNT_MAINTENANCE_SECRET='<maintenance secret>' --project-ref <ref>
   ```

4. **Set the export part size from 0.2.** The part size must be at most the upload limit minus 1 MiB, and no more than 45 MiB is recommended. With the 50 MB default, leave it unset (the default is 45 MiB):

   ```sh
   supabase secrets set ACCOUNT_EXPORT_PART_BYTES=<bytes> --project-ref <ref>   # only if the limit is lower
   ```

5. **Do NOT set `ACCOUNT_RECENT_AUTH_SECONDS`.** It is a test-only override and can only shorten the 10-minute window.

6. **Alert delivery (monitoring, §7).** Configure at least one channel. With none, alerts are only logged and shown to admins in the Dashboard.
   - **Email, through the existing Resend account:**

     ```sh
     supabase secrets set ACCOUNT_ALERT_EMAIL_TO='<ops address>[,<second address>]' --project-ref <ref>   # up to 5
     supabase secrets set ACCOUNT_ALERT_FROM_EMAIL='<verified sender>' --project-ref <ref>              # optional
     ```

     - `RESEND_API_KEY` is already set for the waitlist.
     - Without `ACCOUNT_ALERT_FROM_EMAIL`, alerts are sent from `WAITLIST_FROM_EMAIL`.
     - The sender's domain must be verified in Resend.
   - **Webhook** (optional; for example a Slack incoming webhook or your own endpoint):

     ```sh
     supabase secrets set ACCOUNT_ALERT_WEBHOOK_URL='https://…' --project-ref <ref>
     supabase secrets set ACCOUNT_ALERT_WEBHOOK_SECRET="$(openssl rand -hex 32)" --project-ref <ref>   # optional: signs the body
     ```

     - The URL must use https.
     - With a secret, each request carries `X-CacheCase-Signature: sha256=<HMAC-SHA256 of the body>`.
   - **Label** (optional): `supabase secrets set ACCOUNT_ALERT_ENVIRONMENT=production --project-ref <ref>` adds the label to the subject line.
   - Alerts are sent through the same Vault values as the scheduler (`project_url`, `account_maintenance_secret`). Nothing extra is needed in Vault.

## 2. Database migrations (forward-only) — **APPROVAL**

1. Dry run, and confirm the list:

   ```sh
   supabase db push --linked --dry-run
   ```

   Expected new migrations, in this order (plus any earlier unapplied ones confirmed in 0.4):
   - `20261103120000_add_account_lifecycle`
   - `20261104120000_account_lifecycle_dm_privacy`
   - `20261105120000_add_account_exports`
   - `20261106120000_account_permanent_deletion`
   - `20261106130000_account_export_parts`
   - `20261106140000_account_maintenance_schedule` (enables `pg_cron` and `pg_net`; creates the job)
   - `20261107120000_account_deletion_launch_hardening` (deactivates the job)
   - `20261107130000_lifecycle_query_performance` (adds 7 indexes; tables are small, brief locks)
   - `20261108120000_account_deletion_monitoring` (monitoring tables, the extended admin summary, and the `account-deletion-monitor` cron job, created **inactive**; it is activated in §7.1)

2. Apply:

   ```sh
   supabase db push --linked
   ```

   - Each migration runs in its own transaction.
   - A failure stops at that migration, with nothing from it applied.
   - **Never use `migration repair`.**

3. **Verify:**

   ```sql
   SELECT public.account_deletion_preflight();
   -- expect {"ready": false, "scheduler_configured": false, "username_key_configured": true}
   SELECT jobname, schedule, active FROM cron.job;
   -- expect: account-maintenance | */10 * * * * | f
   --         account-deletion-monitor | */15 * * * * | f
   SELECT count(*) FROM public.account_lifecycle;   -- expect 0
   SELECT count(*) FROM pg_policies
   WHERE policyname IN ('account_lifecycle_read_guard', 'account_lifecycle_conversation_guard');
   ```

**What is live from this moment (with no lifecycle rows, there is no visible change):**
- **Lifecycle read and write guards.**
- **The final-deletion trigger on `auth.users`.** Any user deleted from the Dashboard now also gets the retention policy applied, though not a username reservation.
- **Fail-closed username reservations.** None exist yet.
- **The read-only rule for direct conversations with one participant.**

## 3. Edge Functions — **APPROVAL**

Deploy **all** functions: every one imports `_shared/registry-image.ts`, which changed.

```sh
supabase functions deploy --project-ref <ref>
```

- `account-maintenance` deploys with gateway JWT verification **off**, from `supabase/config.toml`. It checks its own secret in constant time.
- `account-monitor` (alert delivery) also deploys with JWT verification **off**, and checks the same secret.
- Confirm in Dashboard → Edge Functions that `account-maintenance` and `account-monitor` show **Verify JWT: off** and that every other function is unchanged (on, unless already configured otherwise).

**Version compatibility:**
- The new functions need the step 2 schema. They must never be deployed before it.
- The current App Store / TestFlight build never calls `account-deletion`, `account-export` or `account-maintenance`.
- `redeem-waitlist-invite` keeps the same request and response contract. Its only addition is the existing `retry` reason, returned when reservations can't be checked.

## 4. Verify the worker by hand (scheduler still inactive)

```sh
# wrong secret → 403
curl -s -X POST https://<ref>.supabase.co/functions/v1/account-maintenance \
  -H 'Authorization: Bearer wrong' -d '{}'
# real secret → 200, ready:true, started:0, processed:[]
curl -s -X POST https://<ref>.supabase.co/functions/v1/account-maintenance \
  -H "Authorization: Bearer $ACCOUNT_MAINTENANCE_SECRET" -d '{}'
```

**Pass when:**
- the wrong secret returns 403;
- the real secret returns `{"status":"ok","ready":true,"started":0,"processed":[], "exports":{"status":"ok",…}, "housekeeping":{…}}`;
- the function logs show one `{"fn":"account-maintenance","outcome":"run",…}` line with no `alert`.

## 5. Activate the scheduler — **APPROVAL**

Once the scheduler is active:
- accounts whose 14-day window has ended **start being deleted irreversibly** (none exist at launch);
- Delete Now becomes available.

```sql
SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-maintenance';
SELECT public.account_deletion_preflight();   -- expect "ready": true
```

**After 10–20 minutes:**

```sql
SELECT status, return_message, start_time FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'account-maintenance')
ORDER BY start_time DESC LIMIT 3;                       -- expect succeeded
SELECT status_code, left(content, 120), created FROM net._http_response
ORDER BY created DESC LIMIT 3;                          -- expect 200
```

## 6. Smoke test with disposable accounts — **APPROVAL** (creates and permanently deletes test accounts in production)

**Use only accounts created for this test.** Use an `@example.test`-style address you control, and a username you never need again: it will be reserved for 90 days. Never use a real collector's account.

1. **Create two invite-redeemed test accounts, T1 and T2.** On each, add one collection, one item with one photo, one post, and one DM between T1 and T2.
2. **T1: Download My Data.** Wait for Ready. Download every part, and check that each opens and that `manifest.json` lists the parts.
3. **T1: Delete After 14 Days.** Check the Pending screen and that T2 no longer sees T1. Cancel, and check that everything is back.
4. **T1: Delete Permanently Now.** Watch "Your account is being deleted", then "Your account has been deleted".
5. **Verify** (SQL):
   - T1's job is `completed`;
   - `auth.users` has no T1;
   - `storage.objects` has no object under T1's folders;
   - T2 sees the thread as "Deleted account", read-only;
   - signing up again with T1's username is refused.
6. **Delete T2 the same way.**
7. **Record the job ids.** They are purged automatically after 30 days.

## 7. Monitoring and alerts

### 7.1 Activate monitoring — **APPROVAL**

Only after the worker is verified (§4), the scheduler is active (§5), the smoke test has passed (§6), and the alert secrets are set (§1.6).

1. **Check the channels.** Call the alert function by hand. With nothing due it sends nothing, and only reports its channels:

   ```sh
   curl -s -X POST https://<ref>.supabase.co/functions/v1/account-monitor \
     -H "Authorization: Bearer $ACCOUNT_MAINTENANCE_SECRET" -d '{}'
   # expect {"status":"ok","notices":0,"channels":{"email":"configured", …}}
   ```

   - **Pass:** at least one of `email` / `webhook` is `configured`.
   - **`missing_recipients`:** set `ACCOUNT_ALERT_EMAIL_TO` (§1.6).
   - **`missing_sender`:** set `ACCOUNT_ALERT_FROM_EMAIL` or `WAITLIST_FROM_EMAIL`.
   - **`invalid_url`:** the webhook URL must use https.
   - **`not_configured`:** that channel is not in use.
   - **A 403** means the Vault and Edge Function secrets differ.
2. **Confirm in SQL:**

   ```sql
   SELECT private.account_monitoring_snapshot() -> 'alerts';
   -- expect "channel_configured": true, "monitor_active": false
   SELECT private.account_monitoring_snapshot() ->> 'status';   -- expect healthy
   ```

3. **Activate:**

   ```sql
   SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'account-deletion-monitor';
   SELECT private.account_monitoring_snapshot() #>> '{alerts,monitor_active}';   -- expect true
   ```

   The Dashboard's Account Deletions row now reads "Alerts on · via …".
4. **Verify an alert end to end:**
   1. While a §6 test account is pending deletion, deactivate `account-maintenance` (§9).
   2. Within 15 minutes, expect a `scheduler_inactive` notice on every configured channel. `last_delivery_channels` in the snapshot names the channels that accepted it.
   3. Re-activate the scheduler (§5). Expect a resolved notice within 15–30 minutes.
   4. Cancel or delete the test account as in §6.

**How it works:**
- **Every 15 minutes** the `account-deletion-monitor` cron job checks health in SQL. The check does not depend on the maintenance worker or its Edge Function.
- **It records each issue** as an open or resolved alert.
- **It calls `account-monitor`**, which sends one digest through every configured channel (§1.6), when:
  - an issue opens;
  - an issue is still open after 24 h;
  - an issue resolves.
- **A failed delivery** is retried after 1 hour.
  - A notice counts as delivered only when a channel accepts it (2xx).
  - Otherwise `last_delivery_error` gives the reason: `alert_recipients_missing`, `alert_sender_missing`, `alert_webhook_invalid`, `alert_channel_not_configured`, `webhook_rejected`, `webhook_unreachable`, `resend_rejected` or `resend_unreachable`.
- **Channel report:** `account-monitor` reports its channel status on every call, and at least every 6 hours. Admins see it as "Alerts on/off · via email + webhook" or "no delivery channel configured".
- **Alerts contain only** issue codes, counts and times: no emails, usernames or account ids.

**Where to look:**
- **Admins:** App Dashboard → Admin Tools → **Account Deletions**. It shows:
  - the status and open issues;
  - the last successful maintenance run;
  - overdue, in-progress (over 1 h) and failed deletions;
  - failed and abandoned exports;
  - undelivered alerts.
- **From SQL:** `SELECT private.account_monitoring_snapshot();`
- **Delivery check:** `SELECT * FROM private.account_monitoring_alerts;` shows each alert with `notified_at` and `last_delivery_error`.

| Issue code | Raised when | Action |
|---|---|---|
| `scheduler_not_configured` | Vault `project_url` / `account_maintenance_secret` (≥ 32 characters) or the username key is missing, while the scheduler is active or deletions are pending | Restore the values (§1.1–1.2). |
| `scheduler_inactive` | The `account-maintenance` job is inactive while deletions are pending | Re-activate it (§5) once the cause is fixed. |
| `maintenance_runs_missing` | Active, but no successful run for 30 min | Check `cron.job_run_details`, the `account-maintenance` function logs and its deployment. |
| `maintenance_calls_failing` | The last 3 scheduled calls failed (non-2xx, timeout, or no answer) | A 403 means the Vault and Edge Function secrets differ. A 5xx means the function logs show the cause. |
| `deletions_failed` | Any deletion job is `failed` | Follow §8. |
| `deletions_overdue` | A recovery window ended over 1 h ago and deletion hasn't started | The scheduler isn't enqueueing. See the issues above. |
| `deletions_stuck` | A deletion has been in progress for over 1 h | Check the job's `last_error_code` and `step_failures` (§8). |
| `deletion_leases_expired` | A job's lease ended over 15 min ago and no run picked it up | Runs are crashing mid-job, or none are running. Check the function logs. |
| `exports_failing` | 3 or more Download My Data exports failed (not abandoned) in 24 h | Check the `account-export` function logs and Storage. |
| `exports_stuck` | An export has been untouched in progress for over 25 h | The maintenance sweep isn't running. See the scheduler issues. |

**Log lines:**

| Signal | Where | Action |
|---|---|---|
| `"alert":"account_deletion_monitoring"` | `account-monitor` logs | One line per digest, with `delivered` / `delivery_error`. |
| `"alert":"account_monitoring_no_channel"` | same | No channel can deliver. Fix §1.6. |
| `"alert":"account_deletion_failed"` | `account-maintenance` logs | Follow §8. |
| `"alert":"account_deletion_not_configured"` | same | The username key is missing: restore it (§1.1). |
| `"alert":"account_deletion_late_files_failed"` | same | Check Storage health; the next run retries. |

**Limits:**
- **Notices are not instant.** They arrive within 15 minutes of an issue, and an answer from pg_net is kept for 6 h only.
- **If the database or pg_cron is down, nothing alerts.** Use Supabase's own project health notifications for that.
- **If Edge Functions are down entirely,** issues are still recorded and shown in the Dashboard, but no notice is sent.

## 8. Failure recovery

**Failed job** (status `failed`, after 8 consecutive failed runs):

```sql
SELECT id, status, last_error_code, step_failures, objects_total, objects_deleted, failed_at
FROM public.account_deletion_jobs WHERE status = 'failed';
```

| Code | Meaning | Fix |
|---|---|---|
| `storage_remove_failed` / `storage_remove_ineffective` / `storage_check_failed` | Storage refused, or didn't remove, a file | Check Storage health and the object path. |
| `auth_delete_failed` | Auth refused to delete the user | Check the Auth logs. A trigger error such as `username_reservation_key_missing` means the key is gone. |
| `verification_failed` | The user, profile or files are still present after deletion | Investigate before re-queueing. |
| `manifest_failed` / `export_check_failed` | A database call failed | Check the database logs. |

After fixing the cause, re-queue the job. It is idempotent and resumes from its stage:

```sql
UPDATE public.account_deletion_jobs
SET status = 'queued', step_failures = 0, failed_at = NULL, next_attempt_at = now()
WHERE id = '<job id>' AND status = 'failed';
```

- **A user asks to restore a pending account** (still within 14 days): they can cancel themselves by signing in. An operator can also run `SELECT public.cancel_account_deletion('<user id>');` as service role.
- **An account in `deleting` cannot be restored.** That is by design.

## 9. Rollback and mitigation

The migrations are forward-only. Mitigate rather than revert:

| Problem | Mitigation | Effect |
|---|---|---|
| Deletions misbehaving | `SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-maintenance';` | Processing pauses. Delete Now becomes unavailable within one status check. Jobs resume safely when re-activated. |
| Need to stop Delete Now only | Unset `ACCOUNT_MAINTENANCE_SECRET` | Delete Now is unavailable. **Warning:** the kick-off and the scheduler's 403 also stop, so pair this with deactivating cron. |
| A bad function deploy | Redeploy the previous commit's function source. Earlier versions of the new functions don't exist, so deactivate cron instead. | — |
| Alerts too noisy or misdirected | `SELECT cron.alter_job(job_id := jobid, active := false) FROM cron.job WHERE jobname = 'account-deletion-monitor';` or unset the alert secrets | Monitoring stops; deletion is unaffected. |
| A guard hides too much or too little | A forward-fix migration. Pending accounts can be cancelled by an operator. | — |
| Data deleted wrongly | The only recovery is a whole-project restore from a daily backup (≤ 7 days). **APPROVAL**: it is destructive for every other change since then. | — |

## 10. App release readiness

The app goes out only after steps 1–6 pass. Before it ships:
- [ ] The privacy policy is updated and approved by legal (see `privacy-policy-draft-account-deletion.md`), and the in-app wording matches it.
- [ ] A support contact is configured in `lib/support-contact.ts`. Today it is `null`, so the failed-deletion screens show no contact.
- [ ] Native iOS checks on a real iPhone (the list in the Checkpoint 5 report).
- [ ] Hosted checks:
  - [ ] multipart export uploads (TUS) succeed against hosted Storage;
  - [ ] the part size fits the confirmed upload limit;
  - [ ] the scheduler's `pg_net` calls reach the function.
- [ ] Registry, Transfers and Group Messaging are still hidden or inactive in the release build.

# Moderation monitoring and alerts: operations runbook

For CacheCase admins and the on-call operator. It covers what the monitor watches, how issues and alerts behave, how to switch delivery on, and what to do when an alert arrives.

**Status (2026-11-12):** built in Phase 2B M4 step 5B and tested only on an isolated local stack. Nothing is deployed. Alert delivery is **off**, and the `moderation-monitor` job is **inactive** everywhere.

## 1. What is watched

The monitor reads database state only. It never claims that a file has gone from a CDN or the physical object store just because the database says so.

| Code | Severity | Condition |
|---|---|---|
| `child_safety_unquarantined` | critical | Child-safety media not quarantined more than 5 minutes after the decision |
| `public_removal_overdue` | critical | Public media still at its public source more than 15 minutes after a removal decision |
| `integrity_failure` | critical | A flagged checksum, copy or object-identity failure, in quarantine jobs or purge items |
| `public_origin_reachable` | critical | **Not detectable in SQL.** Needs a hosted Storage-origin or CDN probe; catalogued, never opened |
| `scheduler_stalled` | high | Scheduler switch on, work waiting over 10 minutes, no completed scheduled run in that time |
| `quarantine_attempts_exhausted` | high | Jobs flagged after their whole retry budget |
| `quarantine_needs_attention` | high | Jobs flagged for another reason |
| `urgent_reports_overdue` | high | Urgent reports open longer than the threshold (60 minutes by default; placeholder pending approval) |
| `restore_conflict` | routine | Restorations blocked: destination occupied, owner unavailable, or held again |
| `quarantine_lease_stale` | routine | Non-child-safety leases expired over 10 minutes ago and not picked up again |
| `purge_approval_pending` | routine | Manual purge runs waiting for a second administrator |
| `purge_run_incomplete` | routine | Purge runs that expired, ran out of time, or have items needing attention |

## 2. Issues and alerts

- **One issue per condition.** Each issue has a stable identity (its code), and there is never more than one open issue per identity. The issue records when it opened, the current and peak counts, the oldest affected time, when it was last seen and when it resolved. A recurrence is a new issue.
- **Critical and high** issues send a notice when they open, when they get worse (at most hourly), as a reminder after 24 hours, and when they resolve. Unresolved child-safety issues are reminded **hourly**.
- **Routine** issues are never sent on their own; they appear in a **daily summary**, sent only while issues are open.
- **Acknowledging** an issue (`admin_acknowledge_moderation_issue`) means someone is on it. It never resolves the issue. Ordinary reminders pause until the issue worsens or resolves; critical reminders continue.
- **Failed delivery** is retried after 15 minutes, then 30, 60, 120, 240, then every 6 hours. One channel accepting the message counts as delivered.
- **Storm limits:** at most 20 notices per message, one message per channel per run, and one monitor run at a time (concurrent runs return `busy`).
- **Always visible:** `admin_moderation_monitoring_overview()` refreshes the check and lists every open issue, routine ones included, even while delivery is off or failing.

## 3. What an alert contains

Only: the environment label, a delivery id, the time, and for each issue its notice kind, category, code, severity, count, age of the oldest affected record and an admin page path such as `/admin/moderation/quarantine`.

Never: collector or reporter names or ids, account, job or report ids, message or post text, Storage paths, image URLs, evidence, hashes, moderation notes or secrets. Logs carry codes and counts only.

## 4. Channels and credentials

All credentials are dedicated to moderation alerts. None of the account-monitoring credentials are used.

| Setting | Purpose |
|---|---|
| `MODERATION_MONITOR_SECRET` (≥ 32 chars; also Vault `moderation_monitor_secret`) | The only credential that can call `moderation-monitor` |
| `MODERATION_ALERT_RESEND_API_KEY` | Resend key used only for these alerts |
| `MODERATION_ALERT_EMAIL_TO` | 1–5 addresses. More than 5 is refused (`too_many_recipients`); one invalid address disables email (`missing_recipients`) |
| `MODERATION_ALERT_FROM_EMAIL` | A verified sender |
| `MODERATION_ALERT_WEBHOOK_URL` | https only |
| `MODERATION_ALERT_WEBHOOK_SECRET` (≥ 32 chars) | Required; a webhook is never sent unsigned |
| `MODERATION_ALERT_ENVIRONMENT` | A label for subject lines, e.g. `production` |

**Webhook verification (receiver side).** Each request carries three headers:
- `X-CacheCase-Timestamp` (unix seconds);
- `X-CacheCase-Delivery` (a UUID);
- `X-CacheCase-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<delivery>.<raw body>")>`.

Reject a request when the signature does not match, when the timestamp is more than 5 minutes off, or when the delivery id has already been accepted. A retry after a failure is a new delivery with a new id.

## 5. Switching delivery on (needs separate written approval; not done anywhere)

1. Confirm the target project and that the approval covers it.
2. Set the function secrets in section 4, and put `moderation_monitor_secret` in Vault next to `project_url`.
3. Deploy `moderation-monitor` with JWT verification off, as `config.toml` specifies.
4. Check: a call without the secret returns 401, and a call with it returns `delivery: disabled`.
5. Turn delivery on: `UPDATE private.moderation_monitoring_state SET delivery_enabled = true WHERE id;` (recorded in `moderation_monitoring_config_changes`).
6. Activate the job: `SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'moderation-monitor';`
7. Confirm the first delivery in `admin_moderation_monitoring_overview()`.

**Switching off:** undo steps 6 and 5. Issues keep being recorded whenever an admin opens the overview.

## 6. When an alert arrives

1. Open the admin page named in the alert, then the overview, to see the open issue, its count and age.
2. **Acknowledge** it so others know it is being handled. This does not resolve it.
3. Act according to the code:
   - `child_safety_unquarantined`, `public_removal_overdue`: run the quarantine worker (`admin-media-quarantine`) and check the job status. If jobs keep failing, treat it as `needs_attention`.
   - `integrity_failure`: **freeze**. Do not retry, cancel or purge. Read the job's events and error code, check holds and the child-safety flag, and escalate to engineering. Purge items flagged `object_reappeared` or `object_missing_unverified` need a Storage investigation (see the retention runbook).
   - `quarantine_attempts_exhausted`, `quarantine_needs_attention`: read the error code in `admin_media_quarantine_overview`. Retry with `admin_media_quarantine_retry` only once the cause is understood.
   - `scheduler_stalled`: check `admin_media_quarantine_scheduler_status()` and the function logs. If in doubt, switch the scheduler off and run the worker manually.
   - `urgent_reports_overdue`: review the urgent queue.
   - Routine codes: handle during normal working hours.
4. The issue resolves on its own when the condition clears; with delivery on, a "resolved" notice follows.
5. Never paste report content, ids or paths into tickets or chat. Refer to the issue code and the time instead.

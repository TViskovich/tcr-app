# Media quarantine: operations runbook

For CacheCase admins and the on-call operator. It covers how moderated media leaves public storage, how to watch the queue, what to do with a flagged job, how to restore media, and how to clean up orphaned share snapshots.

**Status (2026-11-12):** built and tested on a local stack only. Nothing is deployed and there is no admin UI yet. An automatic scheduler exists (section 8) but is **off everywhere**; until it is approved and switched on, every command below is a manual admin call.

## 1. How it works

1. An admin restricts content or clears a profile field (M2.1 or M2.2). In the same database transaction, every affected file is **queued** as a quarantine job: public avatars, hero images, badges and share snapshots always; private item images, folder covers and DM photos only for child-safety restrictions.
2. From that moment collectors cannot delete, overwrite, move or re-link the file. Child-safety files are also no longer signed, exported or readable by anyone.
3. **The file is still publicly reachable until the worker runs.** The worker (`admin-media-quarantine`) has Storage copy the file into the private `moderation-quarantine` bucket (server-side; the file never passes through the worker's memory), verifies the copy byte for byte (streamed SHA-256 and size), removes the public original, and confirms the original is gone.
4. When every restriction holding a file is lifted, the job waits in `restore_pending`. Nothing is restored automatically. An admin runs `admin-media-restore`, which writes the exact original bytes back and verifies them.
5. Private copies are never deleted by these functions. Ordinary copies get a 90-day retention date for the future M4 purge. Child-safety copies carry a legal hold with no end date.

## 2. Calling the functions

All three functions need a signed-in **admin** session token (an account in `admin_users` that is not pending deletion). Never paste the service-role key or a secret into these calls.

```sh
# Process up to 10 queued jobs. A run stops after about 25 seconds, or once it
# has hashed about 64 MB (one 50 MB file), whichever comes first.
curl -X POST "$PROJECT_URL/functions/v1/admin-media-quarantine" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" -d '{"limit": 10}'

# Restore specific jobs (ids come from the overview or job status).
curl -X POST "$PROJECT_URL/functions/v1/admin-media-restore" ... \
  -d '{"job_ids": ["<job id>"]}'          # add "confirm_child_safety": true for child-safety media

# Orphaned snapshots: dry run first (the default), then run.
curl -X POST "$PROJECT_URL/functions/v1/admin-snapshot-reconcile" ... -d '{}'
curl -X POST "$PROJECT_URL/functions/v1/admin-snapshot-reconcile" ... -d '{"dry_run": false}'
```

Responses contain job ids and outcome codes only, never file paths.

To inspect the queue, call these as the admin (PostgREST RPC, same token):

| RPC | Shows |
|---|---|
| `admin_media_quarantine_overview()` | Counts by state, the oldest open job, and every job needing attention |
| `admin_media_quarantine_status(moderation_id)` | The files a restriction holds, with paths, and anything skipped |
| `admin_media_quarantine_retry(job_id)` | Returns a flagged job to the queue (audited) |

## 3. Worker outcomes

| Outcome | Meaning | Action |
|---|---|---|
| `quarantined` | Original removed and verified gone; private copy verified | None |
| `restore_pending` | Released while it was being removed | Restore it if the decision was to restore |
| `source_missing` | The original was already gone before copying | None; the path stays reserved while held |
| `cancelled` | Released before the original was removed; it stayed in place | None |
| `retry_scheduled` | A temporary failure; it will back off and retry (30 s doubling up to 1 h, at most 5 attempts) | Watch it |
| `needs_attention` | Flagged; it leaves the queue until an admin acts | See section 4 |
| `interrupted` / HTTP 546 | The worker was stopped mid-job (crash or runtime limit). The job resumes from its recorded step after its 2-minute lease expires. | Run again; repeated kills flag the job |
| `lease_lost` | The job's lease was about to expire, so the worker started no deletion or restore write | Run again after 2 minutes |
| `deferred` (restore) | The restore request reached its hashing budget before this job | Run the restore again for the remaining ids |

## 4. Flagged jobs (`needs_attention`)

A flagged job's original **may still be publicly reachable**. Treat every flag as open until resolved. Child-safety flags first, always.

| `last_error` | What happened | What to do |
|---|---|---|
| `source_changed` | The file at the path is not the file that was moderated (different version, size, type or bytes) | Nothing was removed. Review the current file. If it also violates policy, moderate it again (a new job). Then retry or leave flagged with a note. |
| `destination_conflict` | Something already occupies the private copy's path with different bytes | Escalate to engineering. Do not delete either object. |
| `hash_mismatch` | The private copy does not match the original | Escalate to engineering. The original was not removed. |
| `copy_missing` | The private copy vanished after it was recorded | **Integrity incident.** Escalate immediately; check Storage for tampering. |
| `invalid_source` | The job's path does not belong to its recorded owner | **Integrity incident.** Escalate; the database record may have been altered. |
| `unverified_copy` | A copy exists but the original vanished before it was verified | Escalate; keep the copy as possible evidence. |
| `attempts_exhausted` | The worker kept dying on this job (for example, a file too large for its memory) | Large files: see section 7. Otherwise escalate. |
| `copy_failed`, `delete_failed`, `verify_failed`, `source_read_failed` (after 5 attempts) | Repeated Storage failures | Check Storage health, then `admin_media_quarantine_retry`. |
| `destination_occupied` (restore) | Something now sits at the original path | Do not overwrite. Decide with the owner/support whether restoration is still wanted. |
| `owner_unavailable` (restore) | The owner is deleted or pending deletion | Do not restore. The copy stays under retention. |
| `held_again` (restore) | A new restriction holds the file again | None; it stays quarantined. |

After fixing the cause, `admin_media_quarantine_retry(job_id)` returns the job to the queue. Every retry is recorded with your admin id.

## 5. Restoring media

1. Lift the restriction the normal way (`admin_restore_content`, or `admin_restore_profile_fields`). A **released** profile field is never restored: the removal stands.
2. Check the job is `restore_pending` (`admin_media_quarantine_status`).
3. Run `admin-media-restore` with the job id. Refusal reasons: `not_released` (a hold is still active or a field was released), `already_restored`, `owner_deleted`, `owner_unavailable`, `needs_attention`, `child_safety_confirmation_required`, `second_admin_required`.
4. **Child safety:** the restriction must be cleared by a second admin under the M2.1 rules, and the file restored by an admin who did not impose any restriction on it, with `"confirm_child_safety": true`. The legal-hold copy is kept regardless.
5. **From the report screen (M5.3).** The report's **Media restoration** card lists the jobs held by that report's own restrictions, with their state:
   - quarantined, queued, awaiting restoration, being restored, restored, failed, or needs attention;
   - whether the signed-in admin may restore each one right now.

   **Restore media** calls `admin-media-restore` with the report's id (`report_id`). Any job not held by that report's restrictions is refused as `not_in_report`. Only the worker's `restored` outcome is reported as done.

### Report media inspection (M5.3)

The report screen can show the images recorded in that report's evidence: DM photo, folder cover, item images, post image, avatar.
- **One at a time:** an image loads only when an admin taps View, through `admin-report-media`.
- **Nothing from the app:** no path, bucket or URL is ever taken from the app.
- **The database decides:** `report_media_authorize` re-checks the admin's standing, resolves the image from that report's evidence, and returns it only while the original is still at its recorded location. A quarantined original is never served; quarantine copies stay service-only.
- **Child safety:** these reports need an explicit confirmation, and the image is shown blurred until revealed.
- **Short-lived:** the signed URL lasts 60 seconds and is never cached.
- **Logged:** every request, allowed or refused, is appended to `private.report_media_access` (admin, report, position, child safety, outcome). Review it in the SQL editor:

```sql
select created_at, admin_id, report_id, ref, kind, child_safety, allowed, reason
from private.report_media_access order by created_at desc limit 100;
```

## 6. Orphaned share snapshots

`admin-snapshot-reconcile` removes only copies the snapshot ledger proves an operation created, older than the grace period (default 7 days, minimum 24 hours):

| Reason | Meaning |
|---|---|
| `abandoned` | Reserved but never published (the request died) |
| `rejected` / `discarded` | Refused or discarded, removal not yet confirmed |
| `unreferenced` | Published, but no post or other row links to it |
| `staging` | A post-photo upload left mid-deletion |

Each candidate is re-checked under a per-path lock immediately before removal. Held, referenced or recent files are never removed. Files outside the ledger are only counted (`unledgered_orphans`) for review, never deleted. Always dry-run first.

## 7. Known limits

- **File size.** Since M2.3e the worker streams: Storage copies the file server-side and checksums are computed chunk by chunk, so memory use does not grow with file size. In local testing every size up to the supported 50 MB was quarantined in a single run (a 50 MB file in about 0.8 s) and restored byte-identical. The runtime's CPU limit (2 s per request) is why a run stops taking work after about 64 MB of hashing; a 50 MB job uses roughly a third of it. Confirm these figures on staging.
- **CDN and caches.** Removal is verified at the Storage origin only. CDN copies, browser caches (`max-age=3600` on public files) and anything already downloaded may persist. Staging must confirm CDN purge timing before beta.
- **Scheduler off.** The scheduler (section 8) is built but switched off. Until it is approved and switched on, an admin must run the worker, and queued public files stay public until then.

## 8. Automatic scheduler (built, OFF)

Built in M4 step 5A (`20261126120000_media_quarantine_scheduler.sql`, Edge Function `media-quarantine-scheduled`) and tested only on an isolated local stack. It runs the same worker as `admin-media-quarantine`, with the same checks, leases, retries and checksums. It does **quarantine work only**: it never restores, purges, resolves reports or suspends accounts.

**How it starts work.** Both routes are controlled by one switch, `private.media_quarantine_scheduler_config.enabled`, which is `false` by default:

- **Kick.** When a quarantine job is queued, or a job becomes child safety, the database asks pg_net to call the worker. pg_net only sends requests from committed transactions, so a rolled-back moderation decision sends nothing. Kicks are throttled to one per 10 seconds; child-safety jobs get their own kick, at most one per 5 seconds.
- **Sweep.** The pg_cron job `media-quarantine-worker` runs every minute and calls the worker only when the switch is on and work is waiting. It is created **inactive**.

**Who can run it.** Only `MEDIA_QUARANTINE_WORKER_SECRET`, at least 32 characters, compared in constant time. It is stored in Vault as `media_quarantine_worker_secret` and in the function's secrets; it is never in the repository. No API key or user token is accepted. Even with the secret, the database must open the run: it refuses while the switch is off, when 2 scheduled runs are already active, or above 20 runs a minute.

**Limits per run.** At most 5 jobs, about 25 seconds, and the existing hashing budget, with a 120-second lease. A run that dies is marked `abandoned` after 3 minutes, and its job is picked up again when its lease expires. Child-safety jobs are always claimed first.

**Records.** Scheduled steps appear in the job history as `actor_kind = scheduler` with a run id and no user id. Admin steps appear as `actor_kind = admin` with the admin's id. Dispatches and runs hold codes, counts and durations only. Admins can read `admin_media_quarantine_scheduler_status()`.

**Activation (needs separate written approval; not done anywhere).**
1. Confirm the target project and that the approval covers it.
2. Generate a new secret (at least 32 random characters). Set it as the function secret `MEDIA_QUARANTINE_WORKER_SECRET`, and in Vault as `media_quarantine_worker_secret`, next to `project_url`. Never paste it into tickets or chat.
3. Deploy `media-quarantine-scheduled` with JWT verification off, as `config.toml` says.
4. Check a call without the secret returns 401, and a call with it returns `skipped: disabled`.
5. Switch on: `UPDATE private.media_quarantine_scheduler_config SET enabled = true;` (recorded in `media_quarantine_scheduler_changes`).
6. Activate the sweep: `SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job WHERE jobname = 'media-quarantine-worker';`
7. Watch `admin_media_quarantine_scheduler_status()` and the next completed run.

**Switching off.** Undo steps 6 and 5, in that order. Runs already in flight finish their current job; anything left waits for an admin or for the switch to come back on.

## 9. Production operation still to be approved

- **Retries.** The current 5 attempts with 30 s–1 h back-off, then flag.
- **Alerts** (from `admin_media_quarantine_overview` and the job table):

| Alert | Condition | Urgency |
|---|---|---|
| Child-safety job waiting | Any child-safety job not `quarantined` after 5 minutes | Page immediately |
| Public original still reachable | Any job wanting quarantine whose source still exists after 15 minutes | High |
| Integrity failure | `hash_mismatch`, `copy_missing`, `invalid_source`, `destination_conflict`, `unverified_copy` | Page immediately |
| Repeated failures | Any `needs_attention`, or a job at 3+ attempts | High |
| Restore conflict | `destination_occupied`, `owner_unavailable` | Normal (next business day) |
| Stale lease | A lease expired more than 10 minutes ago and was not reclaimed | High |

- **Reconciliation.** Run manually, weekly, dry run first, until the orphan rate is understood.

# Moderation retention and legal holds: operations runbook

For CacheCase admins, the on-call operator and whoever reviews retention with counsel. It covers the central retention policy, legal holds, and the read-only purge candidate report.

**Status (2026-11-12):** Phase 2B M4 steps 1–3, the step 4A security hardening (section 6) and the step 4B manual two-admin purge executor (section 7). Built and tested on a local stack only. Nothing is deployed, nothing runs on a schedule, and nothing purges anything unless two admins prepare and approve a run (section 7). Every call below is a manual admin RPC (a signed-in account in `admin_users` that is not pending deletion or suspended).

## 1. Retention policy

`private.retention_policy` holds every retention period in one place. Existing moderation functions still carry their own literals, so the table changed no behaviour. `policy_conformance` in the summary (section 3) flags any drift between the two.

| Key | Period | Status | Applies to |
|---|---|---|---|
| `report_evidence_after_resolution` | 90 days | enforced | Report evidence, counted from resolution. Open reports keep their evidence. |
| `quarantine_copy_after_release` | 90 days | enforced | Non-legal-hold copies in `moderation-quarantine` |
| `profile_field_original_after_end` | 90 days | provisional | Original values of ended profile-field restrictions. Used by the candidate report only. |
| `moderation_note` | 1 year | **proposed: legal review** | Free-text notes in the audit log and on suspensions |
| `ordinary_legal_hold_max` | 1 year | provisional | Ordinary legal holds |
| `child_safety_evidence` | none | **unresolved: legal review** | All child-safety evidence |
| `username_reservation` | 90 days | enforced | Deleted accounts' username HMACs |
| `deletion_job_metadata` | 30 days | enforced | Deletion job records. The date is set in the `account-maintenance` Edge Function and isn't covered by the conformance check. |

To change a period: write a forward migration that updates **both** the policy row and every function that `private.retention_policy_conformance()` lists for that key. The pgTAP suite fails if they disagree. Don't shorten a period that applies to existing rows without a separate review.

## 2. Legal holds

A hold stops a single subject from being purged. Subject kinds:
- `report`: the report's evidence.
- `quarantine_copy`: a quarantined file.
- `profile_field`: a cleared profile value.
- `account`: everything above that belongs to one collector.

**A hold does not stop account deletion** (see section 5).

| Action | Who | Rules |
|---|---|---|
| `admin_place_legal_hold(kind, id, basis_code, basis_note, expires_at, child_safety)` | any admin | Ordinary holds need an end date between 1 day and 1 year from now. Allowed bases: `law_enforcement_request`, `litigation`, `regulatory_inquiry`, `internal_investigation`, `child_safety_preservation`, `other_legal_obligation`. A note is required. Only one open hold is allowed per subject and basis. |
| `admin_renew_legal_hold(hold_id, expires_at, note)` | any admin | Active ordinary holds only. The new end date must be later than the current one and at most 1 year away. Renewal closes the old row as `renewed` and creates a linked new row. An **expired** hold can't be renewed; place a new one, so the lapse stays on record. |
| `admin_release_legal_hold(hold_id, reason, note)` | an admin **other than the placer** (or the last renewer) | Ordinary holds only. Reason is `no_longer_required` or `placed_in_error`. |
| `admin_request_legal_hold_release(hold_id, legal_review_ref, note)` | any admin | Child-safety holds only. Step 1: records counsel's review reference. |
| `admin_approve_legal_hold_release(hold_id, note, confirm_child_safety: true)` | an admin who is **neither the requester nor the placer** | Step 2 of a child-safety release. |
| `admin_list_legal_holds(state)`, `admin_subject_legal_holds(kind, id)` | any admin | `state` is `active`, `expired`, `release_requested` or `all`. |

- **Child safety.** A hold becomes a child-safety hold when:
  - the subject is child-safety evidence,
  - the admin marks the hold as child safety, or
  - the basis is `child_safety_preservation`.

  Child-safety holds have **no automatic end date**. Releasing one does **not** make the evidence purgeable: the candidate report blocks child-safety evidence regardless of holds while its policy is unresolved.
- **Expiry.** An ordinary hold stops protecting its subject at `expires_at`; no job needs to run. The summary shows lapsed holds and holds expiring within 30 days, so you can renew in time.
- **Conflict of interest.** An admin can't release, or request release of, a hold on their own evidence.
- **Audit.** Every place, renew, request and release writes a row to `moderation_actions`.
- **Database-level defences:**
  - hold rows are append-only, and can't be deleted or truncated;
  - check constraints enforce the 1-year ceiling, the absence of an expiry on child-safety holds, the second-admin rule and the two-admin rule;
  - a unique index allows one open hold per subject and basis;
  - an advisory lock serializes every operation on the same subject.

## 3. Purge candidates (read-only dry run)

- `admin_retention_summary()`: counts per category, status and blocker. It also shows:
  - open-report ageing at 30, 90 and 180 days, plus the child-safety count;
  - legal-hold state, including holds on accounts pending deletion;
  - the policy and its conformance.
- `admin_retention_candidates(category, status, limit, offset)`: one row per record.
  - **Categories:** `report_evidence`, `quarantine_copy`, `profile_field_original`, `moderation_note`.
  - **Statuses:** `eligible`, `not_due` or `blocked`.
  - Blocked rows list their blockers.

**Blockers:**
- `child_safety`
- `legal_hold`
- `quarantine_legal_hold`
- `open_report`
- `live_restriction`
- `live_profile_field`
- `live_suspension`
- `in_progress`, for a quarantine job mid-flight
- `quarantine_not_terminal`, for a retained `quarantined` job (phase 1 purges only `restored` and `cancelled` jobs)
- `deleted_owner_hold_ambiguous`, for G6 (see section 6)
- `no_retention_date`
- `policy_pending_legal_review`, which applies to every moderation note today

Both functions are STABLE, so they can't write. They return ids and metadata only, never evidence, notes, original values or hold bases. **`eligible` is a report, not an instruction:** no executor exists yet.

## 4. Open decisions (need legal review)

1. **Child-safety retention.**
   - The report-hold design (`20261114120000` §6) says holds must be bounded at ≤ 1 year and renewable.
   - The quarantine design keeps child-safety copies under `legal_hold = true` with no end date.

   This milestone keeps both: ordinary holds are bounded, and child-safety holds have no automatic expiry. Counsel needs to decide how long child-safety material may or must be kept, under what reporting and preservation duties, and what happens when that period ends.
2. **Moderation note retention.** 1 year is proposed but not approved.
3. **Evidence after account deletion (D4).** Account deletion still CASCADE-deletes `moderated_profile_fields`, including child-safety originals, even under a hold. Report evidence, quarantine copies and hold rows survive deletion (ids become NULL, or have no FK). We need to decide whether held evidence must survive deletion, in a separated, minimally identifying form.
4. **Reporter free text.** `content_reports.details` (≤ 500 characters, written by the reporter) is not covered by any purge rule today.
5. **Backups.** 7-day retention is provisionally acceptable. The current production setting still needs verifying.
6. **Purged-record tombstones (D7).** We need to define exactly which fields a tombstone keeps.

## 5. Not built yet

- Purging profile-field originals, moderation notes, reporter comments, child-safety evidence, or retained (`quarantined`) copies.
- Any change to account-deletion behaviour for held evidence.
- Any schedule or automatic purge. A schedule needs separate approval.
- An admin UI for purge actions. Every step is an RPC or the `admin-retention-purge` function (section 7); the dashboard (5C) is read-only.

## 6. Security hardening (step 4A) and the purge-approval contract

**What is enforced in the database now** (`20261124120000`):

| Gap | Before | Now |
|---|---|---|
| G1: clearing report evidence | Any role with UPDATE, the service role included, once the retention date had passed. No hold or child-safety check. | Only inside a transaction that holds a **purge claim** for that exact report. The guard rechecks every blocker under the legal-hold locks. Child-safety evidence is always refused. There is no operator exemption. |
| G2: deleting or truncating reports | Allowed for the service role. | The service role keeps SELECT only. DELETE and TRUNCATE work only for a database operator logged in as `postgres` with no SET ROLE; that narrow exemption is unchanged. |
| G3: `moderation-quarantine` objects | Unprotected from the service role. | A delete needs a live, unexpired, single-use claim for that exact object of that exact job. Child safety, holds and job state are rechecked inside the Storage API's own delete. After verification, a copy can't be overwritten, moved or soft-deleted. Objects that no job owns are refused too. |
| G6: deleted owners | Account holds couldn't be matched to reports whose owner id was erased. | Such reports are blocked (`deleted_owner_hold_ambiguous`) while any active account hold names an account that no longer exists. Reports with a known owner are unaffected. |

**Purge claims** (`private.retention_purge_claims`):
- one subject per claim, plus the exact object for a quarantine copy;
- `prepared_by` ≠ `approved_by`, and both must be current admins who aren't hidden;
- a lease of at most 5 minutes, used once, then closed as `consumed` or `expired`.

No API role can read or write claims, and **no function creates them yet**. Until the separately approved executor exists, nothing can clear evidence or delete a quarantine copy.

**Test fixtures:** integration scripts clean up their own quarantine copies with `scripts/integration/quarantine-fixture-cleanup.ts`. It runs as the database operator against the local stack only.

**G6 limitation and future design.** The rule fails closed, so a single unreleased hold on a deleted account blocks *every* report whose owner was erased. A privacy-preserving fix:
- when an account with an active account hold is deleted, record the hold's coverage, meaning the report, copy and field ids that belonged to the account, in a private table keyed by hold id;
- this stores only ids that already exist, plus the hold link, and no personal data;
- purge eligibility then matches exactly, and the coverage is removed when the hold ends.

This needs a change to account deletion, which needs separate approval.

**Two-admin purge contract (for the future executor):**
1. Admin A runs a preview, which is read-only, and requests a purge of the exact set it returned. The run is frozen with its ids, the policy snapshot and an expiry.
2. Admin B, a different admin, reviews and approves that exact run before it expires. Self-approval is refused, as is approval of a changed set.
3. The executor rechecks eligibility immediately before each item. It creates the claim with both admin ids, so the claim itself refuses self-approval, and acts inside that claim.
4. A candidate that has changed, is newly held or is newly child-safety is **skipped and recorded**, never purged.
5. Each purge records both admins, the run, the policy key, the due date and the size. It never records content or a hash of the content (decision C).

## 7. Manual two-admin purge (step 4B)

**What it can purge, and nothing else:**
- **Ordinary report evidence:** the `content_reports.evidence` column of resolved reports past `evidence_purge_after`. The report row, the reporter's details, status, resolution and the audit log all stay.
- **Ordinary terminal quarantine copies:** the private `moderation-quarantine` object of a `restored` or `cancelled` job past `retain_until`. Only that one object is deleted, by exact path. Source files are never touched.

**Never purged:**
- child-safety evidence;
- anything under an active legal hold (on the subject or the account);
- G6-ambiguous reports;
- open reports, and anything a live restriction, profile lock or suspension depends on;
- non-terminal jobs, and copies whose object doesn't match the job's recorded size;
- notes, reporter details and profile originals.

**Flow** (all manual):

| Step | Who | Call |
|---|---|---|
| Dry run | any admin | `admin_retention_purge_preview(category, limit)`: eligible ids, exclusions with reasons, sizes, policy conformance. Read-only. |
| Prepare | Admin A, holding `retention_purge_preparer` (section 8) | `admin_retention_prepare_run(category, ids[])`: 1–50 explicitly chosen ids, all currently eligible, none already in an open run. The set is frozen with a digest and the policy snapshot. A has **30 minutes** to get approval. |
| Approve | Admin B ≠ A, holding `retention_purge_approver` | `admin_retention_approve_run(run_id, set_digest, item_count)`: must name the exact frozen set. B must be an active admin; A must still be active and still hold the preparer privilege. Opens a **30-minute** execution window. |
| Execute reports | an approver ≠ A | `admin_retention_execute_reports(run_id, limit)` |
| Execute copies | an approver ≠ A | `POST /functions/v1/admin-retention-purge {run_id, limit}`, signed in as that admin |
| Settle after a crash | an approver ≠ A | `admin_retention_reconcile_run(run_id)`. Also runs automatically at the start of each execution. |
| Cancel | any admin | `admin_retention_cancel_run(run_id)` |
| Inspect | any admin | `admin_retention_purge_run(run_id)`, `admin_list_retention_purge_runs(status)` |

**Guarantees:**
- **Re-checked every time.** Each item is checked again immediately before it's purged, under the legal-hold locks. An item that changed (new hold, restriction, suspension, child-safety flag, G6 ambiguity, or no longer due) is **skipped and recorded**, never forced.
- **Report evidence is all-or-nothing.** The claim, the evidence clear, the tombstone, the audit row and the completion commit together or not at all. A failure is recorded as a bounded retry.
- **Copies are confirmed from database evidence only.** Each one runs: claim (two-admin claim, 2-minute lease) → Storage API delete → confirm. Completion needs the object to be gone **and** the Storage guard to have consumed the claim.
- **Unauthorized disappearance is flagged.** An object that vanished any other way is marked `needs_attention`, never counted as purged, and its claim is withdrawn.
- **Retries are bounded.** A failed Storage call leaves the item in flight until its lease ends, then it's retried, up to 3 attempts, after which it's flagged `needs_attention`.
- **Expiry is safe.** When a run's window passes, items that provably weren't deleted are skipped; anything possibly deleted is settled by reconciliation first.

**Records** (append-only, no API access):
- **Tombstone, one per purged item:**
  - the subject's id and kind, and the run;
  - the policy key and period, and the due date;
  - the size, and a category (for example `spam:dismissed` or `avatar:restored`);
  - the preparing, approving and executing admins, and when it was purged.

  It never holds content, a hash, text, details, a path or a note.
- **Audit:** one `moderation_actions` row per purged item (`purge_report_evidence` or `purge_quarantine_copy`), naming both admins.
- **Events:** each step is logged in `private.retention_purge_events`.

**Testing.** Destructive tests run only on an isolated, disposable local stack:
- `CACHECASE_STACK_WORKDIR=<dir> node scripts/integration/retention-purge-executor.ts`;
- `supabase/tests/database/retention_purge_executor.test.sql` with `cachecase.isolated_stack=on`.

Both refuse to run anywhere else.

## 8. Purge privileges, single-object deletion and erasure evidence (step 5D)

`20261129120000_purge_privileges_and_erasure_evidence.sql`, tested on an isolated local stack only.

### Privileges

Being an administrator is no longer enough to purge.

| Privilege | Allows |
|---|---|
| `retention_purge_preparer` | Preparing a run |
| `retention_purge_approver` | Approving another administrator's run, and executing or settling runs you did not prepare |

- **Checked on every call.** Prepare, approve, execute, confirm, reconcile and every claim check the privilege again at that moment, together with the account being an active administrator (not suspended, not pending deletion, still in `admin_users`). Execution also requires the run's preparer and approver to still hold theirs.
- **Revocations take effect immediately.** A revocation between approval and execution stops the run (`run_admins_not_authorized`), and revoking also **withdraws** that administrator's live claims, so an in-flight delete is refused by the Storage guard. The grant row is locked while an action relies on it, so a concurrent revocation is never half-applied.
- **Fails closed.** A run can't be prepared unless another active administrator holds the approver privilege (`insufficient_purge_administrators`).
- **In-flight claims follow their administrators (step 5D.1, `20261130120000`).** The Storage guard re-authorises both of a claim's administrators immediately before consuming it: active, still in `admin_users`, not suspended, not pending deletion, still privileged. Suspending an administrator (an operator-inserted `account_suspensions` row, since the app refuses to suspend admins), removing them from `admin_users`, or starting their account deletion withdraws every live claim naming them.
  - These changes serialise with deletions: whichever takes the administrator's grant lock first wins, and the other waits. A delete that committed first stands, and is settled normally.
  - Settling a delete that already happened never needs the run's administrators: any approver who did not prepare the run can reconcile it.
  - Continuing a run whose preparer or approver lost standing is refused for everyone. Cancel it and prepare a fresh run with a valid second administrator.
- **Nobody holds a privilege after the migration.** Purging is impossible until an operator grants them.

**Granting and revoking (operator only).** Run these in the SQL editor or psql as the database operator; no API role can call them:

```sql
SELECT private.grant_admin_privilege('<admin user id>', 'retention_purge_approver', '<granting admin user id>', '<reason>');
SELECT private.revoke_admin_privilege('<admin user id>', 'retention_purge_approver', '<revoking admin user id>', '<reason>');
```

- The granting administrator must be a **different** active administrator (self-granting is refused); the grantee must be an active administrator.
- Every grant and revocation records grantee, privilege, granting or revoking administrator, reason, time and database role in `private.admin_privilege_events`. Grants are never edited or deleted, only revoked.
- Keep at least two people able to act, but grant the minimum. One person may hold both privileges, but can never approve or execute their own run.

### Storage deletion

The `admin-retention-purge` function deletes each copy through Storage's **single-object** route:

```
DELETE /storage/v1/object/moderation-quarantine/q/<uuid>/original
```

This replaces the batch `remove()` route, whose S3 backend can drop per-key errors (Step 5 Gate E). The path always comes from the job record and must match `q/<uuid>/original`. The database's claim, legal-hold, child-safety and exact-path checks run inside that delete, unchanged.

Every response is classified explicitly:

| Outcome | Meaning |
|---|---|
| `accepted` | 200 or 204 |
| `not_found` | 404, or a body status of 404 |
| `refused` | 403, for example when the guard refuses |
| `http_error` | Another 4xx or 5xx |
| `timeout` | No response within 15 seconds |
| `unreachable` | The network request failed |
| `unexpected` | Any other status |

After an `accepted` delete the function reads the same object again to check it is no longer available. Nothing is completed on the function's word: completion still needs the object's Storage metadata to be gone **and** the guard to have consumed the claim.

### Erasure evidence

`private.retention_purge_erasure_records` is append-only. It holds one row per reported attempt and one final row per purged or flagged item. It never contains paths, hashes or content.

| Classification | Meaning |
|---|---|
| `unavailable_via_api` | Metadata removed by an authorised delete, and a fresh API read of the object returned not-found. **The strongest result possible.** |
| `metadata_removed` | Metadata removed by an authorised delete; the API response was lost or not checked |
| `database_cleared` | Report evidence: the database value was cleared in the purge transaction |
| `api_accepted` / `api_failed` | The API's report for an attempt that has not settled yet |
| `ambiguous_missing_unverified` | The object disappeared without the authorised delete (`needs_attention`) |
| `ambiguous_reappeared` | An object is back at the path after the authorised delete (`needs_attention`) |
| `incomplete` | Retries exhausted or otherwise unsettled (`needs_attention`) |

There is **no "physically erased" classification**. Supabase Storage gives a project no way to verify removal from the underlying object store, or to list objects whose metadata is gone (the orphan scanner exists only on the provider's operator API). Provider backups and object versions are outside the project's control. Physical removal can only be confirmed by the provider, or by a different architecture such as crypto-shredding or customer-owned object storage, which is not built.

### Reconciliation

`admin_retention_purge_reconciliation(run_id?)` is read-only and open to any admin. For every item that is in flight, failed or `needs_attention`, it lists the run, state, attempts, last error, latest evidence, claim state (`live`, `lease_over`, `consumed`, `expired`, `withdrawn`), whether Storage metadata is present (no path), and a recommended step:

| Recommended step | What to do |
|---|---|
| `wait_for_lease` | A delete may be under way; check again after the 2-minute lease |
| `reconcile_then_retry` | An approver runs `admin_retention_reconcile_run`, then executes the run again within its window |
| `investigate_unverified_disappearance` | The object vanished without an authorised delete. Check Storage and operator logs. If you suspect an orphan or out-of-band deletion, open a provider ticket listing the run and item ids (not paths) |
| `investigate_reappeared_object` | Something wrote the path again after the delete. Freeze the run and investigate before anything else |
| `investigate_repeated_failure` | Three attempts failed. Check Storage health and the attempt evidence |

`needs_attention` is terminal: no reconciliation clears it, and the item is never counted as purged. The dashboard's purge section shows each run's unsettled-item count, your own privileges, and whether enough authorised administrators exist.

**Testing (isolated stack only):** `scripts/integration/retention-purge-authorization.ts` and `supabase/tests/database/purge_privileges_erasure.test.sql`, alongside the 4B tests, now with operator-granted fixtures.


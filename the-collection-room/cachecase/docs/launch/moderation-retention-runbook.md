# Moderation retention and legal holds: operations runbook

For CacheCase admins, the on-call operator and whoever reviews retention with counsel. It covers the central retention policy, legal holds, and the read-only purge candidate report.

**Status (2026-11-12):** Phase 2B M4 steps 1–3. Built and tested on a local stack only. Nothing is deployed, nothing runs on a schedule, and **nothing purges anything**: there is no purge executor yet. Every call below is a manual admin RPC (a signed-in account in `admin_users` that is not pending deletion or suspended).

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

## 5. Not built yet (the destructive part of M4)

- **Purge executors:**
  - set report evidence to NULL, using the existing guard;
  - delete quarantine objects;
  - set profile originals to NULL;
  - set notes to NULL.

  Each must re-check its candidate under lock and leave a minimal tombstone.
- Manual dry-run → confirm → execute flow, with audit.
- Any change to account-deletion behaviour for held evidence.
- Any schedule. A schedule needs separate approval.

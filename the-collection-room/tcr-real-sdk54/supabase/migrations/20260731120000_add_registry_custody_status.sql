-- ============================================================================
-- CacheCase Registry — Registry Status v1 (infrastructure only): custody
-- status foundation.
--
-- Deliberately a NEW column, custody_status, NOT a reuse or rename of the
-- existing registered_cards.status column. status (text, default
-- 'owner_registered', CHECK IN ('owner_registered','active','inactive',
-- 'owner_account_deleted')) is a registration/account lifecycle field —
-- already live, already read by app/registry/[id].tsx's STATUS_LABEL /
-- buildStatusSentence — and is left completely untouched by this
-- migration (no ALTER, no data change, no constraint change). custody_status
-- is a distinct concept: where the physical card currently stands (owned /
-- in transfer / on loan / submitted for grading / missing / stolen /
-- destroyed / archived). The two fields are independent and both exist on
-- the same row going forward.
-- ============================================================================

CREATE TYPE public.registry_custody_status AS ENUM (
  'owned',
  'in_transfer',
  'on_loan',
  'submitted_for_grading',
  'missing',
  'stolen',
  'destroyed',
  'archived'
);

ALTER TABLE public.registered_cards
  ADD COLUMN custody_status public.registry_custody_status NOT NULL DEFAULT 'owned';

-- Nullable — only ever populated together, and only for a 'status_changed'
-- registry_events row (written exclusively by
-- update_registered_card_custody_status, see the companion migration).
-- Every existing event type (registered, item_linked, item_unlinked,
-- ownership_transferred) is unaffected and continues to leave both null.
ALTER TABLE public.registry_events
  ADD COLUMN old_custody_status public.registry_custody_status,
  ADD COLUMN new_custody_status public.registry_custody_status;

-- registry_events.event_type's CHECK constraint already permits
-- 'status_changed' (added in the original Phase 2A design, never written
-- by any RPC until now) — no constraint change needed here.

NOTIFY pgrst, 'reload schema';

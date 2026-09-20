import { supabase } from './supabase';
import type { CustodyStatus, RegisteredCard } from '@/types';

export type UpdateRegistryCustodyStatusResult =
  | { error: null; data: RegisteredCard }
  | { error: string; data: null };

// Thin RPC wrapper — no UI behavior. Mirrors lib/registry-images.ts's
// result-object convention (never throws) rather than lib/item-images.ts's
// throw-on-error convention, since this is the more directly comparable
// "nearby registry client helper." update_registered_card_custody_status
// itself is SECURITY DEFINER and enforces current-owner-only authorization
// and atomicity server-side — this function does not duplicate any of
// that.
export async function updateRegistryCustodyStatus(
  registeredCardId: string,
  newCustodyStatus: CustodyStatus,
): Promise<UpdateRegistryCustodyStatusResult> {
  const { data, error } = await supabase.rpc('update_registered_card_custody_status', {
    p_registered_card_id: registeredCardId,
    p_new_custody_status: newCustodyStatus,
  });

  if (error) {
    return { error: error.message, data: null };
  }

  return { error: null, data: data as RegisteredCard };
}

const CUSTODY_STATUS_LABEL: Record<CustodyStatus, string> = {
  owned: 'Owned',
  in_transfer: 'In Transfer',
  on_loan: 'On Loan',
  submitted_for_grading: 'Submitted for Grading',
  missing: 'Missing',
  stolen: 'Stolen',
  destroyed: 'Destroyed',
  archived: 'Archived',
};

// The one shared formatter for custody-status labels — used by the
// registry history screen today, and intended for any future
// custody-status UI (picker/badge/etc.) rather than each screen defining
// its own copy of this map.
export function formatCustodyStatus(status: CustodyStatus): string {
  return CUSTODY_STATUS_LABEL[status] ?? status;
}

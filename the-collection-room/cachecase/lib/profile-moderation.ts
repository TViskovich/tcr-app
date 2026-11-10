import { supabase } from '@/lib/supabase';

// Profile field moderation — the client half of
// supabase/migrations/20261117120000_profile_moderation.sql. An admin can
// clear and lock individual profile fields; the database refuses any change
// to a locked field (profile_field_locked) and is the only enforcement. This
// module only lets the profile editor know WHICH of the caller's own fields
// are locked, so it never offers or attempts a write the server will refuse.
// It never sees original values, reports, reporters or admins.

export type ModeratedProfileField =
  | 'display_name'
  | 'bio'
  | 'tagline'
  | 'location'
  | 'website'
  | 'hero_display_name'
  | 'avatar_url'
  | 'hero_image_url'
  | 'showcase_badge_url';

export const PROFILE_MODERATION_COPY = {
  notice: 'Some profile details were removed for violating our Community Guidelines and can’t be changed right now.',
  photoLocked: 'Your profile photo was removed for violating our Community Guidelines and can’t be changed right now.',
  saveRefused: 'Some profile details can’t be changed right now. Your other changes weren’t saved — please try again.',
};

// The caller's own locked fields. Fails open to "none" (the server still
// refuses locked writes; this only shapes the form).
export async function fetchLockedProfileFields(): Promise<Set<ModeratedProfileField>> {
  try {
    const { data, error } = await supabase.rpc('my_profile_moderation');
    if (error || !data) return new Set();
    const rows = (data as { locked_fields?: { field?: string }[] }).locked_fields ?? [];
    return new Set(rows.map((r) => r.field).filter((f): f is ModeratedProfileField => typeof f === 'string'));
  } catch {
    return new Set();
  }
}

export function isProfileFieldLockedError(error: { message?: string } | null | undefined): boolean {
  return (error?.message ?? '').includes('profile_field_locked');
}

// Replaces every locked key of a save payload with its currently persisted
// value, so a whole-profile save never tries to change a locked field.
export function keepLockedProfileFields<T extends object>(
  intended: T,
  persisted: Partial<Record<keyof T, unknown>> | null | undefined,
  locked: ReadonlySet<string>,
): T {
  if (locked.size === 0) return intended;
  const next = { ...intended } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (locked.has(key)) next[key] = (persisted as Record<string, unknown> | null | undefined)?.[key] ?? null;
  }
  return next as T;
}

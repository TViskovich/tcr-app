// Display-side invite code handling for the "You're invited" screen. Mirrors
// the server's normalization (supabase/functions/_shared/invite-code.ts):
// uppercase, strip spaces/dashes, I/L -> 1, O -> 0, Crockford alphabet only.
// The server re-normalizes and is authoritative; this only shapes what the
// user sees and decides when the code is complete enough to submit.

const CODE_LENGTH = 20;
const GROUP_SIZE = 5;

function normalizeChars(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, CODE_LENGTH);
}

// "ab cde-fghij..." -> "ABCDE-FGH1J-..." (groups of 5, max 20 characters).
// Caps length itself, so the input needs no maxLength (which would truncate
// a pasted code with surrounding whitespace before it could be cleaned).
export function formatInviteCodeInput(raw: string): string {
  const chars = normalizeChars(raw);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP_SIZE) groups.push(chars.slice(i, i + GROUP_SIZE));
  return groups.join('-');
}

export function isCompleteInviteCode(formatted: string): boolean {
  return normalizeChars(formatted).length === CODE_LENGTH;
}

export const INVITE_CODE_PLACEHOLDER = 'XXXXX-XXXXX-XXXXX-XXXXX';

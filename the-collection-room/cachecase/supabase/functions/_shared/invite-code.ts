// Invite-only access codes (waitlist Phase 2A; Phase 2B redemption reuses
// normalizeInviteCode + hashInviteCode so issuance and redemption can never
// disagree on what a code hashes to).
//
// Format: 20 Crockford base32 characters = 100 bits from
// crypto.getRandomValues, displayed as XXXXX-XXXXX-XXXXX-XXXXX. Crockford
// omits I, L, O and U, so a hand-typed code survives the usual misreads.
//
// Storage: waitlist_signups.access_code holds ONLY the SHA-256 hex digest of
// the normalized code. The plaintext lives in Edge Function memory and the
// invite email, never in PostgreSQL or logs. 100 bits of entropy makes an
// unsalted/unpeppered digest safe against offline guessing.

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 symbols
const CODE_LENGTH = 20; // x 5 bits = 100 bits
const GROUP_SIZE = 5;
const NORMALIZED_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;

// Display form, e.g. "7KQ2M-9XD4R-..." — what goes in the email.
export function generateInviteCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so masking to 5 bits is unbiased.
  const chars = Array.from(bytes, (b) => CROCKFORD_ALPHABET[b & 31]);
  const groups: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i += GROUP_SIZE) groups.push(chars.slice(i, i + GROUP_SIZE).join(''));
  return groups.join('-');
}

// Canonical form that gets hashed: uppercase, separators/whitespace removed,
// Crockford's decode aliases applied (I/L -> 1, O -> 0). Returns null when
// the input can't be a valid code.
export function normalizeInviteCode(input: string): string | null {
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return NORMALIZED_RE.test(normalized) ? normalized : null;
}

// Lowercase hex SHA-256 of an already-normalized code (64 chars — the shape
// grant_waitlist_access requires).
export async function hashInviteCode(normalizedCode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedCode));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

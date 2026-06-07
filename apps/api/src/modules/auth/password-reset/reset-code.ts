/**
 * Password-reset code primitives.
 *
 * The reset code is a bearer credential delivered by email: whoever holds it
 * can set a new password for the account it was minted against. It is treated
 * like a refresh token — never stored in plaintext, only its SHA-256 lands in
 * `password_reset_tokens.code_hash`.
 *
 * Format: 12 symbols of Crockford base32, displayed as three hyphen-separated
 * groups (`XXXX-XXXX-XXXX`). Crockford's alphabet omits I, L, O, and U so the
 * code survives being read aloud, hand-typed, or OCR'd off a screenshot. Each
 * symbol carries 5 bits, so the code is 60 bits of CSPRNG entropy — an online
 * guess effectively never matches a stored hash, and an offline grind of the
 * hash cannot finish inside the 15-minute TTL.
 *
 * No bias: the alphabet is exactly 32 symbols and 256 is divisible by 32, so
 * mapping each random byte through `% 32` is perfectly uniform — no rejection
 * sampling required.
 */
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RAW_LENGTH = 12;
const GROUP_SIZE = 4;

export interface GeneratedResetCode {
  /** Canonical, separator-free, uppercase form. This is what gets hashed. */
  readonly canonical: string;
  /** Human-facing grouped form for the email body (`XXXX-XXXX-XXXX`). */
  readonly display: string;
}

export function generateResetCode(): GeneratedResetCode {
  const bytes = randomBytes(RAW_LENGTH);
  let canonical = '';
  // Iterate the buffer directly: `byte` is `number` (never `undefined`) and
  // `charAt` returns `string` (never `undefined`), so the `+=` stays
  // well-typed without a non-null assertion or a `?? ''` guard.
  for (const byte of bytes) {
    canonical += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return { canonical, display: groupForDisplay(canonical) };
}

/**
 * Folds user-entered input back to the canonical form before hashing:
 * uppercases, strips spaces/hyphens, and maps the visually-confusable
 * characters Crockford reserves (O→0, I/L→1) so a human transcription error
 * still resolves to the right code. Anything still outside the alphabet simply
 * won't match a stored hash, which the service surfaces as an invalid code.
 */
export function normalizeResetCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, '')
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1');
}

export function hashResetCode(canonical: string): Buffer {
  return createHash('sha256').update(canonical, 'utf8').digest();
}

function groupForDisplay(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += GROUP_SIZE) {
    groups.push(canonical.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

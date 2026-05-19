/**
 * Human-friendly 6-character order codes.
 *
 * Encoding: Crockford base32 — the alphabet
 *   0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z
 * omits `I`, `L`, `O`, `U` to reduce read-aloud and OCR ambiguity. With
 * 32 symbols across 6 positions the address space is 32^6 = 1,073,741,824
 * (~1B) — comfortably wide for a 30-day live-orders window even at
 * 100k/day. The collision check (caller's responsibility, see usage
 * below) keeps the rate at zero.
 *
 * Cryptographic source: `crypto.randomBytes(6)` is overkill for a
 * non-secret identifier, but it's the simplest unbiased generator for
 * a non-power-of-2 byte → 32-symbol mapping. We read 6 bytes and only
 * use the low 5 bits of each — bias is < 2^-30, negligible.
 *
 * Usage pattern at the call site (checkout service):
 *
 *   const code = await withCollisionRetry(
 *     generateShortCode,
 *     (c) => ordersRepo.shortCodeExistsRecent(c, THIRTY_DAYS),
 *   );
 *
 * `withCollisionRetry` deliberately throws on max-attempts exhaustion
 * rather than returning a sentinel — the caller's transaction must
 * abort, not silently create an order without a code.
 */
import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (uppercase). 32 symbols, no I/L/O/U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Codes are always 6 chars; widening this is a wire-format change. */
export const SHORT_CODE_LENGTH = 6;

const FIVE_BIT_MASK = 0x1f; // 0b00011111

export function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let out = '';
  for (const byte of bytes) {
    // byte is 0..255; & 0x1f maps it to 0..31 — uniform because
    // 256 = 8 * 32. No modulo bias. The bracket access into the
    // 32-symbol alphabet with a 0..31 index is always defined.
    const idx = byte & FIVE_BIT_MASK;
    out += CROCKFORD_ALPHABET.charAt(idx);
  }
  return out;
}

/**
 * Returns true iff `code` is exactly `SHORT_CODE_LENGTH` characters and
 * every character is in the Crockford alphabet (uppercase only). Used
 * by repository read paths to fail fast on a malformed lookup key
 * before paying for a Postgres round-trip.
 */
export function isValidShortCode(code: string): boolean {
  if (code.length !== SHORT_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!CROCKFORD_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * Default retry budget. With 32^6 codes and 100k orders in the 30-day
 * window, the per-attempt collision rate is ~10^-4, so 8 attempts is
 * far beyond the 99.999%-success boundary. Bumping this hides a real
 * problem (e.g. someone shortened the code, or the collision-check
 * predicate is wrong) — fail loudly instead.
 */
export const DEFAULT_MAX_ATTEMPTS = 8;

export class ShortCodeCollisionError extends Error {
  override readonly name = 'ShortCodeCollisionError';
  constructor(attempts: number) {
    super(
      `Failed to generate a unique short code after ${String(attempts)} attempts; ` +
        `address space exhaustion or buggy collision predicate`,
    );
  }
}

/**
 * Repeatedly calls `generate` until `existsAlready(candidate)` returns
 * false, up to `maxAttempts` tries. The predicate is `async` so the
 * caller can hit Postgres without buffering.
 */
export async function withCollisionRetry(
  generate: () => string,
  existsAlready: (candidate: string) => Promise<boolean>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<string> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer (got ${String(maxAttempts)})`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generate();
    if (!(await existsAlready(candidate))) {
      return candidate;
    }
  }
  throw new ShortCodeCollisionError(maxAttempts);
}

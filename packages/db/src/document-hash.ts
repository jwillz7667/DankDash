/**
 * One-way document-number hasher for `bytea` columns (license numbers,
 * passport numbers, state-ID numbers). Implements HMAC-SHA256 with a
 * server-wide pepper.
 *
 *   stored = HMAC-SHA256(pepper, context || "|" || normalize(value))
 *
 * Why HMAC over plain SHA-256:
 *   1. A leaked database alone does not let an attacker brute-force the
 *      space of plausible license numbers — the pepper is required.
 *   2. A DBA with raw read access still cannot reverse the hash; the
 *      master pepper lives only in the application process (Railway
 *      secret manager).
 *   3. The `context` AAD prevents collision across columns — a license
 *      number "12345" and a passport number "12345" produce different
 *      hashes, so a leaked drivers.license_number_hash cannot be probed
 *      against user_id_documents.document_number_hash even when both
 *      happen to share the same pepper.
 *
 * Why HMAC rather than argon2id / scrypt:
 *   Document numbers are deterministic primary-identifier values used for
 *   equality lookups (does this license number already exist?). A slow
 *   per-value KDF would make those lookups impractical at scale, and the
 *   pepper already raises offline cracking cost from "trivial" to
 *   "requires the pepper". Passwords use argon2id; document hashes use
 *   HMAC.
 *
 * Normalization strategy: trim outer whitespace and uppercase ASCII
 * letters. Real-world license numbers arrive with inconsistent casing
 * ("dl-12345" vs "DL-12345") and stray trailing spaces from POS systems;
 * normalising at hash time means "DL-12345" and "dl-12345 " collapse to
 * the same stored hash, which is what an operator searching by license
 * number expects. Non-ASCII characters pass through unchanged to keep
 * the function locale-independent.
 *
 * Output: a fresh 32-byte Uint8Array per call (the HMAC-SHA256 tag).
 * `bytea` columns persist these verbatim.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EncryptionError } from '@dankdash/types';

const ALGORITHM = 'sha256';
const TAG_BYTES = 32;
const MIN_PEPPER_BYTES = 32;

export interface DocumentHasher {
  /**
   * Compute the HMAC tag for `value` under `context`. The returned
   * Uint8Array is exactly 32 bytes — feed it straight to a `bytea`
   * column without further conversion.
   */
  hash(value: string, context: string): Uint8Array;
  /**
   * Constant-time comparison between a stored hash and the recomputed
   * hash of `value` under `context`. Use this in equality lookups
   * (does this license number match the stored hash?) instead of
   * `Buffer.equals`, which can leak information through timing.
   */
  matches(stored: Uint8Array, value: string, context: string): boolean;
}

export interface CreateDocumentHasherOptions {
  /** Pepper bytes. Must be at least 32 bytes; pre-decoded from base64. */
  readonly pepper: Uint8Array;
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

export function createDocumentHasher(opts: CreateDocumentHasherOptions): DocumentHasher {
  const pepper = Buffer.from(opts.pepper);
  if (pepper.length < MIN_PEPPER_BYTES) {
    throw new EncryptionError(
      'ENCRYPTION_CONFIG_INVALID',
      `Document-hash pepper must be at least ${MIN_PEPPER_BYTES} bytes; got ${pepper.length}`,
      { expectedMinBytes: MIN_PEPPER_BYTES, actualBytes: pepper.length },
    );
  }

  function hash(value: string, context: string): Uint8Array {
    if (context.length === 0) {
      throw new EncryptionError(
        'ENCRYPTION_CONFIG_INVALID',
        'Document-hash context must be a non-empty string',
      );
    }
    if (value.length === 0) {
      throw new EncryptionError(
        'ENCRYPTION_CONFIG_INVALID',
        'Document-hash input value must be a non-empty string',
      );
    }
    const mac = createHmac(ALGORITHM, pepper);
    // `|` is forbidden in the context catalogue below, so the separator is
    // unambiguous — `drivers.license` + `|FOO` and `drivers.license|` + `FOO`
    // can never collide.
    mac.update(`${context}|${normalize(value)}`, 'utf8');
    const digest = mac.digest();
    return new Uint8Array(digest);
  }

  function matches(stored: Uint8Array, value: string, context: string): boolean {
    if (stored.length !== TAG_BYTES) return false;
    const candidate = hash(value, context);
    return timingSafeEqual(Buffer.from(stored), Buffer.from(candidate));
  }

  return Object.freeze({ hash, matches });
}

/**
 * Build a {@link DocumentHasher} from a base64-encoded pepper. Convenience
 * wrapper for `DOCUMENT_HASH_PEPPER_BASE64`.
 */
export function createDocumentHasherFromBase64(base64Pepper: string): DocumentHasher {
  const decoded = Buffer.from(base64Pepper, 'base64');
  return createDocumentHasher({ pepper: new Uint8Array(decoded) });
}

/**
 * Stable list of contexts for document-number hashing. Adding a row here
 * is the only place where new hashed columns should be registered —
 * keeps the universe of contexts auditable in one file and prevents
 * accidental cross-column collision through a typo.
 */
export const DOCUMENT_HASH_CONTEXT = Object.freeze({
  DRIVER_LICENSE_NUMBER: 'drivers.license_number',
  USER_ID_DOCUMENT_NUMBER: 'user_id_documents.document_number',
} as const);

export type DocumentHashContext =
  (typeof DOCUMENT_HASH_CONTEXT)[keyof typeof DOCUMENT_HASH_CONTEXT];

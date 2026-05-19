/**
 * Password hashing primitive.
 *
 * Two-layer construction:
 *
 *   1. HMAC-SHA256 pepper pre-hash
 *        out = HMAC-SHA256(PASSWORD_PEPPER, utf8(password))
 *      The pepper is a per-deployment secret held only in the application
 *      process (Railway secret manager). Without the pepper, even a full DB
 *      compromise yields argon2id hashes whose input space the attacker
 *      cannot reproduce — they must guess the pepper as well as the password.
 *
 *   2. argon2id of the HMAC output
 *        stored = argon2id(out, m=64MiB, t=3, p=1, hashLength=32)
 *      Tunings match the OWASP 2024 "high-resource server" recommendation.
 *      The stored string is the standard self-describing `$argon2id$...`
 *      encoding, which embeds all parameters so future rehashes can detect
 *      drift (`needsRehash`).
 *
 * `verify()` returns boolean — wrong-password is normal flow, not an error.
 * Malformed stored hashes (DB corruption, hand-edited rows) raise
 * `PasswordError('PASSWORD_HASH_MALFORMED')`.
 *
 * Pepper rotation runbook lives at docs/runbooks/password-pepper-rotation.md.
 * The current implementation accepts a single active pepper; the rotation
 * design (dual-pepper window + needsRehash signal) is documented but not
 * wired here — it requires a schema migration for `users.password_pepper_v`
 * and is deferred to the auth schema phase.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PasswordError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

export interface PasswordHashOptions {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly hashLength: number;
}

export const DEFAULT_HASH_OPTIONS: PasswordHashOptions = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

/**
 * Defensive ceiling on raw password length before HMAC. argon2 itself
 * accepts much more, but allowing arbitrarily large inputs is a trivial
 * DoS vector — the hash cost is proportional to input size only at the
 * HMAC step, but bounding here keeps the API obvious.
 */
export const MAX_PASSWORD_BYTES = 1024;

export interface PasswordServiceConfig {
  readonly pepper: string;
  readonly hashOptions?: Partial<PasswordHashOptions>;
}

@Injectable()
export class PasswordService {
  private readonly pepper: Buffer;
  private readonly options: PasswordHashOptions;

  constructor(config: PasswordServiceConfig) {
    if (config.pepper.length < 32) {
      throw new PasswordError(
        'PASSWORD_INPUT_INVALID',
        'PASSWORD_PEPPER must be at least 32 bytes',
      );
    }
    this.pepper = Buffer.from(config.pepper, 'utf8');
    this.options = { ...DEFAULT_HASH_OPTIONS, ...config.hashOptions };
  }

  async hash(plaintext: string): Promise<string> {
    const preHash = this.preHash(plaintext);
    try {
      return await argon2.hash(preHash, {
        type: argon2.argon2id,
        memoryCost: this.options.memoryCost,
        timeCost: this.options.timeCost,
        parallelism: this.options.parallelism,
        hashLength: this.options.hashLength,
      });
    } catch (err) {
      throw new PasswordError('PASSWORD_HASH_FAILED', 'argon2 hash failed', {}, err);
    }
  }

  async verify(plaintext: string, stored: string): Promise<boolean> {
    if (!stored.startsWith('$argon2id$')) {
      throw new PasswordError('PASSWORD_HASH_MALFORMED', 'stored hash is not argon2id');
    }
    const preHash = this.preHash(plaintext);
    try {
      return await argon2.verify(stored, preHash);
    } catch (err) {
      throw new PasswordError('PASSWORD_HASH_MALFORMED', 'argon2 verify rejected hash', {}, err);
    }
  }

  /**
   * True when the stored hash's encoded parameters differ from the
   * current `DEFAULT_HASH_OPTIONS`. Call after a successful verify and
   * re-hash + persist the new value to migrate users to stronger
   * parameters without requiring a forced password reset.
   */
  needsRehash(stored: string): boolean {
    try {
      return argon2.needsRehash(stored, {
        memoryCost: this.options.memoryCost,
        timeCost: this.options.timeCost,
        parallelism: this.options.parallelism,
      });
    } catch {
      // A malformed hash needs to be rehashed by definition. Returning true
      // here would mask the underlying corruption — let verify() be the
      // canonical detector and have it raise PASSWORD_HASH_MALFORMED.
      return true;
    }
  }

  /**
   * Constant-time comparator for callers that need to compare two pepper-
   * pre-hashes (e.g. account-takeover detection comparing two passwords
   * the user typed). Exposed so consumers don't reimplement timingSafeEqual
   * incorrectly. Inputs must be the same length.
   */
  static constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private preHash(plaintext: string): Buffer {
    const raw = Buffer.from(plaintext, 'utf8');
    if (raw.length === 0) {
      throw new PasswordError('PASSWORD_INPUT_INVALID', 'password must not be empty');
    }
    if (raw.length > MAX_PASSWORD_BYTES) {
      throw new PasswordError(
        'PASSWORD_INPUT_INVALID',
        `password must be at most ${String(MAX_PASSWORD_BYTES)} bytes`,
        { actual: raw.length },
      );
    }
    return createHmac('sha256', this.pepper).update(raw).digest();
  }
}

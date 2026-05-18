/**
 * Time-based One-Time Password (TOTP) MFA service.
 *
 * Algorithm: SHA-1 / 6 digits / 30s step (RFC 6238 + Google Authenticator
 * defaults). The secret is a fresh 160-bit base32 string per enrollment.
 *
 * Lifecycle:
 *
 *   beginEnrollment → generates a secret + otpauth URL. Does NOT persist;
 *                     the client holds the secret in memory until confirm.
 *                     Throws MFA_ALREADY_ENROLLED if the user already has
 *                     MFA enabled (rotation requires disable first).
 *
 *   confirmEnrollment → user submits the secret they were shown plus the
 *                       current TOTP code from their authenticator. We verify
 *                       the code matches the secret, encrypt the secret with
 *                       AES-256-GCM (AAD bound to `users.mfa_secret_enc`),
 *                       persist + set mfa_enabled=true.
 *
 *   verifyCode → fetch user (must be enrolled), decrypt secret, totp.verify
 *                with window=1 (±30s clock-skew tolerance). Throws
 *                AuthError MFA_CODE_INVALID on failure.
 *
 *   disable → user proves current possession of the second factor, then we
 *             clear mfa_secret_enc + set mfa_enabled=false.
 *
 * The secret never leaves the API process in plaintext after enrollment —
 * the DB stores only the AES-GCM envelope, and the application decrypts on
 * each verify. A DBA with raw row access cannot derive TOTP codes.
 *
 * Backup codes are not in scope for Phase 2 — the schema has no column for
 * them yet. They become a separate table + service in Phase 2.6+ once the
 * controller layer is in place.
 */
import { UsersRepository, type EncryptionService, type User } from '@dankdash/db';
import { AuthError, ConflictError, NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import speakeasy from 'speakeasy';

const MFA_SECRET_AAD = 'users.mfa_secret_enc';
const DEFAULT_DIGITS = 6;
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_WINDOW = 1;
const DEFAULT_ISSUER = 'DankDash';
const DEFAULT_SECRET_BYTES = 20; // 160-bit, matches Google Authenticator spec

export interface MfaServiceConfig {
  /** Issuer string shown by authenticator apps. */
  readonly issuer?: string;
  /** ±N step tolerance. Default 1 (±30s) — same as Google's docs recommend. */
  readonly window?: number;
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
  /**
   * Source of randomness for new secrets. Defaults to speakeasy's internal
   * (crypto.randomBytes). Exposed for tests that need a known secret without
   * a separate enrollment round-trip.
   */
  readonly secretFactory?: () => SecretMaterial;
}

export interface SecretMaterial {
  readonly base32: string;
}

export interface MfaEnrollment {
  readonly secretBase32: string;
  readonly otpauthUrl: string;
}

export interface BeginEnrollmentInput {
  readonly userId: string;
  /** Used to label the entry in the user's authenticator app (typically email). */
  readonly accountLabel: string;
}

export interface ConfirmEnrollmentInput {
  readonly userId: string;
  readonly secretBase32: string;
  readonly currentCode: string;
}

export interface VerifyCodeInput {
  readonly userId: string;
  readonly code: string;
}

export interface DisableMfaInput {
  readonly userId: string;
  readonly currentCode: string;
}

@Injectable()
export class MfaService {
  private readonly issuer: string;
  private readonly window: number;
  private readonly clock: () => Date;
  private readonly secretFactory: () => SecretMaterial;

  constructor(
    private readonly users: UsersRepository,
    private readonly encryption: EncryptionService,
    config: MfaServiceConfig = {},
  ) {
    this.issuer = config.issuer ?? DEFAULT_ISSUER;
    this.window = config.window ?? DEFAULT_WINDOW;
    this.clock = config.clock ?? ((): Date => new Date());
    this.secretFactory =
      config.secretFactory ??
      ((): SecretMaterial => speakeasy.generateSecret({ length: DEFAULT_SECRET_BYTES }));
  }

  async beginEnrollment(input: BeginEnrollmentInput): Promise<MfaEnrollment> {
    const user = await this.requireUser(input.userId);
    if (user.mfaEnabled) {
      throw new ConflictError(
        'MFA_ALREADY_ENROLLED',
        'MFA is already enabled — disable it first to re-enroll',
        { userId: input.userId },
      );
    }
    const { base32 } = this.secretFactory();
    const otpauthUrl = speakeasy.otpauthURL({
      secret: base32,
      label: `${this.issuer}:${input.accountLabel}`,
      issuer: this.issuer,
      encoding: 'base32',
      algorithm: 'sha1',
      digits: DEFAULT_DIGITS,
      period: DEFAULT_STEP_SECONDS,
    });
    return { secretBase32: base32, otpauthUrl };
  }

  async confirmEnrollment(input: ConfirmEnrollmentInput): Promise<void> {
    const user = await this.requireUser(input.userId);
    if (user.mfaEnabled) {
      throw new ConflictError(
        'MFA_ALREADY_ENROLLED',
        'MFA is already enabled — disable it first to re-enroll',
        { userId: input.userId },
      );
    }
    if (!this.verifyTotp(input.secretBase32, input.currentCode)) {
      throw new AuthError('MFA_CODE_INVALID', 'TOTP code did not match the provided secret');
    }
    const encrypted = this.encryption.encryptString(input.secretBase32, MFA_SECRET_AAD);
    const updated = await this.users.update(input.userId, {
      mfaEnabled: true,
      mfaSecretEnc: encrypted,
    });
    if (updated === null) {
      throw new NotFoundError('User', input.userId);
    }
  }

  async verifyCode(input: VerifyCodeInput): Promise<void> {
    const user = await this.requireUser(input.userId);
    if (!user.mfaEnabled || user.mfaSecretEnc === null) {
      throw new ConflictError('MFA_NOT_ENROLLED', 'user has not enrolled in MFA', {
        userId: input.userId,
      });
    }
    const secretBase32 = this.encryption.decryptString(user.mfaSecretEnc, MFA_SECRET_AAD);
    if (!this.verifyTotp(secretBase32, input.code)) {
      throw new AuthError('MFA_CODE_INVALID', 'TOTP code did not match');
    }
  }

  async disable(input: DisableMfaInput): Promise<void> {
    const user = await this.requireUser(input.userId);
    if (!user.mfaEnabled || user.mfaSecretEnc === null) {
      throw new ConflictError('MFA_NOT_ENROLLED', 'user has not enrolled in MFA', {
        userId: input.userId,
      });
    }
    const secretBase32 = this.encryption.decryptString(user.mfaSecretEnc, MFA_SECRET_AAD);
    if (!this.verifyTotp(secretBase32, input.currentCode)) {
      throw new AuthError('MFA_CODE_INVALID', 'TOTP code did not match — refusing to disable MFA');
    }
    const updated = await this.users.update(input.userId, {
      mfaEnabled: false,
      mfaSecretEnc: null,
    });
    if (updated === null) {
      throw new NotFoundError('User', input.userId);
    }
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new NotFoundError('User', userId);
    }
    return user;
  }

  private verifyTotp(secretBase32: string, code: string): boolean {
    // Strip whitespace defensively — users often paste codes from an
    // authenticator app and include a space between the two groups of three.
    const cleaned = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) return false;
    return speakeasy.totp.verify({
      secret: secretBase32,
      encoding: 'base32',
      token: cleaned,
      window: this.window,
      step: DEFAULT_STEP_SECONDS,
      digits: DEFAULT_DIGITS,
      algorithm: 'sha1',
      time: Math.floor(this.clock().getTime() / 1000),
    });
  }
}

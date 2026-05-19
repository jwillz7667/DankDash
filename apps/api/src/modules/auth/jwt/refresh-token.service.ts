/**
 * Refresh-token issuer + rotator with OWASP-style reuse detection.
 *
 * Lifecycle:
 *
 *   issueOnLogin → creates a new session row whose `family_id` equals its
 *                   own session id (root of the family). Returns the opaque
 *                   token string (only ever held in memory + the client's
 *                   secure storage; the DB stores only its SHA-256 hash).
 *
 *   rotate       → looks the incoming hash up:
 *                   * not found            → AuthError TOKEN_INVALID
 *                   * revokedAt is set     → AuthError TOKEN_REVOKED
 *                   * expiresAt < now      → AuthError TOKEN_EXPIRED
 *                   * rotatedAt is set     → REUSE: revoke entire family,
 *                                            AuthError TOKEN_REVOKED with
 *                                            `reuse_detected: true` detail
 *                   * else                 → atomically issue successor,
 *                                            stamp predecessor.rotated_to
 *
 *   revoke       → revokes a single session (logout)
 *   revokeAllForUser → revokes every active session for a user
 *
 * Reuse detection is the defence against refresh-token theft: even if an
 * attacker exfiltrates one valid token, the moment the *legitimate* client
 * uses it again the entire chain blows up and both attacker and user are
 * forced through fresh authentication.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type SessionsRepository } from '@dankdash/db';
import { AuthError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

export interface RefreshTokenServiceConfig {
  readonly refreshTtlSeconds: number;
  /**
   * Source of randomness for refresh tokens. Defaults to `crypto.randomBytes`;
   * exposed for tests that need deterministic output (never for production).
   */
  readonly rng?: (size: number) => Buffer;
  readonly clock?: () => Date;
}

export interface IssueRefreshTokenInput {
  readonly userId: string;
  readonly deviceId?: string;
  readonly deviceFingerprint?: Record<string, unknown>;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface RotateRefreshTokenInput {
  readonly rawToken: string;
  readonly deviceId?: string;
  readonly deviceFingerprint?: Record<string, unknown>;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IssuedRefreshToken {
  readonly rawToken: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class RefreshTokenService {
  private readonly ttl: number;
  private readonly rng: (size: number) => Buffer;
  private readonly clock: () => Date;

  constructor(
    private readonly sessions: SessionsRepository,
    config: RefreshTokenServiceConfig,
  ) {
    this.ttl = config.refreshTtlSeconds;
    this.rng = config.rng ?? randomBytes;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async issueOnLogin(input: IssueRefreshTokenInput): Promise<IssuedRefreshToken> {
    const rawToken = this.mintToken();
    const hash = hashToken(rawToken);
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);
    const sessionId = uuidv7();
    const created = await this.sessions.create({
      id: sessionId,
      userId: input.userId,
      familyId: sessionId,
      refreshTokenHash: hash,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.deviceFingerprint !== undefined
        ? { deviceFingerprint: input.deviceFingerprint }
        : {}),
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      expiresAt,
    });
    return {
      rawToken,
      sessionId: created.id,
      familyId: created.familyId,
      userId: created.userId,
      expiresAt: created.expiresAt,
    };
  }

  async rotate(input: RotateRefreshTokenInput): Promise<IssuedRefreshToken> {
    const hash = hashToken(input.rawToken);
    const existing = await this.sessions.findByRefreshTokenHash(hash);
    if (existing === null) {
      throw new AuthError('TOKEN_INVALID', 'refresh token not recognised');
    }
    if (existing.revokedAt !== null) {
      throw new AuthError('TOKEN_REVOKED', 'refresh token has been revoked');
    }
    const now = this.clock();
    if (existing.expiresAt.getTime() < now.getTime()) {
      throw new AuthError('TOKEN_EXPIRED', 'refresh token has expired');
    }
    if (existing.rotatedAt !== null) {
      // Token reuse: the legitimate client (or an attacker) is presenting
      // a token we've already rotated. Burn the whole family — even if the
      // attacker still holds the most recent token, it's about to be gone.
      const revoked = await this.sessions.revokeFamily(existing.familyId);
      throw new AuthError('TOKEN_REVOKED', 'refresh token reused — session family revoked', {
        reuse_detected: true,
        family_id: existing.familyId,
        revoked_count: revoked,
      });
    }

    const successorRawToken = this.mintToken();
    const successorHash = hashToken(successorRawToken);
    const successorId = uuidv7();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);
    const successor = await this.sessions.rotate({
      predecessorId: existing.id,
      successor: {
        id: successorId,
        userId: existing.userId,
        familyId: existing.familyId,
        refreshTokenHash: successorHash,
        ...(input.deviceId !== undefined
          ? { deviceId: input.deviceId }
          : existing.deviceId !== null
            ? { deviceId: existing.deviceId }
            : {}),
        ...(input.deviceFingerprint !== undefined
          ? { deviceFingerprint: input.deviceFingerprint }
          : {}),
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
        expiresAt,
      },
    });
    return {
      rawToken: successorRawToken,
      sessionId: successor.id,
      familyId: successor.familyId,
      userId: successor.userId,
      expiresAt: successor.expiresAt,
    };
  }

  async revoke(rawToken: string): Promise<void> {
    const hash = hashToken(rawToken);
    const existing = await this.sessions.findByRefreshTokenHash(hash);
    if (existing === null) {
      // Idempotent — logging out an unknown token is not an error worth
      // surfacing to the caller (and not surfacing prevents an enumeration
      // oracle on hash collisions, even though SHA-256 makes that academic).
      return;
    }
    if (existing.revokedAt !== null) return;
    await this.sessions.revoke(existing.id);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }

  private mintToken(): string {
    return this.rng(REFRESH_TOKEN_BYTES).toString('base64url');
  }
}

export function hashToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

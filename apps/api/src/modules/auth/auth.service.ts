/**
 * Auth orchestration.
 *
 * Composes the leaf services (PasswordService, JwtService, RefreshTokenService,
 * MfaService) and the UsersRepository into the eight controller-facing flows:
 *
 *   register   — hash password, insert user (status=pending_kyc), mint tokens.
 *                Unique-email/phone collisions surface as a single enumeration-
 *                safe ConflictError('ACCOUNT_ALREADY_REGISTERED').
 *
 *   login      — verify password, branch on user.mfaEnabled:
 *                  - MFA off                 → mint tokens immediately
 *                  - MFA on, no code         → return { status: 'mfa_required' }
 *                                              with an opaque challengeId (UI
 *                                              hint only — no server state)
 *                  - MFA on, code present    → verify code, mint tokens
 *                No half-authenticated server state: the second call re-verifies
 *                password + code together, which avoids a Redis-backed challenge
 *                table and the cleanup story that comes with it.
 *
 *   refresh    — RefreshTokenService.rotate (atomic, family-aware reuse detect),
 *                mint a fresh access token bound to the successor session id.
 *
 *   logout     — RefreshTokenService.revoke (idempotent, no enumeration oracle).
 *
 *   mfaSetup / mfaConfirm / mfaVerify / mfaDisable — pass-through to MfaService.
 *                Surfaces here (instead of routing controllers straight at the
 *                MfaService) so the surface stays consistent and the controller
 *                can keep one dependency.
 *
 * Every authenticated mint persists `users.last_login_at` so dashboards and
 * audit queries don't have to derive it from session rows.
 *
 * The service intentionally does NOT touch req/res — it returns plain DTOs.
 * The controller layer adapts them to HTTP responses (status codes, headers).
 */
import { UsersRepository, type User } from '@dankdash/db';
import { AuthError, ConflictError, NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { JwtService } from './jwt/jwt.service.js';
import { RefreshTokenService } from './jwt/refresh-token.service.js';
import { MfaService } from './mfa/mfa.service.js';
import { PasswordService } from './password/password.service.js';
import type {
  LoginRequestDto,
  LoginResponse,
  RegisterRequestDto,
  RegisterResponse,
  RefreshResponse,
  TokenPair,
  UserSummary,
} from './dto/index.js';

export interface AuthServiceConfig {
  readonly accessTtlSeconds: number;
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
}

export interface AuthRequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly deviceId?: string;
}

/**
 * The credential a checkout hand-off exchange yields: a bare access token
 * (no refresh half) plus its lifetime and the role it was minted for.
 */
export interface CheckoutSession {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly role: string;
}

export type RegisterInput = RegisterRequestDto;

export type LoginInput = LoginRequestDto;

@Injectable()
export class AuthService {
  private readonly accessTtl: number;
  private readonly clock: () => Date;

  constructor(
    private readonly users: UsersRepository,
    private readonly password: PasswordService,
    private readonly jwt: JwtService,
    private readonly refresh: RefreshTokenService,
    private readonly mfa: MfaService,
    config: AuthServiceConfig,
  ) {
    this.accessTtl = config.accessTtlSeconds;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async register(input: RegisterInput, ctx: AuthRequestContext = {}): Promise<RegisterResponse> {
    const passwordHash = await this.password.hash(input.password);
    let created: User;
    try {
      created = await this.users.create({
        email: input.email,
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: input.dateOfBirth,
        role: 'customer',
        status: 'pending_kyc',
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Enumeration-safe: we do NOT tell the caller which field collided.
        // An attacker probing for registered emails or phones gets the same
        // response either way.
        throw new ConflictError(
          'ACCOUNT_ALREADY_REGISTERED',
          'an account is already registered with the provided email or phone',
        );
      }
      throw err;
    }

    const tokens = await this.issueTokens(created, ctx);
    return { user: toUserSummary(created), tokens };
  }

  async login(input: LoginInput, ctx: AuthRequestContext = {}): Promise<LoginResponse> {
    const user = await this.users.findByEmail(input.email);
    if (user === null) {
      // Burn an argon2 round so the missing-user path takes roughly the same
      // wall-clock time as the wrong-password path. Hashing the input (instead
      // of verifying against a precomputed dummy) is a single argon2id work
      // unit — identical cost to a real verify, no module-init wiring needed.
      await this.password.hash(input.password).catch(() => '');
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    if (user.deletedAt !== null) {
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    if (user.status === 'banned' || user.status === 'suspended') {
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }

    const ok = await this.password.verify(input.password, user.passwordHash);
    if (!ok) {
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
    }

    if (user.mfaEnabled) {
      if (input.mfaCode === undefined) {
        const now = this.clock();
        // Challenge id is a correlation UUID for client UX — the server holds
        // no state keyed by it. The second /login call re-verifies password +
        // code together; no server-side challenge table means nothing to
        // expire, nothing to leak.
        return {
          status: 'mfa_required',
          challengeId: uuidv7(),
          challengeExpiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS).toISOString(),
        };
      }
      await this.mfa.verifyCode({ userId: user.id, code: input.mfaCode });
    }

    const tokens = await this.issueTokens(user, ctx);
    return { status: 'authenticated', user: toUserSummary(user), tokens };
  }

  async refreshTokens(
    rawRefreshToken: string,
    ctx: AuthRequestContext = {},
  ): Promise<RefreshResponse> {
    const rotated = await this.refresh.rotate({
      rawToken: rawRefreshToken,
      ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
      ...(ctx.ipAddress !== undefined ? { ipAddress: ctx.ipAddress } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    });
    const user = await this.users.findById(rotated.userId);
    if (user === null) {
      // The session row outlived its user (cascade soft-delete should have
      // revoked first). Treat as a revoked token rather than a 404 — the
      // client should drop the refresh and re-authenticate.
      throw new AuthError('TOKEN_REVOKED', 'session no longer references a live user');
    }
    if (user.deletedAt !== null || user.status === 'banned' || user.status === 'suspended') {
      throw new AuthError('TOKEN_REVOKED', 'account is no longer eligible for refresh');
    }

    const accessToken = this.jwt.signAccessToken({
      userId: user.id,
      sessionId: rotated.sessionId,
      role: user.role,
    });
    const now = this.clock();
    const tokens: TokenPair = {
      accessToken,
      refreshToken: rotated.rawToken,
      accessTokenExpiresAt: new Date(now.getTime() + this.accessTtl * 1000).toISOString(),
      refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
      tokenType: 'Bearer',
    };
    return { tokens };
  }

  async logout(rawRefreshToken: string): Promise<void> {
    await this.refresh.revoke(rawRefreshToken);
  }

  async startMfaEnrollment(userId: string): Promise<{
    readonly secretBase32: string;
    readonly otpauthUrl: string;
  }> {
    // Resolve the user's email here so the otpauth URL label is human-readable
    // ("DankDash:jane@example.com") in the authenticator app. MfaService is
    // stateless about labels; AuthService owns the email lookup.
    const user = await this.users.findById(userId);
    if (user === null) throw new NotFoundError('User', userId);
    return this.mfa.beginEnrollment({ userId, accountLabel: user.email });
  }

  async confirmMfaEnrollment(userId: string, secretBase32: string, code: string): Promise<void> {
    await this.mfa.confirmEnrollment({ userId, secretBase32, currentCode: code });
  }

  async verifyMfaCode(userId: string, code: string): Promise<void> {
    await this.mfa.verifyCode({ userId, code });
  }

  async disableMfa(userId: string, currentCode: string): Promise<void> {
    await this.mfa.disable({ userId, currentCode });
  }

  /**
   * Mints a short-lived access-token session for the Apple §10.4 checkout
   * hand-off. The one-time handoff token has already been verified and
   * atomically consumed by `CheckoutHandoffService.consume` before this is
   * called; here we only turn the resolved `userId` into a normal
   * `dankdash.app` access token so checkout-web can read the cart and place
   * the order on the user's behalf.
   *
   * Unlike login this mints NO refresh token and creates NO refresh-token
   * family: the checkout surface is a transient browser hop (minutes), not a
   * long-lived device session, so the single access token is the whole
   * credential and there is nothing to rotate. The `sid` is a fresh UUIDv7 —
   * `JwtAuthGuard` verifies the JWT without a DB session lookup, so an
   * unbacked session id is correct here.
   */
  async issueCheckoutSession(userId: string): Promise<CheckoutSession> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new AuthError(
        'TOKEN_INVALID',
        'checkout hand-off references a user that no longer exists',
      );
    }
    if (user.deletedAt !== null || user.status === 'banned' || user.status === 'suspended') {
      throw new AuthError('TOKEN_INVALID', 'account is not eligible to check out');
    }
    const accessToken = this.jwt.signAccessToken({
      userId: user.id,
      sessionId: uuidv7(),
      role: user.role,
    });
    return {
      accessToken,
      expiresInSeconds: this.accessTtl,
      role: user.role,
    };
  }

  private async issueTokens(user: User, ctx: AuthRequestContext): Promise<TokenPair> {
    const issued = await this.refresh.issueOnLogin({
      userId: user.id,
      ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
      ...(ctx.ipAddress !== undefined ? { ipAddress: ctx.ipAddress } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    });
    const accessToken = this.jwt.signAccessToken({
      userId: user.id,
      sessionId: issued.sessionId,
      role: user.role,
    });
    const now = this.clock();
    await this.users.recordLogin(user.id, now);
    return {
      accessToken,
      refreshToken: issued.rawToken,
      accessTokenExpiresAt: new Date(now.getTime() + this.accessTtl * 1000).toISOString(),
      refreshTokenExpiresAt: issued.expiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }
}

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
    kycVerified: user.kycVerifiedAt !== null,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

interface PgUniqueViolation {
  readonly code: '23505';
  readonly constraint?: string;
}

function isUniqueViolation(err: unknown): err is PgUniqueViolation {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === '23505';
}

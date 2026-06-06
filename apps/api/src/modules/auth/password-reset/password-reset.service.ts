/**
 * Password-reset orchestration.
 *
 * Two flows, both public and unauthenticated:
 *
 *   requestReset  — look up the account by email; if it exists and is
 *                   eligible, invalidate any prior unused codes, mint a fresh
 *                   one, persist only its hash, and email the plaintext code.
 *                   ALWAYS resolves without signalling whether the email
 *                   existed — the controller returns 202 either way, so the
 *                   endpoint is not an account-enumeration oracle. Any failure
 *                   in the "account exists" branch (DB, Redis, provider) is
 *                   caught and logged rather than propagated, so an internal
 *                   error can't become a timing/error oracle that only fires
 *                   for real accounts.
 *
 *   resetPassword — hash the submitted code, look up the token, reject if
 *                   missing/expired/used, then ATOMICALLY claim it
 *                   (`markUsed` guarded on `used_at IS NULL`), set the new
 *                   password, revoke every session for the account, and sweep
 *                   any sibling tokens. Claiming before the expensive argon2
 *                   hash means a lost race or replay costs nothing.
 *
 * The code is a bearer credential: it alone identifies the account on reset,
 * so resetPassword takes no email. Session revocation on success forces every
 * device to re-authenticate — a reset is the canonical "I think I'm
 * compromised" action, so we don't leave old refresh tokens live.
 */
import { AuthError } from '@dankdash/types';
import { Injectable, Logger } from '@nestjs/common';
import { generateResetCode, hashResetCode, normalizeResetCode } from './reset-code.js';
import type { NotificationDispatcher } from '../../notifications/notification-dispatcher.service.js';
import type { PasswordService } from '../password/password.service.js';
import type {
  PasswordResetTokensRepository,
  SessionsRepository,
  UsersRepository,
} from '@dankdash/db';

export interface PasswordResetRequestContext {
  readonly ipAddress?: string;
}

export interface PasswordResetServiceConfig {
  readonly tokenTtlMinutes: number;
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
}

export interface PasswordResetServiceDeps {
  readonly users: UsersRepository;
  readonly tokens: PasswordResetTokensRepository;
  readonly sessions: SessionsRepository;
  readonly password: PasswordService;
  readonly dispatcher: NotificationDispatcher;
  readonly config: PasswordResetServiceConfig;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly ttlMs: number;
  private readonly clock: () => Date;

  constructor(private readonly deps: PasswordResetServiceDeps) {
    this.ttlMs = deps.config.tokenTtlMinutes * 60_000;
    this.clock = deps.config.clock ?? ((): Date => new Date());
  }

  async requestReset(email: string, ctx: PasswordResetRequestContext = {}): Promise<void> {
    const user = await this.deps.users.findByEmail(email);
    if (user?.deletedAt !== null || user.status === 'banned' || user.status === 'suspended') {
      // Enumeration-safe: silently no-op for unknown/ineligible accounts. The
      // controller still returns 202.
      return;
    }

    try {
      // Kill any codes already outstanding for this user so only the newest
      // email is redeemable.
      await this.deps.tokens.invalidateAllActiveForUser(user.id, this.clock());

      const { canonical, display } = generateResetCode();
      const now = this.clock();
      const token = await this.deps.tokens.create({
        userId: user.id,
        codeHash: hashResetCode(canonical),
        expiresAt: new Date(now.getTime() + this.ttlMs),
        ...(ctx.ipAddress !== undefined ? { requestedIp: ctx.ipAddress } : {}),
      });

      await this.deps.dispatcher.dispatch({
        userId: user.id,
        templateKey: 'auth.password_reset',
        payload: { code: display, expiresInMinutes: this.deps.config.tokenTtlMinutes },
        appVariant: 'consumer',
        // token.id is unique per request, so distinct requests never dedupe
        // against each other; a retried dispatch of the same token does.
        idempotencyKey: token.id,
      });
    } catch (err) {
      // Do NOT rethrow: a failure here only happens once we've confirmed the
      // account exists, so propagating it would leak that fact. Log with the
      // user id (never the email or code) for ops and return 202.
      this.logger.error(
        `password reset request failed after account match for user ${user.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async resetPassword(code: string, newPassword: string): Promise<void> {
    const codeHash = hashResetCode(normalizeResetCode(code));
    const token = await this.deps.tokens.findByCodeHash(codeHash);
    if (token === null) {
      throw new AuthError('TOKEN_INVALID', 'reset code is invalid or has already been used');
    }
    if (token.usedAt !== null) {
      throw new AuthError('TOKEN_INVALID', 'reset code is invalid or has already been used');
    }
    if (token.expiresAt.getTime() <= this.clock().getTime()) {
      throw new AuthError('TOKEN_EXPIRED', 'reset code has expired; request a new one');
    }

    // Atomically claim the token. If a concurrent request already consumed it,
    // `markUsed` returns false and we treat this as an invalid code — no
    // password is touched, no argon2 work is wasted.
    const claimed = await this.deps.tokens.markUsed(token.id, this.clock());
    if (!claimed) {
      throw new AuthError('TOKEN_INVALID', 'reset code is invalid or has already been used');
    }

    const user = await this.deps.users.findById(token.userId);
    if (user?.deletedAt !== null || user.status === 'banned' || user.status === 'suspended') {
      // The account became ineligible between minting and redemption. The
      // token is already burned (claimed above); surface a generic invalid.
      throw new AuthError('TOKEN_INVALID', 'reset code is invalid or has already been used');
    }

    const passwordHash = await this.deps.password.hash(newPassword);
    await this.deps.users.update(user.id, { passwordHash });

    // A reset is the canonical "lock out everyone else" action: revoke all
    // sessions and sweep any sibling reset tokens.
    await this.deps.sessions.revokeAllForUser(user.id);
    await this.deps.tokens.invalidateAllActiveForUser(user.id, this.clock());
  }
}

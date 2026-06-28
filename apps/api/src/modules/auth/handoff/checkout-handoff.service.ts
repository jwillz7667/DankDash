/**
 * Apple §10.4 checkout-handoff token service.
 *
 *   issue(userId, cartId, deliveryAddressId)
 *     - Verifies cart ownership (CartsRepository.findByIdForUser)
 *     - Verifies address ownership (UserAddressesRepository.findById + userId
 *       match + not soft-deleted)
 *     - Mints a short-lived RS256-signed JWT (5-min TTL by default) scoped
 *       to `aud: 'dankdash.checkout'`, carrying { sub, cartId, addrId, jti }
 *     - Returns { handoffToken, exchangeUrl, expiresAt } — exchangeUrl is
 *       fully composed against CHECKOUT_BASE_URL so iOS never templates URLs.
 *
 *   consume(token)
 *     - Verifies signature + issuer + audience + expiry
 *     - Atomically claims the jti via Redis SETNX with TTL = remaining
 *       seconds. Second exchange of the same token returns AuthError
 *       TOKEN_REVOKED — the OWASP defence against a stolen handoff being
 *       used twice.
 *     - Returns the parsed claims for checkout-web to consume.
 *
 * Reuse of the same RS256 key material as the access-token JwtService is
 * deliberate (one key-rotation policy) but the `aud` claim differs
 * (`dankdash.checkout` vs `dankdash.app`) so:
 *
 *   - JwtAuthGuard.verifyAccessToken rejects a handoff token (wrong aud)
 *   - consume() rejects an access token (wrong aud)
 *
 * Compromising one surface does not compromise the other.
 *
 * The `iss` claim matches the access-token issuer (`dankdash`) for the
 * same operational reason — a single key+iss pair simplifies key rollover.
 *
 * Cross-user issuance (issuing for someone else's cart or address) returns
 * `NotFoundError` (404) rather than `ForbiddenError` (403): the same response
 * shape as a missing row, so a probe cannot distinguish ownership-fail from
 * existence-fail (matches the read surfaces in /v1/orders + /v1/addresses).
 */
import { randomUUID } from 'node:crypto';
import { deriveJwsAlgorithm } from '@dankdash/config';
import { type CartsRepository, type Database, type UserAddressesRepository } from '@dankdash/db';
import { AuthError, NotFoundError } from '@dankdash/types';
import { Injectable, Logger } from '@nestjs/common';
import jwt, { type Algorithm, type SignOptions, type VerifyOptions } from 'jsonwebtoken';
import type { RedisClient } from '../../../infrastructure/redis.module.js';
import type { CheckoutHandoffResponse } from '../dto/index.js';

export interface CheckoutHandoffScopedRepos {
  readonly carts: CartsRepository;
  readonly userAddresses: UserAddressesRepository;
}

export type CheckoutHandoffScopedReposFactory = (db: Database) => CheckoutHandoffScopedRepos;

export interface CheckoutHandoffServiceConfig {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly ttlSeconds: number;
  readonly checkoutBaseUrl: string;
  readonly issuer?: string;
  readonly audience?: string;
  /** Test seam — defaults to `() => new Date()`. */
  readonly clock?: () => Date;
  /** Test seam — defaults to `crypto.randomUUID`. */
  readonly jtiFactory?: () => string;
}

export interface CheckoutHandoffClaims {
  readonly userId: string;
  readonly cartId: string;
  readonly deliveryAddressId: string;
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

const DEFAULT_ISSUER = 'dankdash';
const DEFAULT_AUDIENCE = 'dankdash.checkout';
const CLOCK_SKEW_SECONDS = 30;
const REDIS_JTI_PREFIX = 'auth:handoff:jti:';

@Injectable()
export class CheckoutHandoffService {
  private readonly logger = new Logger(CheckoutHandoffService.name);
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly ttl: number;
  private readonly baseUrl: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clock: () => Date;
  private readonly jtiFactory: () => string;
  private readonly algorithm: Algorithm;

  constructor(
    private readonly db: Database,
    private readonly reposFor: CheckoutHandoffScopedReposFactory,
    private readonly redis: RedisClient,
    config: CheckoutHandoffServiceConfig,
  ) {
    this.privateKey = config.privateKeyPem;
    this.publicKey = config.publicKeyPem;
    this.ttl = config.ttlSeconds;
    // Strip any trailing slash so `${baseUrl}/checkout?...` is always well-formed.
    this.baseUrl = config.checkoutBaseUrl.replace(/\/+$/, '');
    this.issuer = config.issuer ?? DEFAULT_ISSUER;
    this.audience = config.audience ?? DEFAULT_AUDIENCE;
    this.clock = config.clock ?? ((): Date => new Date());
    this.jtiFactory = config.jtiFactory ?? ((): string => randomUUID());
    // Asymmetric algorithm derived from the (RSA or EC) key the deployment
    // provisioned — the same key material the access-token issuer uses.
    this.algorithm = deriveJwsAlgorithm(this.privateKey);
  }

  async issue(
    userId: string,
    cartId: string,
    deliveryAddressId: string,
  ): Promise<CheckoutHandoffResponse> {
    const repos = this.reposFor(this.db);

    const cart = await repos.carts.findByIdForUser(cartId, userId);
    if (cart === null) {
      // Cross-user or missing cart — same response shape so a probe
      // cannot distinguish ownership-fail from existence-fail.
      throw new NotFoundError('Cart', cartId);
    }

    const address = await repos.userAddresses.findById(deliveryAddressId);
    if (address?.userId !== userId || address.deletedAt !== null) {
      throw new NotFoundError('UserAddress', deliveryAddressId);
    }

    const jti = this.jtiFactory();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttl * 1000);

    const options: SignOptions = {
      algorithm: this.algorithm,
      expiresIn: this.ttl,
      issuer: this.issuer,
      audience: this.audience,
      subject: userId,
      jwtid: jti,
      // jsonwebtoken derives `iat` from `Date.now()` internally — we want
      // it from the test clock when one is provided, so we set it explicitly.
      notBefore: 0,
    };

    const token = jwt.sign(
      {
        iat: Math.floor(now.getTime() / 1000),
        cartId,
        addrId: deliveryAddressId,
      },
      this.privateKey,
      options,
    );

    // URLSearchParams is the only correct way to compose the query string —
    // a hand-rolled concat would silently break on a future token that
    // contains a `+` or `=` in its base64url payload (jwt.io examples do).
    const exchangeUrl = `${this.baseUrl}/checkout?${new URLSearchParams({
      handoff: token,
    }).toString()}`;

    return {
      handoffToken: token,
      exchangeUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async consume(token: string): Promise<CheckoutHandoffClaims> {
    const claims = this.verifyToken(token);
    const remainingSeconds = Math.max(
      1,
      Math.floor((claims.expiresAt.getTime() - this.clock().getTime()) / 1000),
    );
    // SETNX (NX flag) is the atomic "set only if absent" — it returns 'OK'
    // on first insert, null on a subsequent insert. The TTL = remaining
    // seconds keeps the keyspace bounded (we don't carry consumed jtis
    // past the original token's expiry, since the JWT signature check
    // already covers re-exchange after expiry).
    const claimed = await this.redis.set(
      `${REDIS_JTI_PREFIX}${claims.jti}`,
      '1',
      'EX',
      remainingSeconds,
      'NX',
    );
    if (claimed === null) {
      this.logger.warn(
        { jti: claims.jti, userId: claims.userId, cartId: claims.cartId },
        'checkout handoff token reused — rejecting second exchange',
      );
      throw new AuthError('TOKEN_REVOKED', 'checkout handoff token already exchanged', {
        jti: claims.jti,
      });
    }
    return claims;
  }

  private verifyToken(token: string): CheckoutHandoffClaims {
    const options: VerifyOptions = {
      algorithms: [this.algorithm],
      issuer: this.issuer,
      audience: this.audience,
      clockTolerance: CLOCK_SKEW_SECONDS,
      // The runtime `clock` seam is for our internal tests, not jsonwebtoken's
      // verify (which uses Date.now() directly). The test clock is therefore
      // only honored for `issue` + the Redis TTL math; expiry rejection is
      // validated by jsonwebtoken against Date.now(). Tests that need to
      // simulate "6 minutes later" must advance vi.useFakeTimers() too.
      complete: false,
    };
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.publicKey, options);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AuthError('TOKEN_EXPIRED', 'checkout handoff token has expired', {}, err);
      }
      throw new AuthError('TOKEN_INVALID', 'checkout handoff token verification failed', {}, err);
    }
    if (typeof decoded !== 'object' || decoded === null) {
      throw new AuthError('TOKEN_INVALID', 'checkout handoff token claims malformed');
    }
    const raw = decoded as Record<string, unknown>;
    const sub = raw['sub'];
    const cartId = raw['cartId'];
    const addrId = raw['addrId'];
    const jti = raw['jti'];
    const iat = raw['iat'];
    const exp = raw['exp'];
    if (
      typeof sub !== 'string' ||
      typeof cartId !== 'string' ||
      typeof addrId !== 'string' ||
      typeof jti !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      throw new AuthError('TOKEN_INVALID', 'checkout handoff token claims malformed');
    }
    return {
      userId: sub,
      cartId,
      deliveryAddressId: addrId,
      jti,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
    };
  }
}

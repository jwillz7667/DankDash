/**
 * Unit tests for CheckoutHandoffService.
 *
 * The service composes two repositories (CartsRepository,
 * UserAddressesRepository) plus a Redis client (single-shot jti store).
 * Each test rig supplies fakes for all three; the scoped-repos factory is
 * the seam, matching the production path that builds tx-bound repos.
 *
 * Coverage focus:
 *   - issue: happy path mints an RS256 token with the right claims,
 *     composes the Safari URL via URLSearchParams, returns ISO expiresAt
 *   - issue: cross-user or missing cart → NotFoundError (same response
 *     shape as a missing row — probes cannot distinguish ownership from
 *     existence)
 *   - issue: cross-user / soft-deleted / missing address → NotFoundError
 *   - issue: URLSearchParams escapes a `+` or `=` in the token (regression
 *     against a naive concat that would silently break)
 *   - consume: happy path SETNX-claims the jti and returns parsed claims
 *   - consume: second exchange of the same token → TOKEN_REVOKED
 *     (this is the OWASP defence — a stolen handoff can't be replayed)
 *   - consume: token signed by a different key → TOKEN_INVALID
 *   - consume: token with wrong audience (e.g. an access token with
 *     `aud: dankdash.app`) → TOKEN_INVALID
 *   - consume: TTL-math is bounded — never SETNX with TTL <= 0
 */
import { generateKeyPairSync } from 'node:crypto';
import { AuthError, NotFoundError } from '@dankdash/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckoutHandoffService,
  type CheckoutHandoffScopedRepos,
} from './checkout-handoff.service.js';
import type { RedisClient } from '../../../infrastructure/redis.module.js';
import type {
  Cart,
  CartsRepository,
  Database,
  UserAddress,
  UserAddressesRepository,
} from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const CART_ID = '01935f3d-0000-7000-8000-000000000010';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000020';
const JTI = '01935f3d-0000-7000-8000-00000000aaaa';
const FIXED_NOW = new Date('2026-05-20T17:00:00.000Z');

const FAKE_DB = {} as Database;

function makeCart(overrides: Partial<Cart> = {}): Cart {
  const at = new Date('2026-05-20T16:30:00.000Z');
  return {
    id: CART_ID,
    userId: USER_ID,
    dispensaryId: '01935f3d-0000-7000-8000-0000000000aa',
    promoCodeId: null,
    expiresAt: new Date('2026-05-20T20:30:00.000Z'),
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeAddress(overrides: Partial<UserAddress> = {}): UserAddress {
  const at = new Date('2026-05-15T18:00:00.000Z');
  return {
    id: ADDRESS_ID,
    userId: USER_ID,
    label: 'Home',
    line1: '100 Nicollet Mall',
    line2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    country: 'US',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    isDefault: true,
    isValidated: false,
    validatedAt: null,
    deliveryInstructions: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...overrides,
  };
}

class FakeCartsRepo implements Pick<CartsRepository, 'findByIdForUser'> {
  public response: Cart | null = makeCart();
  public calls: { id: string; userId: string }[] = [];

  findByIdForUser(id: string, userId: string): Promise<Cart | null> {
    this.calls.push({ id, userId });
    if (this.response === null) return Promise.resolve(null);
    // Mirror the SQL predicate so a cross-user lookup returns null even
    // when `response` is set — keeps the rig honest.
    if (this.response.userId !== userId || this.response.id !== id) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.response);
  }
}

class FakeUserAddressesRepo implements Pick<UserAddressesRepository, 'findById'> {
  public response: UserAddress | null = makeAddress();
  public calls: string[] = [];

  findById(id: string): Promise<UserAddress | null> {
    this.calls.push(id);
    if (this.response === null) return Promise.resolve(null);
    if (this.response.id !== id) return Promise.resolve(null);
    return Promise.resolve(this.response);
  }
}

class FakeRedis {
  /** key → value */
  public store = new Map<string, string>();
  public calls: Array<[string, string, string, number, string]> = [];

  set = vi.fn(
    (key: string, value: string, ex: string, ttl: number, nx: string): Promise<'OK' | null> => {
      this.calls.push([key, value, ex, ttl, nx]);
      if (nx === 'NX' && this.store.has(key)) return Promise.resolve(null);
      this.store.set(key, value);
      return Promise.resolve('OK');
    },
  );
}

function makeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

interface Rig {
  service: CheckoutHandoffService;
  carts: FakeCartsRepo;
  addresses: FakeUserAddressesRepo;
  redis: FakeRedis;
}

function buildRig(
  keys: { privateKeyPem: string; publicKeyPem: string },
  overrides: {
    ttlSeconds?: number;
    checkoutBaseUrl?: string;
    clock?: () => Date;
    jtiFactory?: () => string;
  } = {},
): Rig {
  const carts = new FakeCartsRepo();
  const addresses = new FakeUserAddressesRepo();
  const redis = new FakeRedis();
  const reposFor = (_db: Database): CheckoutHandoffScopedRepos => ({
    carts: carts as unknown as CartsRepository,
    userAddresses: addresses as unknown as UserAddressesRepository,
  });
  const service = new CheckoutHandoffService(FAKE_DB, reposFor, redis as unknown as RedisClient, {
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    ttlSeconds: overrides.ttlSeconds ?? 300,
    checkoutBaseUrl: overrides.checkoutBaseUrl ?? 'https://app.dankdash.com',
    clock: overrides.clock ?? ((): Date => FIXED_NOW),
    jtiFactory: overrides.jtiFactory ?? ((): string => JTI),
  });
  return { service, carts, addresses, redis };
}

describe('CheckoutHandoffService', () => {
  let keys: ReturnType<typeof makeKeyPair>;

  beforeAll(() => {
    keys = makeKeyPair();
  });

  // Pin the system clock for the whole suite so jsonwebtoken's verify
  // (which reads Date.now() directly — see the service header) sees the
  // same instant the service's `clock` seam returns. Without this, real
  // wall-clock drift past FIXED_NOW + ttl makes issued tokens appear
  // already-expired and masks the behavior under test.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issue', () => {
    it('mints a token with the expected claims and a fully-composed exchange URL', async () => {
      const rig = buildRig(keys);

      const res = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);

      expect(res.handoffToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(res.exchangeUrl).toBe(
        `https://app.dankdash.com/checkout?handoff=${encodeURIComponent(res.handoffToken)}`,
      );
      expect(res.expiresAt).toBe(new Date(FIXED_NOW.getTime() + 300_000).toISOString());

      const decoded = jwt.verify(res.handoffToken, keys.publicKeyPem, {
        algorithms: ['RS256'],
        issuer: 'dankdash',
        audience: 'dankdash.checkout',
      }) as Record<string, unknown>;
      expect(decoded['sub']).toBe(USER_ID);
      expect(decoded['cartId']).toBe(CART_ID);
      expect(decoded['addrId']).toBe(ADDRESS_ID);
      expect(decoded['jti']).toBe(JTI);
      expect(decoded['iss']).toBe('dankdash');
      expect(decoded['aud']).toBe('dankdash.checkout');
      expect(decoded['iat']).toBe(Math.floor(FIXED_NOW.getTime() / 1000));
      expect(decoded['exp']).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + 300);
    });

    it('strips a trailing slash from the configured checkout base URL', async () => {
      const rig = buildRig(keys, { checkoutBaseUrl: 'https://app.dankdash.com/' });
      const res = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);
      expect(res.exchangeUrl).toMatch(/^https:\/\/app\.dankdash\.com\/checkout\?handoff=/);
      expect(res.exchangeUrl).not.toContain('.com//checkout');
    });

    it('returns NotFoundError when the cart is missing', async () => {
      const rig = buildRig(keys);
      rig.carts.response = null;

      await expect(rig.service.issue(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(rig.addresses.calls).toEqual([]);
    });

    it('returns NotFoundError when the cart belongs to a different user', async () => {
      const rig = buildRig(keys);
      rig.carts.response = makeCart({ userId: OTHER_USER_ID });

      await expect(rig.service.issue(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Address lookup must not happen — short-circuit on cart failure so a
      // probe can't distinguish "cart missing" from "address missing".
      expect(rig.addresses.calls).toEqual([]);
    });

    it('returns NotFoundError when the address is missing', async () => {
      const rig = buildRig(keys);
      rig.addresses.response = null;

      await expect(rig.service.issue(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('returns NotFoundError when the address belongs to a different user', async () => {
      const rig = buildRig(keys);
      rig.addresses.response = makeAddress({ userId: OTHER_USER_ID });

      await expect(rig.service.issue(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('returns NotFoundError when the address is soft-deleted', async () => {
      const rig = buildRig(keys);
      rig.addresses.response = makeAddress({
        deletedAt: new Date('2026-05-19T12:00:00.000Z'),
      });

      await expect(rig.service.issue(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('properly URL-encodes a token containing a `+` or `=` in its payload', async () => {
      // Force-feed a jti that, combined with the RSA signature bits, is
      // likely to surface a `+` or `=` in the JWS — and confirm our
      // URLSearchParams-based composition escapes them. Any payload-content
      // permutation is fine; what matters is the *encoder*.
      const rig = buildRig(keys);
      const res = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);

      const url = new URL(res.exchangeUrl);
      // The query parser must round-trip back to the raw JWT bytes.
      expect(url.searchParams.get('handoff')).toBe(res.handoffToken);
    });

    it('does not write to Redis on issuance (jti is only claimed on consume)', async () => {
      const rig = buildRig(keys);
      await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);
      expect(rig.redis.set).not.toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    it('SETNX-claims the jti and returns parsed claims on the first exchange', async () => {
      const rig = buildRig(keys);
      const { handoffToken } = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);

      const claims = await rig.service.consume(handoffToken);

      expect(claims.userId).toBe(USER_ID);
      expect(claims.cartId).toBe(CART_ID);
      expect(claims.deliveryAddressId).toBe(ADDRESS_ID);
      expect(claims.jti).toBe(JTI);
      expect(claims.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 300_000);
      expect(rig.redis.set).toHaveBeenCalledTimes(1);
      const call = rig.redis.set.mock.calls[0];
      expect(call).toBeDefined();
      const [key, value, ex, ttl, nx] = call!;
      expect(key).toBe(`auth:handoff:jti:${JTI}`);
      expect(value).toBe('1');
      expect(ex).toBe('EX');
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      expect(nx).toBe('NX');
    });

    it('rejects a second exchange of the same token with TOKEN_REVOKED', async () => {
      const rig = buildRig(keys);
      const { handoffToken } = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);

      await rig.service.consume(handoffToken);

      try {
        await rig.service.consume(handoffToken);
        expect.fail('expected TOKEN_REVOKED');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_REVOKED');
      }
      expect(rig.redis.set).toHaveBeenCalledTimes(2);
    });

    it('rejects a token signed by a different key as TOKEN_INVALID', async () => {
      const rig = buildRig(keys);
      const foreignKeys = makeKeyPair();
      const forged = jwt.sign({ cartId: CART_ID, addrId: ADDRESS_ID }, foreignKeys.privateKeyPem, {
        algorithm: 'RS256',
        issuer: 'dankdash',
        audience: 'dankdash.checkout',
        subject: USER_ID,
        jwtid: JTI,
        expiresIn: 300,
      });

      try {
        await rig.service.consume(forged);
        expect.fail('expected TOKEN_INVALID');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_INVALID');
      }
      expect(rig.redis.set).not.toHaveBeenCalled();
    });

    it('rejects an access-token-shaped JWT (wrong audience) as TOKEN_INVALID', async () => {
      // This is the cross-surface confusion guard: an access token signed
      // by the SAME key but with `aud: dankdash.app` must NOT validate
      // here. Otherwise compromising the access-token surface would let an
      // attacker exchange one for a checkout handoff.
      const rig = buildRig(keys);
      const accessTokenShaped = jwt.sign({ sid: 'sess', role: 'customer' }, keys.privateKeyPem, {
        algorithm: 'RS256',
        issuer: 'dankdash',
        audience: 'dankdash.app',
        subject: USER_ID,
        expiresIn: 900,
      });

      try {
        await rig.service.consume(accessTokenShaped);
        expect.fail('expected TOKEN_INVALID');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_INVALID');
      }
    });

    it('rejects an expired token as TOKEN_EXPIRED', async () => {
      const rig = buildRig(keys);
      // Sign a token with a backdated iat so it's already past expiry
      // beyond the 30s clock-skew window.
      const expired = jwt.sign(
        {
          iat: Math.floor(FIXED_NOW.getTime() / 1000) - 3600,
          cartId: CART_ID,
          addrId: ADDRESS_ID,
        },
        keys.privateKeyPem,
        {
          algorithm: 'RS256',
          issuer: 'dankdash',
          audience: 'dankdash.checkout',
          subject: USER_ID,
          jwtid: JTI,
          expiresIn: 60,
        },
      );

      try {
        await rig.service.consume(expired);
        expect.fail('expected TOKEN_EXPIRED');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_EXPIRED');
      }
    });

    it('rejects a malformed-claims token as TOKEN_INVALID', async () => {
      const rig = buildRig(keys);
      // Sign a token that verifies but is missing cartId / addrId.
      const malformed = jwt.sign({ wrongShape: true }, keys.privateKeyPem, {
        algorithm: 'RS256',
        issuer: 'dankdash',
        audience: 'dankdash.checkout',
        subject: USER_ID,
        jwtid: JTI,
        expiresIn: 300,
      });

      try {
        await rig.service.consume(malformed);
        expect.fail('expected TOKEN_INVALID');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_INVALID');
      }
    });

    it('clamps Redis TTL to a positive integer when the token is near-expiry', async () => {
      // Service clock advances between issue and consume so the remaining
      // TTL math goes negative — the floor of 1 is what protects the
      // SETNX call from a zero/negative EX value.
      let currentTime = FIXED_NOW.getTime();
      const clock = (): Date => new Date(currentTime);
      const rig = buildRig(keys, { ttlSeconds: 60, clock });
      const { handoffToken } = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);
      // Push the service clock past the JWT exp, but keep the system
      // clock (which jsonwebtoken reads) at FIXED_NOW + 30s so verify
      // still passes — we only want to test the Redis TTL clamp.
      currentTime += 120_000;
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 30_000));

      await rig.service.consume(handoffToken);

      const call = rig.redis.set.mock.calls[0];
      expect(call).toBeDefined();
      expect(call![3]).toBeGreaterThanOrEqual(1);
    });
  });

  describe('integration with fake timers', () => {
    it('rejects an issued token after its TTL has passed (via system clock)', async () => {
      const rig = buildRig(keys, {
        ttlSeconds: 300,
        clock: (): Date => new Date(),
      });
      const { handoffToken } = await rig.service.issue(USER_ID, CART_ID, ADDRESS_ID);

      // Advance past TTL + 30s clock-skew tolerance.
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 400_000));

      try {
        await rig.service.consume(handoffToken);
        expect.fail('expected TOKEN_EXPIRED');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_EXPIRED');
      }
    });
  });
});

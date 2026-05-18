/**
 * Ioredis-backed adapter for the Aeropay package's `TokenCache` interface.
 *
 * The aeropay package deliberately depends on a 3-method `TokenCache`
 * abstraction rather than ioredis directly — it lets the package's own
 * tests use the bundled MemoryTokenCache without spinning a container,
 * and keeps the package zero-dep on Redis. This adapter is the
 * composition-root binding that wires the production ioredis client to
 * that interface; see `payments.module.ts` for the FactoryProvider that
 * constructs it.
 *
 * Why a separate class rather than an inline closure in the module:
 *   - The adapter is independently unit-testable against an in-process
 *     ioredis fake (the constructor takes the minimal `Redis`-shaped
 *     surface, so a hand-rolled stub satisfies the type).
 *   - The TTL handling is the single non-obvious branch: Aeropay's
 *     `expires_in` is in whole seconds and AeropayAuth uses
 *     `SET key value EX ttlSeconds` semantics, which is `set(key, value,
 *     'EX', ttl)` on ioredis. The adapter centralizes that mapping so a
 *     future refactor (Redis cluster, in-process LRU layer) only touches
 *     one file.
 *
 * Errors propagate as-is — the auth flow tolerates a cache miss (refetch
 * from Aeropay) but a hard Redis failure should surface so ops can alert
 * on it rather than silently degrade every API process to per-process
 * token caching.
 */
import { type TokenCache } from '@dankdash/aeropay';

/**
 * Subset of the ioredis surface this adapter exercises. Keeping the type
 * minimal (rather than importing `Redis` from ioredis) lets tests pass a
 * stub object without satisfying ioredis's 200-method interface.
 */
export interface RedisLikeForTokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

export class RedisTokenCache implements TokenCache {
  constructor(private readonly redis: RedisLikeForTokenCache) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

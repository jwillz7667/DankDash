/**
 * Storage abstraction for the catalog cache layer.
 *
 * Two implementations live here:
 *
 *   RedisCatalogCacheStore  — production. JSON-serialises the value into a
 *                             string key with a PX TTL so Redis auto-evicts
 *                             at the freshness boundary. Reads `get` and
 *                             writes `setex` go through a single round trip
 *                             each; deletes pipeline multiple keys when the
 *                             caller has more than one to drop in one go.
 *                             Errors surface to the caller as `null` for
 *                             reads, `void` for writes — the service layer
 *                             above treats a Redis hiccup as a cache miss
 *                             rather than a request failure, because the
 *                             read paths are not on the compliance hot path
 *                             and going to Postgres is safe.
 *
 *   MemoryCatalogCacheStore — tests + local dev without Redis. Same TTL
 *                             semantics, backed by a Map. The clock is
 *                             injectable so tests can advance time without
 *                             sleeping.
 *
 * Values are stored as opaque `unknown` JSON and the typed wrapper above
 * (CatalogCacheService.readThrough<T>) casts on the way out. The cache is
 * a private contract between the catalog service and itself, so a mis-
 * typed read is a programming bug, not a trust-boundary breach the way an
 * HTTP body would be. Callers cast at the read site.
 */
import assert from 'node:assert/strict';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';

export const CATALOG_CACHE_STORE = Symbol.for('CATALOG_CACHE_STORE');

export interface CatalogCacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(keys: readonly string[]): Promise<void>;
}

@Injectable()
export class RedisCatalogCacheStore implements CatalogCacheStore {
  private readonly log = new Logger(RedisCatalogCacheStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(key: string): Promise<unknown> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      return JSON.parse(raw);
    } catch (error) {
      // Fail-open: a Redis hiccup degrades the cache to a pass-through, it
      // does not fail the request. Log so the SRE board picks up sustained
      // outages; the error is structured so pino's redaction rules apply.
      this.log.warn({ key, err: error }, 'catalog cache get failed; returning miss');
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    assert(ttlSeconds > 0, 'ttlSeconds must be positive');
    try {
      const payload = JSON.stringify(value);
      await this.redis.set(key, payload, 'EX', ttlSeconds);
    } catch (error) {
      this.log.warn({ key, err: error }, 'catalog cache set failed');
    }
  }

  async del(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      // ioredis spreads variadic keys, but `del([])` would call DEL with no
      // arguments which Redis rejects. The early return above guards that.
      await this.redis.del(...keys);
    } catch (error) {
      this.log.warn({ keys, err: error }, 'catalog cache del failed');
    }
  }
}

interface MemoryEntry {
  readonly payload: string;
  readonly expiresAt: number;
}

/**
 * In-memory fallback used in unit tests. `now()` is injectable so tests can
 * advance the wall clock and verify TTL expiry without sleeping.
 */
export class MemoryCatalogCacheStore implements CatalogCacheStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: () => number = (): number => Date.now()) {}

  get(key: string): Promise<unknown> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(null);
    if (entry.expiresAt <= this.now()) {
      // Lazy eviction: a hit on an expired entry returns null and clears the
      // slot. A live process never has to sweep the Map, and tests that
      // advance the clock past the TTL see the same behaviour as Redis EX.
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(JSON.parse(entry.payload));
  }

  set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    assert(ttlSeconds > 0, 'ttlSeconds must be positive');
    this.entries.set(key, {
      payload: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  del(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
    return Promise.resolve();
  }

  size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }
}

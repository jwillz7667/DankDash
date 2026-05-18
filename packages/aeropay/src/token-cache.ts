/**
 * Minimal cache surface the Aeropay auth flow depends on.
 *
 * Defined as a 3-method interface (`get`/`set`/`del`) rather than imported
 * from `ioredis` so the package has zero runtime dep on Redis and tests
 * can use the in-memory implementation without spinning a container.
 * The API layer wires an ioredis adapter at the composition root.
 *
 * Values are opaque strings (the cached token JSON). TTL is in whole
 * seconds — Aeropay's `expires_in` is seconds and Redis EXPIRE is
 * second-resolution, so there is no need for millisecond plumbing.
 */
export interface TokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Process-local cache for tests and local development. Holds a single
 * entry per key with an explicit expiry timestamp; `get` returns null
 * when the entry has expired without proactively cleaning up, which is
 * fine because the only key the auth module uses is rewritten on every
 * refresh.
 */
export class MemoryTokenCache implements TokenCache {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return Promise.resolve(null);
    if (entry.expiresAtMs <= this.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

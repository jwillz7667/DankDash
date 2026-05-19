/**
 * RateLimitStore — the storage abstraction the RateLimitGuard depends on.
 *
 * A fixed-window counter keyed by an opaque string. Each call to `hit()`
 * returns the running count for the current window and the milliseconds
 * remaining before the window resets. The guard decides whether to allow
 * or reject based on the limit.
 *
 * Two implementations live in this package:
 *
 *   RedisRateLimitStore  — production. Pipelines INCR + PEXPIRE NX +
 *                          PTTL so the first hit in a window stamps the
 *                          expiry and subsequent hits leave it alone. The
 *                          three commands run in a single round trip; the
 *                          NX flag is what makes the window "fixed" — if
 *                          we re-set the TTL on every hit we'd get a
 *                          rolling window that an attacker can hold open
 *                          indefinitely.
 *
 *   MemoryRateLimitStore — tests + local dev without Redis. Same fixed-
 *                          window semantics, backed by a Map. The wall
 *                          clock can be injected so tests don't have to
 *                          actually wait for windows to expire.
 *
 * Why not @nestjs/throttler's built-in storage adapter? — Two reasons:
 *
 *   1. throttler's @Throttle decorator is awkward for multi-tracker
 *      routes (login needs both per-IP and per-email windows). We'd end
 *      up with a custom guard either way.
 *   2. RedisThrottlerStorage from the community package adds a runtime
 *      dependency (and one more module to keep current). The fixed-
 *      window pipeline is six lines; owning it is cheaper than vendoring.
 */
import assert from 'node:assert/strict';
import { Inject, Injectable } from '@nestjs/common';
import { type Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';

export const RATE_LIMIT_STORE = Symbol.for('RATE_LIMIT_STORE');

export interface RateLimitHit {
  /** Total count for this window (including the call that produced it). */
  readonly count: number;
  /** Milliseconds remaining before the window expires. */
  readonly resetMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

@Injectable()
export class RedisRateLimitStore implements RateLimitStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    // Pipeline keeps the round trip to one. INCR creates the key on
    // first hit; PEXPIRE NX stamps the TTL only when no TTL is set, so
    // subsequent hits in the same window inherit the original deadline;
    // PTTL returns the milliseconds remaining for the caller.
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.pexpire(key, windowMs, 'NX');
    pipeline.pttl(key);
    const results = await pipeline.exec();
    // pipeline.exec() returns null only on a transaction abort, which a
    // non-MULTI pipeline cannot produce. Treat as a storage bug — both
    // here and below are invariants of the ioredis client, not user input.
    assert(results !== null, 'redis pipeline.exec returned null');
    const [incr, , pttl] = results;
    assert(incr !== undefined && pttl !== undefined, 'redis pipeline missing expected result');
    const count = readNumber(incr);
    const resetMsRaw = readNumber(pttl);
    // PTTL returns -1 when the key has no expiry (race: the NX expire
    // landed between INCR and PTTL on a fresh key) and -2 if the key
    // does not exist. Clamp both to windowMs so the caller never sees
    // a nonsensical "this window resets 2ms ago" reply.
    const resetMs = resetMsRaw < 0 ? windowMs : resetMsRaw;
    return { count, resetMs };
  }
}

interface MemoryEntry {
  count: number;
  expiresAt: number;
}

/**
 * In-memory fallback. Used in unit tests and local development without
 * a Redis. Same fixed-window semantics as the Redis impl; `now()` is
 * injectable so tests can advance the clock instead of sleeping.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: () => number = (): number => Date.now()) {}

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing === undefined || existing.expiresAt <= now) {
      const expiresAt = now + windowMs;
      this.entries.set(key, { count: 1, expiresAt });
      return Promise.resolve({ count: 1, resetMs: windowMs });
    }
    existing.count += 1;
    return Promise.resolve({ count: existing.count, resetMs: existing.expiresAt - now });
  }

  reset(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

function readNumber(result: [Error | null, unknown]): number {
  const [err, value] = result;
  if (err !== null) throw err;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10);
  // assert.fail produces an AssertionError carrying the diagnostic — the
  // lint rule forbids `throw new Error` to keep the DomainError envelope
  // discipline; an AssertionError here flags a storage-layer invariant
  // violation that should never reach a user response.
  assert.fail(`unexpected redis result type ${typeof value}`);
}

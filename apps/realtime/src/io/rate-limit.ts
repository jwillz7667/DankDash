/**
 * Per-socket token bucket — enforces client-to-server event rate limits
 * without the cost of a Redis round-trip per event. The bucket is held in
 * `socket.data` so it tears down with the connection automatically.
 *
 * Why in-memory and not Redis: rate limiting here is a UX guardrail
 * (don't flood the location-ingest stream from a buggy client), not a
 * security boundary — a malicious driver would face DB-side rate limits
 * downstream. In-memory is fast, has no failure modes, and matches the
 * 1-second-per-event spec from Phase 9.4 exactly.
 *
 * The bucket holds `capacity` tokens; each event takes one; tokens refill
 * at `refillPerSecond`. `consume()` returns false when the bucket is
 * empty — the caller decides whether to ignore the event silently or
 * tell the client via an `error` emit.
 */
export interface TokenBucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity;
    this.refillPerMs = config.refillPerSecond / 1000;
    this.now = config.now ?? Date.now;
    this.tokens = config.capacity;
    this.lastRefillMs = this.now();
  }

  consume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefillMs;
    if (elapsed <= 0) return;
    const refill = elapsed * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.lastRefillMs = t;
  }
}

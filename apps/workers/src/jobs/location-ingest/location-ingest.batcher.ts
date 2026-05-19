/**
 * Size + time bounded batcher for inbound location events.
 *
 * Why batch at all: the driver fleet pings every 5s, so at 500 active
 * drivers the stream emits ~100 envelopes/sec. One INSERT-per-envelope
 * would burn a transaction round-trip per ping and rate-limit the worker
 * to single-digit-thousand pings/sec on its own — well within the Phase 10
 * DoD's ≥500 msg/sec floor today, but tight enough that a brief Redis
 * stall would back the stream up. Batching `recordBatch` calls makes
 * Postgres take 100 inserts as one round-trip while still keeping a
 * 500ms tail-latency ceiling for the latest ping a customer's tracker
 * UI sees.
 *
 * Flush triggers:
 *   1. **Size**: as soon as the buffer reaches `maxSize`, flush
 *      synchronously and reset the timer. Stops the buffer from growing
 *      under a sudden burst.
 *   2. **Time**: `maxLatencyMs` after the first entry lands, flush
 *      whatever is buffered. Bounds tail latency when the fleet is light.
 *
 * The batcher is intentionally pure I/O-shape: it does not own a Redis
 * connection, a DB pool, or a clock. The consumer drives `enqueue` /
 * `tick` and acts on the flushed-batch callback. This keeps the unit
 * tests deterministic (no fake timers, no testcontainer) and the consumer
 * free to test its XREADGROUP loop against a real Redis without dragging
 * the batching cadence into that test surface.
 */

export interface BatcherOptions<T> {
  /** Maximum number of items before a size-triggered flush. */
  readonly maxSize: number;
  /** Maximum wall-time gap from the first buffered item to a time-triggered flush. */
  readonly maxLatencyMs: number;
  /**
   * Called when a flush is due. The caller is responsible for awaiting it
   * before invoking another flush (the consumer serialises XREADGROUP →
   * `enqueue` → optional `tick` so this is naturally sequential).
   */
  readonly onFlush: (items: readonly T[]) => Promise<void>;
}

export class LocationBatcher<T> {
  private readonly buf: T[] = [];
  private firstEnqueuedAt: number | null = null;
  private readonly options: BatcherOptions<T>;

  constructor(options: BatcherOptions<T>) {
    if (options.maxSize <= 0) {
      throw new RangeError(`maxSize must be > 0; got ${options.maxSize}`);
    }
    if (options.maxLatencyMs <= 0) {
      throw new RangeError(`maxLatencyMs must be > 0; got ${options.maxLatencyMs}`);
    }
    this.options = options;
  }

  /**
   * Append an item. If this push reaches `maxSize`, the flush fires
   * inline and the buffer resets before the call returns — the caller
   * therefore observes back-pressure at the level of `enqueue`, not via a
   * separate scheduler.
   */
  async enqueue(item: T, now: number = Date.now()): Promise<void> {
    if (this.buf.length === 0) {
      this.firstEnqueuedAt = now;
    }
    this.buf.push(item);
    if (this.buf.length >= this.options.maxSize) {
      await this.flush();
    }
  }

  /**
   * Call between XREADGROUP rounds — flushes if the oldest buffered item
   * is older than `maxLatencyMs`. A no-op when the buffer is empty or
   * still within the latency budget.
   *
   * `now` is injected so tests can advance a virtual clock.
   */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.buf.length === 0) return;
    if (this.firstEnqueuedAt === null) return;
    if (now - this.firstEnqueuedAt < this.options.maxLatencyMs) return;
    await this.flush();
  }

  /**
   * Force-flush regardless of triggers. Used by graceful shutdown so the
   * in-flight buffer reaches Postgres before the process exits. Safe to
   * call when empty (returns without invoking `onFlush`).
   */
  async drain(): Promise<void> {
    if (this.buf.length === 0) return;
    await this.flush();
  }

  /** Current buffer depth — exposed for tests + future telemetry. */
  size(): number {
    return this.buf.length;
  }

  private async flush(): Promise<void> {
    // Snapshot + reset before awaiting the handler. If `onFlush` throws,
    // the items are *not* re-buffered — the stream consumer relies on
    // not-acking those entries to redeliver them via XPENDING + XCLAIM.
    // Keeping the buffer reset eliminates an entire "double-process the
    // same item from two recovery paths" failure mode.
    const items = this.buf.splice(0, this.buf.length);
    this.firstEnqueuedAt = null;
    await this.options.onFlush(items);
  }
}

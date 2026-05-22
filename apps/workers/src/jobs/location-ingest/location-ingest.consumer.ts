/**
 * Redis-Streams consumer that drains the `dankdash:realtime` stream of
 * `driver:location` envelopes and feeds them through the batcher → writer
 * pipeline.
 *
 * Architecture overview:
 *
 *   - Consumer group `workers-location-ingest` is independent of the
 *     realtime-service's `realtime` group. Each group sees every entry
 *     XADDed to the stream — Redis Streams fan out per-group, not
 *     per-consumer — so the realtime fanout and the location persistence
 *     happen in parallel without one starving the other.
 *
 *   - Each XREADGROUP pulls up to `batchSize` entries with BLOCK; non-
 *     matching event types (order:status_changed, offer:new, …) are ACKed
 *     immediately and dropped. Matching `driver:location` payloads are
 *     enqueued onto the batcher; the consumer remembers the
 *     `(streamId, item)` pairing and ACKs after the batch's onFlush
 *     resolves.
 *
 *   - Recovery: XPENDING + XCLAIM moves entries idle longer than
 *     `recoverIdleMs` onto this consumer. The recovery path uses the same
 *     decode/enqueue logic as the live path — any stale entry that was
 *     mid-batch when a worker crashed gets re-batched here.
 *
 *   - Failures: if the writer throws inside `flushBatch`, the consumer
 *     does *not* ACK the affected entries. They remain in XPENDING and
 *     the next recovery cycle (this loop iteration or another pod) picks
 *     them up. The batcher already drops its in-memory buffer on error,
 *     so a re-delivery of the same items proceeds from scratch.
 *
 * Not transactional with Postgres — the writer's two operations
 * (recordBatch + per-driver updateLocation) commit independently. See
 * the writer's header comment for why the chosen order minimises
 * user-visible weirdness on a mid-batch crash.
 */
import { hostname } from 'node:os';
import { type Logger } from '@dankdash/config';
import {
  REALTIME_STREAM_KEY,
  decodeStreamEntry,
  type RealtimeEnvelope,
} from '@dankdash/realtime-events';
import { LocationBatcher } from './location-ingest.batcher.js';
import type { LocationIngestItem } from './types.js';
import type { Redis } from 'ioredis';

export interface LocationIngestConsumerOptions {
  /**
   * Dedicated ioredis connection. ioredis serialises commands per
   * connection, so a shared connection would deadlock the BLOCKing
   * XREADGROUP against any concurrent producer XADD. The worker entry
   * point hands us our own client; see `apps/realtime/src/server.ts`
   * for the same pattern.
   */
  readonly redis: Redis;
  readonly logger: Logger;
  /** Consumer group name. Defaults to `workers-location-ingest`. */
  readonly group?: string;
  /** Consumer name within the group. Defaults to `<hostname>-<pid>`. */
  readonly consumerName?: string;
  /** Items per buffered flush. Phase 10 spec § 10.1 mandates 100. */
  readonly batchSize?: number;
  /** Max ms from first buffered item to a time-triggered flush. Spec mandates 500. */
  readonly batchLatencyMs?: number;
  /** ms to BLOCK on XREADGROUP — keep < batchLatencyMs so `tick()` can fire. */
  readonly blockMs?: number;
  /** Threshold for XPENDING idle recovery. */
  readonly recoverIdleMs?: number;
  /** Max entries pulled per XREADGROUP / XPENDING round. */
  readonly readChunkSize?: number;
  /**
   * Persistence handler — the writer in production, a fake in tests. The
   * consumer awaits this; throwing here is the signal to not-ACK the
   * batch.
   */
  readonly flushBatch: (items: readonly LocationIngestItem[]) => Promise<void>;
  /**
   * Optional per-item observer fired *after* a successful flush — used by
   * Phase 10.2's geofence trigger to check arrivals against the just-
   * committed positions. Failures here are logged but do NOT block ACK
   * (the persistence succeeded; the geofence is a side effect and will
   * fire on the next ping if missed).
   */
  readonly onCommitted?: (item: LocationIngestItem) => Promise<void>;
}

type RedisStreamReply = ReadonlyArray<[string, ReadonlyArray<[string, string[]]>]> | null;
type RedisXPendingExtendedReply = ReadonlyArray<readonly [string, string, number, number]>;

interface PendingEntry {
  readonly streamId: string;
  readonly item: LocationIngestItem;
}

export class LocationIngestConsumer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly group: string;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly recoverIdleMs: number;
  private readonly readChunkSize: number;
  private readonly batcher: LocationBatcher<PendingEntry>;
  private readonly flushBatch: (items: readonly LocationIngestItem[]) => Promise<void>;
  private readonly onCommitted: ((item: LocationIngestItem) => Promise<void>) | undefined;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: LocationIngestConsumerOptions) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.group = options.group ?? 'workers-location-ingest';
    this.consumerName = options.consumerName ?? `${hostname()}-${process.pid}`;
    this.blockMs = options.blockMs ?? 250;
    this.recoverIdleMs = options.recoverIdleMs ?? 60_000;
    this.readChunkSize = options.readChunkSize ?? 100;
    this.flushBatch = options.flushBatch;
    this.onCommitted = options.onCommitted;

    const batchSize = options.batchSize ?? 100;
    const batchLatencyMs = options.batchLatencyMs ?? 500;

    this.batcher = new LocationBatcher<PendingEntry>({
      maxSize: batchSize,
      maxLatencyMs: batchLatencyMs,
      onFlush: (entries) => this.handleFlush(entries),
    });
  }

  /**
   * Create the consumer group if it does not exist. `MKSTREAM` so the
   * call works on a fresh Redis where no producer has XADDed yet.
   */
  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', REALTIME_STREAM_KEY, this.group, '$', 'MKSTREAM');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop().catch((err: unknown) => {
      this.logger.error(
        {
          event: 'location-ingest.loop_crashed',
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: consumer loop crashed',
      );
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise !== null) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    // Drain anything still buffered so a graceful shutdown doesn't drop
    // already-XREADGROUPped entries. The XACK in handleFlush ensures the
    // pending list gets cleaned up too.
    try {
      await this.batcher.drain();
    } catch (err) {
      this.logger.warn(
        {
          event: 'location-ingest.drain_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: shutdown drain failed; entries remain in XPENDING',
      );
    }
  }

  /** Test seam — runs one full read+flush cycle without the loop scaffold. */
  async runOnce(): Promise<void> {
    await this.recoverPending();
    await this.readNew();
    await this.batcher.drain();
  }

  private isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.isRunning()) {
      try {
        await this.recoverPending();
        if (!this.isRunning()) break;
        await this.readNew();
        // Time-triggered flush sits between read rounds — keeps the
        // latency budget honest even when the stream is slow.
        await this.batcher.tick();
      } catch (err) {
        this.logger.warn(
          {
            event: 'location-ingest.read_error',
            err: err instanceof Error ? err.message : String(err),
          },
          'location-ingest: read error; backing off',
        );
        await sleep(250);
      }
    }
  }

  private async readNew(): Promise<void> {
    const reply = (await this.redis.xreadgroup(
      'GROUP',
      this.group,
      this.consumerName,
      'COUNT',
      this.readChunkSize,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      REALTIME_STREAM_KEY,
      '>',
    )) as RedisStreamReply;
    if (reply === null) return;
    for (const [, entries] of reply) {
      for (const [streamId, fields] of entries) {
        await this.ingestEntry(streamId, fields);
      }
    }
  }

  private async recoverPending(): Promise<void> {
    const summary = (await this.redis.xpending(
      REALTIME_STREAM_KEY,
      this.group,
      'IDLE',
      this.recoverIdleMs,
      '-',
      '+',
      this.readChunkSize,
    )) as RedisXPendingExtendedReply;
    if (summary.length === 0) return;
    const ids = summary.map((row) => row[0]);
    const claimed = (await this.redis.xclaim(
      REALTIME_STREAM_KEY,
      this.group,
      this.consumerName,
      this.recoverIdleMs,
      ...ids,
    )) as ReadonlyArray<[string, string[]]>;
    for (const [streamId, fields] of claimed) {
      await this.ingestEntry(streamId, fields);
    }
  }

  private async ingestEntry(streamId: string, fields: string[]): Promise<void> {
    let envelope: RealtimeEnvelope;
    try {
      ({ envelope } = decodeStreamEntry(streamId, fields));
    } catch (err) {
      // Malformed envelope — ACK so it leaves XPENDING. The realtime
      // service does the same; both consumer groups need to agree to
      // drop the row or it would block both forever.
      this.logger.warn(
        {
          event: 'location-ingest.decode_failed',
          streamId,
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: dropping un-decodable stream entry',
      );
      await this.ack(streamId);
      return;
    }

    if (envelope.event.type !== 'driver:location') {
      // Other event types are routed by the realtime service; the
      // worker's job here is purely to materialise location updates.
      // ACK and move on so the entry leaves XPENDING for this group.
      await this.ack(streamId);
      return;
    }

    await this.batcher.enqueue({
      streamId,
      item: { streamId, payload: envelope.event.payload },
    });
  }

  private async handleFlush(entries: readonly PendingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const items = entries.map((e) => e.item);
    try {
      await this.flushBatch(items);
    } catch (err) {
      // Persistence failed — DO NOT ACK. XPENDING + XCLAIM will redeliver
      // these entries; the batcher has already cleared its internal buffer
      // so the next read round will see them fresh and re-buffer them.
      this.logger.error(
        {
          event: 'location-ingest.flush_failed',
          batch: entries.length,
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: batch persistence failed; entries will be redelivered',
      );
      return;
    }

    // ACK the whole batch in a single round-trip — XACK accepts variadic
    // ids and Postgres has already committed by this point.
    await this.ackMany(entries.map((e) => e.streamId));

    if (this.onCommitted !== undefined) {
      const observer = this.onCommitted;
      // Fan out post-commit observers in parallel; failures don't block
      // ACK (already done) and don't poison the next batch.
      const results = await Promise.allSettled(items.map((item) => observer(item)));
      for (const r of results) {
        if (r.status === 'rejected') {
          this.logger.warn(
            {
              event: 'location-ingest.observer_failed',
              err: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
            'location-ingest: post-commit observer failed',
          );
        }
      }
    }
  }

  private async ack(streamId: string): Promise<void> {
    try {
      await this.redis.xack(REALTIME_STREAM_KEY, this.group, streamId);
    } catch (err) {
      this.logger.warn(
        {
          event: 'location-ingest.ack_failed',
          streamId,
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: XACK failed; entry will be redelivered',
      );
    }
  }

  private async ackMany(streamIds: readonly string[]): Promise<void> {
    if (streamIds.length === 0) return;
    try {
      await this.redis.xack(REALTIME_STREAM_KEY, this.group, ...streamIds);
    } catch (err) {
      this.logger.warn(
        {
          event: 'location-ingest.ack_failed',
          count: streamIds.length,
          err: err instanceof Error ? err.message : String(err),
        },
        'location-ingest: bulk XACK failed; entries will be redelivered',
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

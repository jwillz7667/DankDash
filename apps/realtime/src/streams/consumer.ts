/**
 * Redis-Streams consumer for `dankdash:realtime`.
 *
 * Architecture:
 *   - One consumer group (`realtime` by default; per-env overridable).
 *   - Each pod registers a unique consumer name (env-overridable; falls
 *     back to hostname + pid). XREADGROUP delivers each entry to exactly
 *     one pod in the group, which broadcasts via the Socket.io adapter.
 *   - On pod death, the entry stays in XPENDING; the next surviving pod
 *     picks it up via the recover-pending loop (XPENDING + XCLAIM).
 *   - We XACK only after the broadcast is dispatched (Socket.io
 *     adapter.emit is fire-and-forget — Redis pub/sub never reports
 *     delivery, so the ACK happens post-call).
 *
 * The consumer is started once per process from server.ts; `stop()` is
 * called from the shutdown hook to break out of the BLOCK loop.
 */
import { hostname } from 'node:os';
import {
  decodeStreamEntry,
  REALTIME_STREAM_KEY,
  type RealtimeEnvelope,
} from '@dankdash/realtime-events';
import { routeEnvelope } from './router.js';
import type { Logger } from '@dankdash/config';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';

export interface StreamConsumerOptions {
  /**
   * Connection used for the blocking XREADGROUP / XPENDING / XCLAIM
   * loop. MUST be dedicated to this consumer — ioredis serializes
   * commands per connection, so reusing it for XADD on the producer side
   * would deadlock (the producer's XADD would queue behind the
   * 5-second BLOCK call). buildServer creates a separate client for the
   * consumer for this reason.
   */
  readonly redis: Redis;
  readonly io: Server;
  readonly logger: Logger;
  readonly group: string;
  readonly consumerName?: string;
  /** ms to block on XREADGROUP. Default 5_000; tests use 100. */
  readonly blockMs?: number;
  /** ms idle threshold for XCLAIM recovery. Default 60_000; tests use 200. */
  readonly recoverIdleMs?: number;
  /** Hard cap on entries returned per XREADGROUP. Default 32. */
  readonly batchSize?: number;
}

type RedisStreamReply = ReadonlyArray<[string, ReadonlyArray<[string, string[]]>]> | null;
type RedisXPendingExtendedReply = ReadonlyArray<readonly [string, string, number, number]>;

export class StreamConsumer {
  private running = false;
  private readonly redis: Redis;
  private readonly io: Server;
  private readonly logger: Logger;
  private readonly group: string;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly recoverIdleMs: number;
  private readonly batchSize: number;
  private loopPromise: Promise<void> | null = null;

  constructor(options: StreamConsumerOptions) {
    this.redis = options.redis;
    this.io = options.io;
    this.logger = options.logger;
    this.group = options.group;
    this.consumerName = options.consumerName ?? `${hostname()}-${process.pid}`;
    this.blockMs = options.blockMs ?? 5_000;
    this.recoverIdleMs = options.recoverIdleMs ?? 60_000;
    this.batchSize = options.batchSize ?? 32;
  }

  /**
   * Idempotent — re-running is a no-op against an existing group.
   * MKSTREAM lets the call succeed even if no producer has XADDed yet.
   */
  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', REALTIME_STREAM_KEY, this.group, '$', 'MKSTREAM');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // BUSYGROUP is the canonical "already exists" — anything else is a
      // real problem (auth, connectivity) and we surface it.
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
          event: 'realtime.stream.loop_crashed',
          err: err instanceof Error ? err.message : String(err),
        },
        'realtime: stream consumer loop crashed',
      );
    });
  }

  private isRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    this.running = false;
    // Wait for the in-flight XREADGROUP to return (it has a BLOCK timeout
    // bounded by this.blockMs so this is at worst one round-trip).
    if (this.loopPromise !== null) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    // isRunning() reads the mutable flag through a method call so TS
    // cannot narrow it away across awaits — stop() flips it from
    // outside the loop's local control flow.
    while (this.isRunning()) {
      try {
        await this.recoverPending();
        if (!this.isRunning()) break;
        await this.readNew();
      } catch (err) {
        this.logger.warn(
          {
            event: 'realtime.stream.read_error',
            err: err instanceof Error ? err.message : String(err),
          },
          'realtime: stream read error; backing off',
        );
        // Short backoff so a flapping Redis does not lock the loop into a
        // tight retry. The BLOCK on the next XREADGROUP gives the bulk
        // of any actual recovery time.
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
      this.batchSize,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      REALTIME_STREAM_KEY,
      '>',
    )) as RedisStreamReply;
    if (reply === null) return;
    for (const [, entries] of reply) {
      for (const [streamId, fields] of entries) {
        await this.handleEntry(streamId, fields);
      }
    }
  }

  private async recoverPending(): Promise<void> {
    // XPENDING with the consumer left blank discovers entries idle longer
    // than recoverIdleMs across the whole group. We claim up to batchSize
    // of them onto ourselves; in steady state this loop returns empty.
    const summary = (await this.redis.xpending(
      REALTIME_STREAM_KEY,
      this.group,
      'IDLE',
      this.recoverIdleMs,
      '-',
      '+',
      this.batchSize,
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
      await this.handleEntry(streamId, fields);
    }
  }

  private async handleEntry(streamId: string, fields: string[]): Promise<void> {
    let envelope: RealtimeEnvelope;
    try {
      ({ envelope } = decodeStreamEntry(streamId, fields));
    } catch (err) {
      // A schema-invalid entry is permanently broken — ACK it so it
      // leaves the pending list. Log enough context to track down the
      // producer that emitted it.
      this.logger.warn(
        {
          event: 'realtime.stream.decode_failed',
          streamId,
          err: err instanceof Error ? err.message : String(err),
        },
        'realtime: dropping un-decodable stream entry',
      );
      await this.ack(streamId);
      return;
    }

    const broadcasts = routeEnvelope(envelope);
    for (const b of broadcasts) {
      // `room === null` is a namespace-wide broadcast (e.g. the open-pool
      // `delivery:claimed` pin removal); otherwise scope to the room.
      const target = b.room === null ? this.io.of(b.namespace) : this.io.of(b.namespace).to(b.room);
      target.emit(b.eventName, b.payload);
    }
    await this.ack(streamId);
  }

  private async ack(streamId: string): Promise<void> {
    try {
      await this.redis.xack(REALTIME_STREAM_KEY, this.group, streamId);
    } catch (err) {
      this.logger.warn(
        {
          event: 'realtime.stream.ack_failed',
          streamId,
          err: err instanceof Error ? err.message : String(err),
        },
        'realtime: XACK failed; will recover via XPENDING',
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Composition root for the location-ingest consumer.
 *
 * The other workers in this package are cron-driven (payouts, dispatch,
 * webhook cleanup) so they expose a `scheduleXxxJob` returning a
 * `ScheduledTask`. Location-ingest is fundamentally a long-running
 * Redis-Streams consumer, so it exposes a `startLocationIngest` that
 * returns a `stop()` handle — the worker entrypoint treats it the same
 * way it treats `task.stop()` for cron jobs.
 *
 * Why a separate ioredis connection: ioredis serialises commands per
 * connection. The consumer issues a BLOCKing XREADGROUP for up to
 * `blockMs` — any other command on the same connection would queue
 * behind it. We don't currently publish from the worker process, but
 * keeping the consumer on its own client now means a future producer
 * here (Phase 11 Metrc retry events, say) doesn't have to coordinate.
 *
 * The connection lifetime is tied to the returned `stop()` handle — the
 * worker entrypoint calls `stop()` from its SIGTERM handler, which both
 * unwinds the read loop and `.disconnect()`s Redis. We do NOT `.quit()`:
 * `.quit()` waits for in-flight commands to drain, and the BLOCK on
 * XREADGROUP can hang for `blockMs` after the loop has already exited,
 * which delays shutdown for no benefit.
 */
import { RepositoryError } from '@dankdash/types';
import { Redis } from 'ioredis';
import { LocationIngestConsumer } from './location-ingest.consumer.js';
import { writeLocationBatch } from './location-ingest.writer.js';
import type { LocationIngestItem } from './types.js';
import type { Logger } from '@dankdash/config';
import type { DriverLocationHistoryRepository, DriversRepository } from '@dankdash/db';

export interface LocationIngestDeps {
  readonly drivers: DriversRepository;
  readonly history: DriverLocationHistoryRepository;
  readonly logger: Logger;
  readonly redisUrl: string;
  /** Optional override — Phase 10.2 wires the geofence observer here. */
  readonly onCommitted?: (item: LocationIngestItem) => Promise<void>;
  /** Test-only knobs. Production uses the consumer's defaults. */
  readonly batchSize?: number;
  readonly batchLatencyMs?: number;
  readonly blockMs?: number;
  readonly recoverIdleMs?: number;
}

export interface LocationIngestHandle {
  /**
   * Stop the consumer loop, drain in-flight buffers, and tear down the
   * dedicated Redis connection. Idempotent — multiple calls await the
   * same shutdown.
   */
  readonly stop: () => Promise<void>;
  /** Test seam — runs one full read+flush cycle without starting the loop. */
  readonly runOnce: () => Promise<void>;
}

export async function startLocationIngest(deps: LocationIngestDeps): Promise<LocationIngestHandle> {
  const redis = new Redis(deps.redisUrl, {
    // Mirror the realtime service's defaults — fail fast on bad config
    // instead of an indefinite reconnect loop in production.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    // `family: 0` is required for Railway private networking — see the
    // commentary on apps/api/src/infrastructure/redis.module.ts.
    family: 0,
  });

  redis.on('error', (err) => {
    deps.logger.error(
      { event: 'location-ingest.redis_error', err: err.message },
      'location-ingest: redis client error',
    );
  });

  const consumer = new LocationIngestConsumer({
    redis,
    logger: deps.logger,
    flushBatch: (items) =>
      writeLocationBatch({ drivers: deps.drivers, history: deps.history }, items).then(
        (summary) => {
          deps.logger.debug(
            {
              event: 'location-ingest.batch_committed',
              historyRows: summary.historyRows,
              driversUpdated: summary.driversUpdated,
            },
            'location-ingest: batch committed',
          );
        },
      ),
    ...(deps.onCommitted !== undefined ? { onCommitted: deps.onCommitted } : {}),
    ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    ...(deps.batchLatencyMs !== undefined ? { batchLatencyMs: deps.batchLatencyMs } : {}),
    ...(deps.blockMs !== undefined ? { blockMs: deps.blockMs } : {}),
    ...(deps.recoverIdleMs !== undefined ? { recoverIdleMs: deps.recoverIdleMs } : {}),
  });

  await consumer.ensureGroup();
  consumer.start();

  deps.logger.info({ event: 'location-ingest.started' }, 'location-ingest: consumer started');

  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  const stop = async (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    stopPromise = (async (): Promise<void> => {
      await consumer.stop();
      // disconnect, not quit — a queued BLOCK would delay shutdown by
      // up to `blockMs` if we waited for it to drain.
      redis.disconnect();
      deps.logger.info({ event: 'location-ingest.stopped' }, 'location-ingest: consumer stopped');
    })();
    return stopPromise;
  };

  return {
    stop,
    runOnce: async () => {
      if (stopped) {
        throw new RepositoryError('location-ingest consumer already stopped');
      }
      await consumer.runOnce();
    },
  };
}

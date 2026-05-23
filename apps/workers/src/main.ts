/**
 * apps/workers entrypoint.
 *
 * Constructs the worker-process DI graph (env, logger, db pool, repos,
 * Aeropay client) and schedules the cron-driven jobs. Each job has its
 * own folder under `src/jobs/` — this file only wires them together.
 *
 * The process stays alive by virtue of the node-cron timers; SIGTERM
 * triggers a graceful shutdown that stops the cron, drains in-flight
 * jobs (none currently), closes the metrics HTTP listener, flushes
 * pending OTel spans, and finally closes the db pool. Railway sends
 * SIGTERM 30s before SIGKILL on rolling restarts, which is plenty for
 * the payout job — the only mutation it performs is bounded per
 * recipient.
 *
 * Observability bootstrap order matters:
 *   1. `./tracing.js`  — must be FIRST so OTel's require-hooks can
 *      patch pg / ioredis / undici before the repositories pull them
 *      in transitively. This is also why the import lives in its own
 *      file: tree-shaking the side effect away would silently disable
 *      tracing.
 *   2. `loadEnv`        — gives us `WORKERS_METRICS_PORT` + NODE_ENV.
 *   3. `configureRegistry` + `createCronMetrics` + `createMetricsServer`
 *      — register the cron histograms with the registry before the
 *      schedulers receive the metrics handle.
 *   4. Schedulers receive `cronMetrics` so every job invocation
 *      records duration / outcome / last-run timestamp.
 */
/* eslint-disable import/order -- tracing must be imported before any other module that OTel auto-instruments (pg, undici, etc.). */
import { workersOtelHandle } from './tracing.js';
import { AeropayAuth, AeropayClient, HttpClient, createUndiciDispatcher } from '@dankdash/aeropay';
import { createLogger, loadEnv } from '@dankdash/config';
import {
  DispatchOffersRepository,
  DispensariesRepository,
  DriverLocationHistoryRepository,
  DriversRepository,
  LedgerEntriesRepository,
  MetrcTransactionsRepository,
  OrderItemsRepository,
  OrdersRepository,
  PartitionsRepository,
  PayoutsRepository,
  WebhookEventsProcessedRepository,
  createEncryptionServiceFromBase64,
  createPoolFromEnv,
} from '@dankdash/db';
import { EtaService, MapboxClient } from '@dankdash/eta';
import {
  HttpClient as MetrcHttpClient,
  MetrcClient,
  createUndiciDispatcher as createMetrcDispatcher,
} from '@dankdash/metrc';
import { configureRegistry } from '@dankdash/observability';
import { publishRealtimeEvent } from '@dankdash/realtime-events';
import { R2Storage } from '@dankdash/storage';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { createCronMetrics } from './instrumentation/cron-spans.js';
import { createMetricsServer } from './instrumentation/metrics-server.js';
import { scheduleDispatchJob, scheduleOfferExpiryJob } from './jobs/dispatch/index.js';
import {
  createEtaObserver,
  createGeofenceObserver,
  startLocationIngest,
  type LocationIngestItem,
} from './jobs/location-ingest/index.js';
import { scheduleMetrcReconciliationJob } from './jobs/metrc-reconciliation/index.js';
import { scheduleMetrcReportingJob } from './jobs/metrc-reporting/index.js';
import {
  ParquetPartitionArchiver,
  schedulePartitionManagementJob,
} from './jobs/partition-management/index.js';
import { schedulePayoutJob } from './jobs/payouts/index.js';
import { scheduleWebhookEventsCleanupJob } from './jobs/webhook-events/index.js';
/* eslint-enable import/order */

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ name: 'workers', environment: env.NODE_ENV });

  // The registry is a process-global singleton inside @dankdash/observability;
  // configuring it here pins service+environment labels on every series and
  // turns on the default Node.js process gauges (RSS, GC pause, event-loop
  // lag). Disabled under NODE_ENV=test so vitest doesn't leak the collection
  // timer between specs.
  const registry = configureRegistry({
    service: 'workers',
    environment: env.NODE_ENV,
    collectDefault: env.NODE_ENV !== 'test',
  });

  const cronMetrics = createCronMetrics(registry);
  const metricsServer = createMetricsServer({ registry, port: env.WORKERS_METRICS_PORT });
  await metricsServer.start();
  logger.info({ port: env.WORKERS_METRICS_PORT }, 'workers metrics listener up');

  const pool = createPoolFromEnv(env, logger);
  const dispensaries = new DispensariesRepository(pool.db);
  const ledger = new LedgerEntriesRepository(pool.db);
  const payouts = new PayoutsRepository(pool.db);
  const webhookEvents = new WebhookEventsProcessedRepository(pool.db);
  const orders = new OrdersRepository(pool.db);
  const drivers = new DriversRepository(pool.db);
  const dispatchOffers = new DispatchOffersRepository(pool.db);
  const driverLocationHistory = new DriverLocationHistoryRepository(pool.db);
  const partitions = new PartitionsRepository(pool.db);
  const metricTransactions = new MetrcTransactionsRepository(pool.db);
  const orderItems = new OrderItemsRepository(pool.db);
  const encryption = createEncryptionServiceFromBase64(env.COLUMN_ENCRYPTION_KEY_BASE64);

  const http = new HttpClient({
    dispatcher: createUndiciDispatcher({ maxConnections: 8, keepAliveTimeoutMs: 30_000 }),
  });
  const aeropayAuth = new AeropayAuth({
    clientId: env.AEROPAY_CLIENT_ID,
    clientSecret: env.AEROPAY_CLIENT_SECRET,
    apiBaseUrl: env.AEROPAY_API_BASE_URL,
    http,
    // Workers run a process-local memory cache rather than the API's
    // Redis-backed one — the worker fleet is small (1–2 instances) and
    // the cron fires once per day; cross-instance token coalescing isn't
    // worth the Redis dependency here.
    cache: createMemoryTokenCache(),
  });
  const aeropay = new AeropayClient({
    apiBaseUrl: env.AEROPAY_API_BASE_URL,
    http,
    auth: aeropayAuth,
  });

  // Dedicated undici pool for Metrc. The vendor recommends ≤4 concurrent
  // connections per integrator (see spec §7.3) and they keep idle sockets
  // alive aggressively, so we share the pool across the reporting and
  // reconciliation cron paths but isolate it from the Aeropay one.
  const metrcHttp = new MetrcHttpClient({
    dispatcher: createMetrcDispatcher({ maxConnections: 4, keepAliveTimeoutMs: 30_000 }),
  });
  const metrcClient = new MetrcClient({
    apiBaseUrl: env.METRC_API_BASE_URL,
    vendorKey: env.METRC_API_KEY,
    http: metrcHttp,
  });

  const payoutTask = schedulePayoutJob(
    { dispensaries, ledger, payouts, aeropay, logger },
    { cronMetrics },
  );
  const webhookCleanupTask = scheduleWebhookEventsCleanupJob(
    { webhookEvents, logger },
    { cronMetrics },
  );
  const dispatchTask = scheduleDispatchJob({ orders, drivers, dispatchOffers, logger });
  const offerExpiryTask = scheduleOfferExpiryJob({ dispatchOffers, logger });

  // Archive bucket shares the same R2 account as the rest of the storage
  // layer. We construct a dedicated client here rather than reuse one
  // from `apps/api` because the worker process owns its DI graph.
  const archiveStorage = new R2Storage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME,
  });
  const partitionArchiver = new ParquetPartitionArchiver({
    partitions,
    storage: archiveStorage,
    logger,
  });
  const partitionTask = schedulePartitionManagementJob({
    partitions,
    archiver: partitionArchiver,
    logger,
    clock: () => new Date(),
  });

  // Metrc reporting is gated by `ENABLE_METRC` so non-production
  // environments (PR previews, local) can stay off the cron entirely —
  // even with a misconfigured vendor key the scheduler would otherwise
  // wake every minute and burn through the per-row backoff ladder.
  const metrcReportingTask = env.ENABLE_METRC
    ? scheduleMetrcReportingJob({
        metricTransactions,
        orders,
        orderItems,
        dispensaries,
        metrc: metrcClient,
        encryption,
        logger,
      })
    : null;

  // Reconciliation cron pairs with the reporting cron — same gate
  // (`ENABLE_METRC`) and same DI graph, distinct schedule. Runs daily
  // at 04:00 Central so the local row that the reporting cron just
  // POSTed is settled in Metrc's backend by the time we look for it.
  const metrcReconciliationTask = env.ENABLE_METRC
    ? scheduleMetrcReconciliationJob({
        metricTransactions,
        orders,
        dispensaries,
        metrc: metrcClient,
        encryption,
        logger,
      })
    : null;

  // Two extra Redis connections for the ETA path:
  //   - etaCacheRedis: GET/SETEX on the eta:v1:* keyspace, sub-second timeouts.
  //   - etaPublishRedis: XADD to dankdash:realtime.
  // We deliberately keep these off the location-ingest connection because
  // ioredis serialises commands per connection and the ingest connection
  // spends most of its time BLOCKed on XREADGROUP; any XADD/GET queued
  // behind it would wait up to `blockMs` for no reason.
  // `family: 0` is required for Railway private networking — see the
  // commentary on apps/api/src/infrastructure/redis.module.ts.
  const etaCacheRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    family: 0,
  });
  const etaPublishRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    family: 0,
  });
  for (const [name, client] of [
    ['eta-cache', etaCacheRedis],
    ['eta-publish', etaPublishRedis],
  ] as const) {
    client.on('error', (err: Error) => {
      logger.error(
        { event: 'workers.redis_error', connection: name, err: err.message },
        'workers: redis client error',
      );
    });
  }
  const mapbox = new MapboxClient({ accessToken: env.MAPBOX_ACCESS_TOKEN });
  const etaService = new EtaService({ redis: etaCacheRedis, mapbox, logger });

  const geofenceObserver = createGeofenceObserver({ orders, logger });
  const etaObserver = createEtaObserver({
    orders,
    eta: etaService,
    publish: (input) => publishRealtimeEvent(etaPublishRedis, input),
    logger,
    idGen: uuidv7,
  });

  // Per-item fan-out across observers. Each observer reports its own
  // failures with the right context; `Promise.allSettled` keeps a single
  // observer crash from cascading into the others. The consumer's outer
  // allSettled becomes a no-op for this combined function (it never
  // rejects), which is exactly what we want — observer-specific logs are
  // strictly more useful than the generic "observer failed" line.
  const onLocationCommitted = async (item: LocationIngestItem): Promise<void> => {
    const results = await Promise.allSettled([geofenceObserver(item), etaObserver(item)]);
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result?.status !== 'rejected') continue;
      logger.warn(
        {
          event: 'workers.location_observer_failed',
          observer: i === 0 ? 'geofence' : 'eta',
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'workers: location observer failed',
      );
    }
  };

  const locationIngest = await startLocationIngest({
    drivers,
    history: driverLocationHistory,
    logger,
    redisUrl: env.REDIS_URL,
    onCommitted: onLocationCommitted,
  });

  logger.info({ env: env.NODE_ENV }, 'workers started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'workers shutting down');
    payoutTask.stop();
    webhookCleanupTask.stop();
    dispatchTask.stop();
    offerExpiryTask.stop();
    partitionTask.stop();
    metrcReportingTask?.stop();
    metrcReconciliationTask?.stop();
    await locationIngest.stop();
    etaCacheRedis.disconnect();
    etaPublishRedis.disconnect();
    // Close the HTTP listener before flushing OTel so the final scrape
    // (if any) sees the same counters the trace exporter is about to
    // ship; then flush spans before closing the pool so any in-flight
    // SQL span gets a parent context.
    await metricsServer.close();
    await workersOtelHandle.shutdown();
    await pool.close();
    process.exit(0);
  };
  process.on('SIGTERM', (sig) => void shutdown(sig));
  process.on('SIGINT', (sig) => void shutdown(sig));
}

/**
 * Minimal in-memory TokenCache that satisfies the aeropay TokenCache
 * interface (get / set / del). The worker process is short-lived
 * compared to the API; per-process caching plus Aeropay's 1-hour token
 * TTL keeps auth chatter negligible without the Redis round-trip.
 */
function createMemoryTokenCache(): {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  readonly del: (key: string) => Promise<void>;
} {
  const store = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  return {
    get: (key) => {
      const hit = store.get(key);
      if (hit === undefined) return Promise.resolve(null);
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(hit.value);
    },
    set: (key, value, ttlSeconds) => {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
      return Promise.resolve();
    },
    del: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`workers fatal: ${message}\n`);
  process.exit(1);
});

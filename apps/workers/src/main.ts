/**
 * apps/workers entrypoint.
 *
 * Constructs the worker-process DI graph (env, logger, db pool, repos,
 * Aeropay client) and schedules the cron-driven jobs. Each job has its
 * own folder under `src/jobs/` — this file only wires them together.
 *
 * The process stays alive by virtue of the node-cron timers; SIGTERM
 * triggers a graceful shutdown that stops the cron, drains in-flight
 * jobs (none currently), and closes the db pool. Railway sends SIGTERM
 * 30s before SIGKILL on rolling restarts, which is plenty for the
 * payout job — the only mutation it performs is bounded per recipient.
 */
import { AeropayAuth, AeropayClient, HttpClient, createUndiciDispatcher } from '@dankdash/aeropay';
import { createLogger, loadEnv } from '@dankdash/config';
import {
  DispatchOffersRepository,
  DispensariesRepository,
  DriverLocationHistoryRepository,
  DriversRepository,
  LedgerEntriesRepository,
  OrdersRepository,
  PayoutsRepository,
  WebhookEventsProcessedRepository,
  createPoolFromEnv,
} from '@dankdash/db';
import { EtaService, MapboxClient } from '@dankdash/eta';
import { publishRealtimeEvent } from '@dankdash/realtime-events';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { scheduleDispatchJob, scheduleOfferExpiryJob } from './jobs/dispatch/index.js';
import {
  createEtaObserver,
  createGeofenceObserver,
  startLocationIngest,
  type LocationIngestItem,
} from './jobs/location-ingest/index.js';
import { schedulePayoutJob } from './jobs/payouts/index.js';
import { scheduleWebhookEventsCleanupJob } from './jobs/webhook-events/index.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ name: 'workers', environment: env.NODE_ENV });

  const pool = createPoolFromEnv(env, logger);
  const dispensaries = new DispensariesRepository(pool.db);
  const ledger = new LedgerEntriesRepository(pool.db);
  const payouts = new PayoutsRepository(pool.db);
  const webhookEvents = new WebhookEventsProcessedRepository(pool.db);
  const orders = new OrdersRepository(pool.db);
  const drivers = new DriversRepository(pool.db);
  const dispatchOffers = new DispatchOffersRepository(pool.db);
  const driverLocationHistory = new DriverLocationHistoryRepository(pool.db);

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

  const payoutTask = schedulePayoutJob({ dispensaries, ledger, payouts, aeropay, logger });
  const webhookCleanupTask = scheduleWebhookEventsCleanupJob({ webhookEvents, logger });
  const dispatchTask = scheduleDispatchJob({ orders, drivers, dispatchOffers, logger });
  const offerExpiryTask = scheduleOfferExpiryJob({ dispatchOffers, logger });

  // Two extra Redis connections for the ETA path:
  //   - etaCacheRedis: GET/SETEX on the eta:v1:* keyspace, sub-second timeouts.
  //   - etaPublishRedis: XADD to dankdash:realtime.
  // We deliberately keep these off the location-ingest connection because
  // ioredis serialises commands per connection and the ingest connection
  // spends most of its time BLOCKed on XREADGROUP; any XADD/GET queued
  // behind it would wait up to `blockMs` for no reason.
  const etaCacheRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const etaPublishRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
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
    await locationIngest.stop();
    etaCacheRedis.disconnect();
    etaPublishRedis.disconnect();
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

/**
 * Observability wiring for apps/api.
 *
 * Owns the lifecycle of:
 *   - the Prom-client registry singleton (`configureRegistry` is called
 *     here so every module pulling `METRICS_REGISTRY` shares one
 *     process-wide registry)
 *   - the HTTP histograms + db gauges + redis gauges + domain counters
 *   - the Sentry handle (a no-op when `SENTRY_DSN` is unset)
 *
 * Why a module instead of bare module-level singletons? Because tests
 * (vitest, supertest, the integration harness) spin up the AppModule
 * per file and would otherwise re-register metrics into a stale global
 * registry — prom-client throws on duplicate metric names. The DI
 * lifecycle gives us a `resetRegistry()` hook on shutdown.
 */
import { loadEnv } from '@dankdash/config';
import {
  configureRegistry,
  createDbMetrics,
  createDomainCounters,
  createHttpHistograms,
  createRedisMetrics,
  initSentry,
  resetRegistry,
  type DbMetrics,
  type DomainCounters,
  type HttpHistograms,
  type RedisMetrics,
  type SentryHandle,
} from '@dankdash/observability';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Registry } from 'prom-client';

export const METRICS_REGISTRY = Symbol.for('METRICS_REGISTRY');
export const HTTP_HISTOGRAMS = Symbol.for('HTTP_HISTOGRAMS');
export const DB_METRICS = Symbol.for('DB_METRICS');
export const REDIS_METRICS = Symbol.for('REDIS_METRICS');
export const DOMAIN_COUNTERS = Symbol.for('DOMAIN_COUNTERS');
export const SENTRY_HANDLE = Symbol.for('SENTRY_HANDLE');

interface ApiObservability {
  readonly registry: Registry;
  readonly http: HttpHistograms;
  readonly db: DbMetrics;
  readonly redis: RedisMetrics;
  readonly domain: DomainCounters;
  readonly sentry: SentryHandle;
}

function buildObservability(): ApiObservability {
  const env = loadEnv({
    allowPartial: process.env['ALLOW_PARTIAL_ENV'] === '1',
  });
  const serviceVersion = process.env['SERVICE_VERSION'] ?? '0.0.0';
  // Disable default Node metrics in the test environment — they
  // populate slowly and the integration harness recreates the registry
  // for every spec file, which would otherwise log "metric is already
  // registered" warnings.
  const collectDefault = env.NODE_ENV !== 'test';
  const registry = configureRegistry({
    service: 'api',
    environment: env.NODE_ENV,
    collectDefault,
  });
  const http = createHttpHistograms(registry);
  const db = createDbMetrics(registry);
  const redis = createRedisMetrics(registry);
  const domain = createDomainCounters(registry);
  const sentry = initSentry({
    ...(env.SENTRY_DSN !== undefined ? { dsn: env.SENTRY_DSN } : {}),
    serviceName: 'api',
    serviceVersion,
    environment: env.NODE_ENV,
  });
  return { registry, http, db, redis, domain, sentry };
}

const SHARED: ApiObservability = buildObservability();

@Injectable()
class ObservabilityShutdown implements OnApplicationShutdown {
  constructor(@Inject(SENTRY_HANDLE) private readonly sentry: SentryHandle) {}

  async onApplicationShutdown(): Promise<void> {
    // 2s flush budget — long enough for the Sentry transport to drain,
    // short enough that Railway's SIGKILL doesn't beat us.
    await this.sentry.close(2000);
    resetRegistry();
  }
}

@Global()
@Module({
  providers: [
    { provide: METRICS_REGISTRY, useValue: SHARED.registry },
    { provide: HTTP_HISTOGRAMS, useValue: SHARED.http },
    { provide: DB_METRICS, useValue: SHARED.db },
    { provide: REDIS_METRICS, useValue: SHARED.redis },
    { provide: DOMAIN_COUNTERS, useValue: SHARED.domain },
    { provide: SENTRY_HANDLE, useValue: SHARED.sentry },
    ObservabilityShutdown,
  ],
  exports: [
    METRICS_REGISTRY,
    HTTP_HISTOGRAMS,
    DB_METRICS,
    REDIS_METRICS,
    DOMAIN_COUNTERS,
    SENTRY_HANDLE,
  ],
})
export class ObservabilityModule {}

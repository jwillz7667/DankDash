/**
 * Postgres connection-pool gauges + slow-query histogram.
 *
 * `pool_size`, `pool_active`, `pool_idle`, `pool_waiting` are gauges
 * sampled by a setInterval driven from the runtime that owns the
 * pool (the api process). The `setPoolGaugesFrom` helper accepts a
 * snapshot object and writes all four in one call so the caller does
 * not race against itself between samples.
 *
 * `slow_query_seconds` is the histogram that `packages/db/src/client.ts`'s
 * `timed()` helper observes when a query crosses the `SLOW_QUERY_MS`
 * threshold. The bucket layout matches `http_request_duration_seconds`
 * so the two dashboards have the same readability.
 */
import { Gauge, Histogram, type Registry } from 'prom-client';

export interface PoolSnapshot {
  readonly size: number;
  readonly active: number;
  readonly idle: number;
  readonly waiting: number;
}

export interface DbMetrics {
  readonly poolSize: Gauge;
  readonly poolActive: Gauge;
  readonly poolIdle: Gauge;
  readonly poolWaiting: Gauge;
  readonly slowQuerySeconds: Histogram<'operation'>;
  readonly setPoolGaugesFrom: (snapshot: PoolSnapshot) => void;
}

const SLOW_QUERY_BUCKETS: readonly number[] = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createDbMetrics(registry: Registry): DbMetrics {
  const poolSize = new Gauge({
    name: 'db_pool_size',
    help: 'Total connections currently allocated to the Postgres pool.',
    registers: [registry],
  });
  const poolActive = new Gauge({
    name: 'db_pool_active',
    help: 'Connections currently executing a query.',
    registers: [registry],
  });
  const poolIdle = new Gauge({
    name: 'db_pool_idle',
    help: 'Connections currently sitting idle in the pool.',
    registers: [registry],
  });
  const poolWaiting = new Gauge({
    name: 'db_pool_waiting',
    help: 'Callers currently blocked waiting for a free connection.',
    registers: [registry],
  });
  const slowQuerySeconds = new Histogram({
    name: 'db_slow_query_seconds',
    help: 'Duration of queries that exceeded the slow-query threshold (see SLOW_QUERY_MS).',
    labelNames: ['operation'],
    buckets: [...SLOW_QUERY_BUCKETS],
    registers: [registry],
  });

  const setPoolGaugesFrom = (snapshot: PoolSnapshot): void => {
    poolSize.set(snapshot.size);
    poolActive.set(snapshot.active);
    poolIdle.set(snapshot.idle);
    poolWaiting.set(snapshot.waiting);
  };

  return {
    poolSize,
    poolActive,
    poolIdle,
    poolWaiting,
    slowQuerySeconds,
    setPoolGaugesFrom,
  };
}

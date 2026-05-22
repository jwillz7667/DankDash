/**
 * Redis INFO sampler for `redis_connected_clients` + `redis_ops_per_second`.
 *
 * `@dankdash/observability` creates the gauges; this module is what
 * actually populates them. ioredis exposes `redis.info(...)` which
 * returns the multi-line INFO blob — we parse the two fields we care
 * about and call `setRedisGaugesFrom`.
 *
 * Cadence: 30s (Phase 21 spec). Anything more frequent burdens Redis
 * with INFO calls and the values don't change meaningfully sub-30s
 * for the dashboards.
 */
import type { RedisMetrics } from '@dankdash/observability';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

const INFO_SECTIONS = ['clients', 'stats'];
const SAMPLE_INTERVAL_MS = 30_000;

export interface RedisSamplerHandle {
  start(): void;
  stop(): void;
}

export interface RedisSamplerOptions {
  readonly redis: Redis;
  readonly metrics: RedisMetrics;
  readonly logger: Logger;
  /** Test seam — override the 30s cadence. */
  readonly intervalMs?: number;
}

export function createRedisSampler(options: RedisSamplerOptions): RedisSamplerHandle {
  const log = options.logger.child({ component: 'redis-sampler' });
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    try {
      const [clients, stats] = await Promise.all([
        options.redis.info(INFO_SECTIONS[0] ?? 'clients'),
        options.redis.info(INFO_SECTIONS[1] ?? 'stats'),
      ]);
      const connected = parseInfoNumber(clients, 'connected_clients') ?? 0;
      const opsPerSec = parseInfoNumber(stats, 'instantaneous_ops_per_sec') ?? 0;
      options.metrics.setRedisGaugesFrom({
        connectedClients: connected,
        opsPerSecond: opsPerSec,
      });
    } catch (err) {
      // Don't escalate — a Redis blip should not bounce the realtime pod.
      // The gauges keep their last value, which Grafana flags as stale.
      log.warn(
        {
          event: 'redis-sampler.info-failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'redis INFO sample failed',
      );
    }
  };

  return {
    start(): void {
      if (timer !== undefined) return;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // Don't keep the event loop alive just for the sampler — the
      // pod stays up because of the HTTP listener.
      timer.unref();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

function parseInfoNumber(blob: string, field: string): number | undefined {
  const lines = blob.split(/\r?\n/u);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    if (key !== field) continue;
    const value = Number(line.slice(idx + 1).trim());
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

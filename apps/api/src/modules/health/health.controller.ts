/**
 * Liveness + readiness probes for Railway and any future k8s-style
 * orchestrator. Excluded from the /v1 global prefix so the platform can
 * probe the process unconditionally; deliberately auth-free.
 *
 *   GET /health         -> 200 if the process is running
 *   GET /health/live    -> alias, used by Railway healthcheck
 *   GET /health/ready   -> 200 only once Postgres + Redis are reachable
 *
 * `/health/ready` issues a trivial query against each dependency with
 * a short timeout. Both must succeed for the route to return 200; any
 * failure returns 503 + the standard error envelope so a load balancer
 * deactivates the instance until recovery. The pool/redis snapshots
 * are also written to the corresponding Prometheus gauges so the
 * Grafana db-pool dashboard surfaces saturation without needing a
 * separate scraper.
 */
import { type RedisMetrics } from '@dankdash/observability';
import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { DRIZZLE_POOL } from '../../infrastructure/drizzle.module.js';
import { REDIS_METRICS } from '../../infrastructure/observability.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import type { RedisClient } from '../../infrastructure/redis.module.js';
import type { Pool } from '@dankdash/db';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'apps/api';
  readonly checkedAt: string;
}

interface ReadyResponse extends HealthResponse {
  readonly checks: {
    readonly postgres: { ok: true; latencyMs: number };
    readonly redis: { ok: true; latencyMs: number };
  };
}

const PROBE_TIMEOUT_MS = 1_500;

function timeoutRejection<T>(label: string, ms: number): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    setTimeout(() => {
      reject(new HealthProbeTimeoutError(label, ms));
    }, ms).unref();
  });
}

class HealthProbeTimeoutError extends Error {
  public override readonly name = 'HealthProbeTimeoutError';
  constructor(label: string, ms: number) {
    super(`health probe ${label} timed out after ${ms}ms`);
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DRIZZLE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    @Inject(REDIS_METRICS) private readonly redisMetrics: RedisMetrics,
  ) {}

  @Public()
  @Get('health')
  health(): HealthResponse {
    return this.payload();
  }

  @Public()
  @Get('health/live')
  live(): HealthResponse {
    return this.payload();
  }

  @Public()
  @Get('health/ready')
  async ready(): Promise<ReadyResponse> {
    const [pg, redis] = await Promise.allSettled([this.probePostgres(), this.probeRedis()]);
    if (pg.status === 'rejected' || redis.status === 'rejected') {
      throw new HttpException(
        {
          error: {
            code: 'NOT_READY',
            message: 'one or more dependencies are unavailable',
            details: {
              postgres: pg.status === 'fulfilled' ? 'ok' : describeReason(pg.reason),
              redis: redis.status === 'fulfilled' ? 'ok' : describeReason(redis.reason),
            },
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      ...this.payload(),
      checks: {
        postgres: { ok: true, latencyMs: pg.value },
        redis: { ok: true, latencyMs: redis.value },
      },
    };
  }

  private async probePostgres(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    await Promise.race([
      this.pool.sql`SELECT 1`,
      timeoutRejection<unknown>('postgres', PROBE_TIMEOUT_MS),
    ]);
    return durationMs(startedAt);
  }

  private async probeRedis(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    await Promise.race([this.redis.ping(), timeoutRejection<string>('redis', PROBE_TIMEOUT_MS)]);
    // Sample basic redis stats while we have the client out — these
    // are cheap calls (a single INFO section each) and keep the
    // Grafana redis-overview dashboard fed.
    try {
      const info = await this.redis.info('clients');
      const connectedClientsLine = info
        .split('\n')
        .find((line) => line.startsWith('connected_clients:'));
      const connectedClients = connectedClientsLine
        ? Number(connectedClientsLine.split(':')[1] ?? 0)
        : 0;
      this.redisMetrics.setRedisGaugesFrom({ connectedClients, opsPerSecond: 0 });
    } catch {
      // Sampling failure is non-fatal; the readiness check already
      // passed via PING. The next sample run will retry.
    }
    return durationMs(startedAt);
  }

  private payload(): HealthResponse {
    return { status: 'ok', service: 'apps/api', checkedAt: new Date().toISOString() };
  }
}

function durationMs(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1_000_000);
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'unknown';
}

/**
 * /health endpoints.
 *
 * Two endpoints because Railway's healthcheck and Kubernetes-style
 * liveness/readiness have subtly different semantics:
 *
 *   GET /health        — overall health; returns 200 if the process is
 *                        running. Dependency-free so a degraded Redis
 *                        does not cascade into a restart loop while the
 *                        rest of the system can still drain.
 *   GET /health/ready  — readiness; returns 200 only if Redis pub/sub
 *                        is reachable. A failing readiness check tells
 *                        Railway to stop routing new connections; the
 *                        existing sockets stay attached.
 */
import { Router as ExpressRouter } from 'express';
import type { Router } from 'express';
import type { Redis } from 'ioredis';

export interface HealthRouterOptions {
  readonly redis: Redis;
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router: Router = ExpressRouter();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'realtime' });
  });

  router.get('/health/ready', (_req, res) => {
    void (async () => {
      try {
        // ioredis types `ping()` as resolving to the literal `"PONG"`, but
        // we only treat the success/throw signal as authoritative — a
        // mis-routed connection will reject the promise rather than return
        // an unexpected payload.
        await options.redis.ping();
        res.status(200).json({ status: 'ready' });
      } catch (err) {
        res.status(503).json({
          status: 'not_ready',
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    })();
  });

  return router;
}

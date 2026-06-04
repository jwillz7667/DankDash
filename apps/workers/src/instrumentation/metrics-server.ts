/**
 * Tiny Fastify HTTP listener that exposes `/metrics` (+ `/healthz`)
 * for the workers runtime.
 *
 * Workers don't otherwise need an HTTP server — they're cron-driven —
 * but Prometheus scrapes only HTTP, so we add a single-purpose
 * listener bound to `WORKERS_METRICS_PORT`. Access is gated to
 * loopback / RFC 1918 / RFC 6598 the same way apps/api and
 * apps/realtime gate theirs: public IPs get 404 (not 403; we don't
 * advertise that the endpoint exists).
 *
 * Healthz returns `{ status: 'ok' }` and is the Railway readiness
 * probe target. Liveness is implicit — if the process is up the
 * cron timers are firing; there is no separate background loop to
 * crash.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

const BIND_HOST = '0.0.0.0';

const ALLOWED_PREFIXES_V4: readonly string[] = [
  '10.',
  '127.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '100.64.',
  '100.65.',
  '100.66.',
  '100.67.',
  '100.68.',
  '100.69.',
  '100.70.',
  '100.71.',
  '100.72.',
  '100.73.',
  '100.74.',
  '100.75.',
  '100.76.',
  '100.77.',
  '100.78.',
  '100.79.',
];

function isInternalIp(ip: string | undefined): boolean {
  if (ip === undefined || ip.length === 0) return false;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const candidate = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (candidate.startsWith('fc') || candidate.startsWith('fd')) return true;
  return ALLOWED_PREFIXES_V4.some((prefix) => candidate.startsWith(prefix));
}

export interface MetricsServerHandle {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly http: FastifyInstance;
}

export interface MetricsServerOptions {
  readonly registry: Registry;
  readonly port: number;
}

export function createMetricsServer(options: MetricsServerOptions): MetricsServerHandle {
  const http = Fastify({ logger: false, disableRequestLogging: true });
  http.get('/healthz', () => ({ status: 'ok' }));
  http.get('/metrics', async (req, reply) => {
    if (!isInternalIp(req.ip)) {
      void reply.code(404).send({ statusCode: 404, error: 'Not Found' });
      return;
    }
    const body = await options.registry.metrics();
    void reply.header('content-type', options.registry.contentType).code(200).send(body);
  });

  return {
    http,
    async start(): Promise<void> {
      await http.listen({ port: options.port, host: BIND_HOST });
    },
    async close(): Promise<void> {
      await http.close();
    },
  };
}

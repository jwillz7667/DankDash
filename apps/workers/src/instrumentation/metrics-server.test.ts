/**
 * Unit tests for the workers metrics-server.
 *
 * The listener is functionally a 3-route Fastify app (/healthz +
 * /metrics + 404 catch-all) with loopback / RFC 1918 / RFC 6598 access
 * gating on /metrics. Fastify's `inject` lets us simulate requests
 * without binding a port, and lets us pass an arbitrary
 * `remoteAddress` to exercise the gate from both sides.
 */
import { Counter, Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createMetricsServer } from './metrics-server.js';

function buildRegistryWithSeedMetric(): Registry {
  const reg = new Registry();
  reg.setDefaultLabels({ service: 'workers', environment: 'test' });
  const seed = new Counter({
    name: 'workers_metrics_server_test_seed_total',
    help: 'Seed counter so /metrics has at least one series to render.',
    registers: [reg],
  });
  seed.inc();
  return reg;
}

describe('metrics-server', () => {
  it('GET /healthz returns 200 ok', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    const res = await server.http.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /metrics from loopback returns the Prometheus text body', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    const res = await server.http.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '127.0.0.1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('workers_metrics_server_test_seed_total');
  });

  it('GET /metrics from an RFC 1918 address returns 200 (Railway internal)', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    const res = await server.http.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.5.12',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('workers_metrics_server_test_seed_total');
  });

  it('GET /metrics from RFC 6598 CGNAT (Railway private network) returns 200', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    const res = await server.http.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '100.64.7.91',
    });

    expect(res.statusCode).toBe(200);
  });

  it('GET /metrics from a public IP returns 404 (does not advertise the endpoint)', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    const res = await server.http.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '8.8.8.8',
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('workers_metrics_server_test_seed_total');
  });

  it('start() then close() resolves cleanly on port 0', async () => {
    const registry = buildRegistryWithSeedMetric();
    const server = createMetricsServer({ registry, port: 0 });

    await server.start();
    await server.close();
  });
});

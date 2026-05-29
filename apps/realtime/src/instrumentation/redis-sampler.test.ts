/**
 * Unit tests for the Redis INFO sampler.
 *
 * The sampler polls `redis.info(section)` on a setInterval. We test
 * with a fake Redis that returns canned INFO blobs and a fake clock
 * (`intervalMs` override) so the suite stays sub-second.
 */
import { createRedisMetrics } from '@dankdash/observability';
import pino from 'pino';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedisSampler } from './redis-sampler.js';

class FakeRedis {
  public infoCalls: string[] = [];
  constructor(private readonly responses: Record<string, string>) {}
  info(section: string): Promise<string> {
    this.infoCalls.push(section);
    return Promise.resolve(this.responses[section] ?? '');
  }
}

const CLIENTS_INFO = ['# Clients', 'connected_clients:42', 'cluster_connections:0'].join('\r\n');

const STATS_INFO = [
  '# Stats',
  'total_connections_received:100',
  'instantaneous_ops_per_sec:1234',
].join('\r\n');

describe('createRedisSampler', () => {
  const handles: Array<{ stop: () => void }> = [];
  afterEach(() => {
    while (handles.length > 0) {
      const h = handles.pop();
      h?.stop();
    }
  });

  it('samples connected_clients and instantaneous_ops_per_sec into the gauges', async () => {
    const registry = new Registry();
    const metrics = createRedisMetrics(registry);
    const redis = new FakeRedis({
      clients: CLIENTS_INFO,
      stats: STATS_INFO,
    });

    const sampler = createRedisSampler({
      redis: redis as unknown as Parameters<typeof createRedisSampler>[0]['redis'],
      metrics,
      logger: pino({ level: 'silent' }),
      intervalMs: 10_000,
    });
    handles.push(sampler);
    sampler.start();
    // start() fires an immediate tick — let the microtask queue flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const text = await registry.metrics();
    expect(text).toMatch(/redis_connected_clients\s+42/);
    expect(text).toMatch(/redis_ops_per_second\s+1234/);
    expect(redis.infoCalls).toEqual(['clients', 'stats']);
  });

  it('keeps the last good values when INFO throws', async () => {
    const registry = new Registry();
    const metrics = createRedisMetrics(registry);

    // First call succeeds, subsequent throw. The sampler should keep
    // the 42 / 1234 values rather than zero them.
    let calls = 0;
    const flakyRedis = {
      info(section: string): Promise<string> {
        calls += 1;
        if (calls <= 2) {
          return Promise.resolve(section === 'clients' ? CLIENTS_INFO : STATS_INFO);
        }
        return Promise.reject(new Error('redis went down'));
      },
    };

    const sampler = createRedisSampler({
      redis: flakyRedis as unknown as Parameters<typeof createRedisSampler>[0]['redis'],
      metrics,
      logger: pino({ level: 'silent' }),
      intervalMs: 30,
    });
    handles.push(sampler);
    sampler.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    const text = await registry.metrics();
    expect(text).toMatch(/redis_connected_clients\s+42/);
    expect(text).toMatch(/redis_ops_per_second\s+1234/);
  });

  it('stop() halts further INFO calls', async () => {
    const registry = new Registry();
    const metrics = createRedisMetrics(registry);
    const redis = new FakeRedis({ clients: CLIENTS_INFO, stats: STATS_INFO });

    const sampler = createRedisSampler({
      redis: redis as unknown as Parameters<typeof createRedisSampler>[0]['redis'],
      metrics,
      logger: pino({ level: 'silent' }),
      intervalMs: 20,
    });
    sampler.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const callsBefore = redis.infoCalls.length;
    sampler.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(redis.infoCalls.length).toEqual(callsBefore);
  });
});

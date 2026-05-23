/**
 * Redis gauges — connected clients + ops-per-second snapshot.
 *
 * Redis (BullMQ + cache + Socket.io adapter) exposes its own metrics
 * via `INFO`. The realtime + workers runtimes sample those values on
 * a setInterval (default 30s — anything more frequent burdens Redis
 * with INFO calls). The api runtime uses ioredis for cache only and
 * does not need this surface; the auto-instrumentation already
 * captures per-command latency.
 */
import { Gauge, type Registry } from 'prom-client';

export interface RedisSnapshot {
  readonly connectedClients: number;
  readonly opsPerSecond: number;
}

export interface RedisMetrics {
  readonly connectedClients: Gauge;
  readonly opsPerSecond: Gauge;
  readonly setRedisGaugesFrom: (snapshot: RedisSnapshot) => void;
}

export function createRedisMetrics(registry: Registry): RedisMetrics {
  const connectedClients = new Gauge({
    name: 'redis_connected_clients',
    help: 'Total clients currently connected to the Redis instance.',
    registers: [registry],
  });
  const opsPerSecond = new Gauge({
    name: 'redis_ops_per_second',
    help: 'Operations-per-second reported by the last Redis INFO sample.',
    registers: [registry],
  });

  const setRedisGaugesFrom = (snapshot: RedisSnapshot): void => {
    connectedClients.set(snapshot.connectedClients);
    opsPerSecond.set(snapshot.opsPerSecond);
  };

  return { connectedClients, opsPerSecond, setRedisGaugesFrom };
}

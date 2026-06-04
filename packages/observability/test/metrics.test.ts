/**
 * Metrics — registry behaviour, histogram boundaries, and the
 * gauge-snapshot helpers.
 *
 * Each test uses its own `configureRegistry` call to keep specs
 * isolated; calling configureRegistry resets the singleton.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDbMetrics } from '../src/metrics/db-gauges.js';
import { createDomainCounters } from '../src/metrics/domain-counters.js';
import { createHttpHistograms, statusFamily } from '../src/metrics/http-histograms.js';
import { createRedisMetrics } from '../src/metrics/redis-gauges.js';
import {
  RegistryNotConfiguredError,
  configureRegistry,
  getRegistry,
  resetRegistry,
} from '../src/metrics/registry.js';

afterEach(() => {
  resetRegistry();
});

describe('registry singleton', () => {
  it('throws when getRegistry is called before configureRegistry', () => {
    expect(() => getRegistry()).toThrow(RegistryNotConfiguredError);
  });

  it('returns the configured registry with the expected default labels', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    expect(getRegistry()).toBe(reg);

    const counter = new (await import('prom-client')).Counter({
      name: 'singleton_test_total',
      help: 'test',
      registers: [reg],
    });
    counter.inc();
    const text = await reg.metrics();
    expect(text).toMatch(/service="api"/u);
    expect(text).toMatch(/environment="test"/u);
  });

  it('configureRegistry called twice replaces the previous registry', () => {
    const r1 = configureRegistry({ service: 'api', environment: 'test', collectDefault: false });
    const r2 = configureRegistry({ service: 'api', environment: 'test', collectDefault: false });
    expect(r2).not.toBe(r1);
    expect(getRegistry()).toBe(r2);
  });
});

describe('statusFamily', () => {
  it.each([
    [100, '1xx'],
    [199, '1xx'],
    [200, '2xx'],
    [201, '2xx'],
    [299, '2xx'],
    [301, '3xx'],
    [399, '3xx'],
    [400, '4xx'],
    [404, '4xx'],
    [422, '4xx'],
    [499, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
    [599, '5xx'],
    [0, 'unknown'],
    [99, 'unknown'],
    [600, 'unknown'],
    [-1, 'unknown'],
  ])('status %i → %s', (input, expected) => {
    expect(statusFamily(input)).toBe(expected);
  });
});

describe('createHttpHistograms', () => {
  it('registers two histograms with the documented bucket layout', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    const h = createHttpHistograms(reg);
    h.requestDurationSeconds.observe({ method: 'GET', route: '/v1/x', status_family: '2xx' }, 0.42);
    h.responseSizeBytes.observe({ method: 'GET', route: '/v1/x', status_family: '2xx' }, 1234);
    const text = await reg.metrics();
    expect(text).toMatch(/http_request_duration_seconds_bucket.*le="0\.5".*1\b/u);
    expect(text).toMatch(/http_response_size_bytes_bucket.*le="4096".*1\b/u);
  });
});

describe('createDbMetrics', () => {
  it('setPoolGaugesFrom writes all four gauges atomically', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    const db = createDbMetrics(reg);
    db.setPoolGaugesFrom({ size: 10, active: 4, idle: 5, waiting: 1 });
    const text = await reg.metrics();
    expect(text).toMatch(/db_pool_size\{[^}]*\} 10\b/u);
    expect(text).toMatch(/db_pool_active\{[^}]*\} 4\b/u);
    expect(text).toMatch(/db_pool_idle\{[^}]*\} 5\b/u);
    expect(text).toMatch(/db_pool_waiting\{[^}]*\} 1\b/u);
  });

  it('slowQuerySeconds observes into the correct bucket', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    const db = createDbMetrics(reg);
    db.slowQuerySeconds.observe({ operation: 'select_orders' }, 0.3);
    const text = await reg.metrics();
    expect(text).toMatch(
      /db_slow_query_seconds_bucket\{le="0\.5"[^}]*operation="select_orders"\} 1\b/u,
    );
    expect(text).toMatch(
      /db_slow_query_seconds_bucket\{le="0\.25"[^}]*operation="select_orders"\} 0\b/u,
    );
  });
});

describe('createRedisMetrics', () => {
  it('setRedisGaugesFrom writes both gauges', async () => {
    const reg = configureRegistry({
      service: 'realtime',
      environment: 'test',
      collectDefault: false,
    });
    const r = createRedisMetrics(reg);
    r.setRedisGaugesFrom({ connectedClients: 42, opsPerSecond: 123 });
    const text = await reg.metrics();
    expect(text).toMatch(/redis_connected_clients\{[^}]*\} 42\b/u);
    expect(text).toMatch(/redis_ops_per_second\{[^}]*\} 123\b/u);
  });
});

describe('createDomainCounters', () => {
  it('orders_placed_total increments with the dispensary_state label', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    const c = createDomainCounters(reg);
    c.ordersPlaced.inc({ dispensary_state: 'MN' });
    c.ordersPlaced.inc({ dispensary_state: 'MN' });
    c.ordersPlaced.inc({ dispensary_state: 'WI' });
    const text = await reg.metrics();
    expect(text).toMatch(/orders_placed_total\{[^}]*dispensary_state="MN"[^}]*\} 2/u);
    expect(text).toMatch(/orders_placed_total\{[^}]*dispensary_state="WI"[^}]*\} 1/u);
  });

  it('cart_validation_failed_total tracks each rule code independently', async () => {
    const reg = configureRegistry({
      service: 'api',
      environment: 'test',
      collectDefault: false,
    });
    const c = createDomainCounters(reg);
    c.cartValidationFailed.inc({ reason: 'THC_LIMIT_EXCEEDED' });
    c.complianceCheckBlocked.inc({ reason: 'OUT_OF_HOURS' });
    c.idScanCompleted.inc({ outcome: 'approved' });
    c.ordersDelivered.inc({ outcome: 'delivered' });
    c.payoutsProcessed.inc({ outcome: 'success' });
    const text = await reg.metrics();
    expect(text).toMatch(/cart_validation_failed_total\{[^}]*reason="THC_LIMIT_EXCEEDED"/u);
    expect(text).toMatch(/compliance_check_blocked_total\{[^}]*reason="OUT_OF_HOURS"/u);
    expect(text).toMatch(/id_scan_completed_total\{[^}]*outcome="approved"/u);
    expect(text).toMatch(/orders_delivered_total\{[^}]*outcome="delivered"/u);
    expect(text).toMatch(/payouts_processed_total\{[^}]*outcome="success"/u);
  });
});

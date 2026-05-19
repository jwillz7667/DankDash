import { ValidationError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EtaService, type EtaLogger } from '../src/eta.service.js';
import { MapboxClient, type FetchLike } from '../src/mapbox.client.js';
import type { Redis } from 'ioredis';

const FROM = { lat: 44.97798, lng: -93.26528 };
const TO = { lat: 44.98, lng: -93.27 };

interface CapturedLog {
  readonly level: 'warn' | 'debug';
  readonly payload: Record<string, unknown>;
  readonly msg: string;
}

function captureLogger(): { readonly logger: EtaLogger; readonly logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const logger: EtaLogger = {
    warn: (payload, msg) => {
      logs.push({ level: 'warn', payload, msg });
    },
    debug: (payload, msg) => {
      logs.push({ level: 'debug', payload, msg });
    },
  };
  return { logger, logs };
}

interface FakeRedis {
  readonly store: Map<string, { readonly value: string; readonly expiresAt: number }>;
  readonly redis: Redis;
  readonly getCalls: { readonly key: string }[];
  readonly setCalls: { readonly key: string; readonly ttl: number }[];
  failNextGet?: Error;
  failNextSet?: Error;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const getCalls: { key: string }[] = [];
  const setCalls: { key: string; ttl: number }[] = [];

  const fake: FakeRedis = {
    store,
    getCalls,
    setCalls,
    redis: {} as Redis, // populated below
  };

  // We need the redis methods to capture state on `fake` so tests can
  // assert against it.
  const redis = {
    get: vi.fn((key: string): Promise<string | null> => {
      getCalls.push({ key });
      if (fake.failNextGet !== undefined) {
        const err = fake.failNextGet;
        delete fake.failNextGet;
        return Promise.reject(err);
      }
      const hit = store.get(key);
      if (hit === undefined) return Promise.resolve(null);
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(hit.value);
    }),
    set: vi.fn((key: string, value: string, mode: string, ttlSeconds: number): Promise<'OK'> => {
      setCalls.push({ key, ttl: ttlSeconds });
      if (fake.failNextSet !== undefined) {
        const err = fake.failNextSet;
        delete fake.failNextSet;
        return Promise.reject(err);
      }
      if (mode !== 'EX') throw new ValidationError(`unexpected set mode ${mode}`);
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
      return Promise.resolve('OK');
    }),
  };
  (fake as { redis: unknown }).redis = redis;
  return fake;
}

function mapboxReturning(route: { duration: number; distance: number }): MapboxClient {
  const fetch: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: 'Ok',
          routes: [{ duration: route.duration, distance: route.distance }],
        }),
      text: () => Promise.resolve(''),
    });
  return new MapboxClient({ accessToken: 'pk.test', fetch });
}

function mapboxFailing(): MapboxClient {
  const fetch: FetchLike = () => Promise.reject(new Error('mapbox down'));
  return new MapboxClient({ accessToken: 'pk.test', fetch });
}

describe('EtaService.computeEta', () => {
  let redis: FakeRedis;
  let logCap: { logger: EtaLogger; logs: CapturedLog[] };

  beforeEach(() => {
    redis = fakeRedis();
    logCap = captureLogger();
  });

  it('cache miss → mapbox call → writes cache → returns source=mapbox', async () => {
    const mapbox = mapboxReturning({ duration: 360, distance: 2_500 });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const result = await service.computeEta(FROM, TO);

    expect(result).toEqual({ durationSeconds: 360, distanceMeters: 2_500, source: 'mapbox' });
    expect(redis.getCalls).toHaveLength(1);
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]?.ttl).toBe(60);
  });

  it('second call within TTL hits cache and skips mapbox', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'Ok', routes: [{ duration: 300, distance: 1_800 }] }),
        text: () => Promise.resolve(''),
      }),
    );
    const mapbox = new MapboxClient({ accessToken: 'pk.test', fetch: fetchSpy });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const first = await service.computeEta(FROM, TO);
    const second = await service.computeEta(FROM, TO);

    expect(first.source).toBe('mapbox');
    expect(second.source).toBe('cache');
    expect(second.durationSeconds).toBe(300);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('two requests within the same grid cell share a cached entry', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'Ok', routes: [{ duration: 240, distance: 1_400 }] }),
        text: () => Promise.resolve(''),
      }),
    );
    const mapbox = new MapboxClient({ accessToken: 'pk.test', fetch: fetchSpy });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    // Two driver pings within the same ~100m cell.
    await service.computeEta({ lat: 44.97798, lng: -93.26528 }, TO);
    const next = await service.computeEta({ lat: 44.97798, lng: -93.2651 }, TO); // ~14m east

    expect(next.source).toBe('cache');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to haversine × 0.8 when mapbox throws, and does NOT cache the fallback', async () => {
    const service = new EtaService({
      redis: redis.redis,
      mapbox: mapboxFailing(),
      logger: logCap.logger,
    });

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('fallback');
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result.distanceMeters).toBeGreaterThan(0);
    // Spec: roads ~25% longer than straight line; durationSeconds at 13.4 m/s
    // for ~520m straight-line ≈ 48s. Bounds are generous to keep the test
    // tolerant of fixture tweaks.
    expect(result.distanceMeters).toBeGreaterThan(500);
    expect(result.distanceMeters).toBeLessThan(800);
    // Cache should NOT have a fallback entry — next caller should retry mapbox.
    expect(redis.setCalls).toHaveLength(0);
    // The failure was logged at warn.
    expect(
      logCap.logs.some((l) => l.level === 'warn' && l.msg.includes('haversine fallback')),
    ).toBe(true);
  });

  it('after a fallback, a subsequent successful mapbox call repopulates the cache', async () => {
    let attempt = 0;
    const fetch: FetchLike = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('temporary outage'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'Ok', routes: [{ duration: 410, distance: 2_900 }] }),
        text: () => Promise.resolve(''),
      });
    };
    const mapbox = new MapboxClient({ accessToken: 'pk.test', fetch });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const first = await service.computeEta(FROM, TO);
    const second = await service.computeEta(FROM, TO);

    expect(first.source).toBe('fallback');
    expect(second.source).toBe('mapbox');
    expect(second.durationSeconds).toBe(410);
    expect(attempt).toBe(2);
  });

  it('treats a redis GET error as a miss and proceeds with mapbox', async () => {
    redis.failNextGet = new Error('redis down');
    const mapbox = mapboxReturning({ duration: 200, distance: 1_000 });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('mapbox');
    expect(logCap.logs.some((l) => l.payload.event === 'eta.cache_get_failed')).toBe(true);
  });

  it('logs a warn when SETEX fails but still returns the fresh result', async () => {
    redis.failNextSet = new Error('disk full');
    const mapbox = mapboxReturning({ duration: 222, distance: 1_111 });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('mapbox');
    expect(result.durationSeconds).toBe(222);
    expect(logCap.logs.some((l) => l.payload.event === 'eta.cache_set_failed')).toBe(true);
  });

  it('ignores a malformed cached entry and refetches', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'Ok', routes: [{ duration: 333, distance: 1_500 }] }),
        text: () => Promise.resolve(''),
      }),
    );
    const mapbox = new MapboxClient({ accessToken: 'pk.test', fetch: fetchSpy });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    // Seed a malformed entry under the exact cache key the service will compute.
    await redis.redis.set(
      'eta:v1:44978,-93265:44980,-93270',
      JSON.stringify({ foo: 'bar' }),
      'EX',
      60,
    );

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('mapbox');
    expect(result.durationSeconds).toBe(333);
  });

  it('logs an ExternalServiceError with its mapbox code on fallback path', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'NoRoute', message: 'no road' }),
        text: () => Promise.resolve(''),
      });
    const mapbox = new MapboxClient({ accessToken: 'pk.test', fetch });
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('fallback');
    const warn = logCap.logs.find((l) => l.payload.event === 'eta.mapbox_failed');
    expect(warn).toBeDefined();
    expect(warn?.payload.mapboxCode).toBe('NoRoute');
  });

  it('honors custom TTL + grid precision + fallback multipliers', async () => {
    const mapbox = mapboxReturning({ duration: 100, distance: 800 });
    const service = new EtaService({
      redis: redis.redis,
      mapbox,
      logger: logCap.logger,
      cacheTtlSeconds: 5,
      gridPrecisionDegrees: 0.01,
      fallbackRoadFactor: 1.5,
      fallbackAverageSpeedMps: 10,
    });

    const fresh = await service.computeEta(FROM, TO);
    expect(fresh.source).toBe('mapbox');
    expect(redis.setCalls[0]?.ttl).toBe(5);
    // Confirm fallback uses overridden constants.
    const failing = new EtaService({
      redis: redis.redis,
      mapbox: mapboxFailing(),
      logger: logCap.logger,
      fallbackRoadFactor: 1.5,
      fallbackAverageSpeedMps: 10,
    });
    const fb = await failing.computeEta(FROM, TO);
    expect(fb.source).toBe('fallback');
    // 520m × 1.5 / 10 m/s ≈ 78s — wide bound to stay fixture-tolerant.
    expect(fb.durationSeconds).toBeGreaterThan(60);
    expect(fb.durationSeconds).toBeLessThan(120);
  });

  it('still degrades to fallback when a non-ExternalServiceError leaks out of mapbox', async () => {
    // Build a MapboxClient whose internal fetch throws a non-Error throwable.
    const mapbox = mapboxFailing();
    const spy = vi
      .spyOn(mapbox, 'getDriveTime')
      .mockRejectedValue(new TypeError('boom from somewhere weird'));
    const service = new EtaService({ redis: redis.redis, mapbox, logger: logCap.logger });

    const result = await service.computeEta(FROM, TO);

    expect(result.source).toBe('fallback');
    expect(logCap.logs.some((l) => l.payload.event === 'eta.unexpected_error')).toBe(true);
    spy.mockRestore();
  });
});

/**
 * Driver → destination ETA, with a Redis-backed grid cache and a
 * haversine-based fallback for when Mapbox is unavailable.
 *
 * Decision tree per call:
 *
 *   1. Quantize both endpoints to grid cells.
 *   2. GET `eta:v1:<from>:<to>` from Redis.
 *      - HIT     → return the cached `EtaResult` with `source: 'cache'`.
 *      - MISS    → call Mapbox. On success, SETEX the result and return
 *                  with `source: 'mapbox'`.
 *      - MAPBOX FAIL → compute haversine × 0.8 (heuristic factor accounts
 *                  for the difference between straight-line distance and
 *                  road distance; spec § 10.3). DO NOT cache the
 *                  fallback — caching it would make the next 60s of
 *                  callers receive a stale fallback even after Mapbox
 *                  recovers. Return with `source: 'fallback'`.
 *
 * Why a single `computeEta` instead of separate "fresh" / "cached" APIs:
 * the cache is an implementation detail. Callers (observer, future
 * HTTP endpoint) want a `(from, to) → ETA`; whether it took 2 ms or 200 ms
 * is observability, not API surface.
 *
 * Why the fallback assumes an average urban speed (haversine × 0.8) instead
 * of "haversine ÷ default-mph": at delivery distances (≤ 10 mi) the road-
 * vs-line ratio is a tighter approximation than guessing a speed; spec
 * § 10.3 ratifies the 0.8 multiplier specifically.
 */
import { ExternalServiceError } from '@dankdash/types';
import { haversineMeters, type LatLng } from './distance.js';
import { DEFAULT_GRID_PRECISION_DEGREES, gridPairCacheKey, quantizeToGrid } from './grid.js';
import type { MapboxClient } from './mapbox.client.js';
import type { Redis } from 'ioredis';

export type EtaSource = 'cache' | 'mapbox' | 'fallback';

export interface EtaResult {
  readonly durationSeconds: number;
  readonly distanceMeters: number;
  readonly source: EtaSource;
}

export interface EtaServiceOptions {
  readonly redis: Redis;
  readonly mapbox: MapboxClient;
  readonly logger?: EtaLogger;
  /** Cache TTL — spec § 10.3 mandates 60 s. Override only for tests. */
  readonly cacheTtlSeconds?: number;
  /** Grid precision in degrees. Default matches spec § 10.3 (~100 m cells). */
  readonly gridPrecisionDegrees?: number;
  /**
   * Average city-driving speed estimate for the haversine-only fallback,
   * expressed as a multiplier on straight-line distance to road distance.
   * Per spec § 10.3: `haversine × 0.8`.
   */
  readonly fallbackRoadFactor?: number;
  /**
   * Assumed average road speed for the haversine fallback (m/s).
   * 13.4 m/s ≈ 30 mph — the MN urban posted-speed average and a
   * conservative midpoint between residential (25 mph) and arterial
   * (35 mph) for delivery routes.
   */
  readonly fallbackAverageSpeedMps?: number;
}

/**
 * Minimal logger shape — we deliberately do not import `@dankdash/config`
 * to keep this package framework-agnostic. Callers wire in their pino
 * logger (which satisfies the shape) or a no-op in tests.
 */
export interface EtaLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
  debug(payload: Record<string, unknown>, msg: string): void;
}

const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_FALLBACK_ROAD_FACTOR = 1 / 0.8; // spec "× 0.8" means roads are ~25% longer than straight-line
const DEFAULT_FALLBACK_AVERAGE_SPEED_MPS = 13.4;

export class EtaService {
  private readonly redis: Redis;
  private readonly mapbox: MapboxClient;
  private readonly logger: EtaLogger;
  private readonly cacheTtlSeconds: number;
  private readonly gridPrecisionDegrees: number;
  private readonly fallbackRoadFactor: number;
  private readonly fallbackAverageSpeedMps: number;

  constructor(options: EtaServiceOptions) {
    this.redis = options.redis;
    this.mapbox = options.mapbox;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.gridPrecisionDegrees = options.gridPrecisionDegrees ?? DEFAULT_GRID_PRECISION_DEGREES;
    this.fallbackRoadFactor = options.fallbackRoadFactor ?? DEFAULT_FALLBACK_ROAD_FACTOR;
    this.fallbackAverageSpeedMps =
      options.fallbackAverageSpeedMps ?? DEFAULT_FALLBACK_AVERAGE_SPEED_MPS;
  }

  async computeEta(from: LatLng, to: LatLng): Promise<EtaResult> {
    const fromCell = quantizeToGrid(from, this.gridPrecisionDegrees);
    const toCell = quantizeToGrid(to, this.gridPrecisionDegrees);
    const cacheKey = gridPairCacheKey(fromCell, toCell);

    const cached = await this.readCache(cacheKey);
    if (cached !== null) {
      return { ...cached, source: 'cache' };
    }

    try {
      const fresh = await this.mapbox.getDriveTime(from, to);
      await this.writeCache(cacheKey, fresh);
      return {
        durationSeconds: fresh.durationSeconds,
        distanceMeters: fresh.distanceMeters,
        source: 'mapbox',
      };
    } catch (err) {
      // Mapbox is down / rate-limited / NoRoute / timeout. Spec is
      // explicit: fall back to haversine × 0.8 so the customer ETA
      // never goes dark. The cache deliberately stays unwritten so the
      // very next call retries Mapbox.
      if (err instanceof ExternalServiceError) {
        this.logger.warn(
          { event: 'eta.mapbox_failed', mapboxCode: err.details.mapboxCode ?? null },
          'eta: mapbox call failed; using haversine fallback',
        );
      } else {
        // Genuinely unexpected — still fall back rather than fail the
        // whole observer, but log it as warn so it shows up in alerts.
        this.logger.warn(
          { event: 'eta.unexpected_error', err: err instanceof Error ? err.message : String(err) },
          'eta: unexpected error in mapbox path; using haversine fallback',
        );
      }
      return this.fallback(from, to);
    }
  }

  private fallback(from: LatLng, to: LatLng): EtaResult {
    const straightLineMeters = haversineMeters(from, to);
    const roadMeters = straightLineMeters * this.fallbackRoadFactor;
    const durationSeconds = roadMeters / this.fallbackAverageSpeedMps;
    return {
      durationSeconds,
      distanceMeters: roadMeters,
      source: 'fallback',
    };
  }

  private async readCache(
    key: string,
  ): Promise<{ readonly durationSeconds: number; readonly distanceMeters: number } | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (err) {
      // A flaky Redis means we degrade to a Mapbox call; we don't want
      // a cache outage to take ETAs offline. Log + treat as miss.
      this.logger.warn(
        { event: 'eta.cache_get_failed', err: err instanceof Error ? err.message : String(err) },
        'eta: redis GET failed; treating as cache miss',
      );
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const durationSeconds = obj.durationSeconds;
      const distanceMeters = obj.distanceMeters;
      if (
        typeof durationSeconds !== 'number' ||
        !Number.isFinite(durationSeconds) ||
        typeof distanceMeters !== 'number' ||
        !Number.isFinite(distanceMeters)
      ) {
        // Cached value pre-dates a schema change. Drop silently — the
        // miss path will overwrite with a fresh entry shortly.
        this.logger.debug({ event: 'eta.cache_malformed', key }, 'eta: cached value malformed');
        return null;
      }
      return { durationSeconds, distanceMeters };
    } catch {
      return null;
    }
  }

  private async writeCache(
    key: string,
    value: { readonly durationSeconds: number; readonly distanceMeters: number },
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.cacheTtlSeconds);
    } catch (err) {
      // Cache write failure is non-fatal — the caller still gets the
      // fresh value; the next caller pays for another Mapbox lookup.
      this.logger.warn(
        { event: 'eta.cache_set_failed', err: err instanceof Error ? err.message : String(err) },
        'eta: redis SETEX failed; ETA returned but not cached',
      );
    }
  }
}

const NOOP_LOGGER: EtaLogger = {
  warn: noopLog,
  debug: noopLog,
};

function noopLog(): void {
  // Default logger when the caller didn't supply one. Intentionally
  // silent — production wires in pino; the noop keeps unit tests free
  // of console noise.
  return;
}

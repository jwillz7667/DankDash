/**
 * Lat/lng grid quantization used by the ETA cache key.
 *
 * Spec § 10.3: "Cache by (driver-grid-cell, destination-grid-cell) for 60s
 * — drivers near each other heading to same destination get cached result."
 *
 * Why a fixed-degree grid instead of geohash / S2 / H3: the cache is
 * short-lived (60s) and the population sparse (≤ low-thousands of
 * concurrent in-flight orders at MVP scale). A grid cell ≈ 100m × 70m at
 * MN latitudes is the right granularity — wide enough that two pings
 * 50m apart land in the same cell most of the time, narrow enough that
 * a cached driving time is still locally accurate (a 70m offset is
 * negligible against a 5-minute drive). The encoded key is also human-
 * readable in Redis (`grid:43983,-86026:43985,-86025`) which makes
 * spelunking a cache miss in production an `XKEYS`-and-eyeball job
 * rather than a base-32 decode.
 *
 * The default precision (0.001°) is chosen deliberately:
 *   1° latitude  ≈ 111_320 m       → 0.001° ≈ 111 m
 *   1° longitude ≈ 111_320·cos(φ)  → 0.001° ≈ 78 m at φ=45°N (Minnesota)
 *
 * Two callers must agree on precision or they will not share a cache;
 * the EtaService exposes the precision in its constructor so a future
 * ops tweak rolls out atomically across all readers/writers.
 */
import type { LatLng } from './distance.js';

/** Default grid precision: ~100m cells at MN latitudes. */
export const DEFAULT_GRID_PRECISION_DEGREES = 0.001;

export interface GridCell {
  /** Rounded latitude × (1 / precision), as an integer for stable key formatting. */
  readonly latIndex: number;
  /** Rounded longitude × (1 / precision), as an integer. */
  readonly lngIndex: number;
}

/**
 * Quantize a point to its grid cell. The integer index is rounded to
 * the nearest cell — a point on the boundary lands deterministically by
 * IEEE-754's round-half-to-even, which is acceptable because the
 * boundary positions a phone GPS would ever report are noise-dominated
 * anyway.
 *
 * Throws on non-finite input rather than coercing to NaN — a non-finite
 * caller is a bug at the boundary (validation should have caught it),
 * and silently NaN-poisoning the cache key would hide that.
 */
export function quantizeToGrid(
  point: LatLng,
  precisionDegrees: number = DEFAULT_GRID_PRECISION_DEGREES,
): GridCell {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new RangeError(`quantizeToGrid: non-finite point (lat=${point.lat}, lng=${point.lng})`);
  }
  if (!Number.isFinite(precisionDegrees) || precisionDegrees <= 0) {
    throw new RangeError(`quantizeToGrid: precisionDegrees must be > 0 (got ${precisionDegrees})`);
  }
  return {
    latIndex: Math.round(point.lat / precisionDegrees),
    lngIndex: Math.round(point.lng / precisionDegrees),
  };
}

/**
 * Cache-key serializer for a (from, to) cell pair. Format:
 *   `eta:v1:<fromLat>,<fromLng>:<toLat>,<toLng>`
 *
 * The `v1` prefix lets us roll a backwards-incompatible payload change
 * (different cache hit/miss semantics, schema bump) without colliding
 * with old entries that would otherwise live the full TTL.
 */
export function gridPairCacheKey(from: GridCell, to: GridCell): string {
  return `eta:v1:${from.latIndex.toString()},${from.lngIndex.toString()}:${to.latIndex.toString()},${to.lngIndex.toString()}`;
}

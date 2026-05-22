/**
 * Pure helpers for the Phase 10.2 geofence trigger.
 *
 * The observer in `geofence.observer.ts` is the IO shell; this file owns
 * only the maths and the JSONB-snapshot parser. Keeping them split lets
 * the math be tested without spinning up a repository fake and lets the
 * observer be tested without re-asserting the haversine formula.
 *
 * Spec § 10.2: "If driver is within 50m of the order's delivery address →
 * emit DriverArrived → API transitions order to arrived_at_dropoff."
 * Threshold is exported as a constant so the test file and the observer
 * share the same source of truth — a future ops decision to widen it for
 * a specific dispensary would override at the observer level, not by
 * editing this constant.
 */

/**
 * Mean Earth radius in metres (WGS84-derived mean). Used by the haversine
 * formula. The formula is accurate to ~0.5% over the ranges we care about
 * (50m–10km); GPS noise from a phone is already ±5–20m on a good fix, so
 * the radius approximation is well below the noise floor.
 */
const EARTH_RADIUS_METERS = 6_371_008.8;

/** Phase 10 spec § 10.2 — arrival fires when driver is within 50m of dropoff. */
export const ARRIVAL_THRESHOLD_METERS = 50;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Great-circle distance in metres between two WGS84 points using the
 * haversine formula. The arithmetic is symmetric — `haversineMeters(a,b)`
 * equals `haversineMeters(b,a)` — and well-behaved near the threshold
 * boundary (no `acos(1+ε)` blow-up that the law-of-cosines form has).
 *
 * We deliberately do NOT short-circuit on coordinate equality: a flapping
 * GPS fix that emits `(lat, lng)` then `(lat + 1e-12, lng)` should still
 * produce a tiny distance, not 0, so the test asserts symmetry holds.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  // Clamp to [0, 1] — float drift on antipodal points can push `h` to
  // 1 + 2e-16, which would produce NaN out of `asin`. The clamp is a
  // cheap guard with no effect on points anywhere near 50m apart.
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * True iff `here` is within `thresholdMeters` of `there`. Inclusive at the
 * boundary — a point exactly 50.0m from the dropoff fires arrival. Hitting
 * the boundary in practice is vanishingly unlikely (GPS quantisation is
 * coarser than that), and the inclusive bound matches the spec's plain
 * reading of "within 50m".
 */
export function isWithinArrivalThreshold(
  here: LatLng,
  there: LatLng,
  thresholdMeters: number = ARRIVAL_THRESHOLD_METERS,
): boolean {
  return haversineMeters(here, there) <= thresholdMeters;
}

/**
 * Parse `orders.delivery_address_snapshot` (JSONB → `unknown` at the
 * Drizzle boundary) for the geocoded dropoff point. The snapshot is
 * shaped by `serializeAddress` in
 * `apps/api/src/modules/checkout/checkout.service.ts` — its `location`
 * field is either a GeoJSON `Point` `{ type, coordinates: [lng, lat] }`
 * or `null` (legacy rows that pre-date geocoding).
 *
 * Returns `null` on any shape mismatch instead of throwing. The geofence
 * path treats "no dropoff point" as "skip arrival" — a legacy row should
 * not crash the worker, and the observer logs a warning so it surfaces
 * if a new code path starts writing the field in a wrong shape.
 *
 * Why hand-rolled instead of zod: keeps the workers package free of a
 * runtime dependency on a schema library it doesn't otherwise need, and
 * the shape is narrow enough (4 type guards) to inline without losing
 * clarity.
 */
export function extractDropoffPoint(snapshot: unknown): LatLng | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const obj = snapshot as Record<string, unknown>;
  const loc = obj.location;
  if (loc === null || typeof loc !== 'object') return null;
  const point = loc as Record<string, unknown>;
  if (point.type !== 'Point') return null;
  const coords: unknown = point.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const tuple = coords as readonly unknown[];
  const lng = tuple[0];
  const lat = tuple[1];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

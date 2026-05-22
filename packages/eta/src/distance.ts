/**
 * Pure great-circle distance helper.
 *
 * Owned here rather than re-imported from the workers package because the
 * eta service is consumed by every backend that wants an ETA preview —
 * keeping the math zero-dependency means a future Next.js / NestJS caller
 * does not transitively pull in the workers' BullMQ / cron weight.
 *
 * The arithmetic matches `apps/workers/src/jobs/location-ingest/
 * geofence.service.ts` to within ULP on the Minneapolis fixtures used by
 * both test suites; if you change one, change the other or add a
 * cross-package equivalence test.
 */

const EARTH_RADIUS_METERS = 6_371_008.8;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Great-circle distance in metres between two WGS84 points using the
 * haversine formula. Accurate to ~0.5% over the 50m–10km range we use
 * for ETA fallback — well below the noise floor of a phone GPS fix.
 *
 * The result is clamped at the asin step to keep float drift on long
 * (near-antipodal) distances from producing NaN; for ETA payloads we
 * never see distances above ~50km, but the clamp is cheap insurance.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

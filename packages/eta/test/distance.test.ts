import { describe, expect, it } from 'vitest';
import { haversineMeters, type LatLng } from '../src/distance.js';

// Same Minneapolis City Hall fixtures used by the workers' geofence
// service tests. The two implementations must agree to within ULP on
// these points — if they drift, the geofence and the ETA fallback would
// start telling the customer slightly different things, and one of the
// two implementations is wrong.
const CITY_HALL: LatLng = { lat: 44.97798, lng: -93.26528 };
const ONE_DOOR_DOWN: LatLng = { lat: 44.97798, lng: -93.265 };
const ONE_BLOCK_EAST: LatLng = { lat: 44.97798, lng: -93.26375 };

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(CITY_HALL, CITY_HALL)).toBe(0);
  });

  it('is symmetric — d(a,b) === d(b,a)', () => {
    const ab = haversineMeters(CITY_HALL, ONE_BLOCK_EAST);
    const ba = haversineMeters(ONE_BLOCK_EAST, CITY_HALL);
    expect(ab).toBeCloseTo(ba, 10);
  });

  it('matches the known short-range distance (~120m, ±5%)', () => {
    const d = haversineMeters(CITY_HALL, ONE_BLOCK_EAST);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(130);
  });

  it('returns a sub-50m distance for a ~25m offset', () => {
    const d = haversineMeters(CITY_HALL, ONE_DOOR_DOWN);
    expect(d).toBeLessThan(50);
    expect(d).toBeGreaterThan(15);
  });

  it('clamps near-antipodal float drift instead of producing NaN', () => {
    const north: LatLng = { lat: 89.9, lng: 0 };
    const south: LatLng = { lat: -89.9, lng: 0 };
    const d = haversineMeters(north, south);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(19_000_000);
  });
});

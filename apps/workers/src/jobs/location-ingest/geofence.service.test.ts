import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_THRESHOLD_METERS,
  extractDropoffPoint,
  haversineMeters,
  isWithinArrivalThreshold,
  type LatLng,
} from './geofence.service.js';

// Minneapolis City Hall (44.97798, -93.26528) and a point one block east
// (~120m). Distances cross-checked against Google Earth's ruler tool — the
// haversine formula will match within ~0.5%, which is the order-of-magnitude
// the test bounds capture.
const CITY_HALL: LatLng = { lat: 44.97798, lng: -93.26528 };
// ~25m east of City Hall — inside the 50m geofence.
const ONE_DOOR_DOWN: LatLng = { lat: 44.97798, lng: -93.265 };
// ~120m east — outside the 50m geofence.
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

  it('matches the known short-range distance from City Hall to one block east (~120m, ±5%)', () => {
    const d = haversineMeters(CITY_HALL, ONE_BLOCK_EAST);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(130);
  });

  it('returns a sub-50m distance for a ~25m offset (~22m)', () => {
    const d = haversineMeters(CITY_HALL, ONE_DOOR_DOWN);
    expect(d).toBeLessThan(50);
    expect(d).toBeGreaterThan(15);
  });

  it('handles antipodal-ish points without NaN (clamp guards float drift)', () => {
    // Two points ~half-way around the globe — sanity-check the clamp.
    const north: LatLng = { lat: 89.9, lng: 0 };
    const south: LatLng = { lat: -89.9, lng: 0 };
    const d = haversineMeters(north, south);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(19_000_000); // ~20,000km
  });
});

describe('isWithinArrivalThreshold', () => {
  it('returns true for a point inside the 50m default threshold', () => {
    expect(isWithinArrivalThreshold(CITY_HALL, ONE_DOOR_DOWN)).toBe(true);
  });

  it('returns false for a point outside the 50m default threshold', () => {
    expect(isWithinArrivalThreshold(CITY_HALL, ONE_BLOCK_EAST)).toBe(false);
  });

  it('respects a custom threshold (a 200m radius captures the block-east point)', () => {
    expect(isWithinArrivalThreshold(CITY_HALL, ONE_BLOCK_EAST, 200)).toBe(true);
  });

  it('exports the spec-mandated 50m default', () => {
    expect(ARRIVAL_THRESHOLD_METERS).toBe(50);
  });
});

describe('extractDropoffPoint', () => {
  it('parses a valid GeoJSON Point snapshot', () => {
    const snapshot = {
      id: '00000000-0000-0000-0000-000000000001',
      city: 'Minneapolis',
      location: { type: 'Point', coordinates: [-93.26528, 44.97798] },
    };
    expect(extractDropoffPoint(snapshot)).toEqual({ lat: 44.97798, lng: -93.26528 });
  });

  it.each([
    ['null', null],
    ['string', 'not-an-object'],
    ['number', 42],
    ['array (not an object)', []],
  ])('returns null for a non-object snapshot (%s)', (_label, value) => {
    expect(extractDropoffPoint(value)).toBeNull();
  });

  it('returns null when location field is missing', () => {
    expect(extractDropoffPoint({ city: 'Minneapolis' })).toBeNull();
  });

  it('returns null when location is null (legacy pre-geocode row)', () => {
    expect(extractDropoffPoint({ location: null })).toBeNull();
  });

  it.each([
    ['type !== Point', { type: 'LineString', coordinates: [-93, 44] }],
    ['coordinates not an array', { type: 'Point', coordinates: 'nope' }],
    ['coordinates wrong arity', { type: 'Point', coordinates: [-93] }],
    ['coordinates non-numeric', { type: 'Point', coordinates: ['-93', '44'] }],
    ['coordinates non-finite', { type: 'Point', coordinates: [Number.NaN, 44] }],
    ['lat out of range', { type: 'Point', coordinates: [-93, 95] }],
    ['lng out of range', { type: 'Point', coordinates: [-200, 44] }],
  ])('returns null for malformed point shape (%s)', (_label, location) => {
    expect(extractDropoffPoint({ location })).toBeNull();
  });
});

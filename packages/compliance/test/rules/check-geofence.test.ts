/**
 * Geofence rule. Exercises:
 *
 *   - Point inside the polygon → pass.
 *   - Point outside → fail.
 *   - Each of the four neighbouring states (WI, ND, SD, IA) → all fail
 *     by virtue of being far outside the MN polygon.
 *   - Boundary semantics (the ray-cast algorithm has asymmetric edges) —
 *     locked down here so consumers can rely on the actual behaviour.
 */
import { describe, expect, it } from 'vitest';
import { checkGeofence } from '../../src/index.js';
import {
  DES_MOINES_IA,
  FARGO_ND,
  HUDSON_WI,
  makeContext,
  makeDispensary,
  MPLS_POINT,
  MPLS_POLYGON,
  SIOUX_FALLS_SD,
} from '../fixtures.js';
import type { Polygon } from 'geojson';

describe('checkGeofence', () => {
  it('passes when the delivery address is inside the polygon', () => {
    const res = checkGeofence(makeContext({ deliveryLocation: MPLS_POINT }));
    expect(res.passed).toBe(true);
  });

  it('fails when the delivery address is outside the polygon', () => {
    const farAway = { latitude: 0, longitude: 0 };
    const res = checkGeofence(makeContext({ deliveryLocation: farAway }));
    expect(res.passed).toBe(false);
  });

  it.each([
    ['Hudson WI', HUDSON_WI],
    ['Fargo ND', FARGO_ND],
    ['Sioux Falls SD', SIOUX_FALLS_SD],
    ['Des Moines IA', DES_MOINES_IA],
  ])('fails for interstate address: %s', (_label, loc) => {
    const res = checkGeofence(makeContext({ deliveryLocation: loc }));
    expect(res.passed).toBe(false);
  });

  it('echoes the deliveryLocation in details for audit', () => {
    const res = checkGeofence(makeContext({ deliveryLocation: MPLS_POINT }));
    expect(res.details['deliveryLocation']).toEqual(MPLS_POINT);
  });

  it('reports the south edge of the polygon as inside (ray-cast convention)', () => {
    const onSouthEdge = { latitude: 44.95, longitude: -93.265 };
    const res = checkGeofence(makeContext({ deliveryLocation: onSouthEdge }));
    expect(res.passed).toBe(true);
  });

  it('reports the north edge of the polygon as outside (ray-cast convention)', () => {
    const onNorthEdge = { latitude: 45.0, longitude: -93.265 };
    const res = checkGeofence(makeContext({ deliveryLocation: onNorthEdge }));
    expect(res.passed).toBe(false);
  });

  it('treats a point inside a hole as outside the polygon', () => {
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [
        // Outer ring
        [
          [-93.3, 44.95],
          [-93.23, 44.95],
          [-93.23, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.95],
        ],
        // Hole around MPLS_POINT
        [
          [-93.27, 44.97],
          [-93.26, 44.97],
          [-93.26, 44.98],
          [-93.27, 44.98],
          [-93.27, 44.97],
        ],
      ],
    };
    const ctx = makeContext({
      dispensary: makeDispensary({ deliveryPolygon: withHole }),
      deliveryLocation: MPLS_POINT,
    });
    const res = checkGeofence(ctx);
    expect(res.passed).toBe(false);
  });

  it('uses the dispensary polygon — not a hard-coded MN boundary', () => {
    // Substitute a wholly different polygon (a square around the equator).
    const equatorial: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [-1, -1],
        ],
      ],
    };
    const ctx = makeContext({
      dispensary: makeDispensary({ deliveryPolygon: equatorial }),
      deliveryLocation: { latitude: 0, longitude: 0 },
    });
    const res = checkGeofence(ctx);
    expect(res.passed).toBe(true);

    // And MPLS_POINT should now be outside the equator polygon.
    const ctxOut = makeContext({
      dispensary: makeDispensary({ deliveryPolygon: equatorial }),
      deliveryLocation: MPLS_POINT,
    });
    const resOut = checkGeofence(ctxOut);
    expect(resOut.passed).toBe(false);
  });

  // For reference, the un-used polygon export is exercised through
  // direct geo tests; keeping the symbol referenced here keeps the eslint
  // unused-import rule happy if a future test deletes its sole use.
  it('test polygon is the expected square shape', () => {
    expect(MPLS_POLYGON.coordinates[0]).toHaveLength(5);
  });
});

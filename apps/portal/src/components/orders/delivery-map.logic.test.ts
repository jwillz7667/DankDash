import { describe, expect, it } from 'vitest';
import { type DriverLocation } from '../../lib/realtime/client.js';
import {
  DELIVERY_MAP_STATUSES,
  frameViewport,
  resolveDriverPoint,
  shouldShowDeliveryMap,
} from './delivery-map.logic.js';

describe('shouldShowDeliveryMap', () => {
  it('is true for the live-delivery window (assigned → id-scan)', () => {
    for (const status of DELIVERY_MAP_STATUSES) {
      expect(shouldShowDeliveryMap(status)).toBe(true);
    }
  });

  it('is false before assignment and after completion', () => {
    expect(shouldShowDeliveryMap('placed')).toBe(false);
    expect(shouldShowDeliveryMap('accepted')).toBe(false);
    expect(shouldShowDeliveryMap('awaiting_driver')).toBe(false);
    expect(shouldShowDeliveryMap('delivered')).toBe(false);
    expect(shouldShowDeliveryMap('canceled')).toBe(false);
  });
});

describe('resolveDriverPoint', () => {
  const live: DriverLocation = {
    driverId: 'dr-1',
    orderId: 'o-1',
    customerId: 'c-1',
    dispensaryId: 'd-1',
    lat: 45.1,
    lng: -93.2,
    accuracyMeters: null,
    speedMps: null,
    headingDeg: null,
    recordedAt: '2026-05-19T12:02:00Z',
  };
  const snapshot = {
    pickup: { latitude: 44.97, longitude: -93.26 },
    dropoff: { latitude: 44.94, longitude: -93.1 },
    driver: { latitude: 44.96, longitude: -93.2 },
  };

  it('prefers the live socket location over the snapshot', () => {
    expect(resolveDriverPoint(live, snapshot)).toEqual({ latitude: 45.1, longitude: -93.2 });
  });

  it('falls back to the snapshot driver point when no live tick yet', () => {
    expect(resolveDriverPoint(null, snapshot)).toEqual({ latitude: 44.96, longitude: -93.2 });
  });

  it('is null when neither live nor snapshot has a driver', () => {
    expect(resolveDriverPoint(null, { ...snapshot, driver: null })).toBeNull();
    expect(resolveDriverPoint(null, undefined)).toBeNull();
  });
});

describe('frameViewport', () => {
  it('centers on the midpoint of the supplied points', () => {
    const vp = frameViewport([
      { latitude: 44.9, longitude: -93.3 },
      { latitude: 45.0, longitude: -93.1 },
    ]);
    expect(vp.latitude).toBeCloseTo(44.95, 5);
    expect(vp.longitude).toBeCloseTo(-93.2, 5);
    expect(vp.zoom).toBeGreaterThan(0);
  });

  it('zooms tighter for a small span than a large one', () => {
    const tight = frameViewport([
      { latitude: 44.978, longitude: -93.265 },
      { latitude: 44.979, longitude: -93.266 },
    ]);
    const wide = frameViewport([
      { latitude: 44.7, longitude: -93.0 },
      { latitude: 45.2, longitude: -93.6 },
    ]);
    expect(tight.zoom).toBeGreaterThan(wide.zoom);
  });

  it('returns a sane fallback for an empty set', () => {
    const vp = frameViewport([]);
    expect(vp.latitude).toBeCloseTo(44.9778, 4);
    expect(vp.longitude).toBeCloseTo(-93.265, 4);
  });
});

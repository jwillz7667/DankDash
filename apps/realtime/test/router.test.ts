/**
 * Pure-function coverage for the streams router.
 *
 * The end-to-end `streams.test.ts` already drives this routing through a
 * real Redis testcontainer; this file complements it with cheap unit
 * tests that exercise edge cases (no driver assigned, null customer)
 * without spinning containers. Combined, they make a router regression
 * a noisy local failure rather than a CI-only catch.
 */
import { describe, expect, it } from 'vitest';
import { routeEnvelope } from '../src/streams/router.js';
import type { RealtimeEnvelope } from '@dankdash/realtime-events';

const ENV_ID = '01900000-0000-7000-8000-000000000001';
const ORDER_ID = '01900000-0000-7000-8000-00000000000a';
const CUSTOMER_ID = '01900000-0000-7000-8000-00000000000b';
const DRIVER_ID = '01900000-0000-7000-8000-00000000000c';
const DISPENSARY_ID = '01900000-0000-7000-8000-00000000000d';

function envelope(event: RealtimeEnvelope['event']): RealtimeEnvelope {
  return {
    id: ENV_ID,
    emittedAt: '2026-05-19T12:00:00.000Z',
    source: 'api',
    event,
  };
}

describe('routeEnvelope', () => {
  it('routes order:created to the vendor dispensary room only', () => {
    const out = routeEnvelope(
      envelope({
        type: 'order:created',
        payload: {
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          dispensaryId: DISPENSARY_ID,
          shortCode: 'ABC-123',
          totalCents: 4200,
          status: 'pending_acceptance',
          placedAt: '2026-05-19T12:00:00.000Z',
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.namespace).toBe('/vendor');
    expect(out[0]?.room).toBe(`dispensary:${DISPENSARY_ID}`);
    expect(out[0]?.eventName).toBe('order:created');
    expect(out[0]?.payload.envelopeId).toBe(ENV_ID);
  });

  it('routes order:status_changed to customer + vendor + driver when driver assigned', () => {
    const out = routeEnvelope(
      envelope({
        type: 'order:status_changed',
        payload: {
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          dispensaryId: DISPENSARY_ID,
          driverId: DRIVER_ID,
          fromStatus: 'picked_up',
          toStatus: 'en_route_dropoff',
          changedAt: '2026-05-19T12:00:00.000Z',
        },
      }),
    );
    expect(out.map((b) => b.namespace)).toEqual(['/customer', '/vendor', '/driver']);
  });

  it('omits the driver broadcast when driverId is null', () => {
    const out = routeEnvelope(
      envelope({
        type: 'order:status_changed',
        payload: {
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          dispensaryId: DISPENSARY_ID,
          driverId: null,
          fromStatus: 'placed',
          toStatus: 'accepted',
          changedAt: '2026-05-19T12:00:00.000Z',
        },
      }),
    );
    expect(out.map((b) => b.namespace)).toEqual(['/customer', '/vendor']);
  });

  it('drops driver:location when no customer is assigned (driver on duty, no order)', () => {
    const out = routeEnvelope(
      envelope({
        type: 'driver:location',
        payload: {
          driverId: DRIVER_ID,
          orderId: null,
          customerId: null,
          lat: 44.978,
          lng: -93.265,
          accuracyMeters: 10,
          speedMps: 5,
          headingDeg: 90,
          recordedAt: '2026-05-19T12:00:00.000Z',
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it('routes driver:location to only the assigned customer when one is present', () => {
    const out = routeEnvelope(
      envelope({
        type: 'driver:location',
        payload: {
          driverId: DRIVER_ID,
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          lat: 44.978,
          lng: -93.265,
          accuracyMeters: 10,
          speedMps: 5,
          headingDeg: 90,
          recordedAt: '2026-05-19T12:00:00.000Z',
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.namespace).toBe('/customer');
    expect(out[0]?.room).toBe(`user:${CUSTOMER_ID}`);
  });

  it('routes offer:new to the targeted driver room', () => {
    const out = routeEnvelope(
      envelope({
        type: 'offer:new',
        payload: {
          offerId: '01900000-0000-7000-8000-00000000000e',
          orderId: ORDER_ID,
          driverId: DRIVER_ID,
          expiresAt: '2026-05-19T12:01:00.000Z',
          payoutEstimateCents: 850,
          distanceMiles: 2.4,
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.namespace).toBe('/driver');
    expect(out[0]?.room).toBe(`driver:${DRIVER_ID}`);
  });

  it('routes offer:expired to the targeted driver room', () => {
    const out = routeEnvelope(
      envelope({
        type: 'offer:expired',
        payload: {
          offerId: '01900000-0000-7000-8000-00000000000f',
          orderId: ORDER_ID,
          driverId: DRIVER_ID,
          expiredAt: '2026-05-19T12:01:00.000Z',
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.eventName).toBe('offer:expired');
  });

  it('routes customer:eta_updated only to the assigned customer room', () => {
    const out = routeEnvelope(
      envelope({
        type: 'customer:eta_updated',
        payload: {
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          driverId: DRIVER_ID,
          etaSeconds: 540.5,
          distanceMeters: 3210,
          source: 'mapbox',
          computedAt: '2026-05-19T12:00:01.000Z',
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.namespace).toBe('/customer');
    expect(out[0]?.room).toBe(`user:${CUSTOMER_ID}`);
    expect(out[0]?.eventName).toBe('customer:eta_updated');
    expect(out[0]?.payload).toMatchObject({
      orderId: ORDER_ID,
      etaSeconds: 540.5,
      source: 'mapbox',
      envelopeId: ENV_ID,
    });
  });
});

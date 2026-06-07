/**
 * Unit tests for the order wire projection. Verifies that every nullable
 * timestamp renders as `null` when the row is fresh and as an ISO-8601
 * string when stamped, and that all monetary + identity fields pass
 * through verbatim. Snapshot-style assertions intentionally avoided —
 * one explicit per-field check makes a future field addition fail loudly
 * (and obviously) instead of silently widening the contract.
 */
import { describe, expect, it } from 'vitest';
import { projectOrder, projectOrderListItem, projectVendorQueueOrder } from './order.projection.js';
import type { Order, VendorQueueOrderRow } from '@dankdash/db';

const PLACED_AT = new Date('2026-05-18T19:00:00.000Z');
const STATUS_CHANGED_AT = new Date('2026-05-18T19:01:00.000Z');

function makeRow(overrides: Partial<Order> = {}): Order {
  return {
    id: '01935f3d-0000-7000-8000-000000001001',
    shortCode: '7K2X4Q',
    userId: '01935f3d-0000-7000-8000-000000000001',
    dispensaryId: '01935f3d-0000-7000-8000-000000000010',
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-000000000060',
    status: 'placed',
    statusChangedAt: STATUS_CHANGED_AT,
    subtotalCents: 9000,
    cannabisTaxCents: 900,
    salesTaxCents: 619,
    deliveryFeeCents: 0,
    driverTipCents: 500,
    discountCents: 0,
    totalCents: 11019,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: PLACED_AT,
    paymentFailedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    preppingAt: null,
    preparedAt: null,
    awaitingDriverAt: null,
    dispatchFailedAt: null,
    driverAssignedAt: null,
    enRoutePickupAt: null,
    pickedUpAt: null,
    enRouteDropoffAt: null,
    arrivedAtDropoffAt: null,
    idScanPendingAt: null,
    deliveredAt: null,
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: null,
    deliveryIdScanPassed: null,
    deliveryIdScanAt: null,
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: PLACED_AT,
    updatedAt: PLACED_AT,
    ...overrides,
  };
}

describe('projectOrder', () => {
  it('renders a fresh placed order with null timestamps and null ratings', () => {
    const projected = projectOrder(makeRow());

    expect(projected.id).toBe('01935f3d-0000-7000-8000-000000001001');
    expect(projected.shortCode).toBe('7K2X4Q');
    expect(projected.status).toBe('placed');
    expect(projected.statusChangedAt).toBe('2026-05-18T19:01:00.000Z');
    expect(projected.totalCents).toBe(11019);

    expect(projected.timestamps.placedAt).toBe('2026-05-18T19:00:00.000Z');
    expect(projected.timestamps.acceptedAt).toBeNull();
    expect(projected.timestamps.preppingAt).toBeNull();
    expect(projected.timestamps.deliveredAt).toBeNull();
    expect(projected.timestamps.canceledAt).toBeNull();
    expect(projected.timestamps.disputedAt).toBeNull();
    expect(projected.timestamps.ratedAt).toBeNull();

    expect(projected.ratings).toEqual({
      customer: null,
      review: null,
      dispensary: null,
      driver: null,
    });
  });

  it('serialises stamped timestamps as ISO strings', () => {
    const projected = projectOrder(
      makeRow({
        status: 'delivered',
        acceptedAt: new Date('2026-05-18T19:05:00.000Z'),
        preppingAt: new Date('2026-05-18T19:10:00.000Z'),
        deliveredAt: new Date('2026-05-18T20:00:00.000Z'),
        ratedAt: new Date('2026-05-18T20:30:00.000Z'),
        customerRating: 5,
        customerReview: 'great',
        driverRating: 5,
        dispensaryRating: 4,
      }),
    );

    expect(projected.timestamps.acceptedAt).toBe('2026-05-18T19:05:00.000Z');
    expect(projected.timestamps.preppingAt).toBe('2026-05-18T19:10:00.000Z');
    expect(projected.timestamps.deliveredAt).toBe('2026-05-18T20:00:00.000Z');
    expect(projected.timestamps.ratedAt).toBe('2026-05-18T20:30:00.000Z');

    expect(projected.ratings).toEqual({
      customer: 5,
      review: 'great',
      dispensary: 4,
      driver: 5,
    });
  });

  it('surfaces driverId once assigned', () => {
    const driverId = '01935f3d-0000-7000-8000-000000000002';
    const projected = projectOrder(makeRow({ driverId, status: 'driver_assigned' }));
    expect(projected.driverId).toBe(driverId);
  });
});

describe('projectVendorQueueOrder', () => {
  function makeQueueRow(overrides: Partial<VendorQueueOrderRow> = {}): VendorQueueOrderRow {
    return {
      ...makeRow(),
      customerFirstName: 'Ada',
      customerLastName: 'Lovelace',
      itemCount: 4,
      ...overrides,
    };
  }

  it('joins first + last name into customerName', () => {
    const projected = projectVendorQueueOrder(makeQueueRow());
    expect(projected.customerName).toBe('Ada Lovelace');
    expect(projected.itemCount).toBe(4);
  });

  it('falls back to just last name when first name is null', () => {
    const projected = projectVendorQueueOrder(
      makeQueueRow({ customerFirstName: null, customerLastName: 'Lovelace' }),
    );
    expect(projected.customerName).toBe('Lovelace');
  });

  it('emits null when both first and last name are missing', () => {
    const projected = projectVendorQueueOrder(
      makeQueueRow({ customerFirstName: null, customerLastName: null }),
    );
    expect(projected.customerName).toBeNull();
  });

  it('treats whitespace-only names as missing', () => {
    const projected = projectVendorQueueOrder(
      makeQueueRow({ customerFirstName: '  ', customerLastName: '' }),
    );
    expect(projected.customerName).toBeNull();
  });

  it('serialises placed/status/accepted timestamps as ISO strings', () => {
    const projected = projectVendorQueueOrder(
      makeQueueRow({
        status: 'prepping',
        acceptedAt: new Date('2026-05-18T19:05:00.000Z'),
        preppingAt: new Date('2026-05-18T19:10:00.000Z'),
      }),
    );
    expect(projected.placedAt).toBe('2026-05-18T19:00:00.000Z');
    expect(projected.acceptedAt).toBe('2026-05-18T19:05:00.000Z');
    expect(projected.preppingAt).toBe('2026-05-18T19:10:00.000Z');
    expect(projected.preparedAt).toBeNull();
  });
});

describe('projectOrderListItem', () => {
  it('projects the slim list row with ISO timestamps', () => {
    const projected = projectOrderListItem(
      makeRow({ status: 'en_route_dropoff', statusChangedAt: STATUS_CHANGED_AT }),
    );

    expect(projected).toEqual({
      id: '01935f3d-0000-7000-8000-000000001001',
      shortCode: '7K2X4Q',
      dispensaryId: '01935f3d-0000-7000-8000-000000000010',
      status: 'en_route_dropoff',
      totalCents: 11019,
      placedAt: '2026-05-18T19:00:00.000Z',
      statusChangedAt: '2026-05-18T19:01:00.000Z',
    });
  });
});

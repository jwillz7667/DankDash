/**
 * Projection tests — pure mapper, no I/O. Two concerns:
 *
 *   1. `projectActiveRoute` reads the JSONB snapshot through DropoffSchema
 *      and refuses malformed shapes with a RepositoryError (loud 500
 *      rather than a silently-corrupt driver card).
 *   2. The pickup projection chooses `dba` over `legalName` when both are
 *      present — the driver app surfaces the customer-facing name, not
 *      the LLC the license is registered under.
 */
import { RepositoryError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { projectActiveRoute, projectNoActiveRoute } from './current-route.projection.js';
import type { Dispensary, Order } from '@dankdash/db';

const ISO = (s: string) => new Date(s);

const SNAPSHOT = {
  id: '01935f3d-0000-7000-8000-0000000000b1',
  label: 'Home',
  line1: '500 S 5th St',
  line2: 'Apt 3B',
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55415',
  country: 'US',
  location: { type: 'Point' as const, coordinates: [-93.262, 44.974] as const },
  deliveryInstructions: 'Leave at the door',
};

const ORDER: Order = {
  id: '01935f3d-0000-7000-8000-000000000001',
  shortCode: 'A1B2C3',
  userId: '01935f3d-0000-7000-8000-0000000000c1',
  dispensaryId: '01935f3d-0000-7000-8000-0000000000a1',
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  deliveryAddressId: '01935f3d-0000-7000-8000-0000000000b1',
  status: 'en_route_pickup',
  statusChangedAt: ISO('2026-05-19T14:30:00.000Z'),
  subtotalCents: 5000,
  cannabisTaxCents: 500,
  salesTaxCents: 250,
  deliveryFeeCents: 800,
  driverTipCents: 500,
  discountCents: 0,
  totalCents: 7050,
  promoCodeId: null,
  discountFundedBy: null,
  complianceCheckPayload: {},
  deliveryAddressSnapshot: SNAPSHOT,
  placedAt: ISO('2026-05-19T14:00:00.000Z'),
  paymentFailedAt: null,
  acceptedAt: ISO('2026-05-19T14:05:00.000Z'),
  rejectedAt: null,
  preppingAt: ISO('2026-05-19T14:06:00.000Z'),
  preparedAt: ISO('2026-05-19T14:20:00.000Z'),
  awaitingDriverAt: ISO('2026-05-19T14:21:00.000Z'),
  dispatchFailedAt: null,
  driverAssignedAt: ISO('2026-05-19T14:25:00.000Z'),
  enRoutePickupAt: ISO('2026-05-19T14:26:00.000Z'),
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
  createdAt: ISO('2026-05-19T14:00:00.000Z'),
  updatedAt: ISO('2026-05-19T14:30:00.000Z'),
};

const DISPENSARY: Dispensary = {
  id: '01935f3d-0000-7000-8000-0000000000a1',
  legalName: 'Northside Cannabis LLC',
  dba: 'Northside Cannabis Co',
  licenseNumber: 'MN-LIC-0001',
  licenseType: 'retailer',
  licenseIssuedAt: '2025-01-01',
  licenseExpiresAt: '2026-12-31',
  metrcFacilityId: null,
  metrcApiKeyEnc: null,
  posProvider: 'manual',
  posCredentialsEnc: null,
  posLastSyncedAt: null,
  addressLine1: '100 W 1st St',
  addressLine2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.265, 44.977] },
  deliveryPolygon: {
    type: 'Polygon',
    coordinates: [
      [
        [-93.3, 44.9],
        [-93.2, 44.9],
        [-93.2, 45.0],
        [-93.3, 45.0],
        [-93.3, 44.9],
      ],
    ],
  },
  hoursJson: {},
  phone: '+16125551212',
  email: 'ops@northside.example',
  logoImageKey: null,
  heroImageKey: null,
  brandColorHex: '#1F8A3C',
  aeropayAccountRef: null,
  isAcceptingOrders: true,
  ratingAvg: '4.50',
  ratingCount: 100,
  status: 'active',
  createdAt: ISO('2025-01-01T00:00:00.000Z'),
  updatedAt: ISO('2026-05-19T00:00:00.000Z'),
  deletedAt: null,
};

describe('projectNoActiveRoute', () => {
  it('returns { activeOrder: null }', () => {
    expect(projectNoActiveRoute()).toEqual({ activeOrder: null });
  });
});

describe('projectActiveRoute', () => {
  it('projects a full route with pickup and dropoff', () => {
    const route = projectActiveRoute(ORDER, DISPENSARY);
    expect(route.activeOrder).not.toBeNull();
    if (route.activeOrder === null) return;
    expect(route.activeOrder.order.id).toBe(ORDER.id);
    expect(route.activeOrder.order.status).toBe('en_route_pickup');
    expect(route.activeOrder.pickup.dispensaryId).toBe(DISPENSARY.id);
    expect(route.activeOrder.pickup.location).toEqual(DISPENSARY.location);
    expect(route.activeOrder.dropoff.line1).toBe('500 S 5th St');
    expect(route.activeOrder.dropoff.deliveryInstructions).toBe('Leave at the door');
  });

  it('prefers DBA over legal name for the pickup display', () => {
    const route = projectActiveRoute(ORDER, DISPENSARY);
    if (route.activeOrder === null) throw new TypeError('expected activeOrder');
    expect(route.activeOrder.pickup.name).toBe('Northside Cannabis Co');
  });

  it('falls back to legal name when DBA is null', () => {
    const noDba: Dispensary = { ...DISPENSARY, dba: null };
    const route = projectActiveRoute(ORDER, noDba);
    if (route.activeOrder === null) throw new TypeError('expected activeOrder');
    expect(route.activeOrder.pickup.name).toBe('Northside Cannabis LLC');
  });

  it('throws RepositoryError on a malformed delivery_address_snapshot', () => {
    const bad: Order = {
      ...ORDER,
      deliveryAddressSnapshot: { id: 'not-a-uuid', line1: '500 S 5th St' },
    };
    expect(() => projectActiveRoute(bad, DISPENSARY)).toThrow(RepositoryError);
  });

  it('throws RepositoryError when the snapshot is missing required fields', () => {
    const bad: Order = { ...ORDER, deliveryAddressSnapshot: {} };
    expect(() => projectActiveRoute(bad, DISPENSARY)).toThrow(RepositoryError);
  });
});

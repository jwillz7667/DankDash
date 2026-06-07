/**
 * Unit tests for the consumer order-detail projections.
 *
 * These are pure boundary mappers (no I/O) — the risk lives entirely in
 * the field-by-field transforms, so that's what's pinned here:
 *
 *   - driver card: first-name + last-initial composition, the generic
 *     "Your driver" fallback, vehicle-string assembly (skipping unrecorded
 *     fields), last-4 phone masking, the always-null avatar, and the
 *     `id` fallback (drivers row id, else the user id).
 *   - dispensary pin: dba-preferred name, GeoJSON `[lng, lat]` → split
 *     `latitude`/`longitude`.
 *   - dropoff pin: address-snapshot unwrap, `region` → `state`, coordinate
 *     split, optional line2/instructions passthrough.
 *   - order + event: flat checkout shape, item mapping, ISO timestamps,
 *     and a clean pass through `OrderResponseSchema.parse`.
 */
import {
  type Dispensary,
  type Driver,
  type Order,
  type OrderEvent,
  type OrderItem,
  type User,
} from '@dankdash/db';
import { describe, expect, it } from 'vitest';
import {
  projectCustomerDispensary,
  projectCustomerDropoff,
  projectCustomerEvent,
  projectCustomerOrder,
  projectDriverPublicProfile,
} from './customer-order-detail.projection.js';

const ORDER_ID = '01935f3d-0000-7000-8000-000000000110';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-000000000140';
const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000101';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000201';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000120';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000130';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000150';
const ITEM_ID = '01935f3d-0000-7000-8000-000000000160';
const EVENT_ID = '01935f3d-0000-7000-8000-000000000170';

const PIN_NOW = new Date('2026-05-15T20:30:00.000Z');

const SAMPLE_SNAPSHOT = {
  id: ADDRESS_ID,
  label: 'Home',
  line1: '345 Park Ave',
  line2: 'Apt 4B',
  city: 'St Paul',
  region: 'MN',
  postalCode: '55102',
  country: 'US',
  location: { type: 'Point' as const, coordinates: [-93.094, 44.953] as const },
  deliveryInstructions: 'Leave with doorman',
};

function makeDriverUser(overrides: Partial<User> = {}): User {
  return {
    id: DRIVER_USER_ID,
    email: 'driver@example.com',
    phone: '+16125554321',
    passwordHash: 'argon2id$placeholder',
    role: 'driver',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Jenkins',
    dateOfBirth: '1992-03-04',
    kycVerifiedAt: new Date('2025-06-01T12:00:00.000Z'),
    kycProvider: 'veriff',
    kycProviderRef: 'veriff-ref-driver',
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: DRIVER_ID,
    userId: DRIVER_USER_ID,
    licenseNumberHash: new Uint8Array([1, 2, 3]),
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehicleYear: 2021,
    vehiclePlate: 'ABC-1234',
    vehicleColor: 'Silver',
    insuranceDocKey: null,
    insuranceExpiresAt: null,
    backgroundCheckPassedAt: null,
    backgroundCheckProviderRef: null,
    currentStatus: 'en_route_dropoff',
    lastStatusChangeAt: PIN_NOW,
    currentLocation: { type: 'Point', coordinates: [-93.2, 44.96] },
    currentLocationUpdatedAt: PIN_NOW,
    currentOrderId: ORDER_ID,
    ratingAvg: '4.90',
    ratingCount: 42,
    totalDeliveries: 128,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: PIN_NOW,
    ...overrides,
  };
}

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  return {
    id: DISPENSARY_ID,
    legalName: 'Twin Cities Cannabis Co.',
    dba: 'TC Cannabis',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '12 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.265, 44.978] },
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
    phone: '+16125550100',
    email: 'orders@tc.example',
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    updatedAt: new Date('2024-06-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeOrderItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: ITEM_ID,
    orderId: ORDER_ID,
    listingId: LISTING_ID,
    productSnapshot: { name: 'Blue Dream 3.5g', category: 'flower' },
    metrcPackageTag: '1A4FF0100000022000000123',
    quantity: 2,
    unitPriceCents: 2500,
    lineSubtotalCents: 5000,
    thcMgTotal: '450.000',
    cbdMgTotal: '12.000',
    weightGramsTotal: '7.000',
    cannabisTaxCents: 500,
    salesTaxCents: 300,
    createdAt: PIN_NOW,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'ABC123',
    userId: CUSTOMER_ID,
    dispensaryId: DISPENSARY_ID,
    deliveryAddressId: ADDRESS_ID,
    driverId: DRIVER_USER_ID,
    status: 'en_route_dropoff',
    statusChangedAt: PIN_NOW,
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 300,
    deliveryFeeCents: 500,
    driverTipCents: 200,
    discountCents: 0,
    totalCents: 6500,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: SAMPLE_SNAPSHOT,
    placedAt: new Date('2026-05-15T18:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: new Date('2026-05-15T18:05:00.000Z'),
    rejectedAt: null,
    preppingAt: new Date('2026-05-15T18:10:00.000Z'),
    preparedAt: new Date('2026-05-15T18:30:00.000Z'),
    awaitingDriverAt: new Date('2026-05-15T18:31:00.000Z'),
    dispatchFailedAt: null,
    driverAssignedAt: PIN_NOW,
    enRoutePickupAt: null,
    pickedUpAt: null,
    enRouteDropoffAt: PIN_NOW,
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
    createdAt: new Date('2026-05-15T18:00:00.000Z'),
    updatedAt: PIN_NOW,
    ...overrides,
  };
}

function makeOrderEvent(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    id: EVENT_ID,
    orderId: ORDER_ID,
    eventType: 'DRIVER_EN_ROUTE_DROPOFF',
    actorUserId: DRIVER_USER_ID,
    actorRole: 'driver',
    payload: { location: { latitude: 44.96, longitude: -93.2 } },
    occurredAt: PIN_NOW,
    ...overrides,
  };
}

describe('projectDriverPublicProfile', () => {
  it('composes first name + last initial, vehicle string, and masked phone', () => {
    const card = projectDriverPublicProfile(makeDriverUser(), makeDriver());

    expect(card).toEqual({
      id: DRIVER_ID,
      displayName: 'Sam J.',
      avatarKey: null,
      vehicleSummary: 'Silver 2021 Toyota Prius',
      maskedPhone: '••• ••• 4321',
    });
  });

  it('uses first name alone when there is no last name', () => {
    const card = projectDriverPublicProfile(makeDriverUser({ lastName: null }), makeDriver());

    expect(card.displayName).toBe('Sam');
  });

  it('falls back to "Your driver" when there is no first name', () => {
    const card = projectDriverPublicProfile(
      makeDriverUser({ firstName: null, lastName: 'Jenkins' }),
      makeDriver(),
    );

    expect(card.displayName).toBe('Your driver');
  });

  it('treats a whitespace-only first name as absent', () => {
    const card = projectDriverPublicProfile(makeDriverUser({ firstName: '   ' }), makeDriver());

    expect(card.displayName).toBe('Your driver');
  });

  it('skips unrecorded vehicle fields when composing the summary', () => {
    const card = projectDriverPublicProfile(
      makeDriverUser(),
      makeDriver({ vehicleColor: null, vehicleYear: null }),
    );

    expect(card.vehicleSummary).toBe('Toyota Prius');
  });

  it('returns a null vehicle summary when no vehicle field is recorded', () => {
    const card = projectDriverPublicProfile(
      makeDriverUser(),
      makeDriver({
        vehicleColor: null,
        vehicleYear: null,
        vehicleMake: null,
        vehicleModel: '   ',
      }),
    );

    expect(card.vehicleSummary).toBeNull();
  });

  it('returns a null vehicle summary when there is no driver row', () => {
    const card = projectDriverPublicProfile(makeDriverUser(), null);

    expect(card.vehicleSummary).toBeNull();
  });

  it('falls back to the user id when there is no driver row', () => {
    const card = projectDriverPublicProfile(makeDriverUser(), null);

    expect(card.id).toBe(DRIVER_USER_ID);
  });

  it('masks the phone to the last four digits, and null when absent or too short', () => {
    expect(projectDriverPublicProfile(makeDriverUser(), makeDriver()).maskedPhone).toBe(
      '••• ••• 4321',
    );
    expect(
      projectDriverPublicProfile(makeDriverUser({ phone: null }), makeDriver()).maskedPhone,
    ).toBeNull();
    expect(
      projectDriverPublicProfile(makeDriverUser({ phone: '123' }), makeDriver()).maskedPhone,
    ).toBeNull();
  });
});

describe('projectCustomerDispensary', () => {
  it('prefers the dba name and splits GeoJSON [lng, lat]', () => {
    const pin = projectCustomerDispensary(makeDispensary());

    expect(pin).toEqual({
      id: DISPENSARY_ID,
      name: 'TC Cannabis',
      latitude: 44.978,
      longitude: -93.265,
    });
  });

  it('falls back to the legal name when there is no dba', () => {
    const pin = projectCustomerDispensary(makeDispensary({ dba: null }));

    expect(pin.name).toBe('Twin Cities Cannabis Co.');
  });
});

describe('projectCustomerDropoff', () => {
  it('unwraps the address snapshot, maps region → state, and splits coordinates', () => {
    const pin = projectCustomerDropoff(makeOrder());

    expect(pin).toEqual({
      latitude: 44.953,
      longitude: -93.094,
      line1: '345 Park Ave',
      line2: 'Apt 4B',
      city: 'St Paul',
      state: 'MN',
      postalCode: '55102',
      instructions: 'Leave with doorman',
    });
  });

  it('passes through null line2 and instructions', () => {
    const order = makeOrder({
      deliveryAddressSnapshot: { ...SAMPLE_SNAPSHOT, line2: null, deliveryInstructions: null },
    });

    const pin = projectCustomerDropoff(order);

    expect(pin.line2).toBeNull();
    expect(pin.instructions).toBeNull();
  });
});

describe('projectCustomerOrder', () => {
  it('emits the flat checkout order shape with mapped items and ISO timestamps', () => {
    const projected = projectCustomerOrder(makeOrder(), [makeOrderItem()]);

    expect(projected.id).toBe(ORDER_ID);
    expect(projected.shortCode).toBe('ABC123');
    expect(projected.status).toBe('en_route_dropoff');
    expect(projected.totalCents).toBe(6500);
    expect(projected.placedAt).toBe('2026-05-15T18:00:00.000Z');
    expect(projected.statusChangedAt).toBe('2026-05-15T20:30:00.000Z');
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]).toMatchObject({
      id: ITEM_ID,
      listingId: LISTING_ID,
      quantity: 2,
      unitPriceCents: 2500,
      lineSubtotalCents: 5000,
      thcMgTotal: '450.000',
      cbdMgTotal: '12.000',
      weightGramsTotal: '7.000',
      createdAt: '2026-05-15T20:30:00.000Z',
    });
    expect(projected.items[0]?.productSnapshot).toEqual({
      name: 'Blue Dream 3.5g',
      category: 'flower',
    });
  });

  it('emits an empty items array when the order has no line items', () => {
    const projected = projectCustomerOrder(makeOrder(), []);

    expect(projected.items).toEqual([]);
  });
});

describe('projectCustomerEvent', () => {
  it('maps the event fields and ISO-formats occurredAt', () => {
    const projected = projectCustomerEvent(makeOrderEvent());

    expect(projected).toEqual({
      id: EVENT_ID,
      orderId: ORDER_ID,
      eventType: 'DRIVER_EN_ROUTE_DROPOFF',
      actorUserId: DRIVER_USER_ID,
      actorRole: 'driver',
      payload: { location: { latitude: 44.96, longitude: -93.2 } },
      occurredAt: '2026-05-15T20:30:00.000Z',
    });
  });

  it('passes through a null actor (system-emitted event)', () => {
    const projected = projectCustomerEvent(
      makeOrderEvent({ eventType: 'DISPATCH_QUEUE', actorUserId: null, actorRole: null }),
    );

    expect(projected.actorUserId).toBeNull();
    expect(projected.actorRole).toBeNull();
  });
});

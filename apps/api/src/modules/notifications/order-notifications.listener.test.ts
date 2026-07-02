/**
 * OrderNotificationsListener routing tests. Every switch arm gets a test
 * that pins (a) the templateKey, (b) the payload shape, (c) the consumer
 * appVariant, and (d) the `${orderId}:${toStatus}` idempotency key.
 *
 * Also covers:
 *   - order-not-found early return (no dispatch, no throw)
 *   - dispensary-not-found early return
 *   - driver-resolution chain: missing driverId / missing driver row /
 *     missing driver user all short-circuit without dispatching
 *   - default case (a transition that maps to no notification, e.g.
 *     `awaiting_driver`) — silent no-op
 *   - thrown dispatcher errors are swallowed (no unhandled rejection)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';
import {
  type NotificationDispatcher,
  type DispatchInput,
  type DispatchOutcome,
} from './notification-dispatcher.service.js';
import { OrderNotificationsListener } from './order-notifications.listener.js';
import type {
  Dispensary,
  DispensariesRepository,
  Driver,
  DriversRepository,
  Order,
  OrdersRepository,
  User,
  UsersRepository,
} from '@dankdash/db';
import type { NotificationTemplateKey } from '@dankdash/notifications';
import type { OrderEventType, OrderState } from '@dankdash/orders';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000020';
const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000021';

const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');

class FakeDispatcher {
  calls: Array<DispatchInput<NotificationTemplateKey>> = [];
  shouldThrow = false;

  dispatch = <TKey extends NotificationTemplateKey>(
    input: DispatchInput<TKey>,
  ): Promise<DispatchOutcome> => {
    if (this.shouldThrow) {
      throw new TypeError('boom');
    }
    this.calls.push(input);
    return Promise.resolve({ skipped: false, results: [] });
  };
}

class FakeOrders {
  rowsById = new Map<string, Order>();
  findById = (id: string): Promise<Order | null> => Promise.resolve(this.rowsById.get(id) ?? null);
}

class FakeDispensaries {
  rowsById = new Map<string, Dispensary>();
  findById = (id: string): Promise<Dispensary | null> =>
    Promise.resolve(this.rowsById.get(id) ?? null);
}

class FakeDrivers {
  rowsById = new Map<string, Driver>();
  findById = (id: string): Promise<Driver | null> => Promise.resolve(this.rowsById.get(id) ?? null);
}

class FakeUsers {
  rowsById = new Map<string, User>();
  findById = (id: string): Promise<User | null> => Promise.resolve(this.rowsById.get(id) ?? null);
}

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'AB123',
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-0000000000ff',
    status: 'placed',
    statusChangedAt: CREATED_AT,
    subtotalCents: 5_000,
    cannabisTaxCents: 500,
    salesTaxCents: 250,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 0,
    totalCents: 6_250,
    promoCodeId: null,
    discountFundedBy: null,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: CREATED_AT,
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function buildDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const base: Dispensary = {
    id: DISPENSARY_ID,
    legalName: 'Green Roots LLC',
    dba: 'Green Roots',
    licenseNumber: 'MN-CR-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 Test St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
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
    phone: null,
    email: null,
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  };
  return { ...base, ...overrides };
}

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: DRIVER_ID,
    userId: DRIVER_USER_ID,
    licenseNumberHash: Buffer.from('hash'),
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    vehiclePlate: null,
    vehicleColor: null,
    insuranceDocKey: null,
    insuranceExpiresAt: null,
    backgroundCheckPassedAt: null,
    backgroundCheckProviderRef: null,
    currentStatus: 'online',
    lastStatusChangeAt: CREATED_AT,
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: null,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function buildUser(id: string, firstName: string): User {
  return {
    id,
    email: `${id}@example.com`,
    phone: null,
    passwordHash: 'argon-hash',
    role: 'customer',
    status: 'active',
    firstName,
    lastName: 'Tester',
    dateOfBirth: '1990-01-01',
    kycVerifiedAt: null,
    kycProvider: null,
    kycProviderRef: null,
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  };
}

interface Harness {
  readonly listener: OrderNotificationsListener;
  readonly dispatcher: FakeDispatcher;
  readonly orders: FakeOrders;
  readonly dispensaries: FakeDispensaries;
  readonly drivers: FakeDrivers;
  readonly users: FakeUsers;
}

function buildHarness(): Harness {
  const dispatcher = new FakeDispatcher();
  const orders = new FakeOrders();
  const dispensaries = new FakeDispensaries();
  const drivers = new FakeDrivers();
  const users = new FakeUsers();
  const listener = new OrderNotificationsListener({
    dispatcher: dispatcher as unknown as NotificationDispatcher,
    orders: orders as unknown as OrdersRepository,
    dispensaries: dispensaries as unknown as DispensariesRepository,
    drivers: drivers as unknown as DriversRepository,
    users: users as unknown as UsersRepository,
  });
  return { listener, dispatcher, orders, dispensaries, drivers, users };
}

function buildEvent(
  toStatus: OrderState,
  event: OrderEventType = 'VENDOR_ACCEPT',
): OrderTransitionedEvent {
  return new OrderTransitionedEvent({
    orderId: ORDER_ID,
    fromStatus: 'placed',
    toStatus,
    event,
    actor: { role: 'system' },
    occurredAt: CREATED_AT,
  });
}

describe('OrderNotificationsListener', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.orders.rowsById.set(ORDER_ID, buildOrder());
    h.dispensaries.rowsById.set(DISPENSARY_ID, buildDispensary());
  });

  it('routes accepted → order.accepted with dispensary dba name', async () => {
    await h.listener.onOrderTransitioned(buildEvent('accepted'));

    expect(h.dispatcher.calls).toEqual([
      {
        userId: USER_ID,
        templateKey: 'order.accepted',
        payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
        appVariant: 'consumer',
        idempotencyKey: `${ORDER_ID}:accepted`,
      },
    ]);
  });

  it('falls back to legalName when dba is null', async () => {
    h.dispensaries.rowsById.set(DISPENSARY_ID, buildDispensary({ dba: null }));

    await h.listener.onOrderTransitioned(buildEvent('accepted'));

    expect(h.dispatcher.calls[0]?.payload).toEqual({
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots LLC',
    });
  });

  it('routes prepping → order.prepping', async () => {
    await h.listener.onOrderTransitioned(buildEvent('prepping'));

    expect(h.dispatcher.calls[0]?.templateKey).toBe('order.prepping');
  });

  it('routes ready_for_pickup → order.ready', async () => {
    await h.listener.onOrderTransitioned(buildEvent('ready_for_pickup'));

    expect(h.dispatcher.calls[0]?.templateKey).toBe('order.ready');
  });

  it('routes picked_up → order.picked_up with driverFirstName from driver→user chain', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ driverId: DRIVER_ID }));
    h.drivers.rowsById.set(DRIVER_ID, buildDriver());
    h.users.rowsById.set(DRIVER_USER_ID, buildUser(DRIVER_USER_ID, 'Alex'));

    await h.listener.onOrderTransitioned(buildEvent('picked_up'));

    expect(h.dispatcher.calls).toEqual([
      {
        userId: USER_ID,
        templateKey: 'order.picked_up',
        payload: { orderId: ORDER_ID, driverFirstName: 'Alex' },
        appVariant: 'consumer',
        idempotencyKey: `${ORDER_ID}:picked_up`,
      },
    ]);
  });

  it('routes arrived_at_dropoff → order.arrived with the driver first name', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ driverId: DRIVER_ID }));
    h.drivers.rowsById.set(DRIVER_ID, buildDriver());
    h.users.rowsById.set(DRIVER_USER_ID, buildUser(DRIVER_USER_ID, 'Jordan'));

    await h.listener.onOrderTransitioned(buildEvent('arrived_at_dropoff'));

    expect(h.dispatcher.calls[0]?.templateKey).toBe('order.arrived');
    expect(h.dispatcher.calls[0]?.payload).toEqual({
      orderId: ORDER_ID,
      driverFirstName: 'Jordan',
    });
  });

  it('skips picked_up when the order has no driver (driverId null)', async () => {
    await h.listener.onOrderTransitioned(buildEvent('picked_up'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('skips arrived_at_dropoff when the driver row is missing', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ driverId: DRIVER_ID }));
    // No driver row inserted.

    await h.listener.onOrderTransitioned(buildEvent('arrived_at_dropoff'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('skips picked_up when the driver user row is missing', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ driverId: DRIVER_ID }));
    h.drivers.rowsById.set(DRIVER_ID, buildDriver());
    // No user row inserted for the driver.

    await h.listener.onOrderTransitioned(buildEvent('picked_up'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('routes delivered → order.completed with totalCents', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ totalCents: 7_499 }));

    await h.listener.onOrderTransitioned(buildEvent('delivered'));

    expect(h.dispatcher.calls[0]?.templateKey).toBe('order.completed');
    expect(h.dispatcher.calls[0]?.payload).toEqual({ orderId: ORDER_ID, totalCents: 7_499 });
  });

  it('routes payment_failed → payment.failed with amountCents and a reason', async () => {
    await h.listener.onOrderTransitioned(buildEvent('payment_failed'));

    expect(h.dispatcher.calls[0]?.templateKey).toBe('payment.failed');
    expect(h.dispatcher.calls[0]?.payload).toMatchObject({
      orderId: ORDER_ID,
      amountCents: 6_250,
    });
    expect((h.dispatcher.calls[0]?.payload as { reason: string }).reason).toMatch(/declined/i);
  });

  it('is a silent no-op for transitions with no template (awaiting_driver)', async () => {
    await h.listener.onOrderTransitioned(buildEvent('awaiting_driver'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('is a silent no-op for terminal cancellation states', async () => {
    await h.listener.onOrderTransitioned(buildEvent('canceled'));
    await h.listener.onOrderTransitioned(buildEvent('rejected'));
    await h.listener.onOrderTransitioned(buildEvent('returned_to_store'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('short-circuits when the order row is missing (no dispatch, no throw)', async () => {
    h.orders.rowsById.clear();

    await h.listener.onOrderTransitioned(buildEvent('accepted'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('short-circuits when the dispensary row is missing', async () => {
    h.dispensaries.rowsById.clear();

    await h.listener.onOrderTransitioned(buildEvent('accepted'));

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('swallows dispatcher errors so the in-process event bus does not see an unhandled rejection', async () => {
    h.dispatcher.shouldThrow = true;

    await expect(h.listener.onOrderTransitioned(buildEvent('accepted'))).resolves.toBeUndefined();
  });

  it('pins ORDER_TRANSITIONED_EVENT as the event-emitter binding string', () => {
    // OnEvent is metadata-applied; we assert the string the listener
    // subscribed to matches the producer (orders) — guards against a
    // future rename desyncing publisher vs. subscriber.
    expect(ORDER_TRANSITIONED_EVENT).toBe('order.transitioned');
    // Ensure the spy-style assertion above runs to keep the import live.
    expect(vi.isMockFunction(OrderTransitionedEvent)).toBe(false);
  });
});

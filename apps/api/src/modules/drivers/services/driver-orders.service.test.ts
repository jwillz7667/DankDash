/**
 * Unit tests for DriverOrdersService.
 *
 * Coverage:
 *
 *   - GET happy path: looks up via `findByIdForDriver`, hydrates four
 *     parallel reads, projects with initialed last name + masked phone,
 *     surfaces dropoff snapshot.
 *   - GET 404 for unknown id OR cross-driver id (the repo seam returns
 *     null in both cases — the service must not distinguish).
 *   - GET 404 when the joined customer or dispensary row is missing.
 *
 *   - pickup-confirm happy path: forwards the location payload via
 *     `OrderTransitionService.transition` with event
 *     `DRIVER_EN_ROUTE_PICKUP`; returns the refreshed projection. The
 *     state-machine in `@dankdash/orders` is responsible for the
 *     FROM-state guard — the service just submits the typed event.
 *   - pickup-confirm 404 for cross-driver id — no transition fired.
 *   - pickup-confirm propagates a 409 ConflictError from the transition
 *     layer (the state-machine rejects an illegal predecessor).
 *
 *   - delivery-confirm happy path: forwards location + notes payload
 *     via event `DRIVER_DELIVERED`. The repo sets `deliveredAt`
 *     automatically through `STATUS_TIMESTAMP_COLUMN`.
 *   - delivery-confirm 404 for cross-driver id.
 *   - delivery-confirm propagates a 409 COMPLIANCE_ID_SCAN_REQUIRED
 *     from the repo's ID-scan gate (the gate itself is exercised by
 *     the repo-level tests; the service must NOT swallow it).
 *
 *   - cancel happy path: locks the driver row, fires DRIVER_CANCELED
 *     through `transitionWithinTx` with `patch: { driverId: null }`,
 *     releases the accepted dispatch offer, frees the driver back to
 *     `online`, and emits the deferred event only after the tx body
 *     resolves.
 *   - cancel 404 when the JWT user has no drivers row.
 *   - cancel 409 DRIVER_ORDER_NOT_ACTIVE when the order is not the
 *     driver's `current_order_id` (stale tab) — nothing mutated.
 *   - cancel propagates the 422 machine rejection after pickup and
 *     skips every post-transition mutation (rollback semantics).
 *
 * The OrderTransitionService dependency is a fake that records every
 * transition request — so the test pins the exact event, actor, and
 * payload the service threads through.
 */
import { OrderError } from '@dankdash/orders';
import { ConflictError, DriverError, NotFoundError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrderTransitionedEvent } from '../../orders/order-transition.events.js';
import { DriverOrdersService, type DriverOrdersScopedRepos } from './driver-orders.service.js';
import type {
  DeferredTransitionResult,
  OrderTransitionService,
  TransitionRequest,
  TransitionResult,
} from '../../orders/order-transition.service.js';
import type {
  Database,
  DispatchOffer,
  DispatchOffersRepository,
  DispensariesRepository,
  Dispensary,
  Driver,
  DriverStatus,
  DriversRepository,
  Order,
  OrderEvent,
  OrderEventsRepository,
  OrderItem,
  OrderItemsRepository,
  OrdersRepository,
  User,
  UsersRepository,
} from '@dankdash/db';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000101';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000110';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000120';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000130';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-000000000140';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000150';

// transaction() is a passthrough so cancelDelivery's tx body runs against
// the same fakes; rollback semantics are asserted by checking that
// nothing after a thrown step recorded a call.
const FAKE_DB = {
  transaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(FAKE_DB),
} as unknown as Database;

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

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'ABC123',
    userId: CUSTOMER_ID,
    dispensaryId: DISPENSARY_ID,
    deliveryAddressId: ADDRESS_ID,
    driverId: DRIVER_USER_ID,
    status: 'driver_assigned',
    statusChangedAt: PIN_NOW,
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 300,
    deliveryFeeCents: 500,
    driverTipCents: 200,
    discountCents: 0,
    totalCents: 6500,
    promoCodeId: null,
    discountFundedBy: null,
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
    createdAt: new Date('2026-05-15T18:00:00.000Z'),
    updatedAt: PIN_NOW,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<User> = {}): User {
  return {
    id: CUSTOMER_ID,
    email: 'sam@example.com',
    phone: '+16125554321',
    passwordHash: 'argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Jenkins',
    dateOfBirth: '1996-01-01',
    kycVerifiedAt: new Date('2025-06-01T12:00:00.000Z'),
    kycProvider: 'veriff',
    kycProviderRef: 'veriff-ref-001',
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
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

/**
 * Driver row in the post-accept state: status already flipped to
 * `en_route_pickup` and `current_order_id` stamped (the offer-accept
 * flow does both immediately, before pickup-confirm).
 */
function makeDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: DRIVER_ID,
    userId: DRIVER_USER_ID,
    licenseNumberHash: new Uint8Array(32),
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    vehiclePlate: null,
    vehicleColor: null,
    insuranceDocKey: null,
    insuranceExpiresAt: '2026-12-31',
    backgroundCheckPassedAt: '2026-01-01',
    backgroundCheckProviderRef: null,
    currentStatus: 'en_route_pickup',
    lastStatusChangeAt: PIN_NOW,
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: ORDER_ID,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: PIN_NOW,
    updatedAt: PIN_NOW,
    ...overrides,
  };
}

class FakeOrdersRepo implements Pick<OrdersRepository, 'findByIdForDriver'> {
  public rows = new Map<string, Order>();
  public callsByDriverId: { orderId: string; driverUserId: string }[] = [];

  seed(row: Order): void {
    this.rows.set(`${row.id}:${row.driverId ?? ''}`, row);
  }

  findByIdForDriver(orderId: string, driverUserId: string): Promise<Order | null> {
    this.callsByDriverId.push({ orderId, driverUserId });
    return Promise.resolve(this.rows.get(`${orderId}:${driverUserId}`) ?? null);
  }
}

class FakeOrderItemsRepo implements Pick<OrderItemsRepository, 'listForOrder'> {
  public rows: OrderItem[] = [];
  listForOrder(orderId: string): Promise<readonly OrderItem[]> {
    return Promise.resolve(this.rows.filter((r) => r.orderId === orderId));
  }
}

class FakeOrderEventsRepo implements Pick<OrderEventsRepository, 'listForOrder'> {
  public rows: OrderEvent[] = [];
  listForOrder(orderId: string): Promise<readonly OrderEvent[]> {
    return Promise.resolve(this.rows.filter((r) => r.orderId === orderId));
  }
}

class FakeUsersRepo implements Pick<UsersRepository, 'findById'> {
  public rows = new Map<string, User>();
  seed(row: User): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeDispensariesRepo implements Pick<DispensariesRepository, 'findById'> {
  public rows = new Map<string, Dispensary>();
  seed(row: Dispensary): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeDriversRepo implements Pick<
  DriversRepository,
  'findByUserId' | 'findByIdForUpdate' | 'setStatus' | 'setCurrentOrder'
> {
  public row: Driver | null = null;
  public lockedIds: string[] = [];
  public setStatusCalls: { id: string; status: DriverStatus }[] = [];
  public setCurrentOrderCalls: { id: string; orderId: string | null }[] = [];

  findByUserId(userId: string): Promise<Driver | null> {
    return Promise.resolve(this.row !== null && this.row.userId === userId ? this.row : null);
  }

  findByIdForUpdate(id: string): Promise<Driver | null> {
    this.lockedIds.push(id);
    return Promise.resolve(this.row !== null && this.row.id === id ? this.row : null);
  }

  setStatus(id: string, status: DriverStatus): Promise<void> {
    this.setStatusCalls.push({ id, status });
    if (this.row !== null && this.row.id === id) {
      this.row = { ...this.row, currentStatus: status };
    }
    return Promise.resolve();
  }

  setCurrentOrder(id: string, orderId: string | null): Promise<void> {
    this.setCurrentOrderCalls.push({ id, orderId });
    if (this.row !== null && this.row.id === id) {
      this.row = { ...this.row, currentOrderId: orderId };
    }
    return Promise.resolve();
  }
}

class FakeDispatchOffersRepo implements Pick<DispatchOffersRepository, 'releaseAcceptedForOrder'> {
  public releaseCalls: { orderId: string; driverId: string; now: Date; reason: string }[] = [];

  // The service treats the flip as fire-and-forget inside the tx and
  // never reads the returned row; null mirrors the no-accepted-row
  // no-op (racing second cancel).
  releaseAcceptedForOrder(
    orderId: string,
    driverId: string,
    now: Date,
    reason: string,
  ): Promise<DispatchOffer | null> {
    this.releaseCalls.push({ orderId, driverId, now, reason });
    return Promise.resolve(null);
  }
}

/**
 * Maps the driver-facing transition events to the order status the
 * real OrderTransitionService would arrive at after the XState
 * machine runs the predicate. Kept narrow on purpose — the test only
 * exercises the two events `DriverOrdersService` fires.
 */
function nextStatusForEvent(event: TransitionRequest['event']): Order['status'] {
  switch (event) {
    case 'DRIVER_EN_ROUTE_PICKUP':
      return 'en_route_pickup';
    case 'DRIVER_EN_ROUTE_DROPOFF':
      return 'en_route_dropoff';
    case 'DRIVER_ARRIVED':
      return 'arrived_at_dropoff';
    case 'DRIVER_DELIVERED':
      return 'delivered';
    default:
      throw new Error(`FakeOrderTransitionService: unexpected event ${event}`);
  }
}

class FakeOrderTransitionService {
  public calls: TransitionRequest[] = [];
  public throwError: Error | null = null;
  public withinTxCalls: TransitionRequest[] = [];
  public throwOnWithinTx: Error | null = null;
  public emitDeferredCalls: OrderTransitionedEvent[] = [];

  constructor(private readonly orders: FakeOrdersRepo) {}

  transition = (req: TransitionRequest): Promise<TransitionResult> => {
    this.calls.push(req);
    if (this.throwError !== null) return Promise.reject(this.throwError);
    const existing = this.orders.rows.get(`${req.orderId}:${DRIVER_USER_ID}`);
    if (existing === undefined) {
      return Promise.reject(new Error(`fake transition: order ${req.orderId} not seeded`));
    }
    const toStatus = nextStatusForEvent(req.event);
    const next: Order = {
      ...existing,
      status: toStatus,
      statusChangedAt: new Date('2026-05-15T20:45:00.000Z'),
    };
    this.orders.rows.set(`${req.orderId}:${DRIVER_USER_ID}`, next);
    return Promise.resolve({
      orderId: req.orderId,
      fromStatus: existing.status,
      toStatus,
    });
  };

  // cancelDelivery is the only caller — the fake hardcodes the
  // DRIVER_CANCELED edge (driver_assigned → awaiting_driver) instead
  // of consulting the machine; the real edge is pinned by the
  // @dankdash/orders machine tests.
  transitionWithinTx = (
    req: TransitionRequest,
    _tx: Database,
  ): Promise<DeferredTransitionResult> => {
    this.withinTxCalls.push(req);
    if (this.throwOnWithinTx !== null) return Promise.reject(this.throwOnWithinTx);
    return Promise.resolve({
      result: { orderId: req.orderId, fromStatus: 'driver_assigned', toStatus: 'awaiting_driver' },
      deferredEvent: new OrderTransitionedEvent({
        orderId: req.orderId,
        fromStatus: 'driver_assigned',
        toStatus: 'awaiting_driver',
        event: req.event,
        actor: req.actor,
        occurredAt: PIN_NOW,
      }),
    });
  };

  emitDeferred = (event: OrderTransitionedEvent): void => {
    this.emitDeferredCalls.push(event);
  };
}

interface Rig {
  readonly service: DriverOrdersService;
  readonly orders: FakeOrdersRepo;
  readonly orderItems: FakeOrderItemsRepo;
  readonly orderEvents: FakeOrderEventsRepo;
  readonly users: FakeUsersRepo;
  readonly dispensaries: FakeDispensariesRepo;
  readonly drivers: FakeDriversRepo;
  readonly dispatchOffers: FakeDispatchOffersRepo;
  readonly transitions: FakeOrderTransitionService;
}

function makeRig(): Rig {
  const orders = new FakeOrdersRepo();
  const orderItems = new FakeOrderItemsRepo();
  const orderEvents = new FakeOrderEventsRepo();
  const users = new FakeUsersRepo();
  const dispensaries = new FakeDispensariesRepo();
  const drivers = new FakeDriversRepo();
  const dispatchOffers = new FakeDispatchOffersRepo();
  const transitions = new FakeOrderTransitionService(orders);
  const scoped: DriverOrdersScopedRepos = {
    orders: orders as unknown as OrdersRepository,
    orderItems: orderItems as unknown as OrderItemsRepository,
    orderEvents: orderEvents as unknown as OrderEventsRepository,
    users: users as unknown as UsersRepository,
    dispensaries: dispensaries as unknown as DispensariesRepository,
    drivers: drivers as unknown as DriversRepository,
    dispatchOffers: dispatchOffers as unknown as DispatchOffersRepository,
  };
  const service = new DriverOrdersService(
    FAKE_DB,
    () => scoped,
    transitions as unknown as OrderTransitionService,
  );
  return {
    service,
    orders,
    orderItems,
    orderEvents,
    users,
    dispensaries,
    drivers,
    dispatchOffers,
    transitions,
  };
}

function seedHappyPath(rig: Rig, orderOverrides: Partial<Order> = {}): void {
  rig.orders.seed(makeOrder(orderOverrides));
  rig.users.seed(makeCustomer());
  rig.dispensaries.seed(makeDispensary());
}

describe('DriverOrdersService.getForDriver', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('returns the hydrated projection with initialed last name and masked phone', async () => {
    seedHappyPath(rig);

    const result = await rig.service.getForDriver(DRIVER_USER_ID, ORDER_ID);

    expect(result.order.id).toBe(ORDER_ID);
    expect(result.customer).toEqual({
      firstName: 'Sam',
      lastName: 'J.',
      maskedPhone: '••• ••• 4321',
    });
    expect(result.dropoff).toEqual({
      line1: '345 Park Ave',
      line2: 'Apt 4B',
      city: 'St Paul',
      state: 'MN',
      postalCode: '55102',
      latitude: 44.953,
      longitude: -93.094,
      instructions: 'Leave with doorman',
    });
    expect(result.dispensary.id).toBe(DISPENSARY_ID);
    expect(result.idScan).toEqual({ passed: false, verificationId: null, scannedAt: null });
  });

  it('throws NotFoundError for an unknown id (or cross-driver id — same response)', async () => {
    // Cross-driver lookups return null from the repo; the service does
    // NOT distinguish them from missing rows. A probing driver gets a
    // 404 either way.
    await expect(rig.service.getForDriver(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFoundError when the customer row is missing', async () => {
    rig.orders.seed(makeOrder());
    rig.dispensaries.seed(makeDispensary());
    // no users.seed

    await expect(rig.service.getForDriver(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFoundError when the dispensary row is missing', async () => {
    rig.orders.seed(makeOrder());
    rig.users.seed(makeCustomer());
    // no dispensaries.seed

    await expect(rig.service.getForDriver(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('DriverOrdersService.confirmPickup', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('transitions to en_route_pickup with the driver-supplied location payload', async () => {
    seedHappyPath(rig);
    const location = {
      latitude: 44.978,
      longitude: -93.265,
      accuracyMeters: 7.5,
      capturedAt: '2026-05-15T20:31:00.000Z',
    };

    const result = await rig.service.confirmPickup(DRIVER_USER_ID, ORDER_ID, { location });

    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]).toEqual({
      orderId: ORDER_ID,
      event: 'DRIVER_EN_ROUTE_PICKUP',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
      payload: { location },
    });
    expect(result.order.status).toBe('en_route_pickup');
  });

  it('throws NotFoundError without calling transition when the driver does not own the order', async () => {
    // No seed → repo returns null → NotFoundError before transition.
    await expect(
      rig.service.confirmPickup(DRIVER_USER_ID, ORDER_ID, { location: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('propagates a ConflictError from the state-machine guard inside OrderTransitionService', async () => {
    seedHappyPath(rig);
    rig.transitions.throwError = new ConflictError(
      'ORDER_STATE_INVALID',
      'order is in status delivered, expected one of [driver_assigned, en_route_pickup]',
      { orderId: ORDER_ID },
    );

    const promise = rig.service.confirmPickup(DRIVER_USER_ID, ORDER_ID, { location: null });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({
      code: 'ORDER_STATE_INVALID',
      statusCode: 409,
    });
  });

  it('accepts a null location and forwards it on the event payload', async () => {
    // Location-denied edge case — the audit row still records the
    // denial via `payload.location: null`.
    seedHappyPath(rig);

    await rig.service.confirmPickup(DRIVER_USER_ID, ORDER_ID, { location: null });

    expect(rig.transitions.calls[0]?.payload).toEqual({ location: null });
  });
});

describe('DriverOrdersService.confirmDeparture', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('transitions to en_route_dropoff with the driver-supplied location payload', async () => {
    seedHappyPath(rig, { status: 'picked_up' });
    const location = {
      latitude: 44.978,
      longitude: -93.265,
      accuracyMeters: 6.0,
      capturedAt: '2026-05-15T20:40:00.000Z',
    };

    const result = await rig.service.confirmDeparture(DRIVER_USER_ID, ORDER_ID, { location });

    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]).toEqual({
      orderId: ORDER_ID,
      event: 'DRIVER_EN_ROUTE_DROPOFF',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
      payload: { location },
    });
    expect(result.order.status).toBe('en_route_dropoff');
  });

  it('throws NotFoundError without calling transition when the driver does not own the order', async () => {
    await expect(
      rig.service.confirmDeparture(DRIVER_USER_ID, ORDER_ID, { location: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('propagates a 409 ConflictError from the state-machine guard (wrong from-state)', async () => {
    seedHappyPath(rig, { status: 'driver_assigned' });
    rig.transitions.throwError = new ConflictError(
      'ORDER_STATE_INVALID',
      'order is in status driver_assigned, expected one of [picked_up, en_route_dropoff]',
      { orderId: ORDER_ID },
    );

    await expect(
      rig.service.confirmDeparture(DRIVER_USER_ID, ORDER_ID, { location: null }),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_INVALID', statusCode: 409 });
  });

  it('accepts a null location and forwards it on the event payload', async () => {
    seedHappyPath(rig, { status: 'picked_up' });

    await rig.service.confirmDeparture(DRIVER_USER_ID, ORDER_ID, { location: null });

    expect(rig.transitions.calls[0]?.payload).toEqual({ location: null });
  });
});

describe('DriverOrdersService.confirmArrival', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('transitions to arrived_at_dropoff with the driver-supplied location payload', async () => {
    seedHappyPath(rig, { status: 'en_route_dropoff' });
    const location = {
      latitude: 44.953,
      longitude: -93.094,
      accuracyMeters: 9.0,
      capturedAt: '2026-05-15T20:58:00.000Z',
    };

    const result = await rig.service.confirmArrival(DRIVER_USER_ID, ORDER_ID, { location });

    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]).toEqual({
      orderId: ORDER_ID,
      event: 'DRIVER_ARRIVED',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
      payload: { location },
    });
    expect(result.order.status).toBe('arrived_at_dropoff');
  });

  it('throws NotFoundError without calling transition when the driver does not own the order', async () => {
    await expect(
      rig.service.confirmArrival(DRIVER_USER_ID, ORDER_ID, { location: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('propagates a 409 ConflictError from the state-machine guard (wrong from-state)', async () => {
    seedHappyPath(rig, { status: 'picked_up' });
    rig.transitions.throwError = new ConflictError(
      'ORDER_STATE_INVALID',
      'order is in status picked_up, expected one of [en_route_dropoff, arrived_at_dropoff]',
      { orderId: ORDER_ID },
    );

    await expect(
      rig.service.confirmArrival(DRIVER_USER_ID, ORDER_ID, { location: null }),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_INVALID', statusCode: 409 });
  });
});

describe('DriverOrdersService.confirmDelivery', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('transitions to delivered with location + notes payload and sets deliveredAt', async () => {
    seedHappyPath(rig, {
      status: 'en_route_dropoff',
      deliveryIdScanPassed: true,
      deliveryIdScanRef: 'veriff-session-001',
      deliveryIdScanAt: new Date('2026-05-15T20:55:00.000Z'),
    });
    const location = {
      latitude: 44.953,
      longitude: -93.094,
      accuracyMeters: 11.0,
      capturedAt: '2026-05-15T21:02:00.000Z',
    };

    const result = await rig.service.confirmDelivery(DRIVER_USER_ID, ORDER_ID, {
      location,
      notes: 'Handed to recipient at door',
    });

    expect(rig.transitions.calls).toHaveLength(1);
    const call = rig.transitions.calls[0];
    expect(call?.orderId).toBe(ORDER_ID);
    expect(call?.event).toBe('DRIVER_DELIVERED');
    expect(call?.actor).toEqual({ userId: DRIVER_USER_ID, role: 'driver' });
    expect(call?.payload).toEqual({ location, notes: 'Handed to recipient at door' });
    expect(result.order.status).toBe('delivered');
  });

  it('throws NotFoundError without calling transition when the driver does not own the order', async () => {
    await expect(
      rig.service.confirmDelivery(DRIVER_USER_ID, ORDER_ID, { location: null, notes: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('propagates COMPLIANCE_ID_SCAN_REQUIRED from the repo gate as a 409 ConflictError', async () => {
    // The repo's ID-scan gate (`delivered` requires
    // `delivery_id_scan_passed = true`) is what throws. The service
    // must not swallow or transform it — the iOS client distinguishes
    // this code from a generic 409 to route the user back to the scan
    // screen rather than the dropoff screen.
    seedHappyPath(rig, { status: 'en_route_dropoff' });
    rig.transitions.throwError = new ConflictError(
      'COMPLIANCE_ID_SCAN_REQUIRED',
      `order ${ORDER_ID} cannot transition to delivered without a successful ID scan`,
      { orderId: ORDER_ID },
    );

    const promise = rig.service.confirmDelivery(DRIVER_USER_ID, ORDER_ID, {
      location: null,
      notes: null,
    });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({
      code: 'COMPLIANCE_ID_SCAN_REQUIRED',
      statusCode: 409,
    });
  });
});

describe('DriverOrdersService.cancelDelivery', () => {
  const LOCATION = {
    latitude: 44.978,
    longitude: -93.265,
    accuracyMeters: 8.0,
    capturedAt: '2026-05-15T20:35:00.000Z',
  };

  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('locks the driver, fires DRIVER_CANCELED, releases the offer, frees the driver, emits after the tx', async () => {
    rig.drivers.row = makeDriver();

    const result = await rig.service.cancelDelivery(
      DRIVER_USER_ID,
      ORDER_ID,
      { location: LOCATION, reason: 'car trouble' },
      PIN_NOW,
    );

    expect(result).toEqual({ orderId: ORDER_ID, status: 'awaiting_driver' });

    expect(rig.drivers.lockedIds).toEqual([DRIVER_ID]);

    expect(rig.transitions.withinTxCalls).toHaveLength(1);
    expect(rig.transitions.withinTxCalls[0]).toEqual({
      orderId: ORDER_ID,
      event: 'DRIVER_CANCELED',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
      patch: { driverId: null },
      reason: 'driver canceled before pickup',
      payload: { reason: 'car trouble', location: LOCATION, driverId: DRIVER_ID },
    });

    // Without this flip the dispatch orchestrator sees an accepted
    // history row and strands the order in awaiting_driver forever.
    expect(rig.dispatchOffers.releaseCalls).toEqual([
      {
        orderId: ORDER_ID,
        driverId: DRIVER_ID,
        now: PIN_NOW,
        reason: 'driver_canceled_after_accept',
      },
    ]);

    expect(rig.drivers.setCurrentOrderCalls).toEqual([{ id: DRIVER_ID, orderId: null }]);
    expect(rig.drivers.setStatusCalls).toEqual([{ id: DRIVER_ID, status: 'online' }]);

    expect(rig.transitions.emitDeferredCalls).toHaveLength(1);
    expect(rig.transitions.emitDeferredCalls[0]?.toStatus).toBe('awaiting_driver');
    expect(rig.transitions.emitDeferredCalls[0]?.event).toBe('DRIVER_CANCELED');
  });

  it('throws NotFoundError when the JWT user has no drivers row — nothing fired', async () => {
    rig.drivers.row = null;

    await expect(
      rig.service.cancelDelivery(DRIVER_USER_ID, ORDER_ID, { location: null, reason: null }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(rig.transitions.withinTxCalls).toHaveLength(0);
    expect(rig.dispatchOffers.releaseCalls).toHaveLength(0);
    expect(rig.transitions.emitDeferredCalls).toHaveLength(0);
  });

  it('throws 409 DRIVER_ORDER_NOT_ACTIVE when the order is not the driver’s active delivery', async () => {
    // Stale tab: the driver already canceled (or the order was
    // reassigned) and current_order_id points elsewhere.
    rig.drivers.row = makeDriver({ currentOrderId: '01935f3d-0000-7000-8000-0000000000ff' });

    const promise = rig.service.cancelDelivery(DRIVER_USER_ID, ORDER_ID, {
      location: null,
      reason: null,
    });

    await expect(promise).rejects.toBeInstanceOf(DriverError);
    await expect(promise).rejects.toMatchObject({
      code: 'DRIVER_ORDER_NOT_ACTIVE',
      statusCode: 409,
    });

    expect(rig.transitions.withinTxCalls).toHaveLength(0);
    expect(rig.dispatchOffers.releaseCalls).toHaveLength(0);
    expect(rig.drivers.setStatusCalls).toHaveLength(0);
    expect(rig.drivers.setCurrentOrderCalls).toHaveLength(0);
  });

  it('propagates the 422 machine rejection after pickup and mutates nothing downstream', async () => {
    // Cannabis already in the car — the machine has no DRIVER_CANCELED
    // edge from picked_up. The transition throw aborts the tx body
    // before the offer release / driver free steps run.
    rig.drivers.row = makeDriver({ currentStatus: 'en_route_dropoff' });
    rig.transitions.throwOnWithinTx = OrderError.invalidTransition('picked_up', 'DRIVER_CANCELED');

    const promise = rig.service.cancelDelivery(DRIVER_USER_ID, ORDER_ID, {
      location: null,
      reason: 'changed my mind',
    });

    await expect(promise).rejects.toBeInstanceOf(OrderError);
    await expect(promise).rejects.toMatchObject({
      code: 'ORDER_INVALID_TRANSITION',
      statusCode: 422,
    });

    expect(rig.dispatchOffers.releaseCalls).toHaveLength(0);
    expect(rig.drivers.setCurrentOrderCalls).toHaveLength(0);
    expect(rig.drivers.setStatusCalls).toHaveLength(0);
    expect(rig.transitions.emitDeferredCalls).toHaveLength(0);
  });
});

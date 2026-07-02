/**
 * Unit tests for OrdersService — the read/projection + rating-write surface.
 * Status transitions live in OrderTransitionService and are tested there;
 * this file proves cross-tenant scoping (404 not 403 on a mismatch), the
 * `delivered`/`disputed` guard on recordRating, and the rating field patch
 * thread-through.
 */
import {
  type Database,
  type Dispensary,
  type DispensariesRepository,
  type Driver,
  type DriversRepository,
  type NewOrder,
  type Order,
  type OrderEvent,
  type OrderEventsRepository,
  type OrderItem,
  type OrderItemsRepository,
  type OrdersRepository,
  type OrderStatus,
  type User,
  type UsersRepository,
  type VendorQueueOrderRow,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrdersService,
  type OrdersScopedRepos,
  type OrdersScopedReposFactory,
} from './orders.service.js';
import { decodeOrderCursor } from './order-cursor.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000fe';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';
const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000201';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000202';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000150';
const ITEM_ID = '01935f3d-0000-7000-8000-000000000160';
const EVENT_ID = '01935f3d-0000-7000-8000-000000000170';

const PINNED_NOW = new Date('2026-05-18T19:00:00.000Z');

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
    shortCode: '7K2X4Q',
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-000000000060',
    status: 'placed',
    statusChangedAt: PINNED_NOW,
    subtotalCents: 9000,
    cannabisTaxCents: 900,
    salesTaxCents: 619,
    deliveryFeeCents: 0,
    driverTipCents: 500,
    discountCents: 0,
    totalCents: 11019,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: PINNED_NOW,
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
    createdAt: PINNED_NOW,
    updatedAt: PINNED_NOW,
    ...overrides,
  };
}

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
    aeropayAccountRef: null,
    currentStatus: 'en_route_dropoff',
    lastStatusChangeAt: PINNED_NOW,
    currentLocation: { type: 'Point', coordinates: [-93.2, 44.96] },
    currentLocationUpdatedAt: PINNED_NOW,
    currentOrderId: ORDER_ID,
    ratingAvg: '4.90',
    ratingCount: 42,
    totalDeliveries: 128,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: PINNED_NOW,
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
    createdAt: PINNED_NOW,
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
    occurredAt: PINNED_NOW,
    ...overrides,
  };
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

class FakeDriversRepo implements Pick<DriversRepository, 'findByUserId'> {
  public rows = new Map<string, Driver>();
  seed(row: Driver): void {
    this.rows.set(row.userId, row);
  }
  findByUserId(userId: string): Promise<Driver | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }
}

class FakeOrdersRepo implements Pick<
  OrdersRepository,
  | 'findById'
  | 'listForUser'
  | 'listForUserCursored'
  | 'listForDispensary'
  | 'listForDispensaryQueue'
  | 'update'
> {
  public readonly rows = new Map<string, Order>();
  /** Last patch the service passed to `update` — assertions sample this
   *  instead of fishing through the row map. */
  public lastUpdatePatch: Partial<NewOrder> | null = null;
  /** When set, `update` returns null instead of mutating the row — lets
   *  us exercise the invariant-violation branch in recordRating. */
  public updateReturnsNull = false;
  /** Synthetic name + item-count enrichment keyed by order id; service
   *  tests sample the join via `listForDispensaryQueue`. */
  public readonly enrichment = new Map<
    string,
    { firstName: string | null; lastName: string | null; itemCount: number }
  >();
  /** Records every call's arguments so tests can assert the service
   *  passes the filter set through unchanged. */
  public lastQueueCall: {
    dispensaryId: string;
    statuses: readonly OrderStatus[];
    limit: number;
  } | null = null;

  constructor(initial: Order[] = []) {
    for (const r of initial) this.rows.set(r.id, r);
  }

  findById(id: string): Promise<Order | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listForUser(userId: string, _limit = 50): Promise<readonly Order[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.userId === userId));
  }

  /** Mirrors the real repo: lifecycle filter, `(placedAt DESC, id DESC)`
   *  keyset, and the `limit + 1` over-fetch — so the service's hasMore /
   *  slice / nextCursor logic is exercised against true pagination. */
  listForUserCursored(input: {
    readonly userId: string;
    readonly limit: number;
    readonly statusFilter: 'active' | 'completed' | 'all';
    readonly cursor: { readonly placedAt: Date; readonly id: string } | null;
  }): Promise<readonly Order[]> {
    const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
      'delivered',
      'canceled',
      'rejected',
      'returned_to_store',
      'disputed',
      'id_scan_failed',
      'payment_failed',
    ]);
    const matched = [...this.rows.values()]
      .filter((r) => r.userId === input.userId)
      .filter((r) =>
        input.statusFilter === 'all'
          ? true
          : input.statusFilter === 'completed'
            ? TERMINAL.has(r.status)
            : !TERMINAL.has(r.status),
      )
      .filter((r) => {
        const c = input.cursor;
        if (c === null) return true;
        return (
          r.placedAt.getTime() < c.placedAt.getTime() ||
          (r.placedAt.getTime() === c.placedAt.getTime() && r.id < c.id)
        );
      })
      .sort((a, b) => {
        const byTime = b.placedAt.getTime() - a.placedAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      })
      .slice(0, input.limit + 1);
    return Promise.resolve(matched);
  }

  listForDispensary(dispensaryId: string): Promise<readonly Order[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.dispensaryId === dispensaryId));
  }

  listForDispensaryQueue(
    dispensaryId: string,
    statuses: readonly OrderStatus[],
    limit: number,
  ): Promise<readonly VendorQueueOrderRow[]> {
    this.lastQueueCall = { dispensaryId, statuses, limit };
    if (statuses.length === 0) return Promise.resolve([]);
    const statusSet = new Set<OrderStatus>(statuses);
    const matches = [...this.rows.values()]
      .filter((r) => r.dispensaryId === dispensaryId && statusSet.has(r.status))
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())
      .slice(0, limit);
    return Promise.resolve(
      matches.map((row) => {
        const enrich = this.enrichment.get(row.id) ?? {
          firstName: null,
          lastName: null,
          itemCount: 0,
        };
        return {
          ...row,
          customerFirstName: enrich.firstName,
          customerLastName: enrich.lastName,
          itemCount: enrich.itemCount,
        };
      }),
    );
  }

  update(id: string, patch: Partial<NewOrder>): Promise<Order | null> {
    this.lastUpdatePatch = patch;
    if (this.updateReturnsNull) return Promise.resolve(null);
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    const updated = { ...row, ...patch, updatedAt: new Date() } as Order;
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

function makeStubDb(): Database {
  return {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;
}

interface ServiceRig {
  readonly service: OrdersService;
  readonly repo: FakeOrdersRepo;
  readonly items: FakeOrderItemsRepo;
  readonly events: FakeOrderEventsRepo;
  readonly users: FakeUsersRepo;
  readonly dispensaries: FakeDispensariesRepo;
  readonly drivers: FakeDriversRepo;
}

function makeService(initial: Order[] = []): ServiceRig {
  const repo = new FakeOrdersRepo(initial);
  const items = new FakeOrderItemsRepo();
  const events = new FakeOrderEventsRepo();
  const users = new FakeUsersRepo();
  const dispensaries = new FakeDispensariesRepo();
  const drivers = new FakeDriversRepo();
  const scoped: OrdersScopedRepos = {
    orders: repo as unknown as OrdersRepository,
    orderItems: items as unknown as OrderItemsRepository,
    orderEvents: events as unknown as OrderEventsRepository,
    users: users as unknown as UsersRepository,
    dispensaries: dispensaries as unknown as DispensariesRepository,
    drivers: drivers as unknown as DriversRepository,
  };
  const reposFactory: OrdersScopedReposFactory = (): OrdersScopedRepos => scoped;
  return {
    service: new OrdersService(makeStubDb(), reposFactory),
    repo,
    items,
    events,
    users,
    dispensaries,
    drivers,
  };
}

describe('OrdersService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });

  describe('listForUser', () => {
    it('returns only orders owned by the user', async () => {
      const mine = makeOrder({ id: ORDER_ID, userId: USER_ID });
      const someone_elses = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001fff',
        userId: OTHER_USER_ID,
      });
      const { service } = makeService([mine, someone_elses]);

      const rows = await service.listForUser(USER_ID, 50);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(ORDER_ID);
    });
  });

  describe('listPageForUser', () => {
    const idAt = (n: number): string => `01935f3d-0000-7000-8000-0000000010${`0${n}`.slice(-2)}`;
    // Five orders for the user, strictly decreasing placedAt so the
    // (placedAt DESC) order is unambiguous: idAt(1) newest … idAt(5) oldest.
    const ladder = (): Order[] =>
      [1, 2, 3, 4, 5].map((n) =>
        makeOrder({
          id: idAt(n),
          status: n % 2 === 0 ? 'delivered' : 'placed',
          placedAt: new Date(PINNED_NOW.getTime() - n * 60_000),
          statusChangedAt: new Date(PINNED_NOW.getTime() - n * 60_000),
        }),
      );

    it('returns the first page newest-first with a nextCursor when more rows remain', async () => {
      const { service } = makeService(ladder());

      const page = await service.listPageForUser(USER_ID, {
        status: 'all',
        limit: 2,
        cursor: undefined,
      });

      expect(page.items.map((o) => o.id)).toEqual([idAt(1), idAt(2)]);
      expect(page.nextCursor).not.toBeNull();
    });

    it('resumes after the cursor and returns null nextCursor on the final page', async () => {
      const { service } = makeService(ladder());

      const first = await service.listPageForUser(USER_ID, {
        status: 'all',
        limit: 2,
        cursor: undefined,
      });
      const decoded = decodeOrderCursor(first.nextCursor!)!;
      const second = await service.listPageForUser(USER_ID, {
        status: 'all',
        limit: 2,
        cursor: decoded,
      });
      const third = await service.listPageForUser(USER_ID, {
        status: 'all',
        limit: 2,
        cursor: decodeOrderCursor(second.nextCursor!)!,
      });

      expect(second.items.map((o) => o.id)).toEqual([idAt(3), idAt(4)]);
      expect(third.items.map((o) => o.id)).toEqual([idAt(5)]);
      expect(third.nextCursor).toBeNull();
    });

    it('filters to active (non-terminal) orders only', async () => {
      const { service } = makeService(ladder());

      const page = await service.listPageForUser(USER_ID, {
        status: 'active',
        limit: 50,
        cursor: undefined,
      });

      // placed = active; delivered = terminal. idAt(1,3,5) are placed.
      expect(page.items.map((o) => o.id)).toEqual([idAt(1), idAt(3), idAt(5)]);
      expect(page.nextCursor).toBeNull();
    });

    it('filters to completed (terminal) orders only', async () => {
      const { service } = makeService(ladder());

      const page = await service.listPageForUser(USER_ID, {
        status: 'completed',
        limit: 50,
        cursor: undefined,
      });

      expect(page.items.map((o) => o.id)).toEqual([idAt(2), idAt(4)]);
      expect(page.nextCursor).toBeNull();
    });

    it('scopes to the JWT user — another user’s orders never appear', async () => {
      const mine = makeOrder({ id: ORDER_ID, userId: USER_ID });
      const theirs = makeOrder({ id: idAt(9), userId: OTHER_USER_ID });
      const { service } = makeService([mine, theirs]);

      const page = await service.listPageForUser(USER_ID, {
        status: 'all',
        limit: 50,
        cursor: undefined,
      });

      expect(page.items.map((o) => o.id)).toEqual([ORDER_ID]);
    });
  });

  describe('findForUser', () => {
    it('returns the order when the JWT user owns it', async () => {
      const { service } = makeService([makeOrder()]);

      const r = await service.findForUser(USER_ID, ORDER_ID);

      expect(r.id).toBe(ORDER_ID);
    });

    it('surfaces 404 ORDER_NOT_FOUND when the order belongs to another user (no leak)', async () => {
      const { service } = makeService([makeOrder({ userId: OTHER_USER_ID })]);

      await expect(service.findForUser(USER_ID, ORDER_ID)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('surfaces 404 ORDER_NOT_FOUND when the order does not exist', async () => {
      const { service } = makeService([]);

      await expect(service.findForUser(USER_ID, ORDER_ID)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('listForDispensary', () => {
    it('returns only orders for the queried dispensary', async () => {
      const mine = makeOrder({ id: ORDER_ID, dispensaryId: DISPENSARY_ID });
      const not_mine = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001fff',
        dispensaryId: OTHER_DISPENSARY_ID,
      });
      const { service } = makeService([mine, not_mine]);

      const rows = await service.listForDispensary(DISPENSARY_ID, undefined, 50);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dispensaryId).toBe(DISPENSARY_ID);
    });
  });

  describe('findForDispensary', () => {
    it('returns the order when the dispensary owns it', async () => {
      const { service } = makeService([makeOrder()]);

      const r = await service.findForDispensary(DISPENSARY_ID, ORDER_ID);
      expect(r.id).toBe(ORDER_ID);
    });

    it('surfaces 404 when the order belongs to a different dispensary', async () => {
      const { service } = makeService([makeOrder({ dispensaryId: OTHER_DISPENSARY_ID })]);

      await expect(service.findForDispensary(DISPENSARY_ID, ORDER_ID)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('listForDispensaryQueue', () => {
    it('returns the enriched rows for the dispensary, oldest-first', async () => {
      const newer = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001a01',
        placedAt: new Date('2026-05-18T20:00:00.000Z'),
        status: 'placed',
      });
      const older = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001a02',
        placedAt: new Date('2026-05-18T18:00:00.000Z'),
        status: 'accepted',
      });
      const { service, repo } = makeService([newer, older]);
      repo.enrichment.set(newer.id, { firstName: 'Ada', lastName: 'Lovelace', itemCount: 2 });
      repo.enrichment.set(older.id, { firstName: 'Linus', lastName: 'Torvalds', itemCount: 4 });

      const rows = await service.listForDispensaryQueue(DISPENSARY_ID, ['placed', 'accepted'], 100);

      expect(rows.map((r) => r.id)).toEqual([older.id, newer.id]);
      expect(rows[0]!.customerFirstName).toBe('Linus');
      expect(rows[0]!.itemCount).toBe(4);
    });

    it('forwards the filter set + limit to the repo', async () => {
      const { service, repo } = makeService([]);

      await service.listForDispensaryQueue(DISPENSARY_ID, ['prepping'], 50);

      expect(repo.lastQueueCall).toEqual({
        dispensaryId: DISPENSARY_ID,
        statuses: ['prepping'],
        limit: 50,
      });
    });

    it('filters out orders belonging to other dispensaries', async () => {
      const mine = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001a03',
        status: 'placed',
      });
      const theirs = makeOrder({
        id: '01935f3d-0000-7000-8000-000000001a04',
        dispensaryId: OTHER_DISPENSARY_ID,
        status: 'placed',
      });
      const { service } = makeService([mine, theirs]);

      const rows = await service.listForDispensaryQueue(DISPENSARY_ID, ['placed'], 100);

      expect(rows.map((r) => r.id)).toEqual([mine.id]);
    });

    it('returns an empty list when statuses is empty (degenerate IN ())', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      const rows = await service.listForDispensaryQueue(DISPENSARY_ID, [], 100);
      expect(rows).toEqual([]);
    });
  });

  describe('recordRating', () => {
    it('writes rating + review + ratedAt for a delivered order', async () => {
      const { service, repo } = makeService([makeOrder({ status: 'delivered' })]);

      const updated = await service.recordRating(USER_ID, ORDER_ID, {
        rating: 5,
        review: 'fast & polite',
        driverRating: 5,
        dispensaryRating: 4,
      });

      expect(updated.customerRating).toBe(5);
      expect(updated.customerReview).toBe('fast & polite');
      expect(updated.driverRating).toBe(5);
      expect(updated.dispensaryRating).toBe(4);
      expect(updated.ratedAt).toEqual(PINNED_NOW);

      expect(repo.lastUpdatePatch).toEqual({
        ratedAt: PINNED_NOW,
        customerRating: 5,
        customerReview: 'fast & polite',
        driverRating: 5,
        dispensaryRating: 4,
      });
    });

    it('accepts a partial rating (only one field supplied)', async () => {
      const { service, repo } = makeService([makeOrder({ status: 'delivered' })]);

      await service.recordRating(USER_ID, ORDER_ID, { rating: 3 });

      expect(repo.lastUpdatePatch).toEqual({ ratedAt: PINNED_NOW, customerRating: 3 });
    });

    it('also allows rating on a `disputed` order (customer may rate before/after opening dispute)', async () => {
      const { service } = makeService([makeOrder({ status: 'disputed' })]);

      const updated = await service.recordRating(USER_ID, ORDER_ID, { rating: 2 });
      expect(updated.customerRating).toBe(2);
    });

    it('refuses to rate a non-delivered order with 422 ORDER_RATE_NOT_DELIVERED', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      await expect(service.recordRating(USER_ID, ORDER_ID, { rating: 5 })).rejects.toMatchObject({
        code: 'ORDER_RATE_NOT_DELIVERED',
        statusCode: 422,
      });
    });

    it('refuses to rate someone else’s order with 404 (no leak)', async () => {
      const { service } = makeService([makeOrder({ userId: OTHER_USER_ID, status: 'delivered' })]);

      await expect(service.recordRating(USER_ID, ORDER_ID, { rating: 5 })).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });

    it('rejects with 404 when the order was found in findById but the UPDATE returned no row (invariant)', async () => {
      const { service, repo } = makeService([makeOrder({ status: 'delivered' })]);
      repo.updateReturnsNull = true;

      await expect(service.recordRating(USER_ID, ORDER_ID, { rating: 5 })).rejects.toBeInstanceOf(
        OrderError,
      );
    });
  });

  describe('getDetailForUser', () => {
    function seedDetail(rig: ServiceRig, orderOverrides: Partial<Order> = {}): void {
      rig.repo.rows.set(
        ORDER_ID,
        makeOrder({ deliveryAddressSnapshot: SAMPLE_SNAPSHOT, ...orderOverrides }),
      );
      rig.dispensaries.seed(makeDispensary());
      rig.items.rows = [makeOrderItem()];
      rig.events.rows = [makeOrderEvent()];
    }

    it('returns the flat order, events, dispensary + dropoff pins, and a null driver when none is assigned', async () => {
      const rig = makeService();
      seedDetail(rig, { driverId: null, status: 'prepping' });

      const detail = await rig.service.getDetailForUser(USER_ID, ORDER_ID);

      expect(detail.order.id).toBe(ORDER_ID);
      expect(detail.order.status).toBe('prepping');
      expect(detail.order.items).toHaveLength(1);
      expect(detail.events).toHaveLength(1);
      expect(detail.driver).toBeNull();
      expect(detail.dispensary).toEqual({
        id: DISPENSARY_ID,
        name: 'TC Cannabis',
        latitude: 44.978,
        longitude: -93.265,
      });
      expect(detail.dropoff).toEqual({
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

    it('resolves the privacy-minimal driver card once a driver is assigned', async () => {
      const rig = makeService();
      seedDetail(rig, { driverId: DRIVER_USER_ID, status: 'en_route_dropoff' });
      rig.users.seed(makeDriverUser());
      rig.drivers.seed(makeDriver());

      const detail = await rig.service.getDetailForUser(USER_ID, ORDER_ID);

      expect(detail.driver).toEqual({
        id: DRIVER_ID,
        displayName: 'Sam J.',
        avatarKey: null,
        vehicleSummary: 'Silver 2021 Toyota Prius',
        maskedPhone: '••• ••• 4321',
      });
    });

    it('returns a null driver when the driver user row has vanished', async () => {
      const rig = makeService();
      seedDetail(rig, { driverId: DRIVER_USER_ID });
      // users not seeded → loadDriverProfile returns null
      rig.drivers.seed(makeDriver());

      const detail = await rig.service.getDetailForUser(USER_ID, ORDER_ID);

      expect(detail.driver).toBeNull();
    });

    it('surfaces 404 when the order belongs to another user (no leak)', async () => {
      const rig = makeService();
      seedDetail(rig, { userId: OTHER_USER_ID });

      await expect(rig.service.getDetailForUser(USER_ID, ORDER_ID)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('surfaces 404 when the dispensary row is missing (no partial projection)', async () => {
      const rig = makeService();
      rig.repo.rows.set(ORDER_ID, makeOrder({ deliveryAddressSnapshot: SAMPLE_SNAPSHOT }));
      rig.items.rows = [makeOrderItem()];
      rig.events.rows = [makeOrderEvent()];
      // dispensary not seeded

      await expect(rig.service.getDetailForUser(USER_ID, ORDER_ID)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  describe('rateForUser', () => {
    it('records the rating and returns the flat order projection with items + ratedAt stamped', async () => {
      const rig = makeService();
      rig.repo.rows.set(ORDER_ID, makeOrder({ status: 'delivered' }));
      rig.items.rows = [makeOrderItem()];

      const order = await rig.service.rateForUser(USER_ID, ORDER_ID, {
        rating: 5,
        review: 'great',
      });

      expect(order.id).toBe(ORDER_ID);
      expect(order.status).toBe('delivered');
      expect(order.items).toHaveLength(1);
      expect(rig.repo.lastUpdatePatch).toEqual({
        ratedAt: PINNED_NOW,
        customerRating: 5,
        customerReview: 'great',
      });
    });

    it('surfaces 404 for another user’s order without recording a rating', async () => {
      const rig = makeService();
      rig.repo.rows.set(ORDER_ID, makeOrder({ userId: OTHER_USER_ID, status: 'delivered' }));

      await expect(rig.service.rateForUser(USER_ID, ORDER_ID, { rating: 5 })).rejects.toMatchObject(
        { code: 'ORDER_NOT_FOUND' },
      );
      expect(rig.repo.lastUpdatePatch).toBeNull();
    });
  });
});

/**
 * Unit tests for DriverAppService.
 *
 * What's pinned here:
 *   currentRoute()
 *     1. No active order → { activeOrder: null }, no further reads.
 *     2. Active order → reads order, dispensary, returns full route.
 *     3. Driver row missing → DRIVER_NOT_FOUND (403).
 *     4. Driver points at a missing order → RepositoryError (500).
 *     5. Order points at a missing dispensary → RepositoryError (500).
 *   earnings()
 *     1. `today` bucket — half-open local-day window in America/Chicago.
 *        DST spring-forward and fall-back days are explicit edge cases
 *        because UTC offset shifts mid-bucket.
 *     2. `week` and `month` bucket bounds resolve to ISO-week-start
 *        Monday and 1st-of-month local respectively.
 *     3. totalCents = tipsCents + deliveryFeesCents (deliveriesCount is
 *        a count, not a money column).
 *   shifts()
 *     1. Forwards listForDriver, projects each row.
 *
 * The rig fakes the four repositories with in-memory state. All methods
 * read-only — no transactions, no row locks, so the fakes are simple
 * stubs without per-row mutexes.
 */
import {
  type Database,
  type Dispensary,
  type DispensariesRepository,
  type Driver,
  type DriverShift,
  type DriverShiftsRepository,
  type DriversRepository,
  type Order,
  type OrdersRepository,
} from '@dankdash/db';
import { RepositoryError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { DriverAppService, __bucketBounds } from './driver-app.service.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type { DriverError } from '@dankdash/types';

const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000b1';

const ISO = (s: string) => new Date(s);

function makeContext(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    driverId: DRIVER_ID,
    userId: USER_ID,
    currentStatus: 'online',
    currentOrderId: null,
    ...overrides,
  };
}

function makeDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: DRIVER_ID,
    userId: USER_ID,
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
    currentStatus: 'online',
    lastStatusChangeAt: ISO('2026-05-19T14:00:00.000Z'),
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: null,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: ISO('2026-01-01T00:00:00.000Z'),
    updatedAt: ISO('2026-05-19T14:00:00.000Z'),
    ...overrides,
  };
}

const SNAPSHOT = {
  id: '01935f3d-0000-7000-8000-0000000000b1',
  label: 'Home',
  line1: '500 S 5th St',
  line2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55415',
  country: 'US',
  location: { type: 'Point' as const, coordinates: [-93.262, 44.974] as const },
  deliveryInstructions: null,
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'A1B2C3',
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    driverId: DRIVER_ID,
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
    complianceCheckPayload: {},
    deliveryAddressSnapshot: SNAPSHOT,
    placedAt: ISO('2026-05-19T14:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: ISO('2026-05-19T14:05:00.000Z'),
    rejectedAt: null,
    preppingAt: null,
    preparedAt: null,
    awaitingDriverAt: null,
    dispatchFailedAt: null,
    driverAssignedAt: null,
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
    ...overrides,
  };
}

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  return {
    id: DISPENSARY_ID,
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
    ...overrides,
  };
}

class FakeDriversRepo implements Pick<DriversRepository, 'findById'> {
  public row: Driver | null = null;
  public findByIdCalls: string[] = [];

  findById(id: string): Promise<Driver | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.row);
  }
}

class FakeOrdersRepo implements Pick<OrdersRepository, 'findById' | 'sumDriverEarningsBetween'> {
  public order: Order | null = null;
  public findByIdCalls: string[] = [];
  public earningsCalls: { driverId: string; since: Date; until: Date }[] = [];
  public earnings: { tipsCents: number; deliveryFeesCents: number; deliveriesCount: number } = {
    tipsCents: 0,
    deliveryFeesCents: 0,
    deliveriesCount: 0,
  };

  findById(id: string): Promise<Order | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.order);
  }

  sumDriverEarningsBetween(
    driverId: string,
    since: Date,
    until: Date,
  ): Promise<{
    readonly tipsCents: number;
    readonly deliveryFeesCents: number;
    readonly deliveriesCount: number;
  }> {
    this.earningsCalls.push({ driverId, since, until });
    return Promise.resolve(this.earnings);
  }
}

class FakeDispensariesRepo implements Pick<DispensariesRepository, 'findById'> {
  public row: Dispensary | null = null;
  public findByIdCalls: string[] = [];

  findById(id: string): Promise<Dispensary | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.row);
  }
}

class FakeDriverShiftsRepo implements Pick<DriverShiftsRepository, 'listForDriver'> {
  public shifts: readonly DriverShift[] = [];
  public listCalls: string[] = [];

  listForDriver(driverId: string): Promise<readonly DriverShift[]> {
    this.listCalls.push(driverId);
    return Promise.resolve(this.shifts);
  }
}

interface Rig {
  service: DriverAppService;
  drivers: FakeDriversRepo;
  orders: FakeOrdersRepo;
  dispensaries: FakeDispensariesRepo;
  shifts: FakeDriverShiftsRepo;
}

function setup(): Rig {
  const drivers = new FakeDriversRepo();
  const orders = new FakeOrdersRepo();
  const dispensaries = new FakeDispensariesRepo();
  const shifts = new FakeDriverShiftsRepo();
  const service = new DriverAppService(
    drivers as unknown as DriversRepository,
    orders as unknown as OrdersRepository,
    dispensaries as unknown as DispensariesRepository,
    shifts as unknown as DriverShiftsRepository,
  );
  return { service, drivers, orders, dispensaries, shifts };
}

describe('DriverAppService.currentRoute', () => {
  it('returns activeOrder = null when the driver has no current order', async () => {
    const { service, drivers, orders, dispensaries } = setup();
    drivers.row = makeDriver({ currentOrderId: null });

    const route = await service.currentRoute(makeContext());

    expect(route).toEqual({ activeOrder: null });
    expect(orders.findByIdCalls).toEqual([]);
    expect(dispensaries.findByIdCalls).toEqual([]);
  });

  it('returns a populated route when the driver has a current order', async () => {
    const { service, drivers, orders, dispensaries } = setup();
    drivers.row = makeDriver({ currentOrderId: ORDER_ID });
    orders.order = makeOrder();
    dispensaries.row = makeDispensary();

    const route = await service.currentRoute(makeContext());

    expect(orders.findByIdCalls).toEqual([ORDER_ID]);
    expect(dispensaries.findByIdCalls).toEqual([DISPENSARY_ID]);
    expect(route.activeOrder).not.toBeNull();
    if (route.activeOrder === null) return;
    expect(route.activeOrder.order.id).toBe(ORDER_ID);
    expect(route.activeOrder.pickup.dispensaryId).toBe(DISPENSARY_ID);
    expect(route.activeOrder.dropoff.line1).toBe('500 S 5th St');
  });

  it('throws DRIVER_NOT_FOUND when the driver row vanished', async () => {
    const { service, drivers } = setup();
    drivers.row = null;

    await expect(service.currentRoute(makeContext())).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
  });

  it('throws RepositoryError when current_order_id points at a missing order', async () => {
    const { service, drivers, orders } = setup();
    drivers.row = makeDriver({ currentOrderId: ORDER_ID });
    orders.order = null;

    await expect(service.currentRoute(makeContext())).rejects.toBeInstanceOf(RepositoryError);
  });

  it('throws RepositoryError when the order points at a missing dispensary', async () => {
    const { service, drivers, orders, dispensaries } = setup();
    drivers.row = makeDriver({ currentOrderId: ORDER_ID });
    orders.order = makeOrder();
    dispensaries.row = null;

    await expect(service.currentRoute(makeContext())).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('DriverAppService.earnings', () => {
  // 2026-05-19 is a Tuesday — convenient because the ISO week starts the
  // day before (Monday 2026-05-18 00:00 local). `now` at 19:30 UTC is
  // 14:30 CDT (CDT is UTC-5), so the today bucket starts at 05:00 UTC
  // (the previous local midnight) and ends at 05:00 UTC next day.
  const NOW = new Date('2026-05-19T19:30:00.000Z');

  it('forwards today bucket bounds and returns tips + fees + count + total', async () => {
    const { service, orders } = setup();
    orders.earnings = { tipsCents: 1500, deliveryFeesCents: 4000, deliveriesCount: 5 };

    const res = await service.earnings(makeContext(), { period: 'today' }, NOW);

    expect(orders.earningsCalls).toHaveLength(1);
    const call = orders.earningsCalls[0];
    if (call === undefined) throw new TypeError('expected earnings call');
    expect(call.driverId).toBe(DRIVER_ID);
    expect(call.since.toISOString()).toBe('2026-05-19T05:00:00.000Z');
    expect(call.until.toISOString()).toBe('2026-05-20T05:00:00.000Z');
    expect(res).toEqual({
      period: 'today',
      since: '2026-05-19T05:00:00.000Z',
      until: '2026-05-20T05:00:00.000Z',
      tipsCents: 1500,
      deliveryFeesCents: 4000,
      deliveriesCount: 5,
      totalCents: 5500,
    });
  });

  it('week bucket resolves to ISO-week-start Monday in America/Chicago', async () => {
    const { service } = setup();

    const res = await service.earnings(makeContext(), { period: 'week' }, NOW);

    // Tuesday 2026-05-19 → ISO week starts Mon 2026-05-18 00:00 local
    // (05:00 UTC during CDT) and ends Mon 2026-05-25 00:00 local.
    expect(res.since).toBe('2026-05-18T05:00:00.000Z');
    expect(res.until).toBe('2026-05-25T05:00:00.000Z');
  });

  it('month bucket resolves to 1st-of-month local boundaries', async () => {
    const { service } = setup();

    const res = await service.earnings(makeContext(), { period: 'month' }, NOW);

    expect(res.since).toBe('2026-05-01T05:00:00.000Z');
    expect(res.until).toBe('2026-06-01T05:00:00.000Z');
  });

  it('returns zero totals when the repo finds nothing', async () => {
    const { service, orders } = setup();
    orders.earnings = { tipsCents: 0, deliveryFeesCents: 0, deliveriesCount: 0 };

    const res = await service.earnings(makeContext(), { period: 'today' }, NOW);

    expect(res.tipsCents).toBe(0);
    expect(res.deliveryFeesCents).toBe(0);
    expect(res.deliveriesCount).toBe(0);
    expect(res.totalCents).toBe(0);
  });
});

describe('__bucketBounds (DST edges)', () => {
  // Spring forward in America/Chicago: 2026-03-08 02:00 CST → 03:00 CDT
  // (jump from UTC-6 to UTC-5). A `today` bucket spanning the shift is
  // 23 hours wide in UTC, not 24.
  it('today on spring-forward day is 23h wide (CST -> CDT)', () => {
    const { since, until } = __bucketBounds('today', new Date('2026-03-08T15:00:00.000Z'));
    expect(since.toISOString()).toBe('2026-03-08T06:00:00.000Z'); // 2026-03-08 00:00 CST = 06:00 UTC
    expect(until.toISOString()).toBe('2026-03-09T05:00:00.000Z'); // 2026-03-09 00:00 CDT = 05:00 UTC
    expect(until.getTime() - since.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  // Fall back in America/Chicago: 2026-11-01 02:00 CDT → 01:00 CST
  // (jump back from UTC-5 to UTC-6). A `today` bucket spanning the
  // shift is 25 hours wide in UTC.
  it('today on fall-back day is 25h wide (CDT -> CST)', () => {
    const { since, until } = __bucketBounds('today', new Date('2026-11-01T15:00:00.000Z'));
    expect(since.toISOString()).toBe('2026-11-01T05:00:00.000Z'); // 2026-11-01 00:00 CDT = 05:00 UTC
    expect(until.toISOString()).toBe('2026-11-02T06:00:00.000Z'); // 2026-11-02 00:00 CST = 06:00 UTC
    expect(until.getTime() - since.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

describe('DriverAppService.shifts', () => {
  it('forwards listForDriver and projects each row', async () => {
    const { service, shifts } = setup();
    const shift: DriverShift = {
      id: '01935f3d-0000-7000-8000-0000000000f1',
      driverId: DRIVER_ID,
      startedAt: ISO('2026-05-19T12:00:00.000Z'),
      endedAt: null,
      startingLocation: { type: 'Point', coordinates: [-93.265, 44.977] },
      endingLocation: null,
      totalMiles: null,
      totalDeliveries: 0,
      totalEarningsCents: 0,
    };
    shifts.shifts = [shift];

    const res = await service.shifts(makeContext());

    expect(shifts.listCalls).toEqual([DRIVER_ID]);
    expect(res.shifts).toHaveLength(1);
    const projected = res.shifts[0];
    if (projected === undefined) throw new TypeError('expected shift projection');
    expect(projected.id).toBe(shift.id);
    expect(projected.startedAt).toBe('2026-05-19T12:00:00.000Z');
    expect(projected.endedAt).toBeNull();
  });

  it('returns an empty array when the driver has no shifts', async () => {
    const { service, shifts } = setup();
    shifts.shifts = [];

    const res = await service.shifts(makeContext());

    expect(res).toEqual({ shifts: [] });
  });
});

/**
 * Tenant-isolation tests for the driver-self surface (Phase 8.6 DOD:
 * "Driver can only see their own offers/earnings"). The structural
 * guarantee is that every repo call uses `ctx.driverId` and only
 * `ctx.driverId`. These tests pin that by making the call history
 * directly assertable — a regression that read e.g. `order.driverId`
 * or some shared id would flunk these immediately.
 *
 * Authorization at the offer surface is covered separately in
 * `driver-offers.service.test.ts` (DRIVER_OFFER_NOT_YOURS).
 */
describe('DriverAppService — driver isolation', () => {
  const OTHER_DRIVER_ID = '01935f3d-0000-7000-8000-0000000000ff';

  it('currentRoute looks up ONLY the calling driver, never another id', async () => {
    const { service, drivers } = setup();
    drivers.row = makeDriver({ id: OTHER_DRIVER_ID, currentOrderId: null });

    await service.currentRoute(makeContext({ driverId: DRIVER_ID }));

    expect(drivers.findByIdCalls).toEqual([DRIVER_ID]);
  });

  it('earnings forwards ONLY the calling driver id to sumDriverEarningsBetween', async () => {
    const { service, orders } = setup();
    const now = new Date('2026-05-19T19:30:00.000Z');

    await service.earnings(makeContext({ driverId: DRIVER_ID }), { period: 'today' }, now);

    expect(orders.earningsCalls.map((c) => c.driverId)).toEqual([DRIVER_ID]);
  });

  it('shifts forwards ONLY the calling driver id to listForDriver', async () => {
    const { service, shifts } = setup();

    await service.shifts(makeContext({ driverId: DRIVER_ID }));

    expect(shifts.listCalls).toEqual([DRIVER_ID]);
  });
});

// Suppress unused-warning on Database — kept imported so the rig
// signature mirrors the production service constructor exactly.
void (null as unknown as Database);

// Kept imported so the rig signature mirrors the production service
// constructor's typing exactly.
void (null as unknown as DriverError);

/**
 * Unit tests for DriverDeliveriesService (open delivery pool).
 *
 * listAvailable()
 *   1. Online, free driver → projected claimable board, nearest-first
 *      (the repo already orders by distance; the service just maps).
 *   2. Driver mid-delivery (current_order_id set) → empty board.
 *   3. Driver not `online` → empty board.
 *
 * claim()
 *   1. Happy path: locks the driver FOR UPDATE, fires DRIVER_ASSIGNED
 *      through transitionWithinTx (actor=system, patch.driverId=userId),
 *      expires any stray offers, stamps current_order_id + flips status
 *      to en_route_pickup, emits the deferred OrderTransitionedEvent
 *      AFTER commit, returns { orderId, status }.
 *   2. Driver busy → DRIVER_BUSY_WITH_ORDER (409); no transition, no emit.
 *   3. Driver not online → DRIVER_NOT_ONLINE (422); no transition.
 *   4. Driver row gone → DRIVER_NOT_FOUND (404).
 *   5. Order left awaiting_driver (machine refuses DRIVER_ASSIGNED) →
 *      DRIVER_DELIVERY_ALREADY_CLAIMED (409) = first-come-wins; the
 *      driver is NOT mutated and no event is emitted.
 *   6. Order id unknown (transition throws ORDER_NOT_FOUND) →
 *      DRIVER_DELIVERY_NOT_AVAILABLE (404).
 *
 * The rig fakes the two repos with in-memory state and a passthrough
 * `db.transaction`. OrderTransitionService is faked — transitionWithinTx
 * returns a stub DeferredTransitionResult or rejects with a supplied
 * OrderError; emitDeferred is a spy.
 */
import {
  type AvailableDeliveryRow,
  type Database,
  type DispatchOffersRepository,
  type Driver,
  type DriverStatus,
  type DriversRepository,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderTransitionedEvent } from '../../orders/order-transition.events.js';
import {
  type DeferredTransitionResult,
  type OrderTransitionService,
  type TransitionRequest,
} from '../../orders/order-transition.service.js';
import { projectAvailableDelivery } from './available-delivery.projection.js';
import {
  DriverDeliveriesService,
  type DriverDeliveriesScopedRepos,
} from './driver-deliveries.service.js';
import type { DriverContext } from '../context/driver-context.types.js';

const NOW = new Date('2026-05-19T14:30:00.000Z');
const RADIUS_METERS = 10 * 1609.344;

const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000c1';

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
    lastStatusChangeAt: NOW,
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: null,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRow(overrides: Partial<AvailableDeliveryRow> = {}): AvailableDeliveryRow {
  return {
    orderId: ORDER_ID,
    shortCode: 'AB12',
    dispensaryId: DISPENSARY_ID,
    pickupName: 'Hometown Dispensary',
    pickupLat: 44.9778,
    pickupLng: -93.265,
    dropoffLat: 44.94,
    dropoffLng: -93.1,
    tipCents: 500,
    totalCents: 8200,
    distanceMeters: 1234.5,
    awaitingDriverAt: NOW,
    ...overrides,
  };
}

class FakeDispatchOffersRepo implements Pick<
  DispatchOffersRepository,
  'listAvailableDeliveries' | 'expireAllActiveForOrder'
> {
  public rows: AvailableDeliveryRow[] = [];
  public listCalls: { driverId: string; maxRadiusMeters: number }[] = [];
  public expireAllCalls: { orderId: string; now: Date }[] = [];

  listAvailableDeliveries(
    driverId: string,
    maxRadiusMeters: number,
  ): Promise<readonly AvailableDeliveryRow[]> {
    this.listCalls.push({ driverId, maxRadiusMeters });
    return Promise.resolve(this.rows);
  }

  expireAllActiveForOrder(orderId: string, now: Date): Promise<number> {
    this.expireAllCalls.push({ orderId, now });
    return Promise.resolve(0);
  }
}

class FakeDriversRepo implements Pick<
  DriversRepository,
  'findByIdForUpdate' | 'setStatus' | 'setCurrentOrder'
> {
  public row: Driver | null = null;
  public lockedIds: string[] = [];
  public setStatusCalls: { id: string; status: DriverStatus }[] = [];
  public setCurrentOrderCalls: { id: string; orderId: string | null }[] = [];

  findByIdForUpdate(id: string): Promise<Driver | null> {
    this.lockedIds.push(id);
    return Promise.resolve(this.row);
  }

  setStatus(id: string, status: DriverStatus): Promise<void> {
    this.setStatusCalls.push({ id, status });
    return Promise.resolve();
  }

  setCurrentOrder(id: string, orderId: string | null): Promise<void> {
    this.setCurrentOrderCalls.push({ id, orderId });
    return Promise.resolve();
  }
}

interface FakeOrderTransitions {
  readonly transitionWithinTx: ReturnType<typeof vi.fn>;
  readonly emitDeferred: ReturnType<typeof vi.fn>;
}

function makeFakeOrderTransitions(
  opts: { throwOnTransition?: OrderError } = {},
): FakeOrderTransitions {
  return {
    transitionWithinTx: vi.fn((req: TransitionRequest): Promise<DeferredTransitionResult> => {
      if (opts.throwOnTransition !== undefined) {
        return Promise.reject(opts.throwOnTransition);
      }
      return Promise.resolve({
        result: {
          orderId: req.orderId,
          fromStatus: 'awaiting_driver',
          toStatus: 'driver_assigned',
        },
        deferredEvent: new OrderTransitionedEvent({
          orderId: req.orderId,
          fromStatus: 'awaiting_driver',
          toStatus: 'driver_assigned',
          event: req.event,
          actor: req.actor,
          occurredAt: NOW,
        }),
      });
    }),
    emitDeferred: vi.fn(),
  };
}

function makeService(
  opts: {
    rows?: AvailableDeliveryRow[];
    driver?: Driver | null;
    throwOnTransition?: OrderError;
  } = {},
): {
  service: DriverDeliveriesService;
  offersRepo: FakeDispatchOffersRepo;
  driversRepo: FakeDriversRepo;
  transitions: FakeOrderTransitions;
} {
  const offersRepo = new FakeDispatchOffersRepo();
  offersRepo.rows = opts.rows ?? [];

  const driversRepo = new FakeDriversRepo();
  driversRepo.row = opts.driver === undefined ? makeDriver() : opts.driver;

  const transitions = makeFakeOrderTransitions(
    opts.throwOnTransition !== undefined ? { throwOnTransition: opts.throwOnTransition } : {},
  );

  const scopedReposFor = (_db: Database): DriverDeliveriesScopedRepos => ({
    dispatchOffers: offersRepo as unknown as DispatchOffersRepository,
    drivers: driversRepo as unknown as DriversRepository,
  });

  const fakeDb = {
    transaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(fakeDb),
  } as unknown as Database;

  const service = new DriverDeliveriesService(
    fakeDb,
    transitions as unknown as OrderTransitionService,
    scopedReposFor,
    RADIUS_METERS,
  );

  return { service, offersRepo, driversRepo, transitions };
}

describe('DriverDeliveriesService.listAvailable', () => {
  it('returns the projected claimable board for an online, free driver', async () => {
    const row = makeRow();
    const { service, offersRepo } = makeService({ rows: [row] });

    const result = await service.listAvailable(makeContext());

    expect(result.deliveries).toEqual([projectAvailableDelivery(row)]);
    expect(offersRepo.listCalls).toEqual([{ driverId: DRIVER_ID, maxRadiusMeters: RADIUS_METERS }]);
  });

  it('returns an empty board when the driver is mid-delivery', async () => {
    const { service, offersRepo } = makeService({ rows: [makeRow()] });

    const result = await service.listAvailable(makeContext({ currentOrderId: ORDER_ID }));

    expect(result.deliveries).toEqual([]);
    // Short-circuits before querying — a busy driver can't take a second.
    expect(offersRepo.listCalls).toEqual([]);
  });

  it('returns an empty board when the driver is not online', async () => {
    const { service, offersRepo } = makeService({ rows: [makeRow()] });

    const result = await service.listAvailable(makeContext({ currentStatus: 'on_break' }));

    expect(result.deliveries).toEqual([]);
    expect(offersRepo.listCalls).toEqual([]);
  });
});

describe('DriverDeliveriesService.claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: locks driver, fires DRIVER_ASSIGNED, expires offers, updates driver, emits deferred', async () => {
    const { service, offersRepo, driversRepo, transitions } = makeService();

    const result = await service.claim(makeContext(), ORDER_ID, NOW);

    expect(result).toEqual({ orderId: ORDER_ID, status: 'driver_assigned' });
    expect(driversRepo.lockedIds).toEqual([DRIVER_ID]);

    expect(transitions.transitionWithinTx).toHaveBeenCalledTimes(1);
    const call = transitions.transitionWithinTx.mock.calls[0]?.[0] as TransitionRequest;
    expect(call.orderId).toBe(ORDER_ID);
    expect(call.event).toBe('DRIVER_ASSIGNED');
    expect(call.actor).toEqual({ role: 'system' });
    expect(call.patch).toEqual({ driverId: USER_ID });
    expect(call.payload).toEqual({ driverId: DRIVER_ID, source: 'open_pool' });

    expect(offersRepo.expireAllCalls).toEqual([{ orderId: ORDER_ID, now: NOW }]);
    expect(driversRepo.setCurrentOrderCalls).toEqual([{ id: DRIVER_ID, orderId: ORDER_ID }]);
    expect(driversRepo.setStatusCalls).toEqual([{ id: DRIVER_ID, status: 'en_route_pickup' }]);

    // Emitted AFTER the tx callback resolves (post-commit).
    expect(transitions.emitDeferred).toHaveBeenCalledTimes(1);
  });

  it('rejects with DRIVER_BUSY_WITH_ORDER (409) when the driver already has an order', async () => {
    const { service, transitions, driversRepo } = makeService({
      driver: makeDriver({ currentOrderId: '01935f3d-0000-7000-8000-0000000000ff' }),
    });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_BUSY_WITH_ORDER',
      statusCode: 409,
    });
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
    expect(driversRepo.setCurrentOrderCalls).toEqual([]);
  });

  it('rejects with DRIVER_NOT_ONLINE (422) when the driver is on break', async () => {
    const { service, transitions } = makeService({
      driver: makeDriver({ currentStatus: 'on_break' }),
    });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_NOT_ONLINE',
      statusCode: 422,
    });
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
  });

  it('rejects with DRIVER_NOT_FOUND (404) when the driver row is gone', async () => {
    const { service } = makeService({ driver: null });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('maps a refused DRIVER_ASSIGNED to DRIVER_DELIVERY_ALREADY_CLAIMED (409) — first-come-wins', async () => {
    const { service, driversRepo, transitions } = makeService({
      throwOnTransition: OrderError.invalidTransition('driver_assigned', 'DRIVER_ASSIGNED'),
    });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_DELIVERY_ALREADY_CLAIMED',
      statusCode: 409,
    });
    // The loser is not mutated and nothing is emitted.
    expect(driversRepo.setCurrentOrderCalls).toEqual([]);
    expect(driversRepo.setStatusCalls).toEqual([]);
    expect(transitions.emitDeferred).not.toHaveBeenCalled();
  });

  it('maps a missing order to DRIVER_DELIVERY_NOT_AVAILABLE (404)', async () => {
    const { service } = makeService({ throwOnTransition: OrderError.notFound(ORDER_ID) });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_DELIVERY_NOT_AVAILABLE',
      statusCode: 404,
    });
  });

  it('preserves an unexpected OrderError instead of masking it', async () => {
    const { service } = makeService({
      throwOnTransition: OrderError.actorForbidden('nope'),
    });

    await expect(service.claim(makeContext(), ORDER_ID, NOW)).rejects.toBeInstanceOf(OrderError);
  });
});

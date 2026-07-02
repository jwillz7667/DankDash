/**
 * Unit tests for DriverOffersService.
 *
 * What's pinned here:
 *   accept()
 *     1. Happy path: locks offer + driver under FOR UPDATE, fires
 *        DRIVER_ASSIGNED through OrderTransitionService.transitionWithinTx,
 *        flips offer to `accepted`, expires sibling offers, stamps
 *        `drivers.current_order_id` and flips driver status to
 *        `en_route_pickup` — all inside one outer tx. Emits both the
 *        OfferAcceptedEvent AND the deferred OrderTransitionedEvent
 *        AFTER the tx callback resolves (i.e. after commit).
 *     2. Offer not found → DRIVER_OFFER_NOT_FOUND (404).
 *     3. Offer belongs to another driver → DRIVER_OFFER_NOT_YOURS (403).
 *     4. Offer status not 'offered' (already accepted/declined/expired)
 *        → DRIVER_OFFER_ALREADY_RESPONDED (409).
 *     5. Offer expired (expires_at <= now) → DRIVER_OFFER_EXPIRED (410).
 *     6. Driver currently busy with another order → DRIVER_BUSY_WITH_ORDER.
 *     7. Driver not in `online` status → DRIVER_NOT_ONLINE.
 *     8. Concurrent order transition refusal (e.g. customer canceled
 *        the order while the driver was accepting) — the
 *        transitionWithinTx call throws OrderError, the outer tx rolls
 *        back, no event is emitted.
 *     9. The atomic `respond()` returning null mid-flight surfaces as
 *        DRIVER_OFFER_ALREADY_RESPONDED (defence-in-depth against the
 *        FOR UPDATE somehow not serialising).
 *   decline()
 *     1. Happy path: locks offer, flips to `declined` with the optional
 *        reason. Does NOT expire sibling offers (worker keeps dispatching).
 *     2. Same ownership + status checks as accept.
 *     3. Expired-but-still-offered offer CAN be declined (records the
 *        decision with reason for ops signal).
 *
 * The rig fakes `DispatchOffersRepository` + `DriversRepository` with
 * in-memory state and a per-row mutex on the FOR UPDATE call (so
 * concurrent accept attempts on the same offer can be ordered
 * deterministically). `db.transaction(fn)` is a passthrough that invokes
 * `fn` with the same fake handle. `OrderTransitionService` is also faked
 * — its `transitionWithinTx` returns a stub `DeferredTransitionResult`,
 * its `emitDeferred` is a spy, and a per-test `throwOnTransition` flag
 * simulates the order-machine refusing the DRIVER_ASSIGNED edge.
 */
import {
  type Database,
  type DispatchOffer,
  type DispatchOffersRepository,
  type Driver,
  type DriverStatus,
  type DriversRepository,
  type OfferStatus,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { DriverError } from '@dankdash/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../../orders/order-transition.events.js';
import {
  type DeferredTransitionResult,
  type OrderTransitionService,
  type TransitionRequest,
} from '../../orders/order-transition.service.js';
import { projectDispatchOffer } from './dispatch-offer.projection.js';
import { DriverOffersService, type DriverOffersScopedRepos } from './driver-offers.service.js';
import {
  OFFER_ACCEPTED_EVENT,
  OFFER_DECLINED_EVENT,
  OfferAcceptedEvent,
  OfferDeclinedEvent,
} from './offer.events.js';
import type { DriverContext } from '../context/driver-context.types.js';

const NOW = new Date('2026-05-19T14:30:00.000Z');
const FUTURE = new Date('2026-05-19T14:30:25.000Z');
const PAST = new Date('2026-05-19T14:29:00.000Z');

const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const OTHER_DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d2';
const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';
const OFFER_ID = '01935f3d-0000-7000-8000-0000000000e1';
const SIBLING_OFFER_ID = '01935f3d-0000-7000-8000-0000000000e2';

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
    aeropayAccountRef: null,
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

function makeOffer(overrides: Partial<DispatchOffer> = {}): DispatchOffer {
  return {
    id: OFFER_ID,
    orderId: ORDER_ID,
    driverId: DRIVER_ID,
    offeredAt: NOW,
    expiresAt: FUTURE,
    payoutEstimateCents: 1200,
    distanceMiles: '2.50',
    status: 'offered',
    respondedAt: null,
    declineReason: null,
    ...overrides,
  };
}

class FakeDispatchOffersRepo implements Pick<
  DispatchOffersRepository,
  'findByIdForUpdate' | 'respond' | 'expireOtherActiveForOrder' | 'listActiveForDriver'
> {
  public offers = new Map<string, DispatchOffer>();
  public lockedIds: string[] = [];
  public respondCalls: { id: string; status: OfferStatus; reason?: string; respondedAt: Date }[] =
    [];
  public expireSiblingsCalls: { orderId: string; keepOfferId: string; now: Date }[] = [];
  /** If set, the next respond() returns null (simulates lost race). */
  public respondReturnsNull = false;

  findByIdForUpdate(id: string): Promise<DispatchOffer | null> {
    this.lockedIds.push(id);
    return Promise.resolve(this.offers.get(id) ?? null);
  }

  // Mirrors the SQL: driver_id = ? AND status = 'offered' AND
  // expires_at > now, ORDER BY offered_at DESC.
  listActiveForDriver(driverId: string, now: Date): Promise<readonly DispatchOffer[]> {
    const rows = [...this.offers.values()]
      .filter(
        (o) =>
          o.driverId === driverId &&
          o.status === 'offered' &&
          o.expiresAt.getTime() > now.getTime(),
      )
      .sort((a, b) => b.offeredAt.getTime() - a.offeredAt.getTime());
    return Promise.resolve(rows);
  }

  respond(
    id: string,
    status: Exclude<OfferStatus, 'offered'>,
    respondedAt: Date,
    declineReason?: string,
  ): Promise<DispatchOffer | null> {
    this.respondCalls.push({
      id,
      status,
      respondedAt,
      ...(declineReason ? { reason: declineReason } : {}),
    });
    if (this.respondReturnsNull) return Promise.resolve(null);
    const current = this.offers.get(id);
    if (current?.status !== 'offered') return Promise.resolve(null);
    const next: DispatchOffer = {
      ...current,
      status,
      respondedAt,
      declineReason: declineReason ?? null,
    };
    this.offers.set(id, next);
    return Promise.resolve(next);
  }

  expireOtherActiveForOrder(orderId: string, keepOfferId: string, now: Date): Promise<number> {
    this.expireSiblingsCalls.push({ orderId, keepOfferId, now });
    let count = 0;
    for (const [id, offer] of this.offers) {
      if (id !== keepOfferId && offer.orderId === orderId && offer.status === 'offered') {
        this.offers.set(id, { ...offer, status: 'expired', respondedAt: now });
        count += 1;
      }
    }
    return Promise.resolve(count);
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

interface FakeOrderTransitions {
  readonly transitionWithinTx: ReturnType<typeof vi.fn>;
  readonly emitDeferred: ReturnType<typeof vi.fn>;
}

function makeFakeOrderTransitions(
  opts: {
    throwOnTransition?: OrderError;
  } = {},
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
    offer?: DispatchOffer | null;
    siblings?: DispatchOffer[];
    driver?: Driver | null;
    throwOnTransition?: OrderError;
    respondReturnsNull?: boolean;
  } = {},
): {
  service: DriverOffersService;
  offersRepo: FakeDispatchOffersRepo;
  driversRepo: FakeDriversRepo;
  transitions: FakeOrderTransitions;
  events: EventEmitter2;
  emitSpy: MockInstance;
} {
  const offersRepo = new FakeDispatchOffersRepo();
  if (opts.offer !== undefined && opts.offer !== null) {
    offersRepo.offers.set(opts.offer.id, opts.offer);
  }
  for (const sibling of opts.siblings ?? []) {
    offersRepo.offers.set(sibling.id, sibling);
  }
  if (opts.respondReturnsNull === true) offersRepo.respondReturnsNull = true;

  const driversRepo = new FakeDriversRepo();
  driversRepo.row = opts.driver === undefined ? makeDriver() : opts.driver;

  const transitions = makeFakeOrderTransitions({
    ...(opts.throwOnTransition !== undefined ? { throwOnTransition: opts.throwOnTransition } : {}),
  });

  const scopedReposFor = (_db: Database): DriverOffersScopedRepos => ({
    dispatchOffers: offersRepo as unknown as DispatchOffersRepository,
    drivers: driversRepo as unknown as DriversRepository,
  });

  const events = new EventEmitter2();
  const emitSpy = vi.spyOn(events, 'emit');

  const fakeDb = {
    transaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(fakeDb),
  } as unknown as Database;

  const service = new DriverOffersService(
    fakeDb,
    transitions as unknown as OrderTransitionService,
    scopedReposFor,
    events,
  );

  return { service, offersRepo, driversRepo, transitions, events, emitSpy };
}

describe('DriverOffersService.listPending', () => {
  it('returns this driver’s open, non-expired offers in an { offers } envelope', async () => {
    const offer = makeOffer();
    const { service } = makeService({ offer });

    const result = await service.listPending(makeContext(), NOW);

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toEqual(projectDispatchOffer(offer));
  });

  it('excludes expired and already-responded offers', async () => {
    const open = makeOffer();
    const expired = makeOffer({
      id: '01935f3d-0000-7000-8000-0000000000f1',
      expiresAt: PAST,
    });
    const declined = makeOffer({
      id: '01935f3d-0000-7000-8000-0000000000f2',
      status: 'declined',
      respondedAt: NOW,
    });
    const { service } = makeService({ offer: open, siblings: [expired, declined] });

    const result = await service.listPending(makeContext(), NOW);

    expect(result.offers.map((o) => o.id)).toEqual([open.id]);
  });

  it('returns an empty envelope when the driver has no active offers', async () => {
    const { service } = makeService({ offer: null });

    const result = await service.listPending(makeContext(), NOW);

    expect(result.offers).toEqual([]);
  });
});

describe('DriverOffersService.accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: locks offer + driver, fires DRIVER_ASSIGNED, accepts offer, expires siblings, updates driver, emits events', async () => {
    const offer = makeOffer();
    const sibling = makeOffer({ id: SIBLING_OFFER_ID, driverId: OTHER_DRIVER_ID });
    const { service, offersRepo, driversRepo, transitions, emitSpy } = makeService({
      offer,
      siblings: [sibling],
    });

    const result = await service.accept(makeContext(), OFFER_ID, NOW);

    expect(result.id).toBe(OFFER_ID);
    expect(result.status).toBe('accepted');
    expect(result.respondedAt).toBe(NOW.toISOString());

    expect(offersRepo.lockedIds).toEqual([OFFER_ID]);
    expect(driversRepo.lockedIds).toEqual([DRIVER_ID]);

    expect(transitions.transitionWithinTx).toHaveBeenCalledTimes(1);
    const transitionCall = transitions.transitionWithinTx.mock.calls[0]?.[0] as TransitionRequest;
    expect(transitionCall.orderId).toBe(ORDER_ID);
    expect(transitionCall.event).toBe('DRIVER_ASSIGNED');
    expect(transitionCall.actor).toEqual({ role: 'system' });
    expect(transitionCall.patch).toEqual({ driverId: USER_ID });
    expect(transitionCall.payload).toEqual({ offerId: OFFER_ID, driverId: DRIVER_ID });

    expect(offersRepo.respondCalls).toEqual([
      { id: OFFER_ID, status: 'accepted', respondedAt: NOW },
    ]);
    expect(offersRepo.expireSiblingsCalls).toEqual([
      { orderId: ORDER_ID, keepOfferId: OFFER_ID, now: NOW },
    ]);
    expect(offersRepo.offers.get(SIBLING_OFFER_ID)?.status).toBe('expired');

    expect(driversRepo.setCurrentOrderCalls).toEqual([{ id: DRIVER_ID, orderId: ORDER_ID }]);
    expect(driversRepo.setStatusCalls).toEqual([{ id: DRIVER_ID, status: 'en_route_pickup' }]);

    // emitDeferred runs the OrderTransitionedEvent emit; the service
    // separately emits OfferAcceptedEvent. Both happen AFTER the tx
    // callback resolves — verified implicitly by the fact that the
    // outer await returned successfully and only then did the spies fire.
    expect(transitions.emitDeferred).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(OFFER_ACCEPTED_EVENT, expect.any(OfferAcceptedEvent));
    const offerEvent = emitSpy.mock.calls.find((c) => c[0] === OFFER_ACCEPTED_EVENT)?.[1] as
      | OfferAcceptedEvent
      | undefined;
    expect(offerEvent?.offerId).toBe(OFFER_ID);
    expect(offerEvent?.orderId).toBe(ORDER_ID);
    expect(offerEvent?.driverId).toBe(DRIVER_ID);
    expect(offerEvent?.userId).toBe(USER_ID);
  });

  it('refuses when offer does not exist (DRIVER_OFFER_NOT_FOUND)', async () => {
    const { service, transitions, emitSpy } = makeService({ offer: null });

    await expect(service.accept(makeContext(), OFFER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_OFFER_NOT_FOUND',
      statusCode: 404,
    });

    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
    expect(transitions.emitDeferred).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith(OFFER_ACCEPTED_EVENT, expect.anything());
  });

  it('refuses when offer belongs to a different driver (DRIVER_OFFER_NOT_YOURS)', async () => {
    const offer = makeOffer({ driverId: OTHER_DRIVER_ID });
    const { service, transitions } = makeService({ offer });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_OFFER_NOT_YOURS');
    expect((err as DriverError).statusCode).toBe(403);
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
  });

  it.each<{ status: OfferStatus }>([
    { status: 'accepted' },
    { status: 'declined' },
    { status: 'expired' },
  ])(
    'refuses when offer status is $status (DRIVER_OFFER_ALREADY_RESPONDED)',
    async ({ status }) => {
      const offer = makeOffer({ status });
      const { service, transitions } = makeService({ offer });

      const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe('DRIVER_OFFER_ALREADY_RESPONDED');
      expect((err as DriverError).statusCode).toBe(409);
      expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
    },
  );

  it('refuses when the offer has expired (DRIVER_OFFER_EXPIRED)', async () => {
    const offer = makeOffer({ expiresAt: PAST });
    const { service, transitions } = makeService({ offer });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_OFFER_EXPIRED');
    expect((err as DriverError).statusCode).toBe(410);
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
  });

  it('refuses when expiresAt === now (boundary: strict greater-than)', async () => {
    const offer = makeOffer({ expiresAt: NOW });
    const { service } = makeService({ offer });

    await expect(service.accept(makeContext(), OFFER_ID, NOW)).rejects.toMatchObject({
      code: 'DRIVER_OFFER_EXPIRED',
    });
  });

  it('refuses when driver is already assigned to another order (DRIVER_BUSY_WITH_ORDER)', async () => {
    const offer = makeOffer();
    const driver = makeDriver({ currentOrderId: '01935f3d-0000-7000-8000-0000000000ff' });
    const { service, transitions } = makeService({ offer, driver });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_BUSY_WITH_ORDER');
    expect((err as DriverError).statusCode).toBe(409);
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
  });

  it.each<{ status: DriverStatus }>([
    { status: 'offline' },
    { status: 'on_break' },
    { status: 'unavailable' },
    { status: 'en_route_pickup' },
    { status: 'en_route_dropoff' },
  ])('refuses when driver status is $status (DRIVER_NOT_ONLINE)', async ({ status }) => {
    const offer = makeOffer();
    const driver = makeDriver({ currentStatus: status });
    const { service, transitions } = makeService({ offer, driver });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_NOT_ONLINE');
    expect((err as DriverError).statusCode).toBe(422);
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled();
  });

  it('rolls back and emits nothing when transitionWithinTx refuses (e.g. order canceled mid-flight)', async () => {
    const offer = makeOffer();
    const { service, offersRepo, driversRepo, emitSpy } = makeService({
      offer,
      throwOnTransition: OrderError.invalidTransition('canceled', 'DRIVER_ASSIGNED'),
    });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe('ORDER_INVALID_TRANSITION');

    // Offer is still 'offered' (the respond call never happened because
    // transitionWithinTx threw first); driver state unchanged.
    expect(offersRepo.respondCalls).toEqual([]);
    expect(offersRepo.expireSiblingsCalls).toEqual([]);
    expect(driversRepo.setCurrentOrderCalls).toEqual([]);
    expect(driversRepo.setStatusCalls).toEqual([]);
    expect(emitSpy).not.toHaveBeenCalledWith(OFFER_ACCEPTED_EVENT, expect.anything());
  });

  it('surfaces DRIVER_OFFER_ALREADY_RESPONDED when respond() unexpectedly returns null', async () => {
    const offer = makeOffer();
    const { service, transitions, emitSpy } = makeService({ offer, respondReturnsNull: true });

    const err = await service.accept(makeContext(), OFFER_ID, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_OFFER_ALREADY_RESPONDED');

    // transitionWithinTx WAS called (the lock said `offered`), but the
    // outer tx rolls back when respond returns null. Nothing emitted.
    expect(transitions.transitionWithinTx).toHaveBeenCalledTimes(1);
    expect(transitions.emitDeferred).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith(OFFER_ACCEPTED_EVENT, expect.anything());
  });

  it('does not abort the response when OfferAcceptedEvent subscriber throws', async () => {
    const offer = makeOffer();
    const { service, events } = makeService({ offer });
    events.on(OFFER_ACCEPTED_EVENT, () => {
      throw new TypeError('subscriber blew up');
    });

    // The accept should still return — the event emit is best-effort.
    const result = await service.accept(makeContext(), OFFER_ID, NOW);
    expect(result.status).toBe('accepted');
  });
});

describe('DriverOffersService.decline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: flips offer to declined with reason, no sibling cancel, no driver mutation', async () => {
    const offer = makeOffer();
    const { service, offersRepo, driversRepo, transitions, emitSpy } = makeService({ offer });

    const result = await service.decline(makeContext(), OFFER_ID, { reason: 'too far' }, NOW);

    expect(result.status).toBe('declined');
    expect(result.declineReason).toBe('too far');
    expect(result.respondedAt).toBe(NOW.toISOString());

    expect(offersRepo.lockedIds).toEqual([OFFER_ID]);
    expect(offersRepo.respondCalls).toEqual([
      { id: OFFER_ID, status: 'declined', respondedAt: NOW, reason: 'too far' },
    ]);
    expect(offersRepo.expireSiblingsCalls).toEqual([]); // decline does NOT cancel siblings
    expect(driversRepo.setStatusCalls).toEqual([]); // driver untouched
    expect(driversRepo.setCurrentOrderCalls).toEqual([]);
    expect(transitions.transitionWithinTx).not.toHaveBeenCalled(); // no order transition on decline

    expect(emitSpy).toHaveBeenCalledWith(OFFER_DECLINED_EVENT, expect.any(OfferDeclinedEvent));
    expect(emitSpy).not.toHaveBeenCalledWith(ORDER_TRANSITIONED_EVENT, expect.anything());
    const evt = emitSpy.mock.calls.find((c) => c[0] === OFFER_DECLINED_EVENT)?.[1] as
      | OfferDeclinedEvent
      | undefined;
    expect(evt?.reason).toBe('too far');
  });

  it('happy path without reason: decline_reason persists as null', async () => {
    const offer = makeOffer();
    const { service, offersRepo } = makeService({ offer });

    const result = await service.decline(makeContext(), OFFER_ID, {}, NOW);

    expect(result.declineReason).toBeNull();
    expect(offersRepo.respondCalls[0]).toEqual({
      id: OFFER_ID,
      status: 'declined',
      respondedAt: NOW,
    });
  });

  it('refuses when offer does not exist', async () => {
    const { service } = makeService({ offer: null });

    await expect(service.decline(makeContext(), OFFER_ID, {}, NOW)).rejects.toMatchObject({
      code: 'DRIVER_OFFER_NOT_FOUND',
    });
  });

  it('refuses when offer belongs to a different driver', async () => {
    const offer = makeOffer({ driverId: OTHER_DRIVER_ID });
    const { service } = makeService({ offer });

    await expect(service.decline(makeContext(), OFFER_ID, {}, NOW)).rejects.toMatchObject({
      code: 'DRIVER_OFFER_NOT_YOURS',
    });
  });

  it.each<{ status: OfferStatus }>([
    { status: 'accepted' },
    { status: 'declined' },
    { status: 'expired' },
  ])('refuses when offer status is $status', async ({ status }) => {
    const offer = makeOffer({ status });
    const { service } = makeService({ offer });

    await expect(service.decline(makeContext(), OFFER_ID, {}, NOW)).rejects.toMatchObject({
      code: 'DRIVER_OFFER_ALREADY_RESPONDED',
    });
  });

  it('allows declining an expired-but-still-offered offer (the cron has not flipped it yet)', async () => {
    // status='offered' but expires_at in the past — still allowed to decline.
    const offer = makeOffer({ expiresAt: PAST });
    const { service, offersRepo } = makeService({ offer });

    const result = await service.decline(makeContext(), OFFER_ID, { reason: 'too late' }, NOW);

    expect(result.status).toBe('declined');
    expect(offersRepo.respondCalls).toEqual([
      { id: OFFER_ID, status: 'declined', respondedAt: NOW, reason: 'too late' },
    ]);
  });
});

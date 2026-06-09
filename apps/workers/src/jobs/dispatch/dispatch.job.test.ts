/**
 * Unit tests for runDispatchJob. The job is an I/O shell around the
 * pure `@dankdash/dispatch` orchestrator (covered to 100% in its own
 * package). These tests assert the wiring:
 *
 *   - which DB calls happen for which decision kind
 *   - that the row patch / event type passed to applyTransition is the
 *     one DISPATCH_FAILED needs
 *   - per-order errors do not abort the tick
 *   - skip conditions (missing awaiting_driver_at, accept in flight)
 *     are surfaced in the summary counters
 *
 * No real DB, no real clock — both injected. Fakes stay narrow to make
 * the typecheck do most of the verifying.
 */
import {
  type DispatchCandidateRow,
  type DispatchOffer,
  type DispatchOffersRepository,
  type DriversRepository,
  type NewDispatchOffer,
  type Order,
  type OrdersRepository,
  type TransitionResolver,
} from '@dankdash/db';
import {
  DEFAULT_ATTEMPT_PARAMS,
  DEFAULT_SCORING_PARAMS,
  type AttemptParams,
} from '@dankdash/dispatch';
import { OrderError } from '@dankdash/orders';
import { RepositoryError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDispatchJob } from './dispatch.job.js';

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): { logger: ReturnType<typeof loggerInner>; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return { logger: loggerInner(logs), logs };
}

function loggerInner(logs: CapturedLog[]): {
  child: (fields: Record<string, unknown>) => unknown;
  debug: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
} {
  return {
    child: (): unknown => loggerInner(logs),
    debug: (fields, message): void => {
      logs.push({ level: 'debug', fields, message });
    },
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
  };
}

const NOW = new Date('2026-05-19T18:00:00.000Z');
// Orders enter awaiting_driver 30 seconds before NOW so the attempt budget
// is far from exhausted (default total budget is 3 minutes).
const ATTEMPT_STARTED = new Date(NOW.getTime() - 30_000);

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    shortCode: 'ABC123',
    userId: 'user-1',
    dispensaryId: 'disp-1',
    driverId: null,
    deliveryAddressId: 'addr-1',
    status: 'awaiting_driver',
    statusChangedAt: ATTEMPT_STARTED,
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 100,
    deliveryFeeCents: 800,
    driverTipCents: 200,
    discountCents: 0,
    totalCents: 6600,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: new Date(ATTEMPT_STARTED.getTime() - 60_000),
    paymentFailedAt: null,
    acceptedAt: new Date(ATTEMPT_STARTED.getTime() - 50_000),
    rejectedAt: null,
    preppingAt: new Date(ATTEMPT_STARTED.getTime() - 45_000),
    preparedAt: new Date(ATTEMPT_STARTED.getTime() - 40_000),
    awaitingDriverAt: ATTEMPT_STARTED,
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
    createdAt: new Date(ATTEMPT_STARTED.getTime() - 120_000),
    updatedAt: ATTEMPT_STARTED,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<DispatchCandidateRow> = {}): DispatchCandidateRow {
  return {
    driverId: 'driver-1',
    distanceMeters: 1000,
    ratingAvg: 4.8,
    ratingCount: 50,
    lastDeliveryAt: new Date(ATTEMPT_STARTED.getTime() - 30 * 60 * 1000),
    ...overrides,
  };
}

interface Fakes {
  readonly orders: OrdersRepository;
  readonly drivers: DriversRepository;
  readonly dispatchOffers: DispatchOffersRepository;
  readonly listInStatus: ReturnType<typeof vi.fn>;
  readonly applyTransition: ReturnType<typeof vi.fn>;
  readonly findCandidates: ReturnType<typeof vi.fn>;
  readonly listForOrder: ReturnType<typeof vi.fn>;
  readonly createOffer: ReturnType<typeof vi.fn>;
}

function makeFakes(args: {
  awaitingOrders?: readonly Order[];
  candidates?: readonly DispatchCandidateRow[];
  history?: readonly DispatchOffer[];
  applyTransitionImpl?: (orderId: string, resolver: TransitionResolver) => Promise<Order>;
}): Fakes {
  const listInStatus = vi.fn().mockResolvedValue(args.awaitingOrders ?? []);
  const applyTransition =
    args.applyTransitionImpl !== undefined
      ? vi.fn(args.applyTransitionImpl)
      : vi.fn((orderId: string, resolver: TransitionResolver): Promise<Order> => {
          const decision = resolver({
            id: orderId,
            status: 'awaiting_driver',
            userId: 'user-1',
            dispensaryId: 'disp-1',
            driverId: null,
          });
          return Promise.resolve(
            makeOrder({
              id: orderId,
              status: decision.toStatus,
              dispatchFailedAt: decision.toStatus === 'dispatch_failed' ? NOW : null,
            }),
          );
        });
  const findCandidates = vi.fn().mockResolvedValue(args.candidates ?? []);
  const listForOrder = vi.fn().mockResolvedValue(args.history ?? []);
  const createOffer = vi.fn(
    (input: NewDispatchOffer): Promise<DispatchOffer> =>
      Promise.resolve({
        id: 'offer-new',
        orderId: input.orderId,
        driverId: input.driverId,
        offeredAt: input.offeredAt ?? NOW,
        expiresAt: input.expiresAt,
        payoutEstimateCents: input.payoutEstimateCents,
        distanceMiles: input.distanceMiles,
        status: input.status ?? 'offered',
        respondedAt: null,
        declineReason: null,
      }),
  );

  return {
    orders: { listInStatus, applyTransition } as unknown as OrdersRepository,
    drivers: {
      findDispatchCandidatesNearDispensary: findCandidates,
    } as unknown as DriversRepository,
    dispatchOffers: { listForOrder, create: createOffer } as unknown as DispatchOffersRepository,
    listInStatus,
    applyTransition,
    findCandidates,
    listForOrder,
    createOffer,
  };
}

describe('runDispatchJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeroed counters when there are no awaiting_driver orders', async () => {
    const fakes = makeFakes({ awaitingOrders: [] });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary).toEqual({
      considered: 0,
      offered: 0,
      waited: 0,
      waitedNoCandidates: 0,
      failedNoDrivers: 0,
      failedBudgetExhausted: 0,
      skippedMissingTimestamp: 0,
      skippedAcceptInFlight: 0,
      errors: 0,
    });
    expect(fakes.findCandidates).not.toHaveBeenCalled();
  });

  it('issues an offer for an awaiting order with an eligible driver', async () => {
    const order = makeOrder({ deliveryFeeCents: 800, driverTipCents: 200 });
    const candidate = makeCandidate({ driverId: 'driver-1', distanceMeters: 1609.344 });
    const fakes = makeFakes({ awaitingOrders: [order], candidates: [candidate] });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.offered).toBe(1);
    expect(summary.considered).toBe(1);
    expect(summary.errors).toBe(0);
    expect(fakes.findCandidates).toHaveBeenCalledWith(
      'disp-1',
      DEFAULT_SCORING_PARAMS.maxRadiusMeters,
    );
    expect(fakes.createOffer).toHaveBeenCalledTimes(1);
    const offerArg = fakes.createOffer.mock.calls[0]?.[0] as NewDispatchOffer;
    expect(offerArg).toMatchObject({
      orderId: 'order-1',
      driverId: 'driver-1',
      payoutEstimateCents: 1000,
      distanceMiles: '1.00',
      status: 'offered',
      offeredAt: NOW,
    });
    expect(offerArg.expiresAt.getTime()).toBe(
      NOW.getTime() + DEFAULT_ATTEMPT_PARAMS.perDriverBudgetMs,
    );
    expect(fakes.applyTransition).not.toHaveBeenCalled();
  });

  it('does not create a new offer when a live offer is in flight', async () => {
    const order = makeOrder();
    const liveOffer: DispatchOffer = {
      id: 'offer-live',
      orderId: 'order-1',
      driverId: 'driver-1',
      offeredAt: new Date(NOW.getTime() - 10_000),
      expiresAt: new Date(NOW.getTime() + 20_000),
      payoutEstimateCents: 1000,
      distanceMiles: '1.00',
      status: 'offered',
      respondedAt: null,
      declineReason: null,
    };
    const fakes = makeFakes({
      awaitingOrders: [order],
      candidates: [makeCandidate({ driverId: 'driver-2' })],
      history: [liveOffer],
    });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.waited).toBe(1);
    expect(summary.offered).toBe(0);
    expect(fakes.createOffer).not.toHaveBeenCalled();
    expect(fakes.applyTransition).not.toHaveBeenCalled();
  });

  it('waits (no transition) when the candidate pool is empty but budget remains', async () => {
    // The order entered awaiting_driver 30s ago; the 3-minute budget is
    // far from spent. An empty pool this tick must NOT fail the order —
    // it stays in awaiting_driver so a driver who comes online before the
    // budget elapses still gets it. This is the regression guard for the
    // production "order failed dispatch ~3s after placement" incident.
    const order = makeOrder();
    const fakes = makeFakes({ awaitingOrders: [order], candidates: [] });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.waitedNoCandidates).toBe(1);
    expect(summary.failedNoDrivers).toBe(0);
    expect(summary.offered).toBe(0);
    expect(fakes.applyTransition).not.toHaveBeenCalled();
    expect(fakes.createOffer).not.toHaveBeenCalled();
  });

  it('transitions to dispatch_failed (no_eligible_drivers) when the pool stays empty past the budget', async () => {
    // Order entered awaiting_driver 4 minutes ago (default budget 3min)
    // and no offer was ever sent (empty history) → no_eligible_drivers.
    const ancient = new Date(NOW.getTime() - 4 * 60_000);
    const order = makeOrder({ awaitingDriverAt: ancient });
    const fakes = makeFakes({ awaitingOrders: [order], candidates: [] });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.failedNoDrivers).toBe(1);
    expect(summary.waitedNoCandidates).toBe(0);
    expect(fakes.applyTransition).toHaveBeenCalledTimes(1);

    const [orderId, resolver] = fakes.applyTransition.mock.calls[0] as [string, TransitionResolver];
    expect(orderId).toBe('order-1');
    const decision = resolver({
      id: 'order-1',
      status: 'awaiting_driver',
      userId: 'user-1',
      dispensaryId: 'disp-1',
      driverId: null,
    });
    expect(decision).toMatchObject({
      toStatus: 'dispatch_failed',
      eventType: 'DISPATCH_FAILED',
      actorRole: 'system',
      payload: { reason: 'no_eligible_drivers' },
    });
  });

  it('transitions to dispatch_failed (budget_exhausted) when offers were made but the budget runs out', async () => {
    // Order entered awaiting_driver 4 minutes ago (default budget 3min);
    // an offer was made earlier and expired (non-empty history) → the
    // failure reason is budget_exhausted, not no_eligible_drivers.
    const ancient = new Date(NOW.getTime() - 4 * 60_000);
    const order = makeOrder({ awaitingDriverAt: ancient });
    const expiredOffer: DispatchOffer = {
      id: 'offer-expired',
      orderId: 'order-1',
      driverId: 'driver-1',
      offeredAt: new Date(NOW.getTime() - 3 * 60_000),
      expiresAt: new Date(NOW.getTime() - 2.5 * 60_000),
      payoutEstimateCents: 1000,
      distanceMiles: '1.00',
      status: 'expired',
      respondedAt: null,
      declineReason: null,
    };
    const fakes = makeFakes({
      awaitingOrders: [order],
      candidates: [makeCandidate()],
      history: [expiredOffer],
    });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.failedBudgetExhausted).toBe(1);
    expect(summary.failedNoDrivers).toBe(0);

    const [, resolver] = fakes.applyTransition.mock.calls[0] as [string, TransitionResolver];
    const decision = resolver({
      id: 'order-1',
      status: 'awaiting_driver',
      userId: 'user-1',
      dispensaryId: 'disp-1',
      driverId: null,
    });
    expect(decision.payload).toEqual({ reason: 'budget_exhausted' });
  });

  it('respects an injected attemptParams override (smaller per-driver window)', async () => {
    const order = makeOrder();
    const candidate = makeCandidate({ driverId: 'driver-1' });
    const fakes = makeFakes({ awaitingOrders: [order], candidates: [candidate] });
    const { logger } = makeLogger();

    const attemptParams: AttemptParams = { totalBudgetMs: 120_000, perDriverBudgetMs: 15_000 };

    await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
        attemptParams,
      },
    });

    const offerArg = fakes.createOffer.mock.calls[0]?.[0] as NewDispatchOffer;
    expect(offerArg.expiresAt.getTime()).toBe(NOW.getTime() + 15_000);
  });

  it('skips orders with no awaiting_driver_at timestamp and logs an error', async () => {
    const broken = makeOrder({ awaitingDriverAt: null });
    const fakes = makeFakes({ awaitingOrders: [broken] });
    const { logger, logs } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.skippedMissingTimestamp).toBe(1);
    expect(fakes.findCandidates).not.toHaveBeenCalled();
    expect(fakes.applyTransition).not.toHaveBeenCalled();
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'dispatch: order in awaiting_driver without awaiting_driver_at — skipping',
      }),
    );
  });

  it('marks an accept-in-flight order skippedAcceptInFlight and does not write', async () => {
    const order = makeOrder();
    const acceptedHistory: DispatchOffer = {
      id: 'offer-accepted',
      orderId: 'order-1',
      driverId: 'driver-1',
      offeredAt: new Date(NOW.getTime() - 20_000),
      expiresAt: new Date(NOW.getTime() + 10_000),
      payoutEstimateCents: 1000,
      distanceMiles: '1.00',
      status: 'accepted',
      respondedAt: new Date(NOW.getTime() - 1_000),
      declineReason: null,
    };
    const fakes = makeFakes({
      awaitingOrders: [order],
      candidates: [makeCandidate()],
      history: [acceptedHistory],
    });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.skippedAcceptInFlight).toBe(1);
    expect(fakes.createOffer).not.toHaveBeenCalled();
    expect(fakes.applyTransition).not.toHaveBeenCalled();
  });

  it('keeps processing remaining orders when one order throws', async () => {
    const failing = makeOrder({ id: 'order-fail' });
    const succeeding = makeOrder({ id: 'order-ok' });
    const fakes = makeFakes({
      awaitingOrders: [failing, succeeding],
      candidates: [makeCandidate({ driverId: 'driver-1' })],
    });
    // Make the candidate query fail only for the first order (simulating
    // a transient DB hiccup) — the tick must keep going and process the
    // second order successfully.
    fakes.findCandidates.mockImplementation(() => {
      if (fakes.findCandidates.mock.calls.length === 1) {
        return Promise.reject(new RepositoryError('transient db blip'));
      }
      return Promise.resolve([makeCandidate({ driverId: 'driver-1' })]);
    });
    const { logger, logs } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.considered).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.offered).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'dispatch: per-order failure',
      }),
    );
  });

  it('logs and swallows OrderError raised by applyTransition (concurrent transition)', async () => {
    // Budget exhausted (entered awaiting_driver 4min ago) + empty pool →
    // the tick reaches DISPATCH_FAILED, where applyTransition races a
    // concurrent transition and throws OrderError.
    const ancient = new Date(NOW.getTime() - 4 * 60_000);
    const order = makeOrder({ awaitingDriverAt: ancient });
    const fakes = makeFakes({
      awaitingOrders: [order],
      candidates: [],
      applyTransitionImpl: () => {
        throw OrderError.invalidTransition('canceled', 'DISPATCH_FAILED');
      },
    });
    const { logger, logs } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    // OrderError is caught inside the failOrder helper, so the per-order
    // outcome still counts as a "failed no drivers" attempt — the
    // tick-level error counter stays at 0 because nothing escaped.
    expect(summary.errors).toBe(0);
    expect(summary.failedNoDrivers).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'dispatch: DISPATCH_FAILED skipped — order moved out of awaiting_driver',
      }),
    );
  });

  it('rethrows non-OrderError failures from applyTransition (caught at tick level)', async () => {
    // Budget exhausted + empty pool → the tick reaches DISPATCH_FAILED;
    // a non-OrderError from applyTransition escapes failOrder and is
    // caught at the per-order boundary (errors counter, not failedNoDrivers).
    const ancient = new Date(NOW.getTime() - 4 * 60_000);
    const order = makeOrder({ awaitingDriverAt: ancient });
    const fakes = makeFakes({
      awaitingOrders: [order],
      candidates: [],
      applyTransitionImpl: () => {
        throw new RepositoryError('boom');
      },
    });
    const { logger } = makeLogger();

    const summary = await runDispatchJob({
      now: NOW,
      deps: {
        orders: fakes.orders,
        drivers: fakes.drivers,
        dispatchOffers: fakes.dispatchOffers,
        logger: logger as never,
      },
    });

    expect(summary.errors).toBe(1);
    expect(summary.failedNoDrivers).toBe(0);
  });
});

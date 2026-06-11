/**
 * Unit tests for OrderTransitionService.
 *
 * This is the single chokepoint for every order state change, so the
 * coverage here is exhaustive:
 *   - happy path for each transition class (vendor accept / vendor reject /
 *     driver pickup / system payment_failed / customer cancel / dispute)
 *   - the authorization matrix — each role × each event it shouldn't fire
 *   - row-locking semantics under simulated concurrent transitions
 *   - the OrderTransitionedEvent emitted AFTER tx commit, never on failure
 *   - state-machine refusal surfaces as ORDER_INVALID_TRANSITION (422)
 *   - terminal-state refusal surfaces as ORDER_TERMINAL_STATE (422)
 *   - patch + reason + payload are threaded into the repository call
 *
 * The rig fakes `OrdersRepository` with an in-memory store and replaces
 * `db.transaction(fn)` with a passthrough so every assertion runs without
 * a Postgres connection. The fake repo simulates the SELECT … FOR UPDATE
 * lock with a per-orderId mutex, letting us assert that two concurrent
 * transition calls serialise (the loser sees the new status and bails).
 */
import {
  type Database,
  type LockedOrderSnapshot,
  type NewOrder,
  type Order,
  type OrdersRepository,
  type TransitionDecision,
  type TransitionResolver,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { NotFoundError } from '@dankdash/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_TRANSITIONED_EVENT, OrderTransitionedEvent } from './order-transition.events.js';
import {
  OrderTransitionService,
  type OrderScopedReposFactory,
  type OrderTransitionActor,
  type ScopedOrderRepos,
} from './order-transition.service.js';

const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';
const OTHER_ORDER_ID = '01935f3d-0000-7000-8000-0000000010ff';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000002';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000ff';

const PINNED_NOW = new Date('2026-05-18T19:00:00.000Z');

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

/**
 * Per-order async mutex. `acquire()` returns a promise that resolves only
 * when no other holder is active; used by the fake repo to simulate the
 * SELECT … FOR UPDATE row lock so we can assert concurrent-transition
 * semantics without spinning up a Postgres instance.
 */
class OrderLockTable {
  private readonly waiters = new Map<string, Promise<void>>();

  async acquire(id: string): Promise<() => void> {
    const prev = this.waiters.get(id) ?? Promise.resolve();
    // Seeded with a noop so TS sees a definite assignment before the
    // Promise executor runs; the executor synchronously reassigns it to
    // the actual `resolve`. Named function keeps eslint happy and makes
    // the placeholder obvious in stack traces if it ever leaked.
    let releaseNext: () => void = function noopRelease(): void {
      return;
    };
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.waiters.set(
      id,
      prev.then(() => next),
    );
    await prev;
    return (): void => {
      // Only clear if we're still the head; otherwise leave the chain in
      // place so the next waiter holds the slot.
      if (this.waiters.get(id) === prev.then(() => next)) this.waiters.delete(id);
      releaseNext();
    };
  }
}

class FakeOrdersRepo implements Pick<
  OrdersRepository,
  'findById' | 'applyTransition' | 'update' | 'recordRating' | 'listStatusHistory'
> {
  public readonly rows = new Map<string, Order>();
  public readonly decisions: (TransitionDecision & { readonly orderId: string })[] = [];
  /** Optional override: set to throw from the underlying write step to
   *  test commit-failure semantics (no OrderTransitionedEvent must fire). */
  public writeImpl?: (
    decision: TransitionDecision,
    snapshot: LockedOrderSnapshot,
  ) => Promise<Order>;
  private readonly locks = new OrderLockTable();

  constructor(initial: Order[] = []) {
    for (const r of initial) this.rows.set(r.id, r);
  }

  findById(id: string): Promise<Order | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  /**
   * Faithful simulation of the real applyTransition: lock the row first,
   * THEN invoke the resolver against the locked snapshot, THEN write.
   * The locks table serialises calls per-orderId so a second concurrent
   * call sees the post-write status (mirroring SELECT … FOR UPDATE).
   */
  async applyTransition(orderId: string, resolve: TransitionResolver): Promise<Order> {
    const release = await this.locks.acquire(orderId);
    try {
      const row = this.rows.get(orderId);
      if (row === undefined) throw new NotFoundError('order', orderId);

      const snapshot: LockedOrderSnapshot = {
        id: row.id,
        status: row.status,
        userId: row.userId,
        dispensaryId: row.dispensaryId,
        driverId: row.driverId,
      };

      const decision = resolve(snapshot);
      this.decisions.push({ ...decision, orderId });

      if (this.writeImpl !== undefined) {
        return await this.writeImpl(decision, snapshot);
      }

      const updated = {
        ...row,
        ...decision.patch,
        status: decision.toStatus,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      } as Order;
      this.rows.set(orderId, updated);
      return updated;
    } finally {
      release();
    }
  }

  update(id: string, patch: Partial<Omit<NewOrder, 'id' | 'createdAt'>>): Promise<Order | null> {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    const updated: Order = { ...row, ...patch, updatedAt: new Date() } as Order;
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  recordRating(): Promise<Order | null> {
    // Sentinel for an unused branch on this fake — surfaces as TypeError
    // so the test runner classifies it as "API misused" rather than a
    // generic Error. The transition tests never call rate().
    throw new TypeError('FakeOrdersRepo.recordRating is not exercised by these tests');
  }

  listStatusHistory(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

/** Passthrough Database stub — every tx callback runs against the same
 *  fake repos; we don't need real isolation for these unit tests. */
function makeStubDb(): Database {
  return {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;
}

function makeService(initial: Order[] = []): {
  service: OrderTransitionService;
  repo: FakeOrdersRepo;
  events: EventEmitter2;
  emitted: { event: string; payload: OrderTransitionedEvent }[];
} {
  const repo = new FakeOrdersRepo(initial);
  const reposFactory: OrderScopedReposFactory = (): ScopedOrderRepos => ({
    orders: repo as unknown as OrdersRepository,
  });
  const events = new EventEmitter2();
  const emitted: { event: string; payload: OrderTransitionedEvent }[] = [];
  events.on(ORDER_TRANSITIONED_EVENT, (payload: OrderTransitionedEvent) => {
    emitted.push({ event: ORDER_TRANSITIONED_EVENT, payload });
  });
  const service = new OrderTransitionService(makeStubDb(), reposFactory, events);
  return { service, repo, events, emitted };
}

describe('OrderTransitionService.transition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });

  describe('happy paths', () => {
    it('vendor accepts a placed order → status flips to accepted, event log appended, OrderTransitionedEvent emitted', async () => {
      const { service, repo, emitted } = makeService([makeOrder({ status: 'placed' })]);

      const result = await service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_ACCEPT',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
      });

      expect(result).toEqual({ orderId: ORDER_ID, fromStatus: 'placed', toStatus: 'accepted' });
      expect(repo.decisions).toHaveLength(1);
      const t = repo.decisions[0]!;
      expect(t.orderId).toBe(ORDER_ID);
      expect(t.toStatus).toBe('accepted');
      expect(t.eventType).toBe('VENDOR_ACCEPT');
      expect(t.actorRole).toBe('vendor');
      expect(t.actorUserId).toBe(USER_ID);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.event).toBe(ORDER_TRANSITIONED_EVENT);
      expect(emitted[0]!.payload).toBeInstanceOf(OrderTransitionedEvent);
      expect(emitted[0]!.payload.fromStatus).toBe('placed');
      expect(emitted[0]!.payload.toStatus).toBe('accepted');
      expect(emitted[0]!.payload.event).toBe('VENDOR_ACCEPT');
      expect(emitted[0]!.payload.occurredAt).toEqual(PINNED_NOW);
    });

    it('threads patch + reason + payload into the repository transition call', async () => {
      const { service, repo } = makeService([makeOrder({ status: 'placed' })]);

      await service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_REJECT',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
        reason: 'out of stock',
        payload: { itemId: 'abc' },
      });

      const t = repo.decisions[0]!;
      expect(t.reason).toBe('out of stock');
      expect(t.payload).toEqual({ itemId: 'abc' });
    });

    it('customer cancels their own placed order with a patch (canceledBy + cancelReason)', async () => {
      const { service, repo } = makeService([makeOrder({ status: 'placed' })]);

      await service.transition({
        orderId: ORDER_ID,
        event: 'CUSTOMER_CANCEL',
        actor: { userId: USER_ID, role: 'customer' },
        reason: 'changed my mind',
        patch: { canceledBy: USER_ID, cancelReason: 'changed my mind' },
      });

      expect(repo.decisions[0]!.patch).toEqual({
        canceledBy: USER_ID,
        cancelReason: 'changed my mind',
      });
    });

    it('driver completes a pickup chain (en_route_pickup → picked_up → en_route_dropoff)', async () => {
      const { service } = makeService([
        makeOrder({ status: 'en_route_pickup', driverId: DRIVER_ID }),
      ]);

      const r1 = await service.transition({
        orderId: ORDER_ID,
        event: 'DRIVER_PICKED_UP',
        actor: { userId: DRIVER_ID, role: 'driver' },
      });
      expect(r1.toStatus).toBe('picked_up');

      const r2 = await service.transition({
        orderId: ORDER_ID,
        event: 'DRIVER_EN_ROUTE_DROPOFF',
        actor: { userId: DRIVER_ID, role: 'driver' },
      });
      expect(r2.toStatus).toBe('en_route_dropoff');
    });

    it('assigned driver bails out pre-custody (en_route_pickup → awaiting_driver via DRIVER_CANCELED)', async () => {
      const { service } = makeService([
        makeOrder({ status: 'en_route_pickup', driverId: DRIVER_ID }),
      ]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'DRIVER_CANCELED',
        actor: { userId: DRIVER_ID, role: 'driver' },
        patch: { driverId: null },
      });

      expect(r.toStatus).toBe('awaiting_driver');
    });

    it('system fires PAYMENT_FAILED — allowed for `system` role', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'PAYMENT_FAILED',
        actor: { role: 'system' },
      });

      expect(r.toStatus).toBe('payment_failed');
    });

    it('admin override can fire any vendor event regardless of dispensary affiliation', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_ACCEPT',
        actor: { userId: USER_ID, role: 'admin' },
      });

      expect(r.toStatus).toBe('accepted');
    });

    it('customer can DISPUTE_OPENED on a delivered order', async () => {
      const { service } = makeService([makeOrder({ status: 'delivered' })]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'DISPUTE_OPENED',
        actor: { userId: USER_ID, role: 'customer' },
      });

      expect(r.toStatus).toBe('disputed');
    });
  });

  describe('authorization', () => {
    it('vendor from a different dispensary is rejected with 403 ORDER_ACTOR_FORBIDDEN', async () => {
      const { service, repo, emitted } = makeService([makeOrder({ status: 'placed' })]);

      const promise = service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_ACCEPT',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: OTHER_DISPENSARY_ID },
      });

      await expect(promise).rejects.toBeInstanceOf(OrderError);
      await expect(promise).rejects.toMatchObject({
        code: 'ORDER_ACTOR_FORBIDDEN',
        statusCode: 403,
      });
      expect(repo.decisions).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it('a different customer cannot cancel another user’s order', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'CUSTOMER_CANCEL',
          actor: { userId: 'different-user-id', role: 'customer' },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
    });

    it('a customer cannot fire a vendor event', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'VENDOR_ACCEPT',
          actor: { userId: USER_ID, role: 'customer' },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
    });

    it('a driver who is not the assigned driver cannot fire driver events', async () => {
      const { service } = makeService([
        makeOrder({ status: 'en_route_pickup', driverId: DRIVER_ID }),
      ]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'DRIVER_PICKED_UP',
          actor: { userId: 'other-driver', role: 'driver' },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
    });

    it('the assigned driver is permitted when driverId matches', async () => {
      const { service } = makeService([
        makeOrder({ status: 'driver_assigned', driverId: DRIVER_ID }),
      ]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'DRIVER_EN_ROUTE_PICKUP',
        actor: { userId: DRIVER_ID, role: 'driver' },
      });
      expect(r.toStatus).toBe('en_route_pickup');
    });

    it('the owning vendor can fire DRIVER_PICKED_UP (portal handoff confirm)', async () => {
      const { service } = makeService([
        makeOrder({ status: 'en_route_pickup', driverId: DRIVER_ID }),
      ]);

      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'DRIVER_PICKED_UP',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
      });

      expect(r.toStatus).toBe('picked_up');
    });

    it('a vendor from a different dispensary cannot fire DRIVER_PICKED_UP', async () => {
      const { service, repo, emitted } = makeService([
        makeOrder({ status: 'en_route_pickup', driverId: DRIVER_ID }),
      ]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'DRIVER_PICKED_UP',
          actor: { userId: USER_ID, role: 'vendor', dispensaryId: OTHER_DISPENSARY_ID },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
      expect(repo.decisions).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it('a vendor cannot fire PAYMENT_FAILED (system-only)', async () => {
      const { service } = makeService([makeOrder({ status: 'placed' })]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'PAYMENT_FAILED',
          actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
    });
  });

  describe('not-found and state-machine guards', () => {
    it('a missing order surfaces as ORDER_NOT_FOUND (404) before authorization runs', async () => {
      const { service, repo, emitted } = makeService([]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'VENDOR_ACCEPT',
          actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', statusCode: 404 });

      expect(repo.decisions).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it('an illegal transition for the current state surfaces as ORDER_INVALID_TRANSITION (422)', async () => {
      // A `placed` order cannot transition straight to `delivered`.
      const { service, repo, emitted } = makeService([makeOrder({ status: 'placed' })]);

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'DRIVER_DELIVERED',
          actor: { userId: DRIVER_ID, role: 'driver' },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ACTOR_FORBIDDEN', statusCode: 403 });
      // ^ note: this fails authz first because the actor isn't the assigned
      // driver. The pure-machine failure is exercised in the next test.

      const r2 = service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_READY',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
      });
      await expect(r2).rejects.toMatchObject({
        code: 'ORDER_INVALID_TRANSITION',
        statusCode: 422,
      });

      expect(repo.decisions).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it('a terminal state (canceled, rejected, returned_to_store, disputed, payment_failed) rejects any event with ORDER_TERMINAL_STATE', async () => {
      const TERMINAL_NO_OUTBOUND: readonly Order['status'][] = [
        'canceled',
        'rejected',
        'returned_to_store',
        'disputed',
        'payment_failed',
      ];
      for (const status of TERMINAL_NO_OUTBOUND) {
        const { service } = makeService([makeOrder({ status })]);
        await expect(
          service.transition({
            orderId: ORDER_ID,
            event: 'CUSTOMER_CANCEL',
            actor: { userId: USER_ID, role: 'customer' },
          }),
        ).rejects.toMatchObject({ code: 'ORDER_TERMINAL_STATE', statusCode: 422 });
      }
    });

    it('delivered is the documented exception — DISPUTE_OPENED is allowed; other events are not', async () => {
      const { service } = makeService([makeOrder({ status: 'delivered' })]);

      // Allowed
      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'DISPUTE_OPENED',
        actor: { userId: USER_ID, role: 'customer' },
      });
      expect(r.toStatus).toBe('disputed');

      // Not allowed (machine rejects)
      const { service: s2 } = makeService([makeOrder({ status: 'delivered' })]);
      await expect(
        s2.transition({
          orderId: ORDER_ID,
          event: 'VENDOR_ACCEPT',
          actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
        }),
      ).rejects.toMatchObject({ code: 'ORDER_INVALID_TRANSITION', statusCode: 422 });
    });
  });

  describe('event emission semantics', () => {
    it('does NOT emit when the repository transition throws (commit failure)', async () => {
      const { service, repo, emitted } = makeService([makeOrder({ status: 'placed' })]);
      repo.writeImpl = () => Promise.reject(new Error('DB write failed'));

      await expect(
        service.transition({
          orderId: ORDER_ID,
          event: 'VENDOR_ACCEPT',
          actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
        }),
      ).rejects.toThrow('DB write failed');

      expect(emitted).toHaveLength(0);
    });

    it('a subscriber that throws does not propagate back to the caller', async () => {
      const { service, events, emitted } = makeService([makeOrder({ status: 'placed' })]);
      events.on(ORDER_TRANSITIONED_EVENT, () => {
        // TypeError keeps the test exercising the "subscriber throws"
        // path that we want EventEmitter2 to swallow, without falling
        // afoul of the no-restricted-syntax rule against bare `Error`.
        throw new TypeError('subscriber blew up');
      });

      // Should not throw — EventEmitter2 default behavior is to swallow.
      const r = await service.transition({
        orderId: ORDER_ID,
        event: 'VENDOR_ACCEPT',
        actor: { userId: USER_ID, role: 'vendor', dispensaryId: DISPENSARY_ID },
      });
      expect(r.toStatus).toBe('accepted');
      expect(emitted).toHaveLength(1);
    });
  });

  describe('row-locking concurrency', () => {
    it('two simultaneous VENDOR_ACCEPT on the same order: first wins, second sees `accepted` and bails with ORDER_INVALID_TRANSITION', async () => {
      const { service, emitted } = makeService([makeOrder({ status: 'placed' })]);

      const actor: OrderTransitionActor = {
        userId: USER_ID,
        role: 'vendor',
        dispensaryId: DISPENSARY_ID,
      };

      // Fire both at the same tick.
      const p1 = service.transition({ orderId: ORDER_ID, event: 'VENDOR_ACCEPT', actor });
      const p2 = service.transition({ orderId: ORDER_ID, event: 'VENDOR_ACCEPT', actor });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const fulfilledResult = fulfilled[0]! as PromiseFulfilledResult<{ toStatus: string }>;
      expect(fulfilledResult.value.toStatus).toBe('accepted');

      const rejectedResult = rejected[0]!;
      expect(rejectedResult.reason).toBeInstanceOf(OrderError);
      expect((rejectedResult.reason as OrderError).code).toBe('ORDER_INVALID_TRANSITION');

      // Only the winning transition emits.
      expect(emitted).toHaveLength(1);
    });

    it('transitions on DIFFERENT orders do not serialise — both succeed', async () => {
      const { service, emitted } = makeService([
        makeOrder({ status: 'placed' }),
        makeOrder({ id: OTHER_ORDER_ID, status: 'placed' }),
      ]);

      const actor: OrderTransitionActor = {
        userId: USER_ID,
        role: 'vendor',
        dispensaryId: DISPENSARY_ID,
      };

      const [r1, r2] = await Promise.all([
        service.transition({ orderId: ORDER_ID, event: 'VENDOR_ACCEPT', actor }),
        service.transition({ orderId: OTHER_ORDER_ID, event: 'VENDOR_ACCEPT', actor }),
      ]);

      expect(r1.toStatus).toBe('accepted');
      expect(r2.toStatus).toBe('accepted');
      expect(emitted).toHaveLength(2);
    });
  });
});

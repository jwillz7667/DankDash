/**
 * Unit tests for OrdersService — the read/projection + rating-write surface.
 * Status transitions live in OrderTransitionService and are tested there;
 * this file proves cross-tenant scoping (404 not 403 on a mismatch), the
 * `delivered`/`disputed` guard on recordRating, and the rating field patch
 * thread-through.
 */
import {
  type Database,
  type NewOrder,
  type Order,
  type OrdersRepository,
  type OrderStatus,
  type VendorQueueOrderRow,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrdersService,
  type OrdersScopedRepos,
  type OrdersScopedReposFactory,
} from './orders.service.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000fe';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';

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

class FakeOrdersRepo implements Pick<
  OrdersRepository,
  'findById' | 'listForUser' | 'listForDispensary' | 'listForDispensaryQueue' | 'update'
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

function makeService(initial: Order[] = []): { service: OrdersService; repo: FakeOrdersRepo } {
  const repo = new FakeOrdersRepo(initial);
  const reposFactory: OrdersScopedReposFactory = (): OrdersScopedRepos => ({
    orders: repo as unknown as OrdersRepository,
  });
  return { service: new OrdersService(makeStubDb(), reposFactory), repo };
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
});

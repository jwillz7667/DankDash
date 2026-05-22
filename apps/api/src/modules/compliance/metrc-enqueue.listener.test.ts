/**
 * Unit tests for `MetrcEnqueueListener`.
 *
 * The listener is the only writer of `metric_transactions` rows in the
 * `pending` state, so its behaviour around the order state machine is
 * load-bearing for Metrc compliance:
 *   - filters down to `toStatus === 'delivered'` only
 *   - obeys `ENABLE_METRC` so dev environments don't backlog
 *   - is idempotent under duplicate `OrderTransitionedEvent` (the
 *     `metric_transactions.order_id` UNIQUE constraint trips SQLSTATE
 *     23505, which we map to a no-op)
 *   - swallows every other DB/repo error so a listener fault never
 *     bubbles back to the HTTP response that emitted the event
 *   - still inserts (and warns) on an empty `packageTags` array, so the
 *     row surfaces in the admin failed-list rather than silently dying
 *
 * The rig uses hand-rolled fakes for both repositories rather than a
 * Drizzle stub — the listener only needs `listForOrder` and `create`,
 * and the tests should fail when the listener's contract with the repo
 * changes, not when an unrelated query shape moves.
 */
import {
  type MetrcTransaction,
  type MetrcTransactionsRepository,
  type NewMetrcTransaction,
  type OrderItem,
  type OrderItemsRepository,
} from '@dankdash/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';
import { type OrderTransitionActor } from '../orders/order-transition.service.js';
import { MetrcEnqueueListener } from './metrc-enqueue.listener.js';

const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';
const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000002';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000050';
const TX_ID = '01935f3d-0000-7000-8000-000000002001';
const PINNED_NOW = new Date('2026-05-19T17:00:00.000Z');

const DRIVER_ACTOR: OrderTransitionActor = { role: 'driver', userId: DRIVER_USER_ID };

function makeOrderItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: '01935f3d-0000-7000-8000-000000000100',
    orderId: ORDER_ID,
    listingId: LISTING_ID,
    productSnapshot: { name: 'Test Product' },
    metrcPackageTag: '1A4FF0100000000000000001',
    quantity: 1,
    unitPriceCents: 2500,
    lineSubtotalCents: 2500,
    thcMgTotal: '100.000',
    cbdMgTotal: '0.000',
    weightGramsTotal: '3.500',
    cannabisTaxCents: 250,
    salesTaxCents: 175,
    createdAt: PINNED_NOW,
    ...overrides,
  };
}

function makeMetricRow(overrides: Partial<MetrcTransaction> = {}): MetrcTransaction {
  return {
    id: TX_ID,
    orderId: ORDER_ID,
    packageTags: ['1A4FF0100000000000000001'],
    status: 'pending',
    retryCount: 0,
    nextRetryAt: PINNED_NOW,
    reportedAt: null,
    metrcReceiptId: null,
    responsePayload: null,
    failureReason: null,
    createdAt: PINNED_NOW,
    updatedAt: PINNED_NOW,
    ...overrides,
  };
}

function makeTransitionedEvent(
  overrides: Partial<OrderTransitionedEvent> = {},
): OrderTransitionedEvent {
  return new OrderTransitionedEvent({
    orderId: ORDER_ID,
    fromStatus: 'arrived_at_dropoff',
    toStatus: 'delivered',
    event: 'DRIVER_DELIVERED',
    actor: DRIVER_ACTOR,
    occurredAt: PINNED_NOW,
    ...overrides,
  });
}

class FakeOrderItems {
  public readonly listForOrder = vi.fn<(orderId: string) => Promise<readonly OrderItem[]>>();
}

class FakeMetric {
  public readonly create =
    vi.fn<
      (
        input: Omit<NewMetrcTransaction, 'id'> & { readonly id?: string },
      ) => Promise<MetrcTransaction>
    >();
}

function uniqueViolation(message = 'duplicate key value violates unique constraint'): Error {
  const err = new Error(message);
  (err as { code?: string }).code = '23505';
  return err;
}

function newListener({
  orderItems,
  metric,
  enabled = true,
}: {
  orderItems: FakeOrderItems;
  metric: FakeMetric;
  enabled?: boolean;
}): MetrcEnqueueListener {
  return new MetrcEnqueueListener({
    orderItems: orderItems as unknown as OrderItemsRepository,
    metric: metric as unknown as MetrcTransactionsRepository,
    enabled,
  });
}

describe('MetrcEnqueueListener', () => {
  let orderItems: FakeOrderItems;
  let metric: FakeMetric;

  beforeEach(() => {
    orderItems = new FakeOrderItems();
    metric = new FakeMetric();
  });

  it('subscribes its handler to ORDER_TRANSITIONED_EVENT', () => {
    // EventEmitter2's `@OnEvent` decorator stamps metadata directly on
    // the method function (extendArrayMetadata against `descriptor.value`).
    // We read from the function rather than booting Nest so a rename of
    // the event constant fails this test, not a runtime regression in
    // integration.
    // unbound-method off: we are reading reflect metadata off the
    // function value itself, never invoking it — `this` is irrelevant.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = MetrcEnqueueListener.prototype.onOrderTransitioned;
    const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as
      | ReadonlyArray<{ event: unknown }>
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.[0]?.event).toBe(ORDER_TRANSITIONED_EVENT);
    expect(ORDER_TRANSITIONED_EVENT).toBe('order.transitioned');
  });

  it('enqueues a pending metric_transactions row on order → delivered', async () => {
    orderItems.listForOrder.mockResolvedValueOnce([
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000001' }),
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000002' }),
    ]);
    metric.create.mockResolvedValueOnce(
      makeMetricRow({ packageTags: ['1A4FF0100000000000000001', '1A4FF0100000000000000002'] }),
    );
    const listener = newListener({ orderItems, metric });

    await listener.onOrderTransitioned(makeTransitionedEvent());

    expect(orderItems.listForOrder).toHaveBeenCalledOnce();
    expect(orderItems.listForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(metric.create).toHaveBeenCalledOnce();
    expect(metric.create).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      packageTags: ['1A4FF0100000000000000001', '1A4FF0100000000000000002'],
      status: 'pending',
    });
  });

  it('ignores transitions that do not end in delivered', async () => {
    const listener = newListener({ orderItems, metric });
    const states = [
      { toStatus: 'accepted' as const, event: 'VENDOR_ACCEPT' as const },
      { toStatus: 'prepping' as const, event: 'VENDOR_PREPPING' as const },
      { toStatus: 'en_route_dropoff' as const, event: 'DRIVER_EN_ROUTE_DROPOFF' as const },
      { toStatus: 'canceled' as const, event: 'CUSTOMER_CANCEL' as const },
      { toStatus: 'rejected' as const, event: 'VENDOR_REJECT' as const },
    ];
    for (const { toStatus, event } of states) {
      await listener.onOrderTransitioned(
        makeTransitionedEvent({ toStatus, fromStatus: 'placed', event }),
      );
    }
    expect(orderItems.listForOrder).not.toHaveBeenCalled();
    expect(metric.create).not.toHaveBeenCalled();
  });

  it('skips enqueue when ENABLE_METRC is false', async () => {
    const listener = newListener({ orderItems, metric, enabled: false });

    await listener.onOrderTransitioned(makeTransitionedEvent());

    expect(orderItems.listForOrder).not.toHaveBeenCalled();
    expect(metric.create).not.toHaveBeenCalled();
  });

  it('filters null metrcPackageTags out of the inserted array', async () => {
    orderItems.listForOrder.mockResolvedValueOnce([
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000001' }),
      makeOrderItem({ metrcPackageTag: null }),
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000003' }),
    ]);
    metric.create.mockResolvedValueOnce(
      makeMetricRow({ packageTags: ['1A4FF0100000000000000001', '1A4FF0100000000000000003'] }),
    );
    const listener = newListener({ orderItems, metric });

    await listener.onOrderTransitioned(makeTransitionedEvent());

    expect(metric.create).toHaveBeenCalledOnce();
    expect(metric.create).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      packageTags: ['1A4FF0100000000000000001', '1A4FF0100000000000000003'],
      status: 'pending',
    });
  });

  it('still inserts (with empty tags) when every order item has a null tag — worker surfaces it', async () => {
    // The decision recorded in the listener docstring: an untagged
    // order is a data-integrity bug; we'd rather create a row that
    // fails terminal in the worker than drop it silently in a log
    // line nobody is paged on.
    orderItems.listForOrder.mockResolvedValueOnce([
      makeOrderItem({ metrcPackageTag: null }),
      makeOrderItem({ metrcPackageTag: null }),
    ]);
    metric.create.mockResolvedValueOnce(makeMetricRow({ packageTags: [] }));
    const listener = newListener({ orderItems, metric });

    await listener.onOrderTransitioned(makeTransitionedEvent());

    expect(metric.create).toHaveBeenCalledOnce();
    expect(metric.create).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      packageTags: [],
      status: 'pending',
    });
  });

  it('is idempotent under duplicate ORDER_TRANSITIONED_EVENT (SQLSTATE 23505 → no-op)', async () => {
    orderItems.listForOrder.mockResolvedValue([
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000001' }),
    ]);
    metric.create.mockRejectedValueOnce(uniqueViolation());
    const listener = newListener({ orderItems, metric });

    await expect(listener.onOrderTransitioned(makeTransitionedEvent())).resolves.toBeUndefined();
    expect(metric.create).toHaveBeenCalledOnce();
  });

  it('swallows non-unique repository errors so the event-emit caller is unaffected', async () => {
    orderItems.listForOrder.mockResolvedValueOnce([
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000001' }),
    ]);
    metric.create.mockRejectedValueOnce(new Error('connection terminated'));
    const listener = newListener({ orderItems, metric });

    await expect(listener.onOrderTransitioned(makeTransitionedEvent())).resolves.toBeUndefined();
  });

  it('swallows listForOrder errors too — the transition is durable, we just lose the enqueue', async () => {
    orderItems.listForOrder.mockRejectedValueOnce(
      new Error('table missing during botched migration'),
    );
    const listener = newListener({ orderItems, metric });

    await expect(listener.onOrderTransitioned(makeTransitionedEvent())).resolves.toBeUndefined();
    expect(metric.create).not.toHaveBeenCalled();
  });

  it('treats non-Error rejections sanely (string thrown, object thrown)', async () => {
    orderItems.listForOrder.mockResolvedValue([
      makeOrderItem({ metrcPackageTag: '1A4FF0100000000000000001' }),
    ]);
    // The branch in the listener that calls `String(err)` on a non-Error
    // is otherwise un-exercised; assert both legs don't crash.
    metric.create.mockRejectedValueOnce('raw string failure');
    const listener = newListener({ orderItems, metric });
    await expect(listener.onOrderTransitioned(makeTransitionedEvent())).resolves.toBeUndefined();

    metric.create.mockRejectedValueOnce({ unexpected: 'shape' });
    await expect(listener.onOrderTransitioned(makeTransitionedEvent())).resolves.toBeUndefined();
  });
});

/**
 * Unit tests for OrderRealtimeListener — pins the envelope shape the
 * realtime service depends on (`apps/realtime/src/streams/router.ts`
 * forwards on `order:status_changed`), the customer / dispensary /
 * driver IDs sourced from the locked-and-committed order row (not the
 * in-process event payload), and the error-swallowing contract the
 * EventEmitter2 caller relies on — a listener fault must never bubble
 * back into the HTTP response that triggered the transition.
 */
import { type Order, type OrdersRepository } from '@dankdash/db';
import { REALTIME_STREAM_KEY } from '@dankdash/realtime-events';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';
import { OrderRealtimeListener } from './order-realtime.listener.js';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const DRIVER_ID = '01935f3d-0000-7000-8000-000000000020';
const ENVELOPE_ID = '01935f3d-0000-7000-8000-0000000000ee';
const PINNED_NOW = new Date('2026-05-19T17:00:00.000Z');
const OCCURRED_AT = new Date('2026-05-19T16:59:30.000Z');
const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'AB123',
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-0000000000ff',
    status: 'accepted',
    statusChangedAt: OCCURRED_AT,
    subtotalCents: 5_000,
    cannabisTaxCents: 500,
    salesTaxCents: 250,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 0,
    totalCents: 6_250,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: CREATED_AT,
    paymentFailedAt: null,
    acceptedAt: OCCURRED_AT,
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

function buildEvent(overrides: Partial<OrderTransitionedEvent> = {}): OrderTransitionedEvent {
  return new OrderTransitionedEvent({
    orderId: ORDER_ID,
    fromStatus: 'placed',
    toStatus: 'accepted',
    event: 'VENDOR_ACCEPT',
    actor: { role: 'system' },
    occurredAt: OCCURRED_AT,
    ...overrides,
  });
}

class FakeRedis {
  xadd = vi.fn();
}

class FakeOrders {
  rowsById = new Map<string, Order>();
  findById = vi.fn(
    (id: string): Promise<Order | null> => Promise.resolve(this.rowsById.get(id) ?? null),
  );
}

interface Harness {
  readonly listener: OrderRealtimeListener;
  readonly redis: FakeRedis;
  readonly orders: FakeOrders;
}

function buildHarness(): Harness {
  const redis = new FakeRedis();
  redis.xadd.mockResolvedValue('1700000000000-0');
  const orders = new FakeOrders();
  const listener = new OrderRealtimeListener({
    redis: redis as unknown as Redis,
    orders: orders as unknown as OrdersRepository,
    idGen: () => ENVELOPE_ID,
    now: () => PINNED_NOW,
  });
  return { listener, redis, orders };
}

describe('OrderRealtimeListener', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.orders.rowsById.set(ORDER_ID, buildOrder());
  });

  it('subscribes its handler to ORDER_TRANSITIONED_EVENT', () => {
    // EventEmitter2's `@OnEvent` decorator stamps metadata on the
    // method's function value. Read the metadata directly rather than
    // booting Nest so a desync between producer and subscriber surfaces
    // here, not at runtime under load.
    const handler = OrderRealtimeListener.prototype.onOrderTransitioned;
    const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as
      | ReadonlyArray<{ event: unknown }>
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.[0]?.event).toBe(ORDER_TRANSITIONED_EVENT);
    expect(ORDER_TRANSITIONED_EVENT).toBe('order.transitioned');
  });

  it('publishes an order:status_changed envelope to the realtime stream', async () => {
    await h.listener.onOrderTransitioned(buildEvent());

    expect(h.redis.xadd).toHaveBeenCalledOnce();
    const call = h.redis.xadd.mock.calls[0] as string[];
    expect(call[0]).toBe(REALTIME_STREAM_KEY);
    expect(call[1]).toBe('MAXLEN');
    expect(call[2]).toBe('~');
    expect(call[3]).toBe('100000');
    expect(call[4]).toBe('*');
    expect(call[5]).toBe('envelope');
    const envelope = JSON.parse(call[6] ?? '{}') as unknown;
    expect(envelope).toEqual({
      id: ENVELOPE_ID,
      emittedAt: PINNED_NOW.toISOString(),
      source: 'api',
      event: {
        type: 'order:status_changed',
        payload: {
          orderId: ORDER_ID,
          customerId: USER_ID,
          dispensaryId: DISPENSARY_ID,
          driverId: null,
          fromStatus: 'placed',
          toStatus: 'accepted',
          changedAt: OCCURRED_AT.toISOString(),
        },
      },
    });
  });

  it('sources driverId from the order row when one is assigned', async () => {
    h.orders.rowsById.set(ORDER_ID, buildOrder({ driverId: DRIVER_ID, status: 'picked_up' }));

    await h.listener.onOrderTransitioned(
      buildEvent({
        fromStatus: 'en_route_pickup',
        toStatus: 'picked_up',
        event: 'DRIVER_PICKED_UP',
      }),
    );

    const call = h.redis.xadd.mock.calls[0] as string[];
    const envelope = JSON.parse(call[6] ?? '{}') as {
      event: { payload: { driverId: string | null; fromStatus: string; toStatus: string } };
    };
    expect(envelope.event.payload.driverId).toBe(DRIVER_ID);
    expect(envelope.event.payload.fromStatus).toBe('en_route_pickup');
    expect(envelope.event.payload.toStatus).toBe('picked_up');
  });

  it('looks up the order via OrdersRepository.findById', async () => {
    await h.listener.onOrderTransitioned(buildEvent());

    expect(h.orders.findById).toHaveBeenCalledOnce();
    expect(h.orders.findById).toHaveBeenCalledWith(ORDER_ID);
  });

  it('does not publish when the order row cannot be resolved post-commit', async () => {
    // Theoretical only — the transition tx commits the row before this
    // listener fires — but the guard is there and must not throw.
    h.orders.rowsById.clear();

    await h.listener.onOrderTransitioned(buildEvent());

    expect(h.redis.xadd).not.toHaveBeenCalled();
  });

  it('swallows xadd / publishRealtimeEvent rejections', async () => {
    h.redis.xadd.mockRejectedValueOnce(new Error('redis is down'));

    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();
  });

  it('swallows OrdersRepository.findById rejections', async () => {
    h.orders.findById.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();
    expect(h.redis.xadd).not.toHaveBeenCalled();
  });

  it('treats non-Error rejections without crashing', async () => {
    h.redis.xadd.mockRejectedValueOnce('string failure');
    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();

    h.redis.xadd.mockRejectedValueOnce({ unexpected: 'shape' });
    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();
  });

  it('defaults idGen + now when callers omit them', () => {
    const listener = new OrderRealtimeListener({
      redis: {} as Redis,
      orders: {} as OrdersRepository,
    });
    expect(listener).toBeInstanceOf(OrderRealtimeListener);
  });
});

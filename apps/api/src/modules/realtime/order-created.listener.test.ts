/**
 * Unit tests for OrderCreatedListener — pins the `order:created` envelope
 * the realtime service forwards to the vendor portal (the new-order chime
 * + queue-card insert), the post-commit at-least-once contract, and the
 * error-swallowing guarantee (a failed publish must never bubble back into
 * the checkout HTTP response that triggered it).
 */
import { REALTIME_STREAM_KEY } from '@dankdash/realtime-events';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_PLACED_EVENT, OrderPlacedEvent } from '../orders/order-placed.events.js';
import { OrderCreatedListener } from './order-created.listener.js';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const ENVELOPE_ID = '01935f3d-0000-7000-8000-0000000000ee';
const PINNED_NOW = new Date('2026-05-19T17:00:00.000Z');
const PLACED_AT = new Date('2026-05-19T16:59:55.000Z');

function buildEvent(overrides: Partial<OrderPlacedEvent> = {}): OrderPlacedEvent {
  return new OrderPlacedEvent({
    orderId: ORDER_ID,
    customerId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    shortCode: 'AB123',
    totalCents: 6_250,
    status: 'placed',
    placedAt: PLACED_AT,
    ...overrides,
  });
}

class FakeRedis {
  xadd = vi.fn();
}

interface Harness {
  readonly listener: OrderCreatedListener;
  readonly redis: FakeRedis;
}

function buildHarness(): Harness {
  const redis = new FakeRedis();
  redis.xadd.mockResolvedValue('1700000000000-0');
  const listener = new OrderCreatedListener({
    redis: redis as unknown as Redis,
    idGen: () => ENVELOPE_ID,
    now: () => PINNED_NOW,
  });
  return { listener, redis };
}

describe('OrderCreatedListener', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('subscribes its handler to ORDER_PLACED_EVENT', () => {
    const handler = OrderCreatedListener.prototype.onOrderPlaced;
    const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as
      | ReadonlyArray<{ event: unknown }>
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.[0]?.event).toBe(ORDER_PLACED_EVENT);
    expect(ORDER_PLACED_EVENT).toBe('order.placed');
  });

  it('publishes an order:created envelope to the realtime stream', async () => {
    await h.listener.onOrderPlaced(buildEvent());

    expect(h.redis.xadd).toHaveBeenCalledOnce();
    const call = h.redis.xadd.mock.calls[0] as string[];
    expect(call[0]).toBe(REALTIME_STREAM_KEY);
    expect(call[5]).toBe('envelope');
    const envelope = JSON.parse(call[6] ?? '{}') as unknown;
    expect(envelope).toEqual({
      id: ENVELOPE_ID,
      emittedAt: PINNED_NOW.toISOString(),
      source: 'api',
      event: {
        type: 'order:created',
        payload: {
          orderId: ORDER_ID,
          customerId: USER_ID,
          dispensaryId: DISPENSARY_ID,
          shortCode: 'AB123',
          totalCents: 6_250,
          status: 'placed',
          placedAt: PLACED_AT.toISOString(),
        },
      },
    });
  });

  it('swallows xadd / publishRealtimeEvent rejections', async () => {
    h.redis.xadd.mockRejectedValueOnce(new Error('redis is down'));
    await expect(h.listener.onOrderPlaced(buildEvent())).resolves.toBeUndefined();
  });

  it('treats non-Error rejections without crashing', async () => {
    h.redis.xadd.mockRejectedValueOnce('string failure');
    await expect(h.listener.onOrderPlaced(buildEvent())).resolves.toBeUndefined();
  });

  it('defaults idGen + now when callers omit them', () => {
    const listener = new OrderCreatedListener({ redis: {} as Redis });
    expect(listener).toBeInstanceOf(OrderCreatedListener);
  });
});

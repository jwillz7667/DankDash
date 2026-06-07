/**
 * Unit tests for OrderDispatchQueueListener — the auto-dispatch bridge
 * that turns a vendor "ready" into a dispatchable `awaiting_driver` job.
 *
 * Pins: (1) it fires the system `DISPATCH_QUEUE` event exactly once, and
 * only when an order enters `ready_for_pickup`; (2) every other transition
 * is a no-op (so the follow-on `awaiting_driver` event it triggers does not
 * loop); (3) a benign `ORDER_INVALID_TRANSITION` (duplicate event / already
 * dispatched) is swallowed; (4) any other fault is swallowed too — the
 * EventEmitter2 caller must never see a rejection, since the triggering
 * transition has already committed.
 */
import { OrderError } from '@dankdash/orders';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_TRANSITIONED_EVENT, OrderTransitionedEvent } from './order-transition.events.js';
import { OrderDispatchQueueListener } from './order-dispatch-queue.listener.js';
import type { OrderTransitionService } from './order-transition.service.js';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const OCCURRED_AT = new Date('2026-05-19T16:59:30.000Z');

function buildEvent(overrides: Partial<OrderTransitionedEvent> = {}): OrderTransitionedEvent {
  return new OrderTransitionedEvent({
    orderId: ORDER_ID,
    fromStatus: 'prepping',
    toStatus: 'ready_for_pickup',
    event: 'VENDOR_READY',
    actor: { role: 'vendor', dispensaryId: '01935f3d-0000-7000-8000-000000000010' },
    occurredAt: OCCURRED_AT,
    ...overrides,
  });
}

interface Harness {
  readonly listener: OrderDispatchQueueListener;
  readonly transition: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  const transition = vi.fn().mockResolvedValue({
    orderId: ORDER_ID,
    fromStatus: 'ready_for_pickup',
    toStatus: 'awaiting_driver',
  });
  const transitions = { transition } as unknown as OrderTransitionService;
  const listener = new OrderDispatchQueueListener({ transitions });
  return { listener, transition };
}

describe('OrderDispatchQueueListener', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('subscribes its handler to ORDER_TRANSITIONED_EVENT', () => {
    const handler = OrderDispatchQueueListener.prototype.onOrderTransitioned;
    const meta = Reflect.getMetadata('EVENT_LISTENER_METADATA', handler) as
      | ReadonlyArray<{ event: unknown }>
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.[0]?.event).toBe(ORDER_TRANSITIONED_EVENT);
    expect(ORDER_TRANSITIONED_EVENT).toBe('order.transitioned');
  });

  it('fires DISPATCH_QUEUE as the system actor when an order reaches ready_for_pickup', async () => {
    await h.listener.onOrderTransitioned(buildEvent());

    expect(h.transition).toHaveBeenCalledOnce();
    expect(h.transition).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      event: 'DISPATCH_QUEUE',
      actor: { role: 'system' },
      reason: 'auto-dispatch on ready_for_pickup',
    });
  });

  it('is a no-op for the awaiting_driver transition it triggers (no loop)', async () => {
    await h.listener.onOrderTransitioned(
      buildEvent({
        fromStatus: 'ready_for_pickup',
        toStatus: 'awaiting_driver',
        event: 'DISPATCH_QUEUE',
        actor: { role: 'system' },
      }),
    );

    expect(h.transition).not.toHaveBeenCalled();
  });

  it('is a no-op for unrelated transitions', async () => {
    await h.listener.onOrderTransitioned(
      buildEvent({ fromStatus: 'placed', toStatus: 'accepted', event: 'VENDOR_ACCEPT' }),
    );

    expect(h.transition).not.toHaveBeenCalled();
  });

  it('swallows ORDER_INVALID_TRANSITION (duplicate event / already dispatched)', async () => {
    h.transition.mockRejectedValueOnce(
      OrderError.invalidTransition('awaiting_driver', 'DISPATCH_QUEUE'),
    );

    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();
    expect(h.transition).toHaveBeenCalledOnce();
  });

  it('swallows any other transition fault (transition is already durable)', async () => {
    h.transition.mockRejectedValueOnce(new Error('db pool exhausted'));

    await expect(h.listener.onOrderTransitioned(buildEvent())).resolves.toBeUndefined();
  });
});

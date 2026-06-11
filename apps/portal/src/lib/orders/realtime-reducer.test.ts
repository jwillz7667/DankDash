import { describe, expect, it } from 'vitest';
import type { VendorQueueOrderSummary } from '../api/vendor-orders.js';
import type { OrderStatusChange, OrderSummary } from '../realtime/client.js';
import { applyOrderCreated, applyOrderStatusChanged } from './realtime-reducer.js';

function order(
  overrides: Partial<VendorQueueOrderSummary> & Pick<VendorQueueOrderSummary, 'id' | 'status'>,
): VendorQueueOrderSummary {
  return {
    shortCode: 'AAAA',
    userId: '01935f3d-0000-7000-8000-000000000abc',
    customerName: 'Mia Reyes',
    itemCount: 2,
    subtotalCents: 5400,
    totalCents: 6210,
    placedAt: '2026-05-19T11:55:00.000Z',
    statusChangedAt: '2026-05-19T11:55:00.000Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

function createdPayload(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    orderId: 'o-new',
    customerId: '01935f3d-0000-7000-8000-0000000000c1',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
    shortCode: 'NEW1',
    totalCents: 8200,
    status: 'placed',
    placedAt: '2026-05-19T12:00:00.000Z',
    ...overrides,
  };
}

function statusChangePayload(overrides: Partial<OrderStatusChange> = {}): OrderStatusChange {
  return {
    orderId: 'o-1',
    customerId: '01935f3d-0000-7000-8000-0000000000c1',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
    driverId: null,
    fromStatus: 'placed',
    toStatus: 'accepted',
    changedAt: '2026-05-19T12:01:00.000Z',
    ...overrides,
  };
}

describe('applyOrderCreated', () => {
  it('prepends a projected card with placeholders for unknown fields', () => {
    const state = [order({ id: 'o-1', status: 'prepping' })];
    const next = applyOrderCreated(state, createdPayload());

    expect(next).toHaveLength(2);
    const inserted = next[0];
    expect(inserted?.id).toBe('o-new');
    expect(inserted?.status).toBe('placed');
    expect(inserted?.customerName).toBeNull();
    expect(inserted?.itemCount).toBe(1);
    expect(inserted?.subtotalCents).toBe(8200);
    expect(inserted?.totalCents).toBe(8200);
    expect(inserted?.statusChangedAt).toBe('2026-05-19T12:00:00.000Z');
    // Original row preserves identity so React can skip its render.
    expect(next[1]).toBe(state[0]);
  });

  it('is idempotent on a duplicate id (redelivered event)', () => {
    const state = [order({ id: 'o-1', status: 'placed' })];
    const next = applyOrderCreated(state, createdPayload({ orderId: 'o-1' }));

    expect(next).toBe(state);
  });

  it('ignores a payload with a status unknown to the catalog', () => {
    const state = [order({ id: 'o-1', status: 'placed' })];
    const next = applyOrderCreated(
      state,
      createdPayload({ orderId: 'o-new', status: 'not-a-real-status' }),
    );

    expect(next).toBe(state);
  });

  it('ignores a payload whose status falls outside the queue surface', () => {
    const state = [order({ id: 'o-1', status: 'placed' })];
    // `delivered` is a valid OrderStatus but lives off the kanban board.
    const next = applyOrderCreated(
      state,
      createdPayload({ orderId: 'o-new', status: 'delivered' }),
    );

    expect(next).toBe(state);
  });
});

describe('applyOrderStatusChanged', () => {
  it('updates status and statusChangedAt for a known order, preserving other rows', () => {
    const a = order({ id: 'o-1', status: 'placed' });
    const b = order({ id: 'o-2', status: 'prepping' });
    const next = applyOrderStatusChanged(
      [a, b],
      statusChangePayload({
        orderId: 'o-1',
        fromStatus: 'placed',
        toStatus: 'accepted',
        changedAt: '2026-05-19T12:01:00.000Z',
      }),
    );

    expect(next).toHaveLength(2);
    expect(next[0]?.id).toBe('o-1');
    expect(next[0]?.status).toBe('accepted');
    expect(next[0]?.statusChangedAt).toBe('2026-05-19T12:01:00.000Z');
    // Unchanged row keeps its identity — React skips re-rendering it.
    expect(next[1]).toBe(b);
  });

  it('removes the order when the new status falls outside the queue surface', () => {
    const a = order({ id: 'o-1', status: 'en_route_pickup' });
    const b = order({ id: 'o-2', status: 'prepping' });
    const next = applyOrderStatusChanged(
      [a, b],
      statusChangePayload({
        orderId: 'o-1',
        fromStatus: 'en_route_pickup',
        toStatus: 'picked_up',
      }),
    );

    expect(next).toEqual([b]);
  });

  it('keeps the order on driver_assigned → en_route_pickup (handoff pending)', () => {
    const a = order({ id: 'o-1', status: 'driver_assigned' });
    const next = applyOrderStatusChanged(
      [a],
      statusChangePayload({
        orderId: 'o-1',
        fromStatus: 'driver_assigned',
        toStatus: 'en_route_pickup',
      }),
    );

    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe('en_route_pickup');
  });

  it('removes the order when the new status is unrecognized', () => {
    const a = order({ id: 'o-1', status: 'placed' });
    const next = applyOrderStatusChanged(
      [a],
      statusChangePayload({ orderId: 'o-1', toStatus: 'bogus-status' }),
    );

    expect(next).toEqual([]);
  });

  it('is a no-op when the order id is not in the snapshot', () => {
    const state = [order({ id: 'o-1', status: 'placed' })];
    const next = applyOrderStatusChanged(state, statusChangePayload({ orderId: 'unknown' }));

    expect(next).toBe(state);
  });

  it('re-buckets in place when the status moves within the queue surface', () => {
    // ready_for_pickup → awaiting_driver moves the card from the
    // "Ready" column to "Out for Delivery"; the reducer must keep it
    // in state so the board can re-bucket on the next paint.
    const a = order({ id: 'o-1', status: 'ready_for_pickup' });
    const next = applyOrderStatusChanged(
      [a],
      statusChangePayload({
        orderId: 'o-1',
        fromStatus: 'ready_for_pickup',
        toStatus: 'awaiting_driver',
        changedAt: '2026-05-19T12:05:00.000Z',
      }),
    );

    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe('awaiting_driver');
  });
});

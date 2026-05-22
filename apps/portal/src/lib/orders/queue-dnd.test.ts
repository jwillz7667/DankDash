import { describe, expect, it, vi } from 'vitest';
import type {
  OrderStatus,
  TransitionResponse,
  VendorQueueOrderSummary,
} from '../api/vendor-orders.js';
import type { VendorOrderActions } from './order-actions.js';
import {
  dispatchDragAction,
  dragActionFor,
  isQueueColumnKey,
  resolveDragDrop,
  validTargetColumnsFor,
} from './queue-dnd.js';

function order(overrides: Partial<VendorQueueOrderSummary> = {}): VendorQueueOrderSummary {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    shortCode: 'A1B2',
    userId: 'u-1',
    customerName: 'Mia',
    status: 'placed',
    itemCount: 1,
    subtotalCents: 100,
    totalCents: 110,
    placedAt: '2026-05-19T11:50:00.000Z',
    statusChangedAt: '2026-05-19T11:50:00.000Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

describe('dragActionFor', () => {
  it('maps placed → prepping column to the accept action', () => {
    expect(dragActionFor('placed', 'prepping')).toBe('accept');
  });

  it('maps prepping → ready column to the markReady action', () => {
    expect(dragActionFor('prepping', 'ready')).toBe('markReady');
  });

  it('rejects accepted → ready because the state machine forbids skipping prepping', () => {
    expect(dragActionFor('accepted', 'ready')).toBeNull();
  });

  it('rejects placed → ready (multi-step transition)', () => {
    expect(dragActionFor('placed', 'ready')).toBeNull();
  });

  it('rejects placed → out_for_delivery (multi-step transition)', () => {
    expect(dragActionFor('placed', 'out_for_delivery')).toBeNull();
  });

  it('rejects ready_for_pickup → out_for_delivery (driver assignment is server-driven)', () => {
    expect(dragActionFor('ready_for_pickup', 'out_for_delivery')).toBeNull();
  });

  it('rejects same-column drops (no-op)', () => {
    expect(dragActionFor('placed', 'new')).toBeNull();
    expect(dragActionFor('prepping', 'prepping')).toBeNull();
  });

  it('rejects backward drags', () => {
    expect(dragActionFor('prepping', 'new')).toBeNull();
    expect(dragActionFor('ready_for_pickup', 'prepping')).toBeNull();
    expect(dragActionFor('awaiting_driver', 'ready')).toBeNull();
  });

  it('rejects every drop for terminal statuses', () => {
    const terminal: readonly OrderStatus[] = [
      'delivered',
      'canceled',
      'rejected',
      'returned_to_store',
    ];
    for (const status of terminal) {
      expect(dragActionFor(status, 'new')).toBeNull();
      expect(dragActionFor(status, 'prepping')).toBeNull();
      expect(dragActionFor(status, 'ready')).toBeNull();
      expect(dragActionFor(status, 'out_for_delivery')).toBeNull();
    }
  });
});

describe('validTargetColumnsFor', () => {
  it('returns prepping for placed orders', () => {
    expect(Array.from(validTargetColumnsFor('placed'))).toEqual(['prepping']);
  });

  it('returns ready for prepping orders', () => {
    expect(Array.from(validTargetColumnsFor('prepping'))).toEqual(['ready']);
  });

  it('returns no targets for accepted orders (must drawer-promote to prepping first)', () => {
    expect(validTargetColumnsFor('accepted').size).toBe(0);
  });

  it('returns no targets for ready_for_pickup or downstream statuses', () => {
    expect(validTargetColumnsFor('ready_for_pickup').size).toBe(0);
    expect(validTargetColumnsFor('awaiting_driver').size).toBe(0);
    expect(validTargetColumnsFor('driver_assigned').size).toBe(0);
  });

  it('returns no targets for terminal statuses', () => {
    expect(validTargetColumnsFor('delivered').size).toBe(0);
    expect(validTargetColumnsFor('canceled').size).toBe(0);
  });
});

describe('isQueueColumnKey', () => {
  it('recognizes every QUEUE_COLUMNS key', () => {
    expect(isQueueColumnKey('new')).toBe(true);
    expect(isQueueColumnKey('prepping')).toBe(true);
    expect(isQueueColumnKey('ready')).toBe(true);
    expect(isQueueColumnKey('out_for_delivery')).toBe(true);
  });

  it('rejects unknown strings, non-strings, and undefined', () => {
    expect(isQueueColumnKey('done')).toBe(false);
    expect(isQueueColumnKey('')).toBe(false);
    expect(isQueueColumnKey(undefined)).toBe(false);
    expect(isQueueColumnKey(null)).toBe(false);
    expect(isQueueColumnKey(42)).toBe(false);
  });
});

describe('resolveDragDrop', () => {
  const placed = order({ id: 'a', status: 'placed' });
  const prepping = order({ id: 'b', status: 'prepping' });
  const accepted = order({ id: 'c', status: 'accepted' });

  it('resolves a placed-card drop on the prepping column to accept', () => {
    expect(resolveDragDrop([placed], 'a', 'prepping')).toEqual({ orderId: 'a', action: 'accept' });
  });

  it('resolves a prepping-card drop on the ready column to markReady', () => {
    expect(resolveDragDrop([prepping], 'b', 'ready')).toEqual({
      orderId: 'b',
      action: 'markReady',
    });
  });

  it('returns null when the target id is not a column key', () => {
    expect(resolveDragDrop([placed], 'a', 'unknown')).toBeNull();
    expect(resolveDragDrop([placed], 'a', undefined)).toBeNull();
  });

  it('returns null when the active id does not match any order', () => {
    expect(resolveDragDrop([placed], 'missing', 'prepping')).toBeNull();
  });

  it('returns null when the activeId is not a string', () => {
    expect(resolveDragDrop([placed], 42, 'prepping')).toBeNull();
  });

  it('returns null when the column-status pair is an illegal transition', () => {
    expect(resolveDragDrop([accepted], 'c', 'ready')).toBeNull();
    expect(resolveDragDrop([placed], 'a', 'ready')).toBeNull();
  });
});

describe('dispatchDragAction', () => {
  const tr = (status: TransitionResponse['status']): TransitionResponse => ({
    id: 'x',
    status,
    statusChangedAt: '2026-05-19T12:00:00.000Z',
  });

  function buildActions(): VendorOrderActions {
    return {
      fetch: vi.fn(),
      accept: vi.fn(async () => tr('accepted')),
      reject: vi.fn(async () => tr('rejected')),
      markPrepped: vi.fn(async () => tr('prepping')),
      markReady: vi.fn(async () => tr('ready_for_pickup')),
      markHandoff: vi.fn(async () => tr('picked_up')),
    } as VendorOrderActions;
  }

  it('routes the accept resolution to actions.accept and returns its response', async () => {
    const actions = buildActions();
    const result = await dispatchDragAction({ orderId: 'x', action: 'accept' }, actions);
    expect(actions.accept).toHaveBeenCalledWith('x');
    expect(result.status).toBe('accepted');
  });

  it('routes the markReady resolution to actions.markReady', async () => {
    const actions = buildActions();
    const result = await dispatchDragAction({ orderId: 'x', action: 'markReady' }, actions);
    expect(actions.markReady).toHaveBeenCalledWith('x');
    expect(result.status).toBe('ready_for_pickup');
  });

  it('propagates the error when the underlying action rejects', async () => {
    const actions = buildActions();
    (actions.accept as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Conflict'));
    await expect(dispatchDragAction({ orderId: 'x', action: 'accept' }, actions)).rejects.toThrow(
      'Conflict',
    );
  });
});

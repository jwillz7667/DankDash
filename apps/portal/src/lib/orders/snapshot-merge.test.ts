import { describe, expect, it } from 'vitest';
import { mergePolledSnapshot } from './snapshot-merge.js';
import type { VendorQueueOrderSummary } from '../api/vendor-orders.js';

function order(overrides: Partial<VendorQueueOrderSummary> = {}): VendorQueueOrderSummary {
  return {
    id: 'order-1',
    shortCode: 'A1B2',
    userId: 'user-1',
    customerName: 'Mia',
    status: 'placed',
    itemCount: 2,
    subtotalCents: 1800,
    totalCents: 2400,
    placedAt: '2026-05-20T12:00:00Z',
    statusChangedAt: '2026-05-20T12:00:00Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

describe('mergePolledSnapshot', () => {
  it('returns an empty array unchanged when both inputs are empty', () => {
    const local: readonly VendorQueueOrderSummary[] = [];
    const next = mergePolledSnapshot(local, []);
    expect(next).toBe(local);
  });

  it('returns the polled list when local is empty', () => {
    const polled = [order({ id: 'a' }), order({ id: 'b', shortCode: 'B' })];
    const next = mergePolledSnapshot([], polled);
    expect(next).toHaveLength(2);
    expect(next[0]?.id).toBe('a');
    expect(next[1]?.id).toBe('b');
  });

  it('returns an empty list when polled is empty (server dropped every row)', () => {
    const local = [order({ id: 'a' })];
    const next = mergePolledSnapshot(local, []);
    expect(next).toHaveLength(0);
  });

  it('preserves the local array reference when every row matches by id and content', () => {
    const a = order({ id: 'a' });
    const b = order({ id: 'b', shortCode: 'B' });
    const local: readonly VendorQueueOrderSummary[] = [a, b];
    // Polled rows are byte-equal copies — content matches, refs differ.
    const polled = [order({ id: 'a' }), order({ id: 'b', shortCode: 'B' })];
    const next = mergePolledSnapshot(local, polled);
    expect(next).toBe(local);
  });

  it('preserves row identity for unchanged rows when one row in the snapshot changes', () => {
    const a = order({ id: 'a' });
    const b = order({ id: 'b', shortCode: 'B', status: 'placed' });
    const local: readonly VendorQueueOrderSummary[] = [a, b];
    const polled = [order({ id: 'a' }), order({ id: 'b', shortCode: 'B', status: 'accepted' })];

    const next = mergePolledSnapshot(local, polled);

    expect(next).not.toBe(local);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(a); // ref preserved
    expect(next[1]).not.toBe(b); // status differs
    expect(next[1]?.status).toBe('accepted');
  });

  it('adds rows that exist in polled but not in local (missed-while-offline)', () => {
    const a = order({ id: 'a' });
    const local: readonly VendorQueueOrderSummary[] = [a];
    const polled = [order({ id: 'a' }), order({ id: 'b', shortCode: 'B' })];

    const next = mergePolledSnapshot(local, polled);

    expect(next).toHaveLength(2);
    expect(next[0]).toBe(a);
    expect(next[1]?.id).toBe('b');
  });

  it('removes rows that exist in local but not in polled (transitioned-off while offline)', () => {
    const a = order({ id: 'a' });
    const b = order({ id: 'b', shortCode: 'B' });
    const local: readonly VendorQueueOrderSummary[] = [a, b];
    const polled = [order({ id: 'a' })];

    const next = mergePolledSnapshot(local, polled);

    expect(next).toHaveLength(1);
    expect(next[0]).toBe(a);
  });

  it('honours the polled order when the local snapshot was sorted differently', () => {
    const a = order({ id: 'a' });
    const b = order({ id: 'b', shortCode: 'B' });
    const local: readonly VendorQueueOrderSummary[] = [a, b];
    // Polled comes back in reverse — newest first server-side.
    const polled = [order({ id: 'b', shortCode: 'B' }), order({ id: 'a' })];

    const next = mergePolledSnapshot(local, polled);

    expect(next).not.toBe(local);
    expect(next.map((r) => r.id)).toEqual(['b', 'a']);
    expect(next[0]).toBe(b); // refs still preserved per-row
    expect(next[1]).toBe(a);
  });

  it('detects a content drift on a single tracked field', () => {
    const a = order({ id: 'a', itemCount: 1 });
    const local: readonly VendorQueueOrderSummary[] = [a];
    const polled = [order({ id: 'a', itemCount: 3 })];

    const next = mergePolledSnapshot(local, polled);

    expect(next).not.toBe(local);
    expect(next[0]?.itemCount).toBe(3);
  });

  it('detects a customerName drift (realtime stub filled in by the poll)', () => {
    const a = order({ id: 'a', customerName: null });
    const local: readonly VendorQueueOrderSummary[] = [a];
    const polled = [order({ id: 'a', customerName: 'Resolved Name' })];

    const next = mergePolledSnapshot(local, polled);

    expect(next[0]?.customerName).toBe('Resolved Name');
    expect(next[0]).not.toBe(a);
  });
});

import { describe, expect, it } from 'vitest';
import type { VendorQueueOrderSummary } from '../api/vendor-orders.js';
import { VENDOR_QUEUE_DEFAULT_STATUSES } from '../api/vendor-orders.js';
import { QUEUE_COLUMNS, bucketByColumn, columnKeyForStatus } from './queue-columns.js';

function makeOrder(
  overrides: Partial<VendorQueueOrderSummary> & Pick<VendorQueueOrderSummary, 'status'>,
): VendorQueueOrderSummary {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    shortCode: 'A1B2',
    userId: '01935f3d-0000-7000-8000-000000000002',
    customerName: 'Mia Reyes',
    itemCount: 2,
    subtotalCents: 5400,
    totalCents: 6210,
    placedAt: '2026-05-19T12:00:00.000+00:00',
    statusChangedAt: '2026-05-19T12:00:00.000+00:00',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

describe('QUEUE_COLUMNS', () => {
  it('exposes four columns in left-to-right workflow order', () => {
    expect(QUEUE_COLUMNS.map((c) => c.key)).toEqual([
      'new',
      'prepping',
      'ready',
      'out_for_delivery',
    ]);
  });

  it('lists every default vendor status across all columns with no overlap', () => {
    // The set of statuses across all columns must equal the portal's
    // VENDOR_QUEUE_DEFAULT_STATUSES exactly — drift between the API
    // default filter and the column mapping silently loses orders.
    const allStatuses = QUEUE_COLUMNS.flatMap((c) => c.statuses);
    expect(allStatuses).toHaveLength(new Set(allStatuses).size);
    expect(new Set(allStatuses)).toEqual(new Set(VENDOR_QUEUE_DEFAULT_STATUSES));
  });
});

describe('columnKeyForStatus', () => {
  it('maps placed to new', () => {
    expect(columnKeyForStatus('placed')).toBe('new');
  });

  it('maps both accepted and prepping to prepping', () => {
    expect(columnKeyForStatus('accepted')).toBe('prepping');
    expect(columnKeyForStatus('prepping')).toBe('prepping');
  });

  it('maps ready_for_pickup to ready', () => {
    expect(columnKeyForStatus('ready_for_pickup')).toBe('ready');
  });

  it('maps awaiting_driver, driver_assigned, and en_route_pickup to out_for_delivery', () => {
    expect(columnKeyForStatus('awaiting_driver')).toBe('out_for_delivery');
    expect(columnKeyForStatus('driver_assigned')).toBe('out_for_delivery');
    expect(columnKeyForStatus('en_route_pickup')).toBe('out_for_delivery');
  });

  it('returns undefined for statuses outside the queue surface', () => {
    expect(columnKeyForStatus('delivered')).toBeUndefined();
    expect(columnKeyForStatus('canceled')).toBeUndefined();
    expect(columnKeyForStatus('picked_up')).toBeUndefined();
  });
});

describe('bucketByColumn', () => {
  it('returns four empty arrays for an empty input', () => {
    expect(bucketByColumn([])).toEqual({
      new: [],
      prepping: [],
      ready: [],
      out_for_delivery: [],
    });
  });

  it('groups orders into the right columns', () => {
    const orders = [
      makeOrder({ id: 'o1', status: 'placed', shortCode: 'A1' }),
      makeOrder({ id: 'o2', status: 'accepted', shortCode: 'A2' }),
      makeOrder({ id: 'o3', status: 'prepping', shortCode: 'A3' }),
      makeOrder({ id: 'o4', status: 'ready_for_pickup', shortCode: 'A4' }),
      makeOrder({ id: 'o5', status: 'awaiting_driver', shortCode: 'A5' }),
      makeOrder({ id: 'o6', status: 'driver_assigned', shortCode: 'A6' }),
    ];

    const buckets = bucketByColumn(orders);

    expect(buckets.new.map((o) => o.id)).toEqual(['o1']);
    expect(buckets.prepping.map((o) => o.id)).toEqual(['o2', 'o3']);
    expect(buckets.ready.map((o) => o.id)).toEqual(['o4']);
    expect(buckets.out_for_delivery.map((o) => o.id)).toEqual(['o5', 'o6']);
  });

  it('preserves the input order within a column (API-side oldest-first)', () => {
    const orders = [
      makeOrder({ id: 'older', status: 'prepping', statusChangedAt: '2026-05-19T08:00:00Z' }),
      makeOrder({ id: 'newer', status: 'prepping', statusChangedAt: '2026-05-19T09:00:00Z' }),
    ];
    expect(bucketByColumn(orders).prepping.map((o) => o.id)).toEqual(['older', 'newer']);
  });

  it('drops orders whose status falls outside any column (delivered, canceled)', () => {
    const orders = [
      makeOrder({ id: 'live', status: 'placed' }),
      makeOrder({ id: 'gone', status: 'delivered' }),
      makeOrder({ id: 'killed', status: 'canceled' }),
    ];
    const buckets = bucketByColumn(orders);
    expect(buckets.new.map((o) => o.id)).toEqual(['live']);
    // Defensive: total count across columns equals the count of
    // queue-eligible orders, never the input length.
    const total = Object.values(buckets).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(1);
  });
});

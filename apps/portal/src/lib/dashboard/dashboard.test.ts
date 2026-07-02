import { describe, expect, it } from 'vitest';
import { type DispensaryHours } from '../api/vendor-settings.js';
import { type VendorPayoutSummary } from '../api/vendor-payouts.js';
import { type OrderStatus, type VendorQueueOrderSummary } from '../api/vendor-orders.js';
import {
  canViewStoreFinancials,
  dayHoursForNow,
  formatClock,
  formatDayHoursLabel,
  greetingFor,
  isStoreOpenNow,
  orderStatusLabel,
  orderStatusTone,
  resolveTodayWindow,
  selectPayoutSnapshot,
  selectRecentActivity,
  summarizeActiveOrders,
} from './dashboard.js';

function makeOrder(overrides: Partial<VendorQueueOrderSummary> = {}): VendorQueueOrderSummary {
  return {
    id: '01935f3d-0000-7000-8000-0000000000a1',
    shortCode: 'ABCD',
    userId: '01935f3d-0000-7000-8000-0000000000c1',
    customerName: 'Jane D.',
    status: 'placed',
    itemCount: 2,
    subtotalCents: 5_000,
    totalCents: 6_200,
    placedAt: '2026-07-02T15:00:00.000Z',
    statusChangedAt: '2026-07-02T15:00:00.000Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

function makePayout(overrides: Partial<VendorPayoutSummary> = {}): VendorPayoutSummary {
  return {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    periodStart: '2026-06-30',
    periodEnd: '2026-07-01',
    grossCents: 100_000,
    feesCents: 1_000,
    netCents: 99_000,
    status: 'completed',
    scheduledFor: '2026-07-01',
    aeropayPayoutRef: 'aero_1',
    initiatedAt: '2026-07-01T08:00:00.000Z',
    completedAt: '2026-07-01T08:15:00.000Z',
    failureReason: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    ...overrides,
  };
}

function hoursEveryDay(day: DispensaryHours['mon']): DispensaryHours {
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
}

describe('resolveTodayWindow', () => {
  it('anchors "from" to America/Chicago midnight in summer (CDT, UTC-5)', () => {
    const now = new Date('2026-07-02T18:30:00.000Z'); // 13:30 CDT
    const window = resolveTodayWindow(now);
    expect(window.from).toBe('2026-07-02T05:00:00.000Z'); // 00:00 CDT
    expect(window.to).toBe('2026-07-02T18:30:00.000Z');
  });

  it('anchors "from" to America/Chicago midnight in winter (CST, UTC-6)', () => {
    const now = new Date('2026-01-15T12:00:00.000Z'); // 06:00 CST
    expect(resolveTodayWindow(now).from).toBe('2026-01-15T06:00:00.000Z'); // 00:00 CST
  });

  it('rolls the day back when the UTC instant is past midnight UTC but before midnight local', () => {
    const now = new Date('2026-07-02T04:30:00.000Z'); // 23:30 CDT on Jul 1
    expect(resolveTodayWindow(now).from).toBe('2026-07-01T05:00:00.000Z');
  });
});

describe('greetingFor', () => {
  it('greets by the store-local hour, not UTC', () => {
    expect(greetingFor(new Date('2026-07-02T14:00:00.000Z'))).toBe('Good morning'); // 09:00 CDT
    expect(greetingFor(new Date('2026-07-02T18:00:00.000Z'))).toBe('Good afternoon'); // 13:00 CDT
    expect(greetingFor(new Date('2026-07-03T01:00:00.000Z'))).toBe('Good evening'); // 20:00 CDT
    expect(greetingFor(new Date('2026-07-02T06:00:00.000Z'))).toBe('Good evening'); // 01:00 CDT
  });
});

describe('summarizeActiveOrders', () => {
  it('buckets queue orders by workflow stage', () => {
    const summary = summarizeActiveOrders([
      makeOrder({ id: '1', status: 'placed' }),
      makeOrder({ id: '2', status: 'placed' }),
      makeOrder({ id: '3', status: 'accepted' }),
      makeOrder({ id: '4', status: 'prepping' }),
      makeOrder({ id: '5', status: 'ready_for_pickup' }),
      makeOrder({ id: '6', status: 'en_route_pickup' }),
    ]);
    expect(summary).toEqual({ total: 6, awaitingAccept: 2, inPrep: 2, readyForHandoff: 2 });
  });

  it('returns zeroes for an empty queue', () => {
    expect(summarizeActiveOrders([])).toEqual({
      total: 0,
      awaitingAccept: 0,
      inPrep: 0,
      readyForHandoff: 0,
    });
  });
});

describe('selectRecentActivity', () => {
  it('orders newest-first by statusChangedAt and caps at the limit', () => {
    const orders = [
      makeOrder({ id: 'old', statusChangedAt: '2026-07-02T15:00:00.000Z' }),
      makeOrder({ id: 'new', statusChangedAt: '2026-07-02T15:30:00.000Z' }),
      makeOrder({ id: 'mid', statusChangedAt: '2026-07-02T15:10:00.000Z' }),
    ];
    const recent = selectRecentActivity(orders, 2);
    expect(recent.map((o) => o.id)).toEqual(['new', 'mid']);
  });

  it('does not mutate the input array', () => {
    const orders = [
      makeOrder({ id: 'a', statusChangedAt: '2026-07-02T15:00:00.000Z' }),
      makeOrder({ id: 'b', statusChangedAt: '2026-07-02T16:00:00.000Z' }),
    ];
    selectRecentActivity(orders, 5);
    expect(orders.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('selectPayoutSnapshot', () => {
  it('picks the first completed payout as last and the soonest upcoming as next', () => {
    const snapshot = selectPayoutSnapshot([
      makePayout({ id: 'p_pending_late', status: 'pending', scheduledFor: '2026-07-05' }),
      makePayout({ id: 'p_processing', status: 'processing', scheduledFor: '2026-07-03' }),
      makePayout({ id: 'p_done', status: 'completed', scheduledFor: '2026-07-01' }),
    ]);
    expect(snapshot.last?.id).toBe('p_done');
    expect(snapshot.next?.id).toBe('p_processing');
  });

  it('returns nulls when there is nothing paid or scheduled', () => {
    expect(selectPayoutSnapshot([makePayout({ status: 'failed' })])).toEqual({
      last: null,
      next: null,
    });
    expect(selectPayoutSnapshot([])).toEqual({ last: null, next: null });
  });
});

describe('isStoreOpenNow', () => {
  const overnight = hoursEveryDay({ open: '08:00', close: '02:00' });

  it('is open during the evening portion of an overnight window', () => {
    // 10:00 CDT — inside 08:00→midnight.
    expect(isStoreOpenNow(overnight, new Date('2026-07-02T15:00:00.000Z'))).toBe(true);
  });

  it('is open in the early morning via the previous day overnight spill', () => {
    // 01:00 CDT — previous day's window runs until 02:00.
    expect(isStoreOpenNow(overnight, new Date('2026-07-02T06:00:00.000Z'))).toBe(true);
  });

  it('is closed in the gap between close and open', () => {
    // 03:00 CDT — after 02:00 close, before 08:00 open.
    expect(isStoreOpenNow(overnight, new Date('2026-07-02T08:00:00.000Z'))).toBe(false);
  });

  it('handles a same-day (non-overnight) window', () => {
    const daytime = hoursEveryDay({ open: '09:00', close: '17:00' });
    expect(isStoreOpenNow(daytime, new Date('2026-07-02T17:00:00.000Z'))).toBe(true); // 12:00 CDT
    expect(isStoreOpenNow(daytime, new Date('2026-07-03T01:00:00.000Z'))).toBe(false); // 20:00 CDT
  });

  it('is closed when the day has no hours and no spill from the prior day', () => {
    expect(isStoreOpenNow(hoursEveryDay(null), new Date('2026-07-02T17:00:00.000Z'))).toBe(false);
  });
});

describe('dayHoursForNow', () => {
  it('reads the row for the store-local weekday', () => {
    const hours: DispensaryHours = {
      ...hoursEveryDay(null),
      thu: { open: '10:00', close: '20:00' },
    };
    // 2026-07-02 is a Thursday; 12:00 CDT stays on Thursday.
    expect(dayHoursForNow(hours, new Date('2026-07-02T17:00:00.000Z'))).toEqual({
      open: '10:00',
      close: '20:00',
    });
  });
});

describe('formatClock', () => {
  it('renders 24h "HH:MM" as 12h with a meridiem', () => {
    expect(formatClock('08:00')).toBe('8:00 AM');
    expect(formatClock('00:00')).toBe('12:00 AM');
    expect(formatClock('12:00')).toBe('12:00 PM');
    expect(formatClock('13:30')).toBe('1:30 PM');
    expect(formatClock('02:00')).toBe('2:00 AM');
  });

  it('returns the raw value when it cannot be parsed', () => {
    expect(formatClock('nope')).toBe('nope');
  });
});

describe('formatDayHoursLabel', () => {
  it('renders "Closed" for a null day', () => {
    expect(formatDayHoursLabel(null)).toBe('Closed');
  });

  it('renders an open–close range', () => {
    expect(formatDayHoursLabel({ open: '08:00', close: '02:00' })).toBe('8:00 AM – 2:00 AM');
  });
});

describe('canViewStoreFinancials', () => {
  it('allows manager and above', () => {
    expect(canViewStoreFinancials('manager')).toBe(true);
    expect(canViewStoreFinancials('owner')).toBe(true);
    expect(canViewStoreFinancials('admin')).toBe(true);
    expect(canViewStoreFinancials('superadmin')).toBe(true);
  });

  it('denies budtender and non-vendor roles', () => {
    expect(canViewStoreFinancials('budtender')).toBe(false);
    expect(canViewStoreFinancials('customer')).toBe(false);
    expect(canViewStoreFinancials('driver')).toBe(false);
  });
});

describe('orderStatusLabel + orderStatusTone', () => {
  it('maps common queue statuses to human labels and badge tones', () => {
    expect(orderStatusLabel('placed')).toBe('New order');
    expect(orderStatusTone('placed')).toBe('info');
    expect(orderStatusLabel('delivered')).toBe('Delivered');
    expect(orderStatusTone('delivered')).toBe('success');
  });

  it('is exhaustive — every status resolves to a non-empty label', () => {
    const statuses: readonly OrderStatus[] = [
      'placed',
      'accepted',
      'prepping',
      'ready_for_pickup',
      'awaiting_driver',
      'driver_assigned',
      'en_route_pickup',
      'delivered',
      'canceled',
    ];
    for (const status of statuses) {
      expect(orderStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

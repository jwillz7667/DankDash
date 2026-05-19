import { describe, expect, it } from 'vitest';
import { OrderError } from '../src/errors.js';
import { legalEventsFrom, nextOrderState, tryNextOrderState } from '../src/order-machine.js';
import {
  isTerminalOrderState,
  ORDER_STATES,
  TERMINAL_ORDER_STATES,
  type OrderState,
} from '../src/states.js';
import type { OrderEventType } from '../src/events.js';

/**
 * The forward edges spec §3.3 calls out — exhaustive. Tests below walk this
 * table and assert every entry succeeds, and (by complementarity) that every
 * edge NOT in this table is rejected. Adding a state requires adding the
 * relevant rows here; the diff is the spec change.
 */
const FORWARD_TRANSITIONS: ReadonlyArray<{
  readonly from: OrderState;
  readonly event: OrderEventType;
  readonly to: OrderState;
}> = [
  { from: 'placed', event: 'VENDOR_ACCEPT', to: 'accepted' },
  { from: 'placed', event: 'VENDOR_REJECT', to: 'rejected' },
  { from: 'placed', event: 'CUSTOMER_CANCEL', to: 'canceled' },
  { from: 'placed', event: 'PAYMENT_FAILED', to: 'payment_failed' },
  { from: 'accepted', event: 'VENDOR_PREPPING', to: 'prepping' },
  { from: 'accepted', event: 'STORE_CANCEL', to: 'canceled' },
  { from: 'prepping', event: 'VENDOR_READY', to: 'ready_for_pickup' },
  { from: 'prepping', event: 'STORE_CANCEL', to: 'canceled' },
  { from: 'ready_for_pickup', event: 'DISPATCH_QUEUE', to: 'awaiting_driver' },
  { from: 'ready_for_pickup', event: 'STORE_CANCEL', to: 'canceled' },
  { from: 'awaiting_driver', event: 'DRIVER_ASSIGNED', to: 'driver_assigned' },
  { from: 'awaiting_driver', event: 'STORE_CANCEL', to: 'canceled' },
  { from: 'driver_assigned', event: 'DRIVER_EN_ROUTE_PICKUP', to: 'en_route_pickup' },
  { from: 'en_route_pickup', event: 'DRIVER_PICKED_UP', to: 'picked_up' },
  { from: 'picked_up', event: 'DRIVER_EN_ROUTE_DROPOFF', to: 'en_route_dropoff' },
  { from: 'en_route_dropoff', event: 'DRIVER_ARRIVED', to: 'arrived_at_dropoff' },
  { from: 'arrived_at_dropoff', event: 'DRIVER_ID_SCAN_STARTED', to: 'id_scan_pending' },
  { from: 'id_scan_pending', event: 'ID_SCAN_PASSED', to: 'id_scan_passed' },
  { from: 'id_scan_pending', event: 'ID_SCAN_FAILED', to: 'id_scan_failed' },
  { from: 'id_scan_passed', event: 'DRIVER_DELIVERED', to: 'delivered' },
  { from: 'id_scan_failed', event: 'DRIVER_ID_SCAN_RETRY', to: 'id_scan_pending' },
  { from: 'id_scan_failed', event: 'DRIVER_RETURNED', to: 'returned_to_store' },
  { from: 'delivered', event: 'DISPUTE_OPENED', to: 'disputed' },
];

const ALL_EVENT_TYPES: readonly OrderEventType[] = [
  'PAYMENT_FAILED',
  'CUSTOMER_CANCEL',
  'VENDOR_ACCEPT',
  'VENDOR_REJECT',
  'VENDOR_PREPPING',
  'VENDOR_READY',
  'STORE_CANCEL',
  'DISPATCH_QUEUE',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE_PICKUP',
  'DRIVER_PICKED_UP',
  'DRIVER_EN_ROUTE_DROPOFF',
  'DRIVER_ARRIVED',
  'DRIVER_ID_SCAN_STARTED',
  'ID_SCAN_PASSED',
  'ID_SCAN_FAILED',
  'DRIVER_DELIVERED',
  'DRIVER_ID_SCAN_RETRY',
  'DRIVER_RETURNED',
  'DISPUTE_OPENED',
];

describe('orderMachine — terminal-state classification', () => {
  it('marks the spec-defined terminal states', () => {
    expect([...TERMINAL_ORDER_STATES].sort()).toEqual(
      [
        'canceled',
        'delivered',
        'disputed',
        'payment_failed',
        'rejected',
        'returned_to_store',
      ].sort(),
    );
  });

  it('every terminal state passes isTerminalOrderState', () => {
    for (const state of TERMINAL_ORDER_STATES) {
      expect(isTerminalOrderState(state)).toBe(true);
    }
  });

  it('non-terminal states fail isTerminalOrderState', () => {
    const terminal = new Set<OrderState>(TERMINAL_ORDER_STATES);
    for (const state of ORDER_STATES) {
      if (!terminal.has(state)) {
        expect(isTerminalOrderState(state)).toBe(false);
      }
    }
  });
});

describe('nextOrderState — forward (happy-path) transitions', () => {
  for (const { from, event, to } of FORWARD_TRANSITIONS) {
    it(`${from} -> ${event} -> ${to}`, () => {
      expect(nextOrderState(from, event)).toBe(to);
    });
  }
});

describe('nextOrderState — invalid transitions', () => {
  const legalKey = (s: OrderState, e: OrderEventType): string => `${s}::${e}`;
  const legalSet = new Set(FORWARD_TRANSITIONS.map(({ from, event }) => legalKey(from, event)));

  it('every non-terminal state rejects every event NOT in the forward table', () => {
    const terminal = new Set<OrderState>(TERMINAL_ORDER_STATES);
    for (const state of ORDER_STATES) {
      if (terminal.has(state)) continue;
      for (const event of ALL_EVENT_TYPES) {
        if (legalSet.has(legalKey(state, event))) continue;
        expect(() => nextOrderState(state, event)).toThrow(OrderError);
        try {
          nextOrderState(state, event);
        } catch (err) {
          expect(err).toBeInstanceOf(OrderError);
          const e = err as OrderError;
          expect(e.code).toBe('ORDER_INVALID_TRANSITION');
          expect(e.statusCode).toBe(422);
          expect(e.details).toMatchObject({ from: state, event });
        }
      }
    }
  });

  it('terminal states reject every event with ORDER_TERMINAL_STATE', () => {
    for (const state of TERMINAL_ORDER_STATES) {
      // `delivered` is the one "terminal-but-still-transitions" exception
      // (DISPUTE_OPENED), so skip it here and assert it in its own test.
      if (state === 'delivered') continue;
      for (const event of ALL_EVENT_TYPES) {
        let thrown: unknown;
        try {
          nextOrderState(state, event);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `${state} -> ${event} should have thrown`).toBeInstanceOf(OrderError);
        const e = thrown as OrderError;
        expect(e.code).toBe('ORDER_TERMINAL_STATE');
        expect(e.statusCode).toBe(422);
      }
    }
  });

  it('delivered accepts only DISPUTE_OPENED and rejects everything else', () => {
    expect(nextOrderState('delivered', 'DISPUTE_OPENED')).toBe('disputed');
    for (const event of ALL_EVENT_TYPES) {
      if (event === 'DISPUTE_OPENED') continue;
      expect(() => nextOrderState('delivered', event)).toThrow(OrderError);
    }
  });

  it('rejects an unknown current state with ORDER_STATE_UNKNOWN', () => {
    let thrown: unknown;
    try {
      nextOrderState('not_a_real_state' as OrderState, 'VENDOR_ACCEPT');
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'Expected ORDER_STATE_UNKNOWN to throw').toBeInstanceOf(OrderError);
    const e = thrown as OrderError;
    expect(e.code).toBe('ORDER_STATE_UNKNOWN');
    expect(e.statusCode).toBe(500);
    expect(e.details).toMatchObject({ state: 'not_a_real_state' });
  });
});

describe('tryNextOrderState', () => {
  it('returns ok: true on legal transition', () => {
    expect(tryNextOrderState('placed', 'VENDOR_ACCEPT')).toEqual({ ok: true, next: 'accepted' });
  });

  it('returns ok: false with OrderError on illegal transition', () => {
    const res = tryNextOrderState('placed', 'DRIVER_PICKED_UP');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(OrderError);
      expect(res.error.code).toBe('ORDER_INVALID_TRANSITION');
    }
  });

  it('returns ok: false with OrderError on terminal state', () => {
    const res = tryNextOrderState('canceled', 'VENDOR_ACCEPT');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ORDER_TERMINAL_STATE');
    }
  });

  it('returns ok: false with OrderError on unknown state', () => {
    const res = tryNextOrderState('garbage' as OrderState, 'VENDOR_ACCEPT');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ORDER_STATE_UNKNOWN');
    }
  });

  it('propagates non-OrderError exceptions unchanged', () => {
    // Production-grade nextOrderState only throws OrderError, so we inject
    // a resolver that throws a vanilla error to exercise the rethrow
    // branch — without this, any future bug that produces a non-OrderError
    // would be silently swallowed by tryNextOrderState. The injectable
    // resolver parameter exists solely for this coverage path.
    expect(() =>
      tryNextOrderState('placed', 'VENDOR_ACCEPT', () => {
        throw new RangeError('boom');
      }),
    ).toThrow(RangeError);
  });
});

describe('legalEventsFrom', () => {
  it('returns exactly the forward-edge events for each non-terminal state', () => {
    const expected = new Map<OrderState, OrderEventType[]>();
    for (const state of ORDER_STATES) expected.set(state, []);
    for (const { from, event } of FORWARD_TRANSITIONS) {
      expected.get(from)!.push(event);
    }
    for (const state of ORDER_STATES) {
      const got = [...legalEventsFrom(state)].sort();
      const want = [...(expected.get(state) ?? [])].sort();
      expect(got).toEqual(want);
    }
  });

  it('returns empty for terminal states (except delivered which allows DISPUTE_OPENED)', () => {
    for (const state of TERMINAL_ORDER_STATES) {
      if (state === 'delivered') {
        expect(legalEventsFrom(state)).toEqual(['DISPUTE_OPENED']);
      } else {
        expect(legalEventsFrom(state)).toEqual([]);
      }
    }
  });
});

describe('OrderError factories cover every code', () => {
  it('notFound', () => {
    const e = OrderError.notFound('abc');
    expect(e.code).toBe('ORDER_NOT_FOUND');
    expect(e.statusCode).toBe(404);
    expect(e.details).toEqual({ orderId: 'abc' });
  });

  it('actorForbidden', () => {
    const e = OrderError.actorForbidden('wrong role', { actorRole: 'customer' });
    expect(e.code).toBe('ORDER_ACTOR_FORBIDDEN');
    expect(e.statusCode).toBe(403);
    expect(e.details).toEqual({ actorRole: 'customer' });
  });

  it('actorForbidden uses default empty details when omitted', () => {
    const e = OrderError.actorForbidden('forbidden');
    expect(e.details).toEqual({});
  });

  it('cancelTooLate', () => {
    const e = OrderError.cancelTooLate('accepted');
    expect(e.code).toBe('ORDER_CANCEL_TOO_LATE');
    expect(e.statusCode).toBe(422);
    expect(e.details).toEqual({ state: 'accepted' });
  });

  it('rateNotDelivered', () => {
    const e = OrderError.rateNotDelivered('en_route_dropoff');
    expect(e.code).toBe('ORDER_RATE_NOT_DELIVERED');
    expect(e.statusCode).toBe(422);
    expect(e.details).toEqual({ state: 'en_route_dropoff' });
  });

  it('ratingOutOfRange', () => {
    const e = OrderError.ratingOutOfRange('driverRating', 9);
    expect(e.code).toBe('ORDER_RATING_OUT_OF_RANGE');
    expect(e.statusCode).toBe(422);
    expect(e.details).toEqual({ field: 'driverRating', value: 9 });
  });

  it('constructor stores a cause when supplied', () => {
    const cause = new Error('root');
    const e = new OrderError('ORDER_NOT_FOUND', 'missing', { orderId: 'x' }, cause);
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('OrderError');
  });

  it('constructor defaults details to {} when omitted', () => {
    const e = new OrderError('ORDER_NOT_FOUND', 'missing');
    expect(e.details).toEqual({});
  });
});

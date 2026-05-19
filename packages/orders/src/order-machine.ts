import { createActor, setup } from 'xstate';
import { OrderError } from './errors.js';
import { ORDER_STATES, type OrderState } from './states.js';
import type { OrderEventType, OrderMachineEvent } from './events.js';

/**
 * XState v5 definition of the order lifecycle. Mirrors the diagram in
 * `docs/spec/DankDash-Technical-Spec.md` §3.3 exactly. The machine itself
 * has no actions, no entry/exit side effects, and no actors — it's a pure
 * transition table that the `OrderTransitionService` consults inside the
 * same DB transaction that persists the new status + appends the
 * `order_events` row. Service-layer authorization (who is allowed to send
 * which event) is enforced separately; the machine only answers "is this
 * edge legal from the current node?".
 *
 * Why XState over a hand-rolled `Record<state, Record<event, state>>`:
 * the v5 typing surfaces invalid transitions at compile time, and the
 * machine can later drive a SwiftUI animation diagram or a vendor-portal
 * state graph without re-deriving the structure.
 */
export const orderMachine = setup({
  types: {
    events: {} as OrderMachineEvent,
  },
}).createMachine({
  id: 'order',
  initial: 'placed',
  states: {
    placed: {
      on: {
        VENDOR_ACCEPT: 'accepted',
        VENDOR_REJECT: 'rejected',
        CUSTOMER_CANCEL: 'canceled',
        PAYMENT_FAILED: 'payment_failed',
      },
    },
    payment_failed: { type: 'final' },
    accepted: {
      on: {
        VENDOR_PREPPING: 'prepping',
        STORE_CANCEL: 'canceled',
      },
    },
    rejected: { type: 'final' },
    prepping: {
      on: {
        VENDOR_READY: 'ready_for_pickup',
        STORE_CANCEL: 'canceled',
      },
    },
    ready_for_pickup: {
      on: {
        DISPATCH_QUEUE: 'awaiting_driver',
        STORE_CANCEL: 'canceled',
      },
    },
    awaiting_driver: {
      on: {
        DRIVER_ASSIGNED: 'driver_assigned',
        DISPATCH_FAILED: 'dispatch_failed',
        STORE_CANCEL: 'canceled',
      },
    },
    dispatch_failed: { type: 'final' },
    driver_assigned: {
      on: {
        DRIVER_EN_ROUTE_PICKUP: 'en_route_pickup',
      },
    },
    en_route_pickup: {
      on: {
        DRIVER_PICKED_UP: 'picked_up',
      },
    },
    picked_up: {
      on: {
        DRIVER_EN_ROUTE_DROPOFF: 'en_route_dropoff',
      },
    },
    en_route_dropoff: {
      on: {
        DRIVER_ARRIVED: 'arrived_at_dropoff',
      },
    },
    arrived_at_dropoff: {
      on: {
        DRIVER_ID_SCAN_STARTED: 'id_scan_pending',
      },
    },
    id_scan_pending: {
      on: {
        ID_SCAN_PASSED: 'id_scan_passed',
        ID_SCAN_FAILED: 'id_scan_failed',
      },
    },
    id_scan_passed: {
      on: {
        DRIVER_DELIVERED: 'delivered',
      },
    },
    id_scan_failed: {
      on: {
        DRIVER_ID_SCAN_RETRY: 'id_scan_pending',
        DRIVER_RETURNED: 'returned_to_store',
      },
    },
    delivered: {
      on: {
        DISPUTE_OPENED: 'disputed',
      },
    },
    returned_to_store: { type: 'final' },
    canceled: { type: 'final' },
    disputed: { type: 'final' },
  },
});

const ORDER_STATE_SET: ReadonlySet<OrderState> = new Set(ORDER_STATES);

function assertKnownState(state: string): asserts state is OrderState {
  if (!(ORDER_STATE_SET as ReadonlySet<string>).has(state)) {
    throw OrderError.stateUnknown(state);
  }
}

/**
 * Pure transition resolver. Given the current persisted status and an event
 * the service-layer wants to apply, return the next status — or throw an
 * `OrderError` whose `code` distinguishes "illegal transition" from
 * "already terminal". Never spins up a long-running actor; safe to call
 * inside a DB transaction without managing actor lifecycle.
 *
 * The XState actor is created, fed one event, and discarded; this is
 * intentional and far cheaper than re-implementing the transition table
 * by hand. Actors are subscription-based but `getSnapshot()` is synchronous
 * so this remains a pure function from `(state, event)` to next-state.
 */
export function nextOrderState(current: OrderState, event: OrderEventType): OrderState {
  assertKnownState(current);

  const actor = createActor(orderMachine, {
    snapshot: orderMachine.resolveState({ value: current }),
  });
  actor.start();
  const startStatus = actor.getSnapshot().status;
  if (startStatus === 'done') {
    actor.stop();
    throw OrderError.terminalState(current, event);
  }

  actor.send({ type: event });
  const snap = actor.getSnapshot();
  const next = snap.value as string;
  actor.stop();

  if (next === current) {
    throw OrderError.invalidTransition(current, event);
  }
  assertKnownState(next);
  return next;
}

/**
 * Sibling to `nextOrderState` that returns a discriminated result instead
 * of throwing. Useful when the caller wants to enumerate every possible
 * event from a state (e.g. for UI gating) without paying the exception
 * cost on every illegal edge.
 */
export type TransitionResult =
  | { readonly ok: true; readonly next: OrderState }
  | { readonly ok: false; readonly error: OrderError };

/**
 * The `resolver` argument exists for tests — the production call always uses
 * the default. We accept it because the public contract of this function is
 * "wrap whatever `nextOrderState` does and convert `OrderError` to a result
 * union", and the unreachable rethrow branch must still be covered.
 */
export function tryNextOrderState(
  current: OrderState,
  event: OrderEventType,
  resolver: (s: OrderState, e: OrderEventType) => OrderState = nextOrderState,
): TransitionResult {
  try {
    return { ok: true, next: resolver(current, event) };
  } catch (err) {
    if (err instanceof OrderError) {
      return { ok: false, error: err };
    }
    throw err;
  }
}

const ALL_EVENT_TYPES: readonly OrderEventType[] = [
  'PAYMENT_FAILED',
  'CUSTOMER_CANCEL',
  'VENDOR_ACCEPT',
  'VENDOR_REJECT',
  'VENDOR_PREPPING',
  'VENDOR_READY',
  'STORE_CANCEL',
  'DISPATCH_QUEUE',
  'DISPATCH_FAILED',
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

/**
 * Every event type that is legal from `current`. Drives UI affordances
 * (e.g. the vendor portal showing only the buttons whose events resolve)
 * and lets tests assert the diagram exhaustively. Resolved against the
 * machine's transition table via the public `tryNextOrderState` API rather
 * than internal XState fields so the next minor-version bump cannot break
 * us silently.
 */
export function legalEventsFrom(current: OrderState): readonly OrderEventType[] {
  return ALL_EVENT_TYPES.filter((evt) => tryNextOrderState(current, evt).ok);
}

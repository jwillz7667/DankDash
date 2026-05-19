/**
 * Authoritative list of order lifecycle states. Mirrors the `order_status`
 * Postgres enum declared in `@dankdash/db/schema/enums.ts` — when changing
 * this tuple, also change the DB enum, ship a migration, and mirror the
 * change in the iOS `OrderStatus` enum. The compile-time mirror check in
 * `apps/api/test/integration/orders/order-status-mirror.test.ts` guards
 * against drift between the two declarations.
 *
 * Listed in roughly forward-flow order so a code review can trace the happy
 * path top-to-bottom; the terminal states cluster at the end of the tuple.
 */
export const ORDER_STATES = [
  'placed',
  'payment_failed',
  'accepted',
  'rejected',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'driver_assigned',
  'en_route_pickup',
  'picked_up',
  'en_route_dropoff',
  'arrived_at_dropoff',
  'id_scan_pending',
  'id_scan_passed',
  'id_scan_failed',
  'delivered',
  'returned_to_store',
  'canceled',
  'disputed',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Terminal states — no further transitions are permitted. The service layer
 * uses this set to short-circuit obviously-rejected inputs before spinning
 * up the state machine.
 */
export const TERMINAL_ORDER_STATES = [
  'payment_failed',
  'rejected',
  'delivered',
  'returned_to_store',
  'canceled',
  'disputed',
] as const satisfies readonly OrderState[];

export type TerminalOrderState = (typeof TERMINAL_ORDER_STATES)[number];

export function isTerminalOrderState(state: OrderState): state is TerminalOrderState {
  return (TERMINAL_ORDER_STATES as readonly OrderState[]).includes(state);
}

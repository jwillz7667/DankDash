/**
 * Pure reducers that patch the local queue snapshot in response to
 * realtime events from the `/vendor` Socket.io namespace.
 *
 * Factoring these out of the React board keeps the merge logic
 * exhaustively testable without a DOM, a socket, or a render tree —
 * the board just calls these on each event and resets state with the
 * returned array.
 *
 * Idempotency:
 *
 *   - `applyOrderCreated` is a no-op when the order id is already in
 *     the snapshot. Socket.io can redeliver after a reconnect, and the
 *     server may emit `order:created` shortly before a polling-fallback
 *     fetch lands the same row — collapsing both paths to a single
 *     visible card is the contract.
 *
 *   - `applyOrderStatusChanged` is a no-op when the order id is not in
 *     the snapshot. The realtime payload is intentionally lean (the
 *     server doesn't re-derive `customerName`, `itemCount`, etc. per
 *     event), so we cannot synthesize a card from a status-change
 *     alone. A subsequent snapshot refresh — page reload or the
 *     Phase 14.4 polling fallback — fills the gap.
 *
 * Cardinality:
 *
 *   - Both reducers preserve every other row's identity (`===`). That
 *     lets React skip re-rendering untouched `QueueCard`s when the
 *     board re-buckets, even though the array itself is a fresh copy.
 *
 *   - When a status change takes an order off the queue surface
 *     (e.g. `ready_for_pickup` → `delivered`), the order is removed
 *     from the snapshot rather than retained-but-hidden. Keeping
 *     terminal rows around would grow the array unboundedly across a
 *     long operator shift.
 */
import { asOrderStatus, type VendorQueueOrderSummary } from '../api/vendor-orders.js';
import { columnKeyForStatus } from './queue-columns.js';
import type { OrderStatusChange, OrderSummary } from '../realtime/client.js';

/**
 * Project an `order:created` realtime payload into the queue summary
 * shape the board renders. Fields the realtime envelope doesn't carry
 * (`customerName`, `itemCount`, `subtotalCents`, per-state timestamps)
 * are filled with safe placeholders: the card paints "Guest customer"
 * and "1 item" until a snapshot refresh fills in the truth.
 *
 * The placeholders are intentionally lossy rather than blocking the
 * insert on a follow-up fetch — the operator's first signal that a new
 * order arrived is the card appearing in the New column, and shaving
 * even one network round-trip off that latency is the reason realtime
 * exists. The details fill in on the next paint.
 */
export function applyOrderCreated(
  state: readonly VendorQueueOrderSummary[],
  payload: OrderSummary,
): readonly VendorQueueOrderSummary[] {
  if (state.some((order) => order.id === payload.orderId)) return state;

  const status = asOrderStatus(payload.status);
  if (status === null) return state;
  if (columnKeyForStatus(status) === undefined) return state;

  const projected: VendorQueueOrderSummary = {
    id: payload.orderId,
    shortCode: payload.shortCode,
    userId: payload.customerId,
    customerName: null,
    status,
    itemCount: 1,
    subtotalCents: payload.totalCents,
    totalCents: payload.totalCents,
    placedAt: payload.placedAt,
    statusChangedAt: payload.placedAt,
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
  };
  return [projected, ...state];
}

/**
 * Patch the snapshot for an `order:status_changed` event. The match
 * is by `orderId`; misses (an order that arrived before this tab
 * mounted, or one already removed by an earlier terminal transition)
 * fall through as no-ops.
 *
 * Hit semantics:
 *
 *   - The matching row's `status` is replaced with the narrowed
 *     `toStatus` and `statusChangedAt` is set to the event's
 *     `changedAt` — that's the only timestamp the card renders.
 *   - If `toStatus` falls outside the queue surface (`delivered`,
 *     `canceled`, `disputed`, …), the row is removed.
 *   - If `toStatus` doesn't narrow to a known `OrderStatus`, the row
 *     is removed defensively — a payload that bypasses the type guard
 *     would otherwise leak into `bucketByColumn` and break rendering.
 */
export function applyOrderStatusChanged(
  state: readonly VendorQueueOrderSummary[],
  payload: OrderStatusChange,
): readonly VendorQueueOrderSummary[] {
  const index = state.findIndex((order) => order.id === payload.orderId);
  if (index < 0) return state;

  const status = asOrderStatus(payload.toStatus);
  if (status === null || columnKeyForStatus(status) === undefined) {
    return state.filter((_, i) => i !== index);
  }

  const current = state[index];
  if (current === undefined) return state;
  const next: VendorQueueOrderSummary = {
    ...current,
    status,
    statusChangedAt: payload.changedAt,
  };
  return [...state.slice(0, index), next, ...state.slice(index + 1)];
}

/**
 * Pure logic for the queue board's drag-drop behavior.
 *
 * Drag-drop is intentionally narrow: the server-authoritative state
 * machine only honors specific forward transitions, and a drop that
 * would require two transitions (e.g. `accepted` → `ready_for_pickup`
 * skipping `prepping`) is rejected at the API layer anyway. We mirror
 * that constraint client-side so the operator never sees a phantom
 * move that the server will roll back.
 *
 * Allowed forward drags:
 *
 *   - New column → Prepping column
 *     status `placed` → action `accept` (server: placed → accepted)
 *   - Prepping column → Ready column
 *     status `prepping` → action `markReady` (server: prepping →
 *     ready_for_pickup). NOT valid for `accepted` orders — they must
 *     go through the drawer's "Start prepping" action first, because
 *     the state machine forbids skipping `prepping`.
 *
 * All other column transitions are forbidden:
 *
 *   - Backward drags: would violate the state machine.
 *   - Ready → Out for Delivery: driven by dispatch (server-side), not
 *     an operator action.
 *   - Out for Delivery → terminal: handoff requires a driver-side ID
 *     scan, which the portal can't perform.
 *   - Cross-row jumps (New → Ready): would require two transitions.
 */
import { QUEUE_COLUMNS, type QueueColumnKey } from './queue-columns.js';
import type { VendorOrderActions } from './order-actions.js';
import type {
  OrderStatus,
  TransitionResponse,
  VendorQueueOrderSummary,
} from '../api/vendor-orders.js';

const QUEUE_COLUMN_KEYS: ReadonlySet<QueueColumnKey> = new Set(QUEUE_COLUMNS.map((c) => c.key));

export function isQueueColumnKey(value: unknown): value is QueueColumnKey {
  return typeof value === 'string' && QUEUE_COLUMN_KEYS.has(value as QueueColumnKey);
}

export type DragActionKey = 'accept' | 'markReady';

/**
 * Resolve a drag-drop into an action key, or `null` if the move is
 * not allowed. Pure — caller decides what to do with the result.
 */
export function dragActionFor(
  status: OrderStatus,
  targetColumn: QueueColumnKey,
): DragActionKey | null {
  if (status === 'placed' && targetColumn === 'prepping') return 'accept';
  if (status === 'prepping' && targetColumn === 'ready') return 'markReady';
  return null;
}

/**
 * Which target columns will accept *any* card whose current column
 * matches `fromColumn`. Used by the board to highlight only legal
 * drop zones while a drag is in flight — keeps the visual feedback
 * truthful (a glowing column that would reject the drop is worse
 * than no glow at all).
 */
export function validTargetColumnsFor(status: OrderStatus): ReadonlySet<QueueColumnKey> {
  const targets = new Set<QueueColumnKey>();
  if (status === 'placed') targets.add('prepping');
  if (status === 'prepping') targets.add('ready');
  return targets;
}

export interface DragResolution {
  readonly orderId: string;
  readonly action: DragActionKey;
}

/**
 * Resolve a `DragEndEvent`-shaped pair (active id, over id) against
 * the current snapshot. Returns the action to fire, or `null` for any
 * invalid drop (unknown order, non-column drop zone, illegal
 * transition).
 *
 * Pulled out of the board component so it is unit-testable without
 * mounting `DndContext`.
 */
export function resolveDragDrop(
  orders: readonly VendorQueueOrderSummary[],
  activeId: unknown,
  overId: unknown,
): DragResolution | null {
  if (typeof activeId !== 'string') return null;
  if (!isQueueColumnKey(overId)) return null;
  const order = orders.find((o) => o.id === activeId);
  if (order === undefined) return null;
  const action = dragActionFor(order.status, overId);
  if (action === null) return null;
  return { orderId: order.id, action };
}

/**
 * Dispatch the resolved drag action via the `VendorOrderActions`
 * surface, then hand the typed response back to the caller. Errors
 * are surfaced through `onError` rather than thrown — drag-drop
 * shouldn't blow up the render tree on a transient API failure.
 *
 * Pure side-effect layer (no React state) so the board's drag handler
 * is testable without `DndContext`.
 */
export async function dispatchDragAction(
  resolution: DragResolution,
  actions: VendorOrderActions,
): Promise<TransitionResponse> {
  switch (resolution.action) {
    case 'accept':
      return actions.accept(resolution.orderId);
    case 'markReady':
      return actions.markReady(resolution.orderId);
  }
}

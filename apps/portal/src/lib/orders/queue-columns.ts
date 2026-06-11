/**
 * Kanban column configuration for the vendor order queue.
 *
 * Phase 14 surfaces four columns — New / Prepping / Ready / Out for
 * Delivery — covering every state the dispensary actively works on.
 * Anything outside (pre-payment, terminal, driver-side once handed
 * off) belongs on the order detail timeline, not in the queue.
 *
 * Column → underlying status mapping:
 *
 *   - New                — `placed` (cart cleared compliance, payment
 *                          captured, awaiting the dispensary's accept).
 *   - Prepping           — `accepted` (just accepted, batch not yet
 *                          assembled) and `prepping` (budtender picking
 *                          and bagging).
 *   - Ready              — `ready_for_pickup` (sealed bag tagged,
 *                          waiting on a driver).
 *   - Out for Delivery   — `awaiting_driver` (dispatch open) and
 *                          `driver_assigned` (driver accepted, en
 *                          route to the store; the order stays on the
 *                          dispensary board until handoff so they can
 *                          see who's coming).
 *
 * `bucketByColumn` is the single chokepoint that maps the wire-shape
 * list of orders into the rendered columns — UI components consume its
 * output and never touch `OrderStatus` directly, so a column change is
 * a one-file edit.
 */
import type { BadgeTone } from '../../components/ui/badge.js';
import type { OrderStatus, VendorQueueOrderSummary } from '../api/vendor-orders.js';

export type QueueColumnKey = 'new' | 'prepping' | 'ready' | 'out_for_delivery';

export interface QueueColumnConfig {
  readonly key: QueueColumnKey;
  readonly label: string;
  readonly helper: string;
  readonly tone: BadgeTone;
  readonly statuses: readonly OrderStatus[];
}

export const QUEUE_COLUMNS: readonly QueueColumnConfig[] = [
  {
    key: 'new',
    label: 'New',
    helper: 'Awaiting acceptance',
    tone: 'info',
    statuses: ['placed'],
  },
  {
    key: 'prepping',
    label: 'Prepping',
    helper: 'Picking and bagging',
    tone: 'accent',
    statuses: ['accepted', 'prepping'],
  },
  {
    key: 'ready',
    label: 'Ready',
    helper: 'Tagged for handoff',
    tone: 'warning',
    statuses: ['ready_for_pickup'],
  },
  {
    key: 'out_for_delivery',
    label: 'Out for Delivery',
    helper: 'Driver inbound',
    tone: 'success',
    statuses: ['awaiting_driver', 'driver_assigned', 'en_route_pickup'],
  },
] as const;

/**
 * Reverse index — `status → column key`. Pre-computed at module load
 * so per-order lookup is O(1) regardless of column count. Statuses not
 * in any column return undefined (e.g. `delivered`, `canceled`) — the
 * board drops them rather than miscategorize.
 */
const STATUS_TO_COLUMN: ReadonlyMap<OrderStatus, QueueColumnKey> = (() => {
  const m = new Map<OrderStatus, QueueColumnKey>();
  for (const column of QUEUE_COLUMNS) {
    for (const status of column.statuses) {
      m.set(status, column.key);
    }
  }
  return m;
})();

export function columnKeyForStatus(status: OrderStatus): QueueColumnKey | undefined {
  return STATUS_TO_COLUMN.get(status);
}

export type BucketedQueue = Readonly<Record<QueueColumnKey, readonly VendorQueueOrderSummary[]>>;

/**
 * Group a flat order list by column. Stable within a column —
 * preserves the API-side ordering (oldest `statusChangedAt` first,
 * which puts the most-aged work at the top so the dispensary always
 * sees the bottleneck first).
 *
 * Pure: no side effects, deterministic for a given input. Memoizing
 * is the caller's job — React's `useMemo` is the natural fit on the
 * client; on the server we recompute per render.
 */
export function bucketByColumn(orders: readonly VendorQueueOrderSummary[]): BucketedQueue {
  const buckets: Record<QueueColumnKey, VendorQueueOrderSummary[]> = {
    new: [],
    prepping: [],
    ready: [],
    out_for_delivery: [],
  };
  for (const order of orders) {
    const key = columnKeyForStatus(order.status);
    if (key === undefined) continue;
    buckets[key].push(order);
  }
  return buckets;
}

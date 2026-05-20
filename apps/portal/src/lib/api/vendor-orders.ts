/**
 * Typed surface for the vendor-orders endpoints the portal queue
 * consumes.
 *
 * Mirrors the wire shape from
 * `apps/api/src/modules/orders/dto/index.ts`:
 *
 *   - `VendorQueueOrderResponseSchema` → {@link VendorQueueOrderSummary}
 *   - `ListVendorQueueResponseSchema`  → return of {@link listVendorQueue}
 *   - `OrderResponseSchema`            → {@link VendorOrderDetail}
 *
 * We hand-mirror rather than import the API package — pulling NestJS
 * decorator metadata into Next's bundler trips reflect-metadata code
 * paths that have no business in the browser. A drift between the API
 * DTO and this file surfaces as a typecheck failure in any consumer
 * that reads a field that no longer exists.
 *
 * The full {@link ORDER_STATUSES} enum is mirrored even though the
 * queue only paints six of them by default — realtime `toStatus` can
 * be any of the twenty (e.g. a transition out of the queue surface
 * like `delivered`), and the bucketing helper must be able to filter
 * those out without a runtime cast.
 */
import type { ApiClient } from './client.js';

export const ORDER_STATUSES = [
  'placed',
  'payment_failed',
  'accepted',
  'rejected',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'dispatch_failed',
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
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const ORDER_STATUS_SET: ReadonlySet<string> = new Set(ORDER_STATUSES);

/** Narrow an arbitrary wire string to OrderStatus, or null. */
export function asOrderStatus(value: string): OrderStatus | null {
  return ORDER_STATUS_SET.has(value) ? (value as OrderStatus) : null;
}

/**
 * The six statuses the vendor queue surfaces by default — the API's
 * own `VENDOR_QUEUE_DEFAULT_STATUSES` constant. Anything outside this
 * list is either pre-payment (placed → payment_failed), post-handoff
 * (en_route_pickup onward), or a terminal cancel/dispute — none of
 * which the dispensary acts on from the kanban.
 */
export const VENDOR_QUEUE_DEFAULT_STATUSES: readonly OrderStatus[] = [
  'placed',
  'accepted',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'driver_assigned',
] as const;

export interface VendorQueueOrderSummary {
  readonly id: string;
  readonly shortCode: string;
  readonly userId: string;
  readonly customerName: string | null;
  readonly status: OrderStatus;
  readonly itemCount: number;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly placedAt: string;
  readonly statusChangedAt: string;
  readonly acceptedAt: string | null;
  readonly preppingAt: string | null;
  readonly preparedAt: string | null;
}

export interface VendorOrderTimestamps {
  readonly placedAt: string;
  readonly paymentFailedAt: string | null;
  readonly acceptedAt: string | null;
  readonly rejectedAt: string | null;
  readonly preppingAt: string | null;
  readonly preparedAt: string | null;
  readonly awaitingDriverAt: string | null;
  readonly dispatchFailedAt: string | null;
  readonly driverAssignedAt: string | null;
  readonly enRoutePickupAt: string | null;
  readonly pickedUpAt: string | null;
  readonly enRouteDropoffAt: string | null;
  readonly arrivedAtDropoffAt: string | null;
  readonly idScanPendingAt: string | null;
  readonly deliveredAt: string | null;
  readonly returnedToStoreAt: string | null;
  readonly canceledAt: string | null;
  readonly disputedAt: string | null;
  readonly ratedAt: string | null;
}

export interface VendorOrderRatings {
  readonly customer: number | null;
  readonly review: string | null;
  readonly dispensary: number | null;
  readonly driver: number | null;
}

export interface VendorOrderDetail {
  readonly id: string;
  readonly shortCode: string;
  readonly userId: string;
  readonly dispensaryId: string;
  readonly driverId: string | null;
  readonly status: OrderStatus;
  readonly statusChangedAt: string;
  readonly subtotalCents: number;
  readonly cannabisTaxCents: number;
  readonly salesTaxCents: number;
  readonly deliveryFeeCents: number;
  readonly driverTipCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly timestamps: VendorOrderTimestamps;
  readonly ratings: VendorOrderRatings;
}

export interface ListVendorQueueParams {
  readonly statuses?: readonly OrderStatus[];
  readonly limit?: number;
}

export interface ListVendorQueueResult {
  readonly orders: readonly VendorQueueOrderSummary[];
}

/**
 * GET /v1/vendor/orders — the queue feed. The server projects only
 * what the kanban card needs; the drawer fetches the full detail via
 * {@link getVendorOrder} on demand.
 */
export async function listVendorQueue(
  client: ApiClient,
  params: ListVendorQueueParams = {},
): Promise<ListVendorQueueResult> {
  const query: Record<string, string | number> = {};
  if (params.statuses !== undefined && params.statuses.length > 0) {
    query['statuses'] = params.statuses.join(',');
  }
  if (params.limit !== undefined) {
    query['limit'] = params.limit;
  }
  return client.request<ListVendorQueueResult>('/v1/vendor/orders', { query });
}

/**
 * GET /v1/vendor/orders/:id — the drawer detail call. Returns the full
 * `OrderResponse`, not the lean queue projection.
 */
export async function getVendorOrder(
  client: ApiClient,
  orderId: string,
): Promise<VendorOrderDetail> {
  return client.request<VendorOrderDetail>(`/v1/vendor/orders/${encodeURIComponent(orderId)}`);
}

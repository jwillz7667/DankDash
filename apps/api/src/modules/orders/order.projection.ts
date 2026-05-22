/**
 * Wire projection — converts a Drizzle `Order` row into the externally
 * stable `OrderResponse` shape. Kept separate from the services so the
 * vendor-listing and customer-detail surfaces serialise identically; if
 * we ever need to surface a different shape per surface we'll fork this
 * function rather than scatter the mapping.
 *
 * `Date | null` values are rendered as ISO-8601 strings (or `null`).
 * Dates serialised through Fastify's default JSON path go through
 * `Date.prototype.toJSON`, but doing the conversion here keeps the
 * controller's return type a plain JSON shape, which is easier to
 * snapshot in tests.
 */
import type { OrderResponse, VendorQueueOrderResponse } from './dto/index.js';
import type { Order, VendorQueueOrderRow } from '@dankdash/db';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Builds the lean "queue card" projection for the vendor portal.
 * Concatenates the customer's first/last name into a single
 * `customerName` string; emits `null` when both fields are absent
 * (soft-deleted user). Trims away whitespace from the join.
 */
function joinCustomerName(first: string | null, last: string | null): string | null {
  const combined = [first, last]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return combined.length > 0 ? combined : null;
}

export function projectVendorQueueOrder(row: VendorQueueOrderRow): VendorQueueOrderResponse {
  return {
    id: row.id,
    shortCode: row.shortCode,
    userId: row.userId,
    customerName: joinCustomerName(row.customerFirstName, row.customerLastName),
    status: row.status,
    itemCount: row.itemCount,
    subtotalCents: row.subtotalCents,
    totalCents: row.totalCents,
    placedAt: row.placedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    acceptedAt: iso(row.acceptedAt),
    preppingAt: iso(row.preppingAt),
    preparedAt: iso(row.preparedAt),
  };
}

export function projectOrder(o: Order): OrderResponse {
  return {
    id: o.id,
    shortCode: o.shortCode,
    userId: o.userId,
    dispensaryId: o.dispensaryId,
    driverId: o.driverId,
    status: o.status,
    statusChangedAt: o.statusChangedAt.toISOString(),
    subtotalCents: o.subtotalCents,
    cannabisTaxCents: o.cannabisTaxCents,
    salesTaxCents: o.salesTaxCents,
    deliveryFeeCents: o.deliveryFeeCents,
    driverTipCents: o.driverTipCents,
    discountCents: o.discountCents,
    totalCents: o.totalCents,
    timestamps: {
      placedAt: o.placedAt.toISOString(),
      paymentFailedAt: iso(o.paymentFailedAt),
      acceptedAt: iso(o.acceptedAt),
      rejectedAt: iso(o.rejectedAt),
      preppingAt: iso(o.preppingAt),
      preparedAt: iso(o.preparedAt),
      awaitingDriverAt: iso(o.awaitingDriverAt),
      dispatchFailedAt: iso(o.dispatchFailedAt),
      driverAssignedAt: iso(o.driverAssignedAt),
      enRoutePickupAt: iso(o.enRoutePickupAt),
      pickedUpAt: iso(o.pickedUpAt),
      enRouteDropoffAt: iso(o.enRouteDropoffAt),
      arrivedAtDropoffAt: iso(o.arrivedAtDropoffAt),
      idScanPendingAt: iso(o.idScanPendingAt),
      deliveredAt: iso(o.deliveredAt),
      returnedToStoreAt: iso(o.returnedToStoreAt),
      canceledAt: iso(o.canceledAt),
      disputedAt: iso(o.disputedAt),
      ratedAt: iso(o.ratedAt),
    },
    ratings: {
      customer: o.customerRating,
      review: o.customerReview,
      dispensary: o.dispensaryRating,
      driver: o.driverRating,
    },
  };
}

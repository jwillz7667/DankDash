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
import type { OrderResponse } from './dto/index.js';
import type { Order } from '@dankdash/db';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

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

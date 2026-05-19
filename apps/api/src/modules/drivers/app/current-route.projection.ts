/**
 * Order + Dispensary → CurrentRouteResponse projection.
 *
 * Pure mapper, no I/O. Two concerns:
 *
 *   1. Pickup shape — narrowed dispensary subset (name, address, geo,
 *      phone, brand colour). The public dispensary projection carries
 *      delivery-polygon + ratings + isOpenNow, none of which the driver
 *      app needs and some of which (delivery_polygon) we do not want to
 *      leak through driver tooling.
 *
 *   2. Dropoff parse — the order row stores the customer address as
 *      JSONB at `orders.delivery_address_snapshot`, written by
 *      `checkout.service.ts:serializeAddress`. We validate that JSONB
 *      through `DropoffSchema` here so a snapshot written by an older
 *      code path with a missing field surfaces as a 500 (loud failure)
 *      instead of a silently-corrupt driver card.
 */
import { RepositoryError } from '@dankdash/types';
import { projectOrder } from '../../orders/order.projection.js';
import { DropoffSchema, type CurrentRouteResponse, type Pickup } from './dto/index.js';
import type { Dispensary, Order } from '@dankdash/db';

export function projectActiveRoute(order: Order, dispensary: Dispensary): CurrentRouteResponse {
  // Snapshot shape is owned by checkout — if it doesn't match
  // DropoffSchema, the checkout writer drifted from the reader. Loud
  // 500 (REPOSITORY_INVARIANT_VIOLATION) rather than a silently-broken
  // driver card; ops can alert on the code.
  const dropoffParse = DropoffSchema.safeParse(order.deliveryAddressSnapshot);
  if (!dropoffParse.success) {
    throw new RepositoryError(
      `delivery_address_snapshot for order ${order.id} does not match Dropoff shape`,
      { orderId: order.id, issues: dropoffParse.error.issues },
    );
  }
  const pickup: Pickup = {
    dispensaryId: dispensary.id,
    name: dispensary.dba ?? dispensary.legalName,
    addressLine1: dispensary.addressLine1,
    addressLine2: dispensary.addressLine2,
    city: dispensary.city,
    region: dispensary.region,
    postalCode: dispensary.postalCode,
    location: dispensary.location,
    phone: dispensary.phone,
    brandColorHex: dispensary.brandColorHex,
  };
  return {
    activeOrder: {
      order: projectOrder(order),
      pickup,
      dropoff: dropoffParse.data,
    },
  };
}

export function projectNoActiveRoute(): CurrentRouteResponse {
  return { activeOrder: null };
}

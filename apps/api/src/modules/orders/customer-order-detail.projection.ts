/**
 * Pure projections for the consumer order-detail surface
 * (`GET /v1/orders/:id`). Mirrors the driver-side projection in
 * `drivers/services/driver-orders.service.ts` but emits the consumer
 * shape: the flat checkout order, the two map points, and the
 * privacy-minimal driver card. No I/O — `OrdersService.getDetailForUser`
 * hydrates the rows, these functions map them.
 *
 * Kept as a separate pure module (mirroring `order.projection.ts`, the
 * vendor/nested projection) so the boundary mapping — last-name
 * initialing, phone masking, GeoJSON lng/lat unwrap, vehicle-string
 * composition — is unit-testable without a DB.
 */
import {
  type Dispensary,
  type Driver,
  type Order,
  type OrderEvent,
  type OrderItem,
  type User,
} from '@dankdash/db';
import {
  OrderResponseSchema,
  type OrderItemResponse,
  type OrderResponse,
} from '../checkout/dto/index.js';
import {
  type CustomerOrderDispensary,
  type CustomerOrderDropoff,
  type DriverPublicProfile,
} from './dto/customer-order-detail.dto.js';
import { type OrderEventResponse } from './dto/index.js';

export function projectCustomerOrder(order: Order, items: readonly OrderItem[]): OrderResponse {
  const projected: OrderResponse = {
    id: order.id,
    shortCode: order.shortCode,
    userId: order.userId,
    dispensaryId: order.dispensaryId,
    deliveryAddressId: order.deliveryAddressId,
    status: order.status,
    subtotalCents: order.subtotalCents,
    cannabisTaxCents: order.cannabisTaxCents,
    salesTaxCents: order.salesTaxCents,
    deliveryFeeCents: order.deliveryFeeCents,
    driverTipCents: order.driverTipCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    items: items.map(projectCustomerOrderItem),
    placedAt: order.placedAt.toISOString(),
    statusChangedAt: order.statusChangedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
  return OrderResponseSchema.parse(projected);
}

function projectCustomerOrderItem(item: OrderItem): OrderItemResponse {
  return {
    id: item.id,
    listingId: item.listingId,
    productSnapshot: item.productSnapshot as Record<string, unknown>,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    lineSubtotalCents: item.lineSubtotalCents,
    thcMgTotal: item.thcMgTotal,
    cbdMgTotal: item.cbdMgTotal,
    weightGramsTotal: item.weightGramsTotal,
    cannabisTaxCents: item.cannabisTaxCents,
    salesTaxCents: item.salesTaxCents,
    createdAt: item.createdAt.toISOString(),
  };
}

export function projectCustomerEvent(event: OrderEvent): OrderEventResponse {
  return {
    id: event.id,
    orderId: event.orderId,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    payload: event.payload as Record<string, unknown>,
    occurredAt: event.occurredAt.toISOString(),
  };
}

export function projectCustomerDispensary(dispensary: Dispensary): CustomerOrderDispensary {
  const [lng, lat] = dispensary.location.coordinates;
  return {
    id: dispensary.id,
    name: dispensary.dba ?? dispensary.legalName,
    latitude: lat,
    longitude: lng,
  };
}

/**
 * Reads `orders.delivery_address_snapshot` — the JSONB frozen at
 * checkout. Field-by-field narrowing because the column is `unknown` at
 * the type level; we trust the checkout writer to have shaped it (see
 * checkout.service.ts `serializeAddress`). Same source the driver
 * dropoff projection reads, so the two surfaces never disagree on where
 * the order is going.
 */
export function projectCustomerDropoff(order: Order): CustomerOrderDropoff {
  const snapshot = order.deliveryAddressSnapshot as DropoffSnapshotRaw;
  const [lng, lat] = snapshot.location.coordinates;
  return {
    latitude: lat,
    longitude: lng,
    line1: snapshot.line1,
    line2: snapshot.line2,
    city: snapshot.city,
    state: snapshot.region,
    postalCode: snapshot.postalCode,
    instructions: snapshot.deliveryInstructions,
  };
}

/**
 * The driver card. `driverUser` is the `users` row referenced by
 * `orders.driver_id`; `driver` is the matching `drivers` row (vehicle
 * fields), or `null` if the driver hasn't recorded a vehicle. `id`
 * prefers the drivers-table id and falls back to the user id, so the
 * field is always present whenever a driver is assigned.
 */
export function projectDriverPublicProfile(
  driverUser: User,
  driver: Driver | null,
): DriverPublicProfile {
  return {
    id: driver?.id ?? driverUser.id,
    displayName: driverDisplayName(driverUser),
    avatarKey: null,
    vehicleSummary: vehicleSummary(driver),
    maskedPhone: maskPhone(driverUser.phone),
  };
}

interface DropoffSnapshotRaw {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly location: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly deliveryInstructions: string | null;
}

/**
 * "Sam J." — first name + last initial. Falls back to a generic label
 * when the driver has no first name on file, since the schema requires a
 * non-empty `displayName` and the consumer should still see *something*.
 */
function driverDisplayName(user: User): string {
  const first = user.firstName?.trim() ?? '';
  const lastInitial = initial(user.lastName);
  if (first.length > 0) {
    return lastInitial === null ? first : `${first} ${lastInitial}`;
  }
  return 'Your driver';
}

/**
 * "Silver 2021 Toyota Prius" — color, year, make, model in reading
 * order, skipping any unrecorded field. Returns `null` when there is no
 * driver row or no vehicle field is present.
 */
function vehicleSummary(driver: Driver | null): string | null {
  if (driver === null) return null;
  const parts = [
    driver.vehicleColor,
    driver.vehicleYear === null ? null : String(driver.vehicleYear),
    driver.vehicleMake,
    driver.vehicleModel,
  ].filter((part): part is string => part !== null && part.trim().length > 0);
  return parts.length === 0 ? null : parts.join(' ');
}

function initial(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return `${trimmed.charAt(0)}.`;
}

function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  if (phone.length < 5) return null;
  return `••• ••• ${phone.slice(-4)}`;
}

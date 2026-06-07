/**
 * DriverOrdersService — the driver app's read + write surface for an
 * order currently in their hands.
 *
 *   GET  /v1/driver/orders/:id                   → DriverOrderDetailResponse
 *   POST /v1/driver/orders/:id/pickup-confirm    → DriverOrderDetailResponse
 *   POST /v1/driver/orders/:id/delivery-confirm  → DriverOrderDetailResponse
 *
 * Three structural choices to flag:
 *
 *   1. Driver-scoped lookups. Every query pairs (orderId, driverUserId)
 *      in the WHERE so a cross-driver id resolves to null and surfaces as
 *      404 — same response shape as a missing order. A driver who pastes
 *      another driver's order id cannot enumerate the assignment graph
 *      by status code.
 *
 *   2. Snapshot-first projection. The dropoff address comes from
 *      `orders.delivery_address_snapshot` (JSONB frozen at checkout), not
 *      from a live `user_addresses` join. The customer can edit or
 *      delete the address after checkout; the driver still needs the
 *      original drop. The dispensary and customer rows are joined live
 *      because their identifiers do not change.
 *
 *   3. Status transitions never bypass OrderTransitionService. The pickup-
 *      and delivery-confirm flows hand the driver-supplied location +
 *      timestamp through as the event payload; the XState machine in
 *      `@dankdash/orders` enforces legal predecessors, and the ID-scan
 *      compliance gate lives in OrdersRepository so even a future caller
 *      can't reach `delivered` without a Veriff pass.
 *
 * The customer's last name is initialed ("Sam J.") at the boundary; the
 * raw last name never leaves the service. Phone is masked to last-4 —
 * Phase 23 will route tap-to-call through Twilio Proxy so the driver
 * never sees the raw E.164.
 */
import {
  type Database,
  type DispensariesRepository,
  type Dispensary,
  type Order,
  type OrderEvent,
  type OrderEventsRepository,
  type OrderItem,
  type OrderItemsRepository,
  type OrdersRepository,
  type User,
  type UsersRepository,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import {
  OrderResponseSchema,
  type OrderItemResponse,
  type OrderResponse,
} from '../../checkout/dto/index.js';
import { type OrderEventResponse } from '../../orders/dto/index.js';
import { OrderTransitionService } from '../../orders/order-transition.service.js';
import type {
  DriverArriveRequest,
  DriverCustomerSummary,
  DriverDeliveryConfirmRequest,
  DriverDepartRequest,
  DriverDispensarySummary,
  DriverDropoffAddress,
  DriverIdScanState,
  DriverOrderDetailResponse,
  DriverPickupConfirmRequest,
} from '../dto/index.js';

export interface DriverOrdersScopedRepos {
  readonly orders: OrdersRepository;
  readonly orderItems: OrderItemsRepository;
  readonly orderEvents: OrderEventsRepository;
  readonly users: UsersRepository;
  readonly dispensaries: DispensariesRepository;
}

export type DriverOrdersScopedReposFactory = (db: Database) => DriverOrdersScopedRepos;

@Injectable()
export class DriverOrdersService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: DriverOrdersScopedReposFactory,
    private readonly orderTransitions: OrderTransitionService,
  ) {}

  /**
   * GET /v1/driver/orders/:id. Hydrates four parallel reads after the
   * order-detail lookup confirms the driver owns this row:
   *
   *   - items + events (always)
   *   - customer (users.id = order.userId, always)
   *   - dispensary (dispensaries.id = order.dispensaryId, always)
   *
   * If the customer or dispensary row is missing (impossible under the
   * `onDelete: 'restrict'` FK but possible mid-test-mutation) we 404 —
   * the driver should never see a half-formed order.
   */
  async getForDriver(driverUserId: string, orderId: string): Promise<DriverOrderDetailResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    return this.hydrate(scoped, order);
  }

  /**
   * POST /v1/driver/orders/:id/pickup-confirm. Transitions the order
   * to `en_route_pickup` and writes an `order_pickup_confirmed` event
   * carrying the driver's location at the moment of the tap.
   *
   * Allowed FROM-states are `driver_assigned` (the dispatcher just
   * handed off the offer and the driver accepted) or `en_route_pickup`
   * itself (idempotent re-tap after a 5xx — the response shape is the
   * same as the first call). Any other state returns 409 from the
   * repository.
   *
   * The returned detail is the freshly-hydrated projection — the iOS
   * client renders it without a follow-up GET.
   */
  async confirmPickup(
    driverUserId: string,
    orderId: string,
    body: DriverPickupConfirmRequest,
  ): Promise<DriverOrderDetailResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    await this.orderTransitions.transition({
      orderId,
      event: 'DRIVER_EN_ROUTE_PICKUP',
      actor: { userId: driverUserId, role: 'driver' },
      payload: { location: body.location },
    });
    const refreshed = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (refreshed === null) {
      throw new NotFoundError('Order', orderId);
    }
    return this.hydrate(scoped, refreshed);
  }

  /**
   * POST /v1/driver/orders/:id/depart. Transitions the order to
   * `en_route_dropoff` — the driver has the bag and is leaving the
   * dispensary for the customer. The only legal FROM-state is
   * `picked_up`. The machine has no self-loop on `DRIVER_EN_ROUTE_DROPOFF`,
   * so a re-tap once the order has already advanced is rejected as an
   * invalid transition (`ORDER_INVALID_TRANSITION` → 422) — not silently
   * idempotent. The client must guard against double-taps rather than
   * rely on the server absorbing them.
   */
  async confirmDeparture(
    driverUserId: string,
    orderId: string,
    body: DriverDepartRequest,
  ): Promise<DriverOrderDetailResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    await this.orderTransitions.transition({
      orderId,
      event: 'DRIVER_EN_ROUTE_DROPOFF',
      actor: { userId: driverUserId, role: 'driver' },
      payload: { location: body.location },
    });
    const refreshed = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (refreshed === null) {
      throw new NotFoundError('Order', orderId);
    }
    return this.hydrate(scoped, refreshed);
  }

  /**
   * POST /v1/driver/orders/:id/arrive. Transitions the order to
   * `arrived_at_dropoff` — the driver reached the customer. The next
   * legal step is the non-bypassable ID-scan session; arriving is what
   * unblocks `id-scan-session` (which requires the order be at
   * `arrived_at_dropoff`). The only legal FROM-state is `en_route_dropoff`.
   * The machine has no self-loop on `DRIVER_ARRIVED`, so a re-tap once the
   * order has already advanced is rejected as an invalid transition
   * (`ORDER_INVALID_TRANSITION` → 422) — not silently idempotent. The
   * client must guard against double-taps rather than rely on the server
   * absorbing them.
   */
  async confirmArrival(
    driverUserId: string,
    orderId: string,
    body: DriverArriveRequest,
  ): Promise<DriverOrderDetailResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    await this.orderTransitions.transition({
      orderId,
      event: 'DRIVER_ARRIVED',
      actor: { userId: driverUserId, role: 'driver' },
      payload: { location: body.location },
    });
    const refreshed = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (refreshed === null) {
      throw new NotFoundError('Order', orderId);
    }
    return this.hydrate(scoped, refreshed);
  }

  /**
   * POST /v1/driver/orders/:id/delivery-confirm. Transitions the order
   * to `delivered` and writes an `order_delivered` event carrying
   * location, timestamp, and any free-text driver note.
   *
   * Two gates fire inside OrdersRepository.transitionStatus:
   *
   *   - FROM-state in {`en_route_dropoff`, `arrived_at_dropoff`,
   *     `id_scan_passed`}. Anything else is 409 ORDER_STATE_INVALID.
   *
   *   - `delivery_id_scan_passed === true` on the row. Without it the
   *     repo throws 409 COMPLIANCE_ID_SCAN_REQUIRED — the non-bypassable
   *     handoff per Phase 20 §20.3.
   *
   * `deliveredAt` is set in the same UPDATE via the patch field so the
   * timestamp is co-committed with the status change.
   */
  async confirmDelivery(
    driverUserId: string,
    orderId: string,
    body: DriverDeliveryConfirmRequest,
  ): Promise<DriverOrderDetailResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    await this.orderTransitions.transition({
      orderId,
      event: 'DRIVER_DELIVERED',
      actor: { userId: driverUserId, role: 'driver' },
      payload: { location: body.location, notes: body.notes },
    });
    const refreshed = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (refreshed === null) {
      throw new NotFoundError('Order', orderId);
    }
    return this.hydrate(scoped, refreshed);
  }

  private async hydrate(
    scoped: DriverOrdersScopedRepos,
    order: Order,
  ): Promise<DriverOrderDetailResponse> {
    const [items, events, customer, dispensary] = await Promise.all([
      scoped.orderItems.listForOrder(order.id),
      scoped.orderEvents.listForOrder(order.id),
      scoped.users.findById(order.userId),
      scoped.dispensaries.findById(order.dispensaryId),
    ]);
    if (customer === null) {
      throw new NotFoundError('Order customer', order.userId);
    }
    if (dispensary === null) {
      throw new NotFoundError('Order dispensary', order.dispensaryId);
    }
    return {
      order: projectOrder(order, items),
      events: events.map(projectEvent),
      customer: projectCustomer(customer),
      dispensary: projectDispensary(dispensary),
      dropoff: projectDropoff(order),
      idScan: projectIdScan(order),
    };
  }
}

function projectOrder(order: Order, items: readonly OrderItem[]): OrderResponse {
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
    items: items.map(projectOrderItem),
    placedAt: order.placedAt.toISOString(),
    statusChangedAt: order.statusChangedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
  return OrderResponseSchema.parse(projected);
}

function projectOrderItem(item: OrderItem): OrderItemResponse {
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

function projectEvent(event: OrderEvent): OrderEventResponse {
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

function projectCustomer(user: User): DriverCustomerSummary {
  return {
    firstName: user.firstName,
    lastName: initial(user.lastName),
    maskedPhone: maskPhone(user.phone),
  };
}

function projectDispensary(dispensary: Dispensary): DriverDispensarySummary {
  const [lng, lat] = dispensary.location.coordinates;
  return {
    id: dispensary.id,
    name: dispensary.dba ?? dispensary.legalName,
    addressLine1: dispensary.addressLine1,
    addressLine2: dispensary.addressLine2,
    city: dispensary.city,
    state: dispensary.region,
    postalCode: dispensary.postalCode,
    latitude: lat,
    longitude: lng,
    phone: dispensary.phone,
  };
}

/**
 * Reads `orders.delivery_address_snapshot` — the JSONB frozen at
 * checkout. Field-by-field narrowing because the column is `unknown`
 * at the type system level; we trust the checkout writer to have shaped
 * it correctly (see checkout.service.ts `serializeAddress`).
 */
function projectDropoff(order: Order): DriverDropoffAddress {
  const snapshot = order.deliveryAddressSnapshot as DropoffSnapshotRaw;
  const [lng, lat] = snapshot.location.coordinates;
  return {
    line1: snapshot.line1,
    line2: snapshot.line2,
    city: snapshot.city,
    state: snapshot.region,
    postalCode: snapshot.postalCode,
    latitude: lat,
    longitude: lng,
    instructions: snapshot.deliveryInstructions,
  };
}

function projectIdScan(order: Order): DriverIdScanState {
  return {
    passed: order.deliveryIdScanPassed === true,
    verificationId: order.deliveryIdScanRef,
    scannedAt: order.deliveryIdScanAt === null ? null : order.deliveryIdScanAt.toISOString(),
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

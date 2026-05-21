/**
 * DriverOrdersService — the driver app's read surface for the order
 * currently in their hands.
 *
 *   GET /v1/driver/orders/:id   → DriverOrderDetailResponse
 *
 * Two structural choices to flag:
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
import type {
  DriverCustomerSummary,
  DriverDispensarySummary,
  DriverDropoffAddress,
  DriverIdScanState,
  DriverOrderDetailResponse,
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
    const [items, events, customer, dispensary] = await Promise.all([
      scoped.orderItems.listForOrder(orderId),
      scoped.orderEvents.listTimelineForOrder(orderId),
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

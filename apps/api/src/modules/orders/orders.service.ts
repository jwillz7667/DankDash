/**
 * OrdersService — owns the *non-transition* surface of the orders
 * module: list-mine, get-mine/get-vendor's, and recordRating. Every
 * state change goes through `OrderTransitionService` instead; this
 * service is the read/projection layer plus the post-delivery rating
 * write (which is not a status transition — it amends the delivered
 * order with the customer's feedback and stamps `rated_at`).
 *
 * Cross-tenant authorization is enforced inline:
 *   - Customer queries scope by `userId === order.userId`.
 *   - Vendor queries scope by `dispensaryId === order.dispensaryId`.
 *   - Mismatches surface as 404 (not 403) so a probing call cannot
 *     distinguish "no such order" from "exists but not yours" — same
 *     pattern as the cart and listings surfaces.
 */
import {
  type Database,
  type DispensariesRepository,
  type DriversRepository,
  type Order,
  type OrderEventsRepository,
  type OrderItemsRepository,
  type OrdersRepository,
  type OrderStatus,
  type UsersRepository,
  type VendorQueueOrderRow,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { type OrderResponse } from '../checkout/dto/index.js';
import {
  projectCustomerDispensary,
  projectCustomerDropoff,
  projectCustomerEvent,
  projectCustomerOrder,
  projectDriverPublicProfile,
} from './customer-order-detail.projection.js';
import {
  type CustomerOrderDetailResponse,
  type DriverPublicProfile,
} from './dto/customer-order-detail.dto.js';
import { encodeOrderCursor, type OrderCursor } from './order-cursor.js';
import type { RateOrderRequest } from './dto/index.js';

export interface OrdersScopedRepos {
  readonly orders: OrdersRepository;
  readonly orderItems: OrderItemsRepository;
  readonly orderEvents: OrderEventsRepository;
  readonly users: UsersRepository;
  readonly dispensaries: DispensariesRepository;
  readonly drivers: DriversRepository;
}

export type OrdersScopedReposFactory = (db: Database) => OrdersScopedRepos;

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly reposFactory: OrdersScopedReposFactory,
  ) {}

  async listForUser(userId: string, limit: number): Promise<readonly Order[]> {
    const repos = this.reposFactory(this.db);
    return repos.orders.listForUser(userId, limit);
  }

  /**
   * GET /v1/orders — the cursor-paginated Orders-tab read. Scopes to the
   * JWT user, filters by lifecycle (`active` = not in a terminal state,
   * `completed` = terminal, `all` = everything), and returns at most
   * `limit` rows plus the `nextCursor` to fetch the page after them.
   *
   * The repo fetches `limit + 1` so we can tell whether a further page
   * exists without a second count query: if the extra row came back, drop
   * it and mint a cursor from the LAST kept row's `(placedAt, id)`;
   * otherwise this is the final page and `nextCursor` is null.
   */
  async listPageForUser(
    userId: string,
    input: {
      readonly status: 'active' | 'completed' | 'all';
      readonly limit: number;
      readonly cursor: OrderCursor | undefined;
    },
  ): Promise<{ readonly items: readonly Order[]; readonly nextCursor: string | null }> {
    const repos = this.reposFactory(this.db);
    const rows = await repos.orders.listForUserCursored({
      userId,
      limit: input.limit,
      statusFilter: input.status,
      cursor: input.cursor ?? null,
    });

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const last = items.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? encodeOrderCursor({ placedAt: last.placedAt, id: last.id })
        : null;

    return { items, nextCursor };
  }

  async findForUser(userId: string, orderId: string): Promise<Order> {
    const repos = this.reposFactory(this.db);
    const order = await repos.orders.findById(orderId);
    if (order?.userId !== userId) {
      throw OrderError.notFound(orderId);
    }
    return order;
  }

  /**
   * GET /v1/orders/:id — the consumer tracking projection. After the
   * ownership check (cross-user → 404, no leak) it hydrates the order's
   * items + events, the dispensary pickup point, and — only when a
   * driver is assigned — the privacy-minimal driver card. The dropoff
   * point is read from the order's own address snapshot, so no extra
   * read is needed for it.
   *
   * A missing dispensary row is impossible under the `onDelete:
   * 'restrict'` FK but is mapped to 404 (not 500) so a half-formed order
   * never surfaces a partial projection to the client.
   */
  async getDetailForUser(userId: string, orderId: string): Promise<CustomerOrderDetailResponse> {
    const repos = this.reposFactory(this.db);
    const order = await repos.orders.findById(orderId);
    if (order?.userId !== userId) {
      throw OrderError.notFound(orderId);
    }

    const [items, events, dispensary, driver] = await Promise.all([
      repos.orderItems.listForOrder(order.id),
      repos.orderEvents.listForOrder(order.id),
      repos.dispensaries.findById(order.dispensaryId),
      this.loadDriverProfile(repos, order.driverId),
    ]);
    if (dispensary === null) {
      throw OrderError.notFound(orderId);
    }

    return {
      order: projectCustomerOrder(order, items),
      events: events.map(projectCustomerEvent),
      driver,
      dispensary: projectCustomerDispensary(dispensary),
      dropoff: projectCustomerDropoff(order),
    };
  }

  /**
   * Resolves the driver card for `orders.driver_id` (a `users.id`).
   * Joins the user row (name + phone) and the driver row (vehicle
   * fields) in parallel. Returns `null` when no driver is assigned, or
   * when the user row has vanished — the consumer simply shows no card
   * rather than a half-resolved one.
   */
  private async loadDriverProfile(
    repos: OrdersScopedRepos,
    driverUserId: string | null,
  ): Promise<DriverPublicProfile | null> {
    if (driverUserId === null) {
      return null;
    }
    const [driverUser, driverRow] = await Promise.all([
      repos.users.findById(driverUserId),
      repos.drivers.findByUserId(driverUserId),
    ]);
    if (driverUser === null) {
      return null;
    }
    return projectDriverPublicProfile(driverUser, driverRow);
  }

  async listForDispensary(
    dispensaryId: string,
    status: OrderStatus | undefined,
    limit: number,
  ): Promise<readonly Order[]> {
    const repos = this.reposFactory(this.db);
    return repos.orders.listForDispensary(dispensaryId, status, limit);
  }

  async findForDispensary(dispensaryId: string, orderId: string): Promise<Order> {
    const repos = this.reposFactory(this.db);
    const order = await repos.orders.findById(orderId);
    if (order?.dispensaryId !== dispensaryId) {
      throw OrderError.notFound(orderId);
    }
    return order;
  }

  /**
   * Vendor-portal queue feed. Returns oldest-first orders within the
   * supplied status set, joined with customer name + item count for the
   * kanban-card projection. Tenant scoping is enforced inside the
   * query (the `dispensaryId` predicate joins the WHERE); we don't need
   * a post-fetch authz pass because there is no per-row decision —
   * the entire set is by definition the vendor's own.
   */
  async listForDispensaryQueue(
    dispensaryId: string,
    statuses: readonly OrderStatus[],
    limit: number,
  ): Promise<readonly VendorQueueOrderRow[]> {
    const repos = this.reposFactory(this.db);
    return repos.orders.listForDispensaryQueue(dispensaryId, statuses, limit);
  }

  /**
   * Records the customer's post-delivery rating. Not a status transition
   * — the order stays in `delivered`. We refuse to record ratings before
   * delivery (the spec says ratings are post-delivery only) and clamp
   * each numeric field to 1..5 at the DTO layer; we additionally write
   * `rated_at = NOW()` so the dispute window logic in Phase 14 can
   * answer "did the customer rate before complaining?".
   */
  async recordRating(userId: string, orderId: string, req: RateOrderRequest): Promise<Order> {
    return this.db.transaction(async (tx) => {
      const repos = this.reposFactory(tx);
      const order = await repos.orders.findById(orderId);
      if (order?.userId !== userId) {
        throw OrderError.notFound(orderId);
      }
      if (order.status !== 'delivered' && order.status !== 'disputed') {
        throw OrderError.rateNotDelivered(order.status);
      }

      const patch: Partial<Order> = { ratedAt: new Date() };
      if (req.rating !== undefined) patch.customerRating = req.rating;
      if (req.review !== undefined) patch.customerReview = req.review;
      if (req.driverRating !== undefined) patch.driverRating = req.driverRating;
      if (req.dispensaryRating !== undefined) patch.dispensaryRating = req.dispensaryRating;

      const updated = await repos.orders.update(orderId, patch);
      if (updated === null) {
        // findById succeeded inside the same tx; UPDATE returning no row
        // would be an invariant violation, not a user error.
        throw OrderError.notFound(orderId);
      }
      return updated;
    });
  }

  /**
   * Records the rating (see `recordRating`) and returns the flat
   * checkout-shaped order projection — the same shape the iOS
   * `rateOrder` client decodes and the tracking reducer refreshes its
   * order slice from. Items are read after the rating tx commits; the
   * rating write does not touch line items, so a post-commit read is
   * consistent.
   */
  async rateForUser(
    userId: string,
    orderId: string,
    req: RateOrderRequest,
  ): Promise<OrderResponse> {
    const order = await this.recordRating(userId, orderId, req);
    const repos = this.reposFactory(this.db);
    const items = await repos.orderItems.listForOrder(order.id);
    return projectCustomerOrder(order, items);
  }
}

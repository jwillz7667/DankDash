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
  type Order,
  type OrdersRepository,
  type OrderStatus,
  type VendorQueueOrderRow,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import type { RateOrderRequest } from './dto/index.js';

export interface OrdersScopedRepos {
  readonly orders: OrdersRepository;
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

  async findForUser(userId: string, orderId: string): Promise<Order> {
    const repos = this.reposFactory(this.db);
    const order = await repos.orders.findById(orderId);
    if (order?.userId !== userId) {
      throw OrderError.notFound(orderId);
    }
    return order;
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
}

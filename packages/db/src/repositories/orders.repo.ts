import { NotFoundError, RepositoryError } from '@dankdash/types';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { type OrderStatus } from '../schema/enums.js';
import {
  orderEvents,
  orderItems,
  orders,
  orderStatusHistory,
  type NewOrder,
  type NewOrderEvent,
  type NewOrderItem,
  type NewOrderStatusHistoryRow,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderStatusHistoryRow,
} from '../schema/orders.js';
import { BaseRepository, newId } from './base.js';

/**
 * Inputs for an order-status transition. The service layer constructs this
 * after validating the transition against the XState machine; the repository
 * simply persists the change atomically alongside the immutable event +
 * status-history rows.
 */
export interface OrderStatusTransitionInput {
  readonly orderId: string;
  readonly toStatus: OrderStatus;
  readonly eventType: string;
  readonly actorUserId?: string | undefined;
  readonly actorRole?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
  /**
   * Optional patch applied to the order row in the same UPDATE. Used to set
   * fields like `canceledBy`, `cancelReason`, or the Veriff scan ref that
   * are not derivable from `toStatus` alone. The per-status timestamp is
   * set automatically based on `toStatus` and does NOT need to be supplied
   * here — see `STATUS_TIMESTAMP_COLUMN` below.
   */
  readonly patch?: Partial<Omit<NewOrder, 'id' | 'createdAt' | 'updatedAt' | 'status'>> | undefined;
  /**
   * Optional human-readable reason written to `order_status_history.reason`.
   * Used for cancellations and rejections; ignored otherwise.
   */
  readonly reason?: string | undefined;
}

/**
 * Subset of the order row that the service-layer transition resolver needs
 * to make a decision under the row lock. Kept narrow so the lock query
 * touches only the columns the resolver actually reads.
 */
export interface LockedOrderSnapshot {
  readonly id: string;
  readonly status: OrderStatus;
  readonly userId: string;
  readonly dispensaryId: string;
  readonly driverId: string | null;
}

/**
 * Decision returned by the service-layer resolver running INSIDE the row
 * lock. Carries the new status the machine resolved to plus any
 * transition-specific payload / reason / row patch.
 */
export interface TransitionDecision {
  readonly toStatus: OrderStatus;
  readonly eventType: string;
  readonly actorUserId?: string | undefined;
  readonly actorRole?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
  readonly patch?: Partial<Omit<NewOrder, 'id' | 'createdAt' | 'updatedAt' | 'status'>> | undefined;
  readonly reason?: string | undefined;
}

/**
 * Callback supplied by the service to `applyTransition`. Receives the
 * locked row snapshot and returns the persistence decision. Throwing from
 * the resolver rolls back the entire transition tx — so authorization,
 * terminal-state checks, and state-machine validation all live here.
 */
export type TransitionResolver = (locked: LockedOrderSnapshot) => TransitionDecision;

/**
 * Mapping from each order status to the dedicated timestamp column on
 * `orders` (when one exists). The transition repository sets this column
 * to NOW() in the same UPDATE that flips `status`, so a query like
 * "average time from accepted -> ready_for_pickup" stays a single-table
 * scan rather than a join through `order_status_history`.
 *
 * Statuses without a column (`accepted` uses `accepted_at`, etc.) are
 * still recorded in `order_status_history`; the per-column timestamp is
 * a denormalisation for hot read paths.
 */
const STATUS_TIMESTAMP_COLUMN: Readonly<Partial<Record<OrderStatus, keyof NewOrder>>> = {
  placed: 'placedAt',
  payment_failed: 'paymentFailedAt',
  accepted: 'acceptedAt',
  rejected: 'rejectedAt',
  prepping: 'preppingAt',
  ready_for_pickup: 'preparedAt',
  awaiting_driver: 'awaitingDriverAt',
  dispatch_failed: 'dispatchFailedAt',
  driver_assigned: 'driverAssignedAt',
  en_route_pickup: 'enRoutePickupAt',
  picked_up: 'pickedUpAt',
  en_route_dropoff: 'enRouteDropoffAt',
  arrived_at_dropoff: 'arrivedAtDropoffAt',
  id_scan_pending: 'idScanPendingAt',
  delivered: 'deliveredAt',
  returned_to_store: 'returnedToStoreAt',
  canceled: 'canceledAt',
  disputed: 'disputedAt',
};

export class OrdersRepository extends BaseRepository {
  async findById(id: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row ?? null;
  }

  async findByShortCode(shortCode: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.shortCode, shortCode))
      .limit(1);
    return row ?? null;
  }

  /**
   * Collision check for the short-code generator. Asks only about the live
   * 30-day window (the spec's collision-uniqueness scope) so the index hit
   * is on `orders_placed_at` rather than a sequential scan of every
   * `short_code` ever issued. `orders.short_code` carries a UNIQUE index
   * so an exact-match probe is a single index lookup either way; the
   * `placed_at >= since` clause keeps the result honest about the time
   * window in case a future archival strategy moves cold orders to a
   * separate table and the UNIQUE index narrows with it.
   */
  async shortCodeExistsSince(shortCode: string, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(orders)
      .where(and(eq(orders.shortCode, shortCode), gte(orders.placedAt, since)))
      .limit(1);
    return row !== undefined;
  }

  async listForUser(userId: string, limit = 50): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }

  async listForDispensary(
    dispensaryId: string,
    status?: OrderStatus,
    limit = 100,
  ): Promise<readonly Order[]> {
    const where =
      status === undefined
        ? eq(orders.dispensaryId, dispensaryId)
        : and(eq(orders.dispensaryId, dispensaryId), eq(orders.status, status));
    return this.db.select().from(orders).where(where).orderBy(desc(orders.placedAt)).limit(limit);
  }

  async listForDriver(driverId: string, limit = 100): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.driverId, driverId))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }

  async create(input: Omit<NewOrder, 'id'> & { readonly id?: string }): Promise<Order> {
    const [row] = await this.db
      .insert(orders)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('orders insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewOrder, 'id' | 'createdAt'>>,
  ): Promise<Order | null> {
    const [row] = await this.db
      .update(orders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Atomic status transition. Holds a row lock on the order, runs the
   * service-supplied `resolve` callback INSIDE the lock to decide what
   * the new state should be, then writes the UPDATE + the immutable
   * `order_events` row + the typed `order_status_history` row — all
   * inside one transaction. Either every write succeeds or none does;
   * the audit trail can never disagree with current state.
   *
   * Why the callback runs under the lock: the state machine's "is this
   * edge legal from the current status?" check must see the *post-lock*
   * status, not the status as read before the lock was acquired. Without
   * this, two concurrent VENDOR_ACCEPTs on a `placed` order both pass
   * the machine check (each reads `placed` before locking), both call
   * UPDATE, and both "win" — silently losing the audit invariant that
   * every transition is unique. With this design, the loser sees the
   * post-lock status (`accepted`), the resolver throws
   * ORDER_INVALID_TRANSITION, and the loser's tx rolls back cleanly.
   *
   * The repo deliberately knows nothing about the state machine — that
   * stays in `@dankdash/orders`. The resolver is the seam.
   */
  async applyTransition(orderId: string, resolve: TransitionResolver): Promise<Order> {
    return this.db.transaction(async (tx) => {
      const [lockedRow] = await tx
        .select({
          id: orders.id,
          status: orders.status,
          userId: orders.userId,
          dispensaryId: orders.dispensaryId,
          driverId: orders.driverId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (lockedRow === undefined) {
        throw new NotFoundError('order', orderId);
      }

      const decision = resolve({
        id: lockedRow.id,
        status: lockedRow.status,
        userId: lockedRow.userId,
        dispensaryId: lockedRow.dispensaryId,
        driverId: lockedRow.driverId,
      });

      const fromStatus = lockedRow.status;
      const now = new Date();
      const tsColumn = STATUS_TIMESTAMP_COLUMN[decision.toStatus];
      const timestampPatch: Partial<NewOrder> = tsColumn === undefined ? {} : { [tsColumn]: now };

      const [updated] = await tx
        .update(orders)
        .set({
          ...decision.patch,
          ...timestampPatch,
          status: decision.toStatus,
          statusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(orders.id, orderId))
        .returning();
      if (updated === undefined) {
        // Lock succeeded but UPDATE returned nothing — should be impossible.
        throw new RepositoryError(`orders.applyTransition: order ${orderId} vanished`);
      }

      await tx.insert(orderEvents).values({
        id: newId(),
        orderId,
        eventType: decision.eventType,
        actorUserId: decision.actorUserId,
        actorRole: decision.actorRole,
        payload: decision.payload ?? {},
        occurredAt: now,
      } satisfies NewOrderEvent);

      await tx.insert(orderStatusHistory).values({
        id: newId(),
        orderId,
        fromStatus,
        toStatus: decision.toStatus,
        eventType: decision.eventType,
        changedBy: decision.actorUserId,
        actorRole: decision.actorRole,
        reason: decision.reason,
        changedAt: now,
      } satisfies NewOrderStatusHistoryRow);

      return updated;
    });
  }

  /**
   * Legacy unchecked transition — flips status without re-validating
   * against the locked-in row. Retained for the few callers that have
   * already validated by other means; new code should call
   * `applyTransition` so the state-machine check runs under the lock.
   *
   * @deprecated Use `applyTransition` with a resolver.
   */
  async transitionStatus(input: OrderStatusTransitionInput): Promise<Order> {
    return this.applyTransition(input.orderId, () => ({
      toStatus: input.toStatus,
      eventType: input.eventType,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      payload: input.payload,
      patch: input.patch,
      reason: input.reason,
    }));
  }

  /**
   * Loads the most recent status-history row for the given order. Used by
   * the customer order-details endpoint to render a transition timeline
   * without spinning up the full audit-stream pagination flow.
   */
  async listStatusHistory(orderId: string, limit = 50): Promise<readonly OrderStatusHistoryRow[]> {
    return this.db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.changedAt))
      .limit(limit);
  }

  async recordRating(
    id: string,
    ratings: Pick<
      NewOrder,
      'customerRating' | 'customerReview' | 'dispensaryRating' | 'driverRating'
    >,
  ): Promise<Order | null> {
    return this.update(id, ratings);
  }
}

export class OrderItemsRepository extends BaseRepository {
  async listForOrder(orderId: string): Promise<readonly OrderItem[]> {
    return this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  }

  async create(input: Omit<NewOrderItem, 'id'> & { readonly id?: string }): Promise<OrderItem> {
    const [row] = await this.db
      .insert(orderItems)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('order_items insert returned no row');
    return row;
  }

  async createMany(
    inputs: readonly (Omit<NewOrderItem, 'id'> & { readonly id?: string })[],
  ): Promise<readonly OrderItem[]> {
    if (inputs.length === 0) return [];
    const values = inputs.map((input) => ({ ...input, id: input.id ?? newId() }));
    return this.db.insert(orderItems).values(values).returning();
  }
}

/**
 * Append-only repository — the underlying `order_events` table is guarded by
 * a BEFORE UPDATE OR DELETE trigger (`dankdash_block_mutation`) that rejects
 * mutations regardless of role. No `update` or `delete` methods are exposed.
 */
export class OrderEventsRepository extends BaseRepository {
  async record(input: Omit<NewOrderEvent, 'id'> & { readonly id?: string }): Promise<OrderEvent> {
    const [row] = await this.db
      .insert(orderEvents)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('order_events insert returned no row');
    return row;
  }

  async listForOrder(orderId: string, limit = 200): Promise<readonly OrderEvent[]> {
    return this.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(desc(orderEvents.occurredAt))
      .limit(limit);
  }
}

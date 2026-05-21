import { ConflictError, NotFoundError, RepositoryError } from '@dankdash/types';
import { and, asc, desc, eq, gte, inArray, lt, not, or, sql } from 'drizzle-orm';
import { type OrderStatus } from '../schema/enums.js';
import { users } from '../schema/identity.js';
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
 * Vendor-portal queue projection — an order row enriched with the
 * customer's display name (joined off `users`) and a `COUNT(*)` of
 * `order_items` rows. Used by the portal's kanban-style queue view;
 * not authoritative state — every status flip still goes through
 * `applyTransition` against the unjoined `orders` row.
 */
export interface VendorQueueOrderRow extends Order {
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
  readonly itemCount: number;
}

/**
 * Projection used by the vendor-portal payouts detail view — one row per
 * delivered order that contributed to a given payout window. Only the
 * fields the detail page renders are selected, so we avoid hauling the
 * full order row + compliance payload across the wire for every line.
 */
export interface VendorPayoutOrderRow {
  readonly id: string;
  readonly shortCode: string;
  readonly deliveredAt: Date;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly discountCents: number;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
}

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
  /**
   * Optional FROM-state guard. When provided, the row's current status
   * must be one of these values or the transition is rejected with
   * `ConflictError('ORDER_STATE_INVALID')`. Callers that already locked
   * the row in their own SELECT can omit this; callers driving the
   * state machine from the outside (driver app, vendor portal) pass
   * the expected predecessor set so two parallel taps cannot double-
   * transition.
   */
  readonly expectedFromStatus?: readonly OrderStatus[] | undefined;
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
   * Batched lookup used by the Metrc reconciliation cron to map a set of
   * `metric_transactions.order_id` values back to their owning dispensary
   * without an N+1. Empty input short-circuits — Drizzle's `inArray` on
   * an empty list emits a degenerate `WHERE id IN ()` that some drivers
   * reject outright and others read as "match nothing", and we'd rather
   * make that contract explicit at the call site than depend on either.
   */
  async findManyByIds(ids: readonly string[]): Promise<readonly Order[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(orders).where(inArray(orders.id, ids));
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

  /**
   * Cursor pagination ordered by `(placedAt DESC, id DESC)`. The cursor
   * fixes the position to the row immediately AFTER the last one
   * returned in the previous page — `placedAt < cursor.placedAt OR
   * (placedAt = cursor.placedAt AND id < cursor.id)`. Pairs with the
   * `orders_user_placed_idx` btree so the predicate is a single index
   * scan no matter where in the user's history the page sits.
   *
   * `statusFilter` partitions the user's orders into "still in flight"
   * vs "done with". Both surfaces (the Active and Past tabs) call the
   * same endpoint with a different filter; `'all'` is reserved for
   * admin-tooling read paths.
   *
   * The repo asks for `limit + 1` rows so the caller can tell whether
   * a next page exists without a separate count query — if the extra
   * row comes back, drop it and emit a cursor for the LAST kept row.
   */
  async listForUserCursored(input: {
    readonly userId: string;
    readonly limit: number;
    readonly statusFilter: 'active' | 'completed' | 'all';
    readonly cursor: { readonly placedAt: Date; readonly id: string } | null;
  }): Promise<readonly Order[]> {
    const TERMINAL_STATUSES: readonly OrderStatus[] = [
      'delivered',
      'canceled',
      'rejected',
      'returned_to_store',
      'disputed',
      'id_scan_failed',
      'payment_failed',
    ];
    const statusPredicate =
      input.statusFilter === 'active'
        ? not(inArray(orders.status, TERMINAL_STATUSES))
        : input.statusFilter === 'completed'
          ? inArray(orders.status, TERMINAL_STATUSES)
          : undefined;
    const cursorPredicate =
      input.cursor === null
        ? undefined
        : or(
            lt(orders.placedAt, input.cursor.placedAt),
            and(eq(orders.placedAt, input.cursor.placedAt), lt(orders.id, input.cursor.id)),
          );
    const wheres = [eq(orders.userId, input.userId), statusPredicate, cursorPredicate].filter(
      (clause): clause is Exclude<typeof clause, undefined> => clause !== undefined,
    );
    return this.db
      .select()
      .from(orders)
      .where(wheres.length === 1 ? wheres[0] : and(...wheres))
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(input.limit);
  }

  /**
   * User-scoped detail read. Pairs id + userId in the WHERE so a
   * cross-user id matches zero rows (same response shape as missing —
   * a probe cannot distinguish ownership-fail from existence-fail).
   */
  async findByIdForUser(orderId: string, userId: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Driver-scoped detail read — same probe-resistance shape as
   * findByIdForUser. A driver who pastes another driver's order id
   * gets a 404, not a 403, so they can't enumerate the assignment
   * graph by status code.
   */
  async findByIdForDriver(orderId: string, driverUserId: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.driverId, driverUserId)))
      .limit(1);
    return row ?? null;
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

  /**
   * Vendor-portal queue list. The portal renders a 4-column kanban
   * (placed → accepted → prepping → ready_for_pickup et al), so the
   * caller filters by an explicit `statuses` set rather than the single
   * status of `listForDispensary`. Empty statuses → return nothing
   * (degenerate `IN ()` would error otherwise).
   *
   * Returns each order joined with:
   *   - the customer's first/last name so cards show "Jane D." without
   *     a second roundtrip per row (users are read-only here, no auth
   *     decisions made off this join);
   *   - the `order_items` row count so the card can render "5 items"
   *     at a glance.
   *
   * Item count uses a correlated subquery rather than a GROUP BY join.
   * Queue size is bounded (≤200 per the limit) and `order_items_order_idx`
   * makes each subquery a single index scan; this avoids fanning the
   * outer rowset by item count and preserves the "one row per order"
   * shape the projection expects without a DISTINCT.
   *
   * Oldest-first ordering — the longest-waiting order needs the most
   * attention, which is what the column header pin should highlight.
   */
  async listForDispensaryQueue(
    dispensaryId: string,
    statuses: readonly OrderStatus[],
    limit = 200,
  ): Promise<readonly VendorQueueOrderRow[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select({
        order: orders,
        customerFirstName: users.firstName,
        customerLastName: users.lastName,
        itemCount: sql<number>`(SELECT COUNT(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id})`,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.userId))
      .where(and(eq(orders.dispensaryId, dispensaryId), inArray(orders.status, [...statuses])))
      .orderBy(asc(orders.placedAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r.order,
      customerFirstName: r.customerFirstName,
      customerLastName: r.customerLastName,
      itemCount: r.itemCount,
    }));
  }

  /**
   * Constituent-orders query for the vendor payouts detail page. Returns
   * every `delivered` order belonging to `dispensaryId` whose `delivered_at`
   * falls in the half-open window `[deliveredFromUtc, deliveredToUtc)`.
   *
   * Window semantics mirror the payout job: `period_start` and `period_end`
   * are stored as Central calendar dates, and the boundary instants
   * computed in `computePayoutPeriod` are the same UTC instants this
   * predicate filters on. An order delivered at exactly the upper bound
   * belongs to the next period and is intentionally excluded.
   *
   * Joins `users` so the table can render "Jane D." without a second
   * roundtrip per row — same projection shape (modulo selected columns)
   * as `listForDispensaryQueue`. Newest-first ordering matches how an
   * operator reads a statement (most recent activity at the top); the
   * sum of `totalCents` across the rows should reconcile to the payout's
   * gross, less any in-window refunds the ledger has already netted out.
   *
   * Index-supported via `orders_dispensary_status_idx (dispensary_id,
   * status, placed_at)`. The `delivered_at` predicate filters in-memory
   * after the index lookup, which is fine for a single day's volume per
   * dispensary (≤ a few hundred rows typical); larger windows are capped
   * by the `limit` parameter (default 500).
   */
  async listDeliveredForDispensaryBetween(
    dispensaryId: string,
    deliveredFromUtc: Date,
    deliveredToUtc: Date,
    limit = 500,
  ): Promise<readonly VendorPayoutOrderRow[]> {
    const rows = await this.db
      .select({
        id: orders.id,
        shortCode: orders.shortCode,
        deliveredAt: orders.deliveredAt,
        subtotalCents: orders.subtotalCents,
        totalCents: orders.totalCents,
        discountCents: orders.discountCents,
        customerFirstName: users.firstName,
        customerLastName: users.lastName,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.userId))
      .where(
        and(
          eq(orders.dispensaryId, dispensaryId),
          eq(orders.status, 'delivered'),
          gte(orders.deliveredAt, deliveredFromUtc),
          lt(orders.deliveredAt, deliveredToUtc),
        ),
      )
      .orderBy(desc(orders.deliveredAt))
      .limit(limit);
    return rows.flatMap((row) =>
      row.deliveredAt === null
        ? []
        : [
            {
              id: row.id,
              shortCode: row.shortCode,
              deliveredAt: row.deliveredAt,
              subtotalCents: row.subtotalCents,
              totalCents: row.totalCents,
              discountCents: row.discountCents,
              customerFirstName: row.customerFirstName,
              customerLastName: row.customerLastName,
            },
          ],
    );
  }

  async listForDriver(driverId: string, limit = 100): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.driverId, driverId))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }

  /**
   * Aggregate earnings for the driver-self dashboard.
   *
   * Sums tips + delivery fees + deliveries-count across orders this driver
   * delivered in [since, until). The window is half-open so day/week/month
   * buckets stitched at the same instant don't double-count the boundary.
   *
   * Only `delivered` orders count — an order that was assigned-then-cancelled
   * is not a paid trip. The deliveredAt timestamp is the source of truth
   * (not statusChangedAt, which gets overwritten on every subsequent
   * status change); deliveredAt is auto-stamped by `STATUS_TIMESTAMP_COLUMN`
   * the moment the order flips to `delivered` and never moves again.
   *
   * COALESCE both SUMs so an all-zero window returns 0 instead of NULL —
   * the driver app should display "$0 earned today" cleanly.
   *
   * Index-supported via `orders_driver_idx` (partial WHERE driver_id IS NOT
   * NULL). The deliveredAt predicate filters in-memory after the index
   * lookup, which is fine for a single driver's window — they will not
   * have enough delivered orders for a sequential scan to bite.
   */
  async sumDriverEarningsBetween(
    driverId: string,
    since: Date,
    until: Date,
  ): Promise<{
    readonly tipsCents: number;
    readonly deliveryFeesCents: number;
    readonly deliveriesCount: number;
  }> {
    const [row] = await this.db
      .select({
        tipsCents: sql<number>`COALESCE(SUM(${orders.driverTipCents}), 0)::int`,
        deliveryFeesCents: sql<number>`COALESCE(SUM(${orders.deliveryFeeCents}), 0)::int`,
        deliveriesCount: sql<number>`COUNT(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, driverId),
          eq(orders.status, 'delivered'),
          gte(orders.deliveredAt, since),
          sql`${orders.deliveredAt} < ${until}`,
        ),
      );
    return row ?? { tipsCents: 0, deliveryFeesCents: 0, deliveriesCount: 0 };
  }

  /**
   * List all orders currently in a given status, oldest-first. Used by the
   * dispatch worker, which sweeps `awaiting_driver` orders on its tick and
   * decides whether to issue an offer, wait, or fail. Oldest-first ordering
   * matters — an order that has been waiting longer should get its next
   * offer or its `DISPATCH_FAILED` first, before fresher arrivals.
   *
   * Index-supported via `orders_status_idx (status, placed_at)`. `limit`
   * defaults to 200 — the worker tick should never have more in flight
   * for a single status; if it does, telemetry will surface the saturation.
   */
  async listInStatus(status: OrderStatus, limit = 200): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.status, status))
      .orderBy(orders.placedAt)
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
   *
   * The driver-app `transitionStatus` wrapper (below) layers two
   * non-bypassable gates on top of the resolver:
   *
   *   - **FROM-state guard** (`expectedFromStatus`): the row's current
   *     status must be one of the expected predecessors or the
   *     transition throws `ConflictError('ORDER_STATE_INVALID')`. A
   *     driver double-tapping Confirm Pickup gets a 409, not a silent
   *     double-transition.
   *
   *   - **ID-scan gate**: when `toStatus === 'delivered'` the row must
   *     carry `delivery_id_scan_passed = true`. Otherwise throws
   *     `ConflictError('COMPLIANCE_ID_SCAN_REQUIRED')`. Spec §6.2 —
   *     even a future caller bypassing the service layer cannot reach
   *     delivered without a Veriff-approved scan recorded on the row.
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
          deliveryIdScanPassed: orders.deliveryIdScanPassed,
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

      if (decision.toStatus === 'delivered' && lockedRow.deliveryIdScanPassed !== true) {
        throw new ConflictError(
          'COMPLIANCE_ID_SCAN_REQUIRED',
          `order ${orderId} cannot transition to delivered without a successful ID scan`,
          { orderId },
        );
      }

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
   * Driver-app transition path. Enforces `expectedFromStatus` under the
   * row lock (via the `applyTransition` resolver), so a driver tap that
   * races with another status flip serialises and the loser gets a
   * `ConflictError('ORDER_STATE_INVALID')` instead of a silent
   * double-transition. The ID-scan gate is enforced inside
   * `applyTransition` for any caller — bypassable only by inserting a
   * `delivery_id_scan_passed = true` row out-of-band.
   *
   * The state-machine resolver-based path (`applyTransition` directly)
   * remains the canonical surface for non-driver callers (vendor,
   * customer, system); this wrapper exists for the Phase 20 driver-app
   * endpoints that need to assert "I expect to be transitioning from
   * one of these states" without rebuilding the resolver pattern.
   */
  async transitionStatus(input: OrderStatusTransitionInput): Promise<Order> {
    return this.applyTransition(input.orderId, (locked) => {
      if (
        input.expectedFromStatus !== undefined &&
        !input.expectedFromStatus.includes(locked.status)
      ) {
        throw new ConflictError(
          'ORDER_STATE_INVALID',
          `order ${input.orderId} is in status ${locked.status}, expected one of [${input.expectedFromStatus.join(', ')}]`,
          {
            orderId: input.orderId,
            currentStatus: locked.status,
            expectedFromStatus: [...input.expectedFromStatus],
            toStatus: input.toStatus,
          },
        );
      }
      return {
        toStatus: input.toStatus,
        eventType: input.eventType,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        payload: input.payload,
        patch: input.patch,
        reason: input.reason,
      };
    });
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

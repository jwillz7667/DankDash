/**
 * OrderTransitionService — the single chokepoint for every order-state
 * change in the system. The HTTP controllers (vendor + customer + driver
 * + system webhooks) all funnel through `transition()`; nothing else in
 * the API is allowed to UPDATE `orders.status` or INSERT into
 * `order_events` / `order_status_history`.
 *
 * Each call:
 *   1. Holds a SELECT … FOR UPDATE on the order row inside a new tx.
 *   2. Refuses if the principal is not authorised to send this event
 *      (e.g. only the assigned driver can fire DRIVER_PICKED_UP; the
 *      authorising dispensary must own the order for VENDOR_ACCEPT).
 *   3. Asks the pure XState machine in `@dankdash/orders` whether the
 *      requested edge is legal from the locked-in `fromStatus`.
 *   4. Persists the new status, the per-state timestamp, the immutable
 *      `order_events` row and the typed `order_status_history` row —
 *      all in the same tx.
 *   5. Emits a typed `OrderTransitionedEvent` *after the tx commits*
 *      (so subscribers — realtime push, notifications, dispatch — never
 *      see a state that the DB has not yet committed).
 *
 * Concurrency: two simultaneous Accept requests on the same order
 * serialise on the row lock. The loser observes the new status, fails
 * the machine guard with ORDER_INVALID_TRANSITION, and surfaces 422 —
 * exactly the spec's required behavior.
 */
import {
  type Database,
  type OrdersRepository,
  type OrderStatusTransitionInput,
} from '@dankdash/db';
import {
  isTerminalOrderState,
  nextOrderState,
  OrderError,
  type OrderEventType,
  type OrderState,
} from '@dankdash/orders';
import { NotFoundError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { ORDER_TRANSITIONED_EVENT, OrderTransitionedEvent } from './order-transition.events.js';

export type ActorRole = 'customer' | 'vendor' | 'driver' | 'system' | 'admin';

export interface OrderTransitionActor {
  readonly userId?: string;
  readonly role: ActorRole;
  readonly dispensaryId?: string;
}

export interface TransitionRequest {
  readonly orderId: string;
  readonly event: OrderEventType;
  readonly actor: OrderTransitionActor;
  readonly reason?: string;
  /**
   * Free-form payload appended to the immutable `order_events.payload`
   * column. Used for the Veriff scan ref, the cancellation reason
   * payload, or any other transition-specific context auditors will
   * later want to read.
   */
  readonly payload?: Record<string, unknown>;
  /**
   * Optional patch applied to the order row in the same UPDATE — for
   * fields that are not derivable from the event alone (driverId on
   * DRIVER_ASSIGNED, canceledBy/cancelReason on CUSTOMER_CANCEL, the
   * Veriff scan ref + passed flag on ID_SCAN_PASSED/FAILED).
   */
  readonly patch?: OrderStatusTransitionInput['patch'];
}

/**
 * Per-event authorization predicate. Returns true if the actor is allowed
 * to fire the event; false otherwise. The order row from the locked SELECT
 * is passed in so the predicate can check ownership (dispensaryId,
 * driverId, userId). Kept as a pure table so adding a new event in
 * `@dankdash/orders/events.ts` forces a matching authorization rule here
 * (exhaustiveness is enforced by the `Record<OrderEventType, …>` type).
 */
type AuthFn = (
  actor: OrderTransitionActor,
  order: {
    readonly userId: string;
    readonly dispensaryId: string;
    readonly driverId: string | null;
  },
) => boolean;

const allowSystemOrAdmin: AuthFn = (a) => a.role === 'system' || a.role === 'admin';

const vendorOwnsOrder: AuthFn = (a, o) =>
  (a.role === 'vendor' && a.dispensaryId === o.dispensaryId) || a.role === 'admin';

const customerOwnsOrder: AuthFn = (a, o) =>
  (a.role === 'customer' && a.userId === o.userId) || a.role === 'admin';

const assignedDriver: AuthFn = (a, o) =>
  (a.role === 'driver' && o.driverId !== null && a.userId === o.driverId) || a.role === 'admin';

const customerOrAdmin: AuthFn = (a, o) =>
  (a.role === 'customer' && a.userId === o.userId) || a.role === 'admin';

/**
 * Authorization matrix — exhaustive by `OrderEventType`. The exhaustiveness
 * is verified at compile time: adding an event in the orders package
 * without an entry here breaks `tsc`.
 */
const AUTH_BY_EVENT: Readonly<Record<OrderEventType, AuthFn>> = {
  PAYMENT_FAILED: allowSystemOrAdmin,
  CUSTOMER_CANCEL: customerOwnsOrder,
  VENDOR_ACCEPT: vendorOwnsOrder,
  VENDOR_REJECT: vendorOwnsOrder,
  VENDOR_PREPPING: vendorOwnsOrder,
  VENDOR_READY: vendorOwnsOrder,
  STORE_CANCEL: vendorOwnsOrder,
  DISPATCH_QUEUE: allowSystemOrAdmin,
  DRIVER_ASSIGNED: allowSystemOrAdmin,
  DRIVER_EN_ROUTE_PICKUP: assignedDriver,
  DRIVER_PICKED_UP: assignedDriver,
  DRIVER_EN_ROUTE_DROPOFF: assignedDriver,
  DRIVER_ARRIVED: assignedDriver,
  DRIVER_ID_SCAN_STARTED: assignedDriver,
  ID_SCAN_PASSED: allowSystemOrAdmin,
  ID_SCAN_FAILED: allowSystemOrAdmin,
  DRIVER_DELIVERED: assignedDriver,
  DRIVER_ID_SCAN_RETRY: assignedDriver,
  DRIVER_RETURNED: assignedDriver,
  DISPUTE_OPENED: customerOrAdmin,
};

export interface ScopedOrderRepos {
  readonly orders: OrdersRepository;
}

export type OrderScopedReposFactory = (db: Database) => ScopedOrderRepos;

@Injectable()
export class OrderTransitionService {
  private readonly logger = new Logger(OrderTransitionService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly reposFactory: OrderScopedReposFactory,
    private readonly events: EventEmitter2,
  ) {}

  async transition(req: TransitionRequest): Promise<{
    readonly orderId: string;
    readonly fromStatus: OrderState;
    readonly toStatus: OrderState;
  }> {
    const authFn = AUTH_BY_EVENT[req.event];
    // The repo opens the tx, acquires SELECT … FOR UPDATE on the order
    // row, and hands us the locked snapshot. We resolve the transition
    // (authz → terminal check → state machine) using the LOCKED status,
    // not the pre-lock status — so two concurrent VENDOR_ACCEPTs on the
    // same `placed` order serialise: the first sees `placed` and writes
    // `accepted`; the second sees `accepted` and bails via the machine's
    // ORDER_INVALID_TRANSITION. Without the in-lock resolution, both
    // would pass the machine check and silently double-write.
    //
    // The closure throws OrderError on any failure; the repo's tx rolls
    // back automatically so no order_events / order_status_history row
    // is left dangling on a refused transition.
    // The resolver runs inside the row lock. We capture the locked
    // status into a holder so that, after `applyTransition` commits, we
    // can return both `fromStatus` and `toStatus` without re-querying.
    // A holder (rather than `let`) keeps the post-commit unwrap a single
    // explicit `RepositoryError` instead of a non-null assertion.
    const fromStatusHolder: { value?: OrderState } = {};
    const repos = this.reposFactory(this.db);
    let updated;
    try {
      updated = await repos.orders.applyTransition(req.orderId, (locked) => {
        if (
          !authFn(req.actor, {
            userId: locked.userId,
            dispensaryId: locked.dispensaryId,
            driverId: locked.driverId,
          })
        ) {
          throw OrderError.actorForbidden(
            `actor (role=${req.actor.role}) is not permitted to send ${req.event} on this order`,
            { orderId: req.orderId, event: req.event, actorRole: req.actor.role },
          );
        }

        const fromStatus = locked.status;
        // Defence-in-depth: a terminal state must never accept any event
        // (with `delivered` → `disputed` as the documented exception in
        // the machine itself). The state-machine `nextOrderState` already
        // enforces this, but checking it up here keeps the error code
        // explicit (`ORDER_TERMINAL_STATE`) without depending on the
        // machine to classify it.
        if (isTerminalOrderState(fromStatus) && fromStatus !== 'delivered') {
          throw OrderError.terminalState(fromStatus, req.event);
        }

        const toStatus = nextOrderState(fromStatus, req.event);
        fromStatusHolder.value = fromStatus;

        return {
          toStatus,
          eventType: req.event,
          actorUserId: req.actor.userId,
          actorRole: req.actor.role,
          payload: req.payload,
          reason: req.reason,
          patch: req.patch,
        };
      });
    } catch (err) {
      // Translate the repo's generic NotFoundError into the order-domain
      // ORDER_NOT_FOUND code so the iOS client can render the right
      // message. Other DomainErrors (OrderError thrown from the resolver,
      // RepositoryError on the impossible vanished-row case) propagate.
      if (err instanceof NotFoundError) {
        throw OrderError.notFound(req.orderId);
      }
      throw err;
    }

    const resolvedFromStatus = fromStatusHolder.value;
    if (resolvedFromStatus === undefined) {
      // Unreachable: the resolver assigns before returning, and any throw
      // inside the resolver propagates from `applyTransition` instead of
      // reaching this point. Surface as OrderError so the error envelope
      // stays in the order domain rather than leaking as a generic 500.
      throw OrderError.invariantBroken(
        `applyTransition returned without resolver assigning fromStatus`,
        { orderId: req.orderId },
      );
    }
    const result = {
      orderId: updated.id,
      fromStatus: resolvedFromStatus,
      toStatus: updated.status,
    };

    // Emit AFTER commit so downstream subscribers (notifications, realtime,
    // dispatch) never observe a state that has been rolled back. A
    // subscriber that throws must NOT abort the response — the DB has
    // already committed, so the caller's mutation is durable regardless
    // of whether the side-effect chain succeeded. We log and continue.
    try {
      this.events.emit(
        ORDER_TRANSITIONED_EVENT,
        new OrderTransitionedEvent({
          orderId: result.orderId,
          fromStatus: result.fromStatus,
          toStatus: result.toStatus,
          event: req.event,
          actor: req.actor,
          occurredAt: new Date(),
        }),
      );
    } catch (err) {
      this.logger.error(
        { orderId: result.orderId, event: req.event, err },
        'OrderTransitionedEvent subscriber threw — transition is durable, downstream side-effects may be missed',
      );
    }

    return result;
  }
}

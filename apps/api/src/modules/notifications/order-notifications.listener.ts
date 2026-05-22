/**
 * Listens for `ORDER_TRANSITIONED_EVENT` and dispatches the matching
 * consumer-facing notification (push + in_app for accepted/prepping/
 * ready/completed; push + sms for picked_up/arriving/arrived; push +
 * email for payment_failed).
 *
 * The state→template map below is the source of truth for which
 * lifecycle transitions produce a notification. States with no entry
 * (e.g. `awaiting_driver` — dispatch handles the driver-side push, the
 * customer side reuses `ready_for_pickup`) are intentional no-ops.
 *
 * Why a listener and not a worker queue: the customer-visible delivery
 * has a tens-of-seconds budget; the dispatcher's failure path writes the
 * error onto `notifications.error` and the row is still rendered in the
 * iOS in-app inbox via realtime push. A separate worker outbox would
 * trade an extra hop (and another partition rotation surface) for retry
 * semantics that aren't actually required for the consumer feel.
 *
 * Why per-state mapping rather than a single bulk-route handler: each
 * transition needs distinct payload fields — `accepted` carries
 * `etaMinutes` (optional), `picked_up` needs `driverFirstName`,
 * `completed` needs the order total. A switch over `event.toStatus` plus
 * a `await`-only path for the data the template needs keeps each branch
 * obvious. Adding a new state with a notification = adding a case here +
 * a template in @dankdash/notifications.
 *
 * Idempotency: each call to the dispatcher includes
 * `${orderId}:${toStatus}` as the idempotency key. A duplicate
 * `ORDER_TRANSITIONED_EVENT` for the same transition reaches the Redis
 * SETNX inside the dispatcher and bails before any provider is touched.
 */
import {
  type DriversRepository,
  type DispensariesRepository,
  type OrdersRepository,
  type UsersRepository,
} from '@dankdash/db';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';

export interface OrderNotificationsListenerDeps {
  readonly dispatcher: NotificationDispatcher;
  readonly orders: OrdersRepository;
  readonly dispensaries: DispensariesRepository;
  readonly drivers: DriversRepository;
  readonly users: UsersRepository;
}

@Injectable()
export class OrderNotificationsListener {
  private readonly logger = new Logger(OrderNotificationsListener.name);

  constructor(private readonly deps: OrderNotificationsListenerDeps) {}

  @OnEvent(ORDER_TRANSITIONED_EVENT, { suppressErrors: true })
  async onOrderTransitioned(event: OrderTransitionedEvent): Promise<void> {
    try {
      await this.handle(event);
    } catch (err) {
      // Defensive: the listener returns a rejected promise into the
      // discard path of `EventEmitter2.emit`. Without this catch the
      // unhandled rejection pollutes the API logs even though the
      // transition itself is durable.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `notifications listener failed for order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async handle(event: OrderTransitionedEvent): Promise<void> {
    const order = await this.deps.orders.findById(event.orderId);
    if (order === null) {
      this.logger.warn(`notifications listener: order ${event.orderId} not found`);
      return;
    }

    const dispensary = await this.deps.dispensaries.findById(order.dispensaryId);
    if (dispensary === null) {
      this.logger.warn(
        `notifications listener: dispensary ${order.dispensaryId} not found for order ${event.orderId}`,
      );
      return;
    }
    const dispensaryName = dispensary.dba ?? dispensary.legalName;
    const idempotencyKey = `${order.id}:${event.toStatus}`;

    switch (event.toStatus) {
      case 'accepted': {
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.accepted',
          payload: { orderId: order.id, dispensaryName },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'prepping': {
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.prepping',
          payload: { orderId: order.id, dispensaryName },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'ready_for_pickup': {
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.ready',
          payload: { orderId: order.id, dispensaryName },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'picked_up': {
        const driverFirstName = await this.resolveDriverFirstName(order.driverId);
        if (driverFirstName === null) return;
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.picked_up',
          payload: { orderId: order.id, driverFirstName },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'arrived_at_dropoff': {
        const driverFirstName = await this.resolveDriverFirstName(order.driverId);
        if (driverFirstName === null) return;
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.arrived',
          payload: { orderId: order.id, driverFirstName },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'delivered': {
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'order.completed',
          payload: { orderId: order.id, totalCents: order.totalCents },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      case 'payment_failed': {
        await this.deps.dispatcher.dispatch({
          userId: order.userId,
          templateKey: 'payment.failed',
          payload: {
            orderId: order.id,
            amountCents: order.totalCents,
            reason: 'Your payment method was declined.',
          },
          appVariant: 'consumer',
          idempotencyKey,
        });
        return;
      }
      default:
        // No notification for this transition (e.g. `awaiting_driver`,
        // `driver_assigned`, `en_route_pickup/dropoff`, terminal
        // canceled/rejected/returned/disputed — those have their own
        // surfaces or are intentionally silent).
        return;
    }
  }

  private async resolveDriverFirstName(driverId: string | null): Promise<string | null> {
    if (driverId === null) return null;
    const driver = await this.deps.drivers.findById(driverId);
    if (driver === null) return null;
    const driverUser = await this.deps.users.findById(driver.userId);
    if (driverUser === null) return null;
    return driverUser.firstName;
  }
}

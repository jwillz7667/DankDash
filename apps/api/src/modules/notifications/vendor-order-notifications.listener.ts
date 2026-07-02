/**
 * Listens for `ORDER_PLACED_EVENT` (emitted by CheckoutService the moment
 * an order is durably committed) and alerts the dispensary's staff that a
 * new order is waiting to be accepted.
 *
 * Why this exists: the realtime `order:created` envelope already lights up
 * the vendor portal's live queue for an *open* tab. Staff who don't have
 * the portal open miss the order until they happen to look — so the store
 * silently stalls the customer. This listener closes that gap with a
 * durable per-staff notification (email is the reach-when-closed channel;
 * `vendor.new_order` also writes an in_app row the portal can surface).
 *
 * Fan-out is bounded by the dispensary's active staff roster (a handful of
 * budtenders/managers/owners, indexed by `dispensary_staff_dispensary_idx`)
 * and dispatched sequentially — no unbounded `Promise.all`. Each staff
 * member's dispatch is deduped per `(userId, vendor.new_order, orderId)`
 * inside the dispatcher, so a replayed ORDER_PLACED_EVENT never double-sends.
 *
 * Errors are swallowed and logged: the order is already durable when the
 * event fires, and a notification failure must never bubble back into the
 * checkout HTTP response.
 */
import { type DispensariesRepository, type DispensaryStaffRepository } from '@dankdash/db';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ORDER_PLACED_EVENT, OrderPlacedEvent } from '../orders/order-placed.events.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';

export interface VendorOrderNotificationsListenerDeps {
  readonly dispatcher: NotificationDispatcher;
  readonly dispensaries: DispensariesRepository;
  readonly staff: DispensaryStaffRepository;
}

@Injectable()
export class VendorOrderNotificationsListener {
  private readonly logger = new Logger(VendorOrderNotificationsListener.name);

  constructor(private readonly deps: VendorOrderNotificationsListenerDeps) {}

  @OnEvent(ORDER_PLACED_EVENT, { suppressErrors: true })
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    try {
      await this.handle(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `vendor new-order notification failed for order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async handle(event: OrderPlacedEvent): Promise<void> {
    const dispensary = await this.deps.dispensaries.findById(event.dispensaryId);
    if (dispensary === null) {
      this.logger.warn(
        `vendor new-order notification: dispensary ${event.dispensaryId} not found for order ${event.orderId}`,
      );
      return;
    }
    const dispensaryName = dispensary.dba ?? dispensary.legalName;

    const staff = await this.deps.staff.listActiveForDispensary(event.dispensaryId);
    // Only staff who have accepted their invite receive order alerts — a
    // pending invitee has no portal access yet.
    const recipients = staff.filter((member) => member.acceptedAt !== null);
    if (recipients.length === 0) {
      this.logger.warn(
        `vendor new-order notification: no active staff for dispensary ${event.dispensaryId} (order ${event.orderId})`,
      );
      return;
    }

    for (const member of recipients) {
      await this.deps.dispatcher.dispatch({
        userId: member.userId,
        templateKey: 'vendor.new_order',
        payload: {
          orderId: event.orderId,
          shortCode: event.shortCode,
          dispensaryName,
          totalCents: event.totalCents,
        },
        // vendor.new_order renders email + in_app only; the portal is
        // web-only (no APNs variant), so appVariant is inert here.
        appVariant: 'consumer',
        idempotencyKey: event.orderId,
      });
    }
  }
}

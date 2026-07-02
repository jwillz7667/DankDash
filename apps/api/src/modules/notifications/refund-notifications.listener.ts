/**
 * Listens for `REFUND_ISSUED_EVENT` (emitted by RefundsService once a
 * refund is finalized on both the auto-approve and admin-approve paths)
 * and dispatches the customer-facing `refund.issued` notification.
 *
 * The event carries the customer id, amount, and reason directly, so this
 * listener is a thin translation from the payments domain event to the
 * notification dispatch. Errors are swallowed and logged — the refund is
 * already durable when the event fires.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { REFUND_ISSUED_EVENT, RefundIssuedEvent } from '../payments/refund-issued.events.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';

export interface RefundNotificationsListenerDeps {
  readonly dispatcher: NotificationDispatcher;
}

@Injectable()
export class RefundNotificationsListener {
  private readonly logger = new Logger(RefundNotificationsListener.name);

  constructor(private readonly deps: RefundNotificationsListenerDeps) {}

  @OnEvent(REFUND_ISSUED_EVENT, { suppressErrors: true })
  async onRefundIssued(event: RefundIssuedEvent): Promise<void> {
    try {
      await this.deps.dispatcher.dispatch({
        userId: event.userId,
        templateKey: 'refund.issued',
        payload: {
          orderId: event.orderId,
          amountCents: event.amountCents,
          reason: event.reason,
        },
        appVariant: 'consumer',
        idempotencyKey: event.refundId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `refund notification failed for refund ${event.refundId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}

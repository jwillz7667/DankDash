/**
 * Domain event emitted by RefundsService the moment a refund is finalized
 * (Aeropay reverse-ACH issued + reverse ledger committed). Both the
 * auto-approve and admin-approve paths funnel through `finalize`, so this
 * is the single post-commit signal a refund actually left the platform.
 *
 * Consumed by `RefundNotificationsListener` (apps/api/src/modules/
 * notifications), which dispatches the customer-facing `refund.issued`
 * notification. Carries the customer id + amount + reason directly so the
 * listener never has to re-read the order or refund rows.
 *
 * Emitted AFTER the finalize transaction commits — a subscriber failure
 * must never roll back the money movement, which is already durable.
 */

export const REFUND_ISSUED_EVENT = 'refund.issued';

export interface RefundIssuedEventPayload {
  readonly refundId: string;
  readonly orderId: string;
  /** The customer (order owner) who receives the refund + notification. */
  readonly userId: string;
  readonly amountCents: number;
  /** Customer-facing reason text; never contains PII. */
  readonly reason: string;
}

export class RefundIssuedEvent implements RefundIssuedEventPayload {
  public readonly refundId: string;
  public readonly orderId: string;
  public readonly userId: string;
  public readonly amountCents: number;
  public readonly reason: string;

  constructor(payload: RefundIssuedEventPayload) {
    this.refundId = payload.refundId;
    this.orderId = payload.orderId;
    this.userId = payload.userId;
    this.amountCents = payload.amountCents;
    this.reason = payload.reason;
  }
}

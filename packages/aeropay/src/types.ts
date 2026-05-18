/**
 * Public types for the Aeropay adapter.
 *
 * Money values are exposed in integer cents to align with the rest of the
 * codebase (`@dankdash/pricing` and the `*_cents` columns in Postgres). The
 * upstream Aeropay API uses major-units strings in some endpoints and minor
 * units in others — the client normalizes to cents at the boundary so
 * callers never see that inconsistency.
 *
 * `provider_ref`-style identifiers (paymentId, payoutId, bankAccountId,
 * linkSessionId) are upstream-issued opaque strings; we treat them as plain
 * strings here and persist them verbatim in `payment_transactions.provider_ref`.
 */

export type AeropayPaymentStatus =
  | 'initiated'
  | 'authorized'
  | 'settled'
  | 'failed'
  | 'canceled'
  | 'refunded';

export type AeropayPayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed';

export interface AeropayPayment {
  readonly id: string;
  readonly status: AeropayPaymentStatus;
  readonly amountCents: number;
  readonly bankAccountId: string;
  readonly customerRef: string;
  readonly orderRef: string;
  readonly createdAt: Date;
}

export interface AeropayPayout {
  readonly id: string;
  readonly status: AeropayPayoutStatus;
  readonly amountCents: number;
  readonly bankAccountId: string;
  readonly recipientRef: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdAt: Date;
}

export interface AeropayBankAccount {
  readonly id: string;
  readonly customerRef: string;
  readonly status: 'pending' | 'linked' | 'failed';
  readonly maskedAccountNumber: string;
  readonly institutionName: string;
}

export interface AeropayLinkSession {
  readonly id: string;
  readonly hostedUrl: string;
  readonly expiresAt: Date;
}

export interface CreatePaymentInput {
  readonly bankAccountId: string;
  readonly amountCents: number;
  readonly customerRef: string;
  readonly orderRef: string;
  /**
   * Idempotency key — the caller persists the value before the request so
   * that retries (network flakes, in-flight client crashes) coalesce on the
   * Aeropay side. We pass the local `payment_transactions.id` here.
   */
  readonly idempotencyKey: string;
}

export interface CreatePayoutInput {
  readonly bankAccountId: string;
  readonly amountCents: number;
  readonly recipientRef: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Same semantics as `CreatePaymentInput.idempotencyKey`. */
  readonly idempotencyKey: string;
}

export interface RefundPaymentInput {
  readonly paymentId: string;
  readonly amountCents: number;
  readonly reasonCode: string;
  readonly idempotencyKey: string;
}

export interface LinkBankAccountInput {
  readonly customerRef: string;
  /** Redirect URL the hosted flow returns to once linking is complete. */
  readonly returnUrl: string;
}

/**
 * Subset of upstream webhook event names this adapter cares about. The
 * verifier returns one of these for matched events and the literal string
 * `'ignored'` for anything else — callers should noop on `'ignored'`
 * (and webhook delivery still succeeds with a 200 — Aeropay otherwise
 * retries with backoff).
 */
export type AeropayWebhookEventType =
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.failed'
  | 'payment.canceled'
  | 'payment.refunded'
  | 'payout.paid'
  | 'payout.failed'
  | 'bank_account.linked'
  | 'bank_account.failed';

export type AeropayWebhookOutcome =
  | {
      readonly type: AeropayWebhookEventType;
      readonly eventId: string;
      readonly objectId: string;
      readonly occurredAt: Date;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'ignored'; readonly eventName: string; readonly eventId: string };

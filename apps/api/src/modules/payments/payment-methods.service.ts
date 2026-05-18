/**
 * Payment-methods service — owns GET/POST(link)/DELETE on /v1/payment-methods
 * plus the Aeropay link-completion webhook side effects.
 *
 * Two responsibilities here, kept on the same service because they share
 * the `PaymentMethodsRepository` and would otherwise need a redundant DI
 * graph:
 *
 *   1. **User-facing CRUD.** List the caller's payment methods, kick off
 *      an Aeropay link session (creating a `pending` row up front so the
 *      iOS list reflects it immediately), and soft-delete a row when the
 *      user removes it.
 *
 *   2. **Webhook application.** Consume the Aeropay-verified
 *      `bank_account.linked` / `bank_account.failed` outcomes and
 *      transition the matching `payment_methods` row's `status` accordingly.
 *      The bank metadata (name + last4) is enriched by a follow-up
 *      `getBankAccount` REST call so we don't trust whatever shape Aeropay
 *      decides to put in the webhook envelope's `raw.data.object`.
 *
 * Authorization contract: every method that takes a `paymentMethodId`
 * pairs it with `userId` from the JWT. Cross-user access surfaces as 404
 * (same response for "does not exist" and "belongs to someone else") so a
 * probing call cannot distinguish the two — same shape the cart module
 * uses for cart-id scoping.
 *
 * Why we don't auto-set-default: the iOS settings flow has an explicit
 * "Make Default" CTA, and silently re-defaulting the first successfully
 * linked card would surprise a user who added a second card just to keep
 * the option around. The repository's `setDefault` is exposed for a future
 * PATCH endpoint; until then there is no implicit default promotion.
 */
import { type AeropayBankAccount, type AeropayWebhookOutcome } from '@dankdash/aeropay';
import { type PaymentMethod, type PaymentMethodsRepository } from '@dankdash/db';
import { ConflictError, NotFoundError, PaymentError } from '@dankdash/types';
import { Inject, Injectable } from '@nestjs/common';
import { AEROPAY_CLIENT, type AeropayClientLike } from './tokens.js';
import type {
  LinkAeropayResponse,
  ListPaymentMethodsResponse,
  PaymentMethodResponse,
} from './dto/index.js';

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly repo: PaymentMethodsRepository,
    @Inject(AEROPAY_CLIENT) private readonly aeropay: AeropayClientLike,
  ) {}

  async list(userId: string): Promise<ListPaymentMethodsResponse> {
    const rows = await this.repo.listForUser(userId);
    return { paymentMethods: rows.map(toResponse) };
  }

  /**
   * Kick off an Aeropay hosted link session and persist a `pending`
   * row keyed to the resulting `link_session_id`. The iOS client opens
   * `link.hostedUrl`; Aeropay redirects back to `returnUrl` on completion,
   * and the webhook flow promotes the row to `active` once the bank
   * account is linked upstream.
   *
   * Conflict policy: if the user already has an `aeropay_ach` row in
   * `pending` state, we refuse a second link with 409 rather than
   * minting a parallel link session. Multiple in-flight sessions
   * confuse Aeropay's customer_ref bookkeeping and create stranded
   * rows in our DB that never get cleaned up.
   */
  async linkAeropay(userId: string, returnUrl: string): Promise<LinkAeropayResponse> {
    const existing = await this.repo.listForUser(userId);
    const stalePending = existing.find((m) => m.type === 'aeropay_ach' && m.status === 'pending');
    if (stalePending !== undefined) {
      throw new ConflictError(
        'PAYMENT_METHOD_LINK_IN_PROGRESS',
        'an Aeropay bank link session is already pending for this user',
        { paymentMethodId: stalePending.id },
      );
    }

    const link = await this.aeropay.linkBankAccount({
      customerRef: userId,
      returnUrl,
    });

    // Persist the link session id in `aeropay_payment_method_ref` so the
    // webhook can look the row up when Aeropay reports the bank account
    // attached. The id is replaced with the bank-account id on success.
    const row = await this.repo.create({
      userId,
      type: 'aeropay_ach',
      aeropayPaymentMethodRef: link.id,
      bankName: null,
      last4: null,
      isDefault: false,
      status: 'pending',
    });

    return {
      paymentMethod: toResponse(row),
      link: {
        id: link.id,
        hostedUrl: link.hostedUrl,
        expiresAt: link.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Soft-delete a payment method. Hard delete would orphan any historical
   * `payment_transactions` row that references the method id; the schema
   * uses ON DELETE SET NULL but losing the bank ref makes refund handling
   * harder. The repo flips `deleted_at`, clears `is_default`, and updates
   * `updated_at` — the row stays for FK + audit purposes.
   *
   * No 404 detail leakage: a delete against an id the caller does not own
   * also surfaces as 404, identical to "does not exist".
   */
  async delete(userId: string, paymentMethodId: string): Promise<void> {
    const existing = await this.repo.findById(paymentMethodId);
    if (existing?.userId !== userId || existing.deletedAt !== null) {
      throw new NotFoundError('payment_method', paymentMethodId);
    }
    await this.repo.softDelete(paymentMethodId);
  }

  /**
   * Apply an Aeropay-verified webhook outcome. The webhook controller
   * runs `AeropayWebhookVerifier.verify()` first — by the time we get
   * here the signature, timestamp, and envelope shape are all known
   * good, and we trust the typed outcome.
   *
   * Behavior matrix for this phase (payment.* events come in Phase 6.3):
   *   - `bank_account.linked`   → flip the pending row to `active`,
   *                                enrich with bank metadata, and
   *                                rewrite `aeropay_payment_method_ref`
   *                                to the upstream bank-account id.
   *   - `bank_account.failed`   → flip to `failed` so the iOS UI can
   *                                show a retry CTA.
   *   - anything else            → noop. Returns silently so the
   *                                controller can 204 the request.
   *
   * Idempotency: re-receiving the same `bank_account.linked` after the
   * row is already `active` is a no-op. The webhook hardening pass in
   * 6.7 introduces a `webhook_events_processed` table that dedupes at
   * the controller layer; this method tolerates dupes regardless.
   *
   * Row lookup: the `data.object.id` on `bank_account.linked` is the
   * Aeropay bank-account id, NOT the link-session id we persisted.
   * We resolve via `getBankAccount` whose response includes the
   * `customer_ref` (== our userId) — and the in-flight pending row is
   * the one we keyed by the link-session id. Two-step is unavoidable
   * because Aeropay does not echo the originating session in the
   * webhook payload.
   */
  async applyWebhook(outcome: AeropayWebhookOutcome): Promise<void> {
    if (outcome.type === 'bank_account.linked') {
      await this.handleBankAccountLinked(outcome.objectId);
      return;
    }
    if (outcome.type === 'bank_account.failed') {
      await this.handleBankAccountFailed(outcome.objectId);
      return;
    }
    // payment.* and payout.* events land in this method during Phase 6.3
    // and 6.6 respectively. Until then, every non-bank-account event is
    // a noop — the controller still 204s so Aeropay drains its retry
    // queue.
  }

  private async handleBankAccountLinked(bankAccountId: string): Promise<void> {
    const account = await this.aeropay.getBankAccount(bankAccountId);
    const pending = await this.findPendingForCustomer(account);
    if (pending === null) {
      // Nothing pending and no existing record — race with a deleted
      // row or a webhook from another environment. Treat as benign;
      // surfacing a 4xx would trigger Aeropay's retry storm for an
      // event we genuinely have nothing to do with.
      return;
    }
    if (pending.status === 'active' && pending.aeropayPaymentMethodRef === bankAccountId) {
      // Replay — already applied.
      return;
    }

    const updated = await this.repo.updateBankAccountDetails(pending.id, {
      aeropayPaymentMethodRef: bankAccountId,
      bankName: account.institutionName,
      last4: extractLast4(account.maskedAccountNumber),
      status: 'active',
    });
    if (updated === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'payment_methods row vanished mid-webhook',
        { paymentMethodId: pending.id },
        500,
      );
    }
  }

  private async handleBankAccountFailed(bankAccountId: string): Promise<void> {
    // The failed-link webhook carries the bank account id even though the
    // bank account was never fully created upstream; pull customer_ref
    // out of the same `getBankAccount` lookup we use on success.
    const account = await this.aeropay.getBankAccount(bankAccountId);
    const pending = await this.findPendingForCustomer(account);
    if (pending === null) return;
    if (pending.status === 'failed') return;
    await this.repo.updateStatus(pending.id, 'failed');
  }

  private async findPendingForCustomer(account: AeropayBankAccount): Promise<PaymentMethod | null> {
    // First try the bank-account id directly — covers replays of an
    // already-applied `bank_account.linked` plus the failed→retry path.
    const direct = await this.repo.findByAeropayRef(account.id);
    if (direct !== null && direct.userId === account.customerRef) return direct;

    // Otherwise the row was created with the link-session id and has not
    // been rewritten yet — pick the user's most recent `pending`
    // `aeropay_ach` row. `listForUser` orders by isDefault DESC then
    // createdAt DESC, so the first pending entry is the freshest one.
    const all = await this.repo.listForUser(account.customerRef);
    return all.find((m) => m.type === 'aeropay_ach' && m.status === 'pending') ?? null;
  }
}

function toResponse(row: PaymentMethod): PaymentMethodResponse {
  return {
    id: row.id,
    type: row.type,
    aeropayPaymentMethodRef: row.aeropayPaymentMethodRef,
    bankName: row.bankName,
    last4: row.last4,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function extractLast4(masked: string): string | null {
  // Aeropay returns masked account numbers like "****1234" or "XXXXXX1234".
  // Pull the trailing 4-digit run; if for any reason the format is unknown
  // we record null rather than truncating an unexpected value.
  const match = /(\d{4})$/.exec(masked);
  return match === null ? null : (match[1] ?? null);
}

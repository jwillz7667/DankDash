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
import {
  type Database,
  type LedgerEntriesRepository,
  type NewLedgerEntry,
  type Order,
  type OrdersRepository,
  type PaymentMethod,
  type PaymentMethodsRepository,
  type PaymentTransaction,
  type PaymentTransactionsRepository,
} from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { computePlatformFeeCents } from '@dankdash/pricing';
import { ConflictError, NotFoundError, PaymentError, RepositoryError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderTransitionService } from '../orders/order-transition.service.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from './tokens.js';
import type {
  LinkAeropayResponse,
  ListPaymentMethodsResponse,
  PaymentMethodResponse,
} from './dto/index.js';

/**
 * Repositories the settlement path re-binds to the transactional handle
 * so the status flip and the distribution ledger writes commit atomically.
 * Kept narrow on purpose — only the writes that must share the tx are
 * exposed; pre-tx reads still use the singleton repos on the service.
 */
export interface SettlementScopedRepos {
  readonly paymentTransactions: PaymentTransactionsRepository;
  readonly ledgerEntries: LedgerEntriesRepository;
}

export type SettlementScopedReposFactory = (db: Database) => SettlementScopedRepos;

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    private readonly repo: PaymentMethodsRepository,
    private readonly paymentTransactions: PaymentTransactionsRepository,
    private readonly orders: OrdersRepository,
    private readonly orderTransitions: OrderTransitionService,
    private readonly db: Database,
    private readonly settlementReposFor: SettlementScopedReposFactory,
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
   * Promote a payment method to the user's default, demoting whatever held
   * the flag before. Backs `PATCH /v1/payment-methods/:id { isDefault: true }`.
   *
   * Ownership is validated here before delegating to the repo: `repo.setDefault`
   * clears the user's current default *first* and only then keys the promotion
   * by id, so handing it an id the caller does not own (or a deleted row) would
   * silently strip the existing default while promoting nothing — leaving the
   * user with no default at all. The findById guard makes that unreachable;
   * cross-user / missing ids surface as 404 (same shape as `delete`).
   *
   * Only an `active` method can be defaulted. A `pending` Aeropay link isn't a
   * usable funding source yet, and `failed`/`revoked` rows are dead — defaulting
   * any of them would point checkout at a method it can't charge. Those surface
   * as 409 `PAYMENT_METHOD_NOT_ACTIVE` rather than silently succeeding.
   *
   * Already-default is an idempotent no-op: we return the row untouched instead
   * of opening a redundant transaction, so a double-tap from the client is free.
   */
  async setDefault(
    userId: string,
    paymentMethodId: string,
  ): Promise<{ paymentMethod: PaymentMethodResponse }> {
    const existing = await this.repo.findById(paymentMethodId);
    if (existing?.userId !== userId || existing.deletedAt !== null) {
      throw new NotFoundError('payment_method', paymentMethodId);
    }
    if (existing.status !== 'active') {
      throw new ConflictError(
        'PAYMENT_METHOD_NOT_ACTIVE',
        'only an active payment method can be set as default',
        { paymentMethodId, status: existing.status },
      );
    }
    if (existing.isDefault) {
      return { paymentMethod: toResponse(existing) };
    }

    await this.repo.setDefault(userId, paymentMethodId);

    const updated = await this.repo.findById(paymentMethodId);
    if (updated === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'payment_methods row vanished mid-setDefault',
        { paymentMethodId },
        500,
      );
    }
    return { paymentMethod: toResponse(updated) };
  }

  /**
   * Apply an Aeropay-verified webhook outcome. The webhook controller
   * runs `AeropayWebhookVerifier.verify()` first — by the time we get
   * here the signature, timestamp, and envelope shape are all known
   * good, and we trust the typed outcome.
   *
   * Behavior matrix:
   *   - `bank_account.linked`    → flip the pending payment_methods row
   *                                 to `active`, enrich with bank
   *                                 metadata, and rewrite
   *                                 `aeropay_payment_method_ref` to the
   *                                 upstream bank-account id.
   *   - `bank_account.failed`    → flip the pending payment_methods row
   *                                 to `failed` so the iOS UI can show a
   *                                 retry CTA.
   *   - `payment.authorized`     → flip the payment_transactions row to
   *                                 `authorized` and stamp authorizedAt.
   *                                 Unlocks vendor-accept on the order.
   *   - `payment.settled`        → flip the payment_transactions row to
   *                                 `settled` and stamp settledAt. Phase
   *                                 6.4 layers the distribution ledger
   *                                 writes onto this hook.
   *   - `payment.failed`         → flip the payment_transactions row to
   *                                 `failed` and stamp failedAt; also
   *                                 transition the parent order to
   *                                 `payment_failed` so the vendor /
   *                                 customer see the failure surface.
   *   - `payment.canceled`       → flip the payment_transactions row to
   *                                 `canceled` and stamp canceledAt. The
   *                                 order stays in `placed` — explicit
   *                                 order cancellation is a separate
   *                                 flow with its own auditing.
   *   - `payment.refunded` / `payout.*` → noop here. Phase 6.5 / 6.6
   *                                 handle refunds and payouts on their
   *                                 dedicated controllers. The 204 the
   *                                 controller still returns drains
   *                                 Aeropay's retry queue.
   *   - `ignored` / unknown      → noop.
   *
   * Idempotency: re-receiving the same event after the row is already in
   * the target state is a no-op. The webhook hardening pass in 6.7
   * introduces a `webhook_events_processed` table that dedupes at the
   * controller layer; this method tolerates dupes regardless.
   *
   * Bank-account row lookup: the `data.object.id` on
   * `bank_account.linked` is the Aeropay bank-account id, NOT the
   * link-session id we persisted. We resolve via `getBankAccount` whose
   * response includes the `customer_ref` (== our userId) — and the
   * in-flight pending row is the one we keyed by the link-session id.
   * Two-step is unavoidable because Aeropay does not echo the
   * originating session in the webhook payload.
   *
   * Payment row lookup: `data.object.id` on `payment.*` is the Aeropay
   * payment id; we persisted that same id as
   * `payment_transactions.provider_ref` at checkout time, so a single
   * `findByProviderRef('aeropay', objectId)` resolves the row.
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
    if (outcome.type === 'payment.authorized') {
      await this.handlePaymentAuthorized(outcome.objectId, outcome.occurredAt);
      return;
    }
    if (outcome.type === 'payment.settled') {
      await this.handlePaymentSettled(outcome.objectId, outcome.occurredAt);
      return;
    }
    if (outcome.type === 'payment.failed') {
      await this.handlePaymentFailed(outcome.objectId, outcome.occurredAt, outcome.raw);
      return;
    }
    if (outcome.type === 'payment.canceled') {
      await this.handlePaymentCanceled(outcome.objectId, outcome.occurredAt);
      return;
    }
    // payment.refunded, payout.* and `ignored` land here as a noop.
    // Refunds get their own admin-gated controller in Phase 6.5; payouts
    // get a cron job in 6.6. Returning silently lets the controller 204
    // so Aeropay drains its retry queue.
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

  private async handlePaymentAuthorized(aeropayPaymentId: string, occurredAt: Date): Promise<void> {
    const tx = await this.findPaymentTransaction(aeropayPaymentId);
    if (tx === null) return;
    if (tx.status === 'authorized' || tx.status === 'settled') return;
    // Settled → authorized would regress; only forward transitions out
    // of `initiated` are allowed. Reaching this branch (status was
    // 'failed' or 'canceled' before authorized arrives) means Aeropay
    // delivered events out of order — the safer choice is to ignore
    // the late event and keep the terminal state.
    if (tx.status !== 'initiated') return;
    await this.paymentTransactions.updateStatus(tx.id, 'authorized', {
      authorizedAt: occurredAt,
    });
  }

  private async handlePaymentSettled(aeropayPaymentId: string, occurredAt: Date): Promise<void> {
    const tx = await this.findPaymentTransaction(aeropayPaymentId);
    if (tx === null) return;
    if (tx.status === 'settled') return;
    // ACH settlement is the natural end state for a non-refunded
    // payment. We accept it from either 'initiated' (rare: Aeropay
    // collapsed authorize+settle into one event) or 'authorized'
    // (normal T+1..T+3 path). Refunded / failed / canceled rows do not
    // re-settle — drop a late settle silently to avoid clobbering the
    // terminal state.
    if (tx.status !== 'initiated' && tx.status !== 'authorized') return;

    // The order is the source of truth for the distribution math. The
    // payment_transactions row only carries the total — splits live on
    // the order header (subtotal, taxes, delivery fee, tip, discount,
    // driverId). A missing order while a payment_transactions row
    // exists is a data-integrity violation (the FK should have
    // prevented it), so fail loudly rather than swallow the webhook.
    const order = await this.orders.findById(tx.orderId);
    if (order === null) {
      throw new RepositoryError(
        `handlePaymentSettled: order ${tx.orderId} missing for payment_transactions ${tx.id}`,
      );
    }
    if (order.totalCents !== tx.amountCents) {
      // Total drift between the order header and the persisted payment
      // amount would silently misallocate funds. The checkout txn pins
      // these to the same value at creation; a divergence here is
      // either tampering or a buggy refund flow that didn't reset the
      // amount. Refuse to distribute on stale numbers.
      throw new RepositoryError(
        `handlePaymentSettled: order ${order.id} total (${String(order.totalCents)}) ` +
          `does not match payment_transactions amount (${String(tx.amountCents)})`,
      );
    }

    const entries = buildSettlementEntries(order, occurredAt);

    // One transaction so the `settled` flip and the eight ledger rows
    // (or fewer when some legs net to zero) commit together. Either
    // both land or neither does — the replay guard above prevents a
    // partial state on Aeropay's retry.
    await this.db.transaction(async (txDb) => {
      const scoped = this.settlementReposFor(txDb);
      const updated = await scoped.paymentTransactions.updateStatus(tx.id, 'settled', {
        settledAt: occurredAt,
      });
      if (updated === null) {
        // We re-read the row inside the tx; if updateStatus returns
        // null something else deleted it between our read and the
        // write. Throwing rolls back the ledger insert that follows.
        throw new RepositoryError(
          `handlePaymentSettled: payment_transactions ${tx.id} vanished mid-settlement`,
        );
      }
      await scoped.ledgerEntries.recordTransaction(entries);
    });
  }

  private async handlePaymentFailed(
    aeropayPaymentId: string,
    occurredAt: Date,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const tx = await this.findPaymentTransaction(aeropayPaymentId);
    if (tx === null) return;
    if (tx.status === 'failed') return;
    // Once money has settled we will not unwind via a failure event —
    // that is a refund path, and Aeropay sends a different event for
    // it. Same logic for already-canceled rows.
    if (tx.status === 'settled' || tx.status === 'canceled') return;

    const { failureCode, failureReason } = extractFailureDetails(raw);
    await this.paymentTransactions.updateStatus(tx.id, 'failed', {
      failedAt: occurredAt,
      failureCode,
      failureReason,
    });
    // Transition the order through the single chokepoint so the authz
    // matrix, the state-machine guard, the immutable order_events /
    // order_status_history rows, AND the post-commit OrderTransitionedEvent
    // (notifications + realtime) all fire — the previous direct
    // `applyTransition` call skipped the event emit, so customers and
    // vendors never saw the payment_failed surface update.
    //
    // PAYMENT_FAILED is only a legal edge from `placed` — i.e. before the
    // vendor accepts, since vendor-accept is gated on `payment.authorized`.
    // An authorization failure (the common case) leaves the order in
    // `placed`, so it transitions cleanly. A settlement-stage failure can
    // arrive after the vendor has accepted; the machine refuses to slam a
    // mid-fulfillment order into a terminal state, so we log it for the
    // refund/dispute flow rather than 5xx the webhook (the
    // payment_transactions row already records the failure, and Aeropay
    // short-circuits on replay via the `tx.status === 'failed'` guard above
    // so a 5xx would not even re-attempt the transition).
    try {
      await this.orderTransitions.transition({
        orderId: tx.orderId,
        event: 'PAYMENT_FAILED',
        actor: { role: 'system' },
        payload: {
          paymentTransactionId: tx.id,
          aeropayPaymentId,
          failureCode,
          failureReason,
        },
      });
    } catch (err) {
      if (
        err instanceof OrderError &&
        (err.code === 'ORDER_INVALID_TRANSITION' || err.code === 'ORDER_TERMINAL_STATE')
      ) {
        this.logger.warn(
          `payment.failed for order ${tx.orderId} could not transition to payment_failed ` +
            `(${err.code}): the order has advanced past 'placed'. Payment marked failed; ` +
            `refund/dispute flow must reconcile. payment_tx=${tx.id} aeropay_payment=${aeropayPaymentId}`,
        );
        return;
      }
      throw err;
    }
  }

  private async handlePaymentCanceled(aeropayPaymentId: string, occurredAt: Date): Promise<void> {
    const tx = await this.findPaymentTransaction(aeropayPaymentId);
    if (tx === null) return;
    if (tx.status === 'canceled') return;
    // Same terminal-state guards as `payment.failed` — once a payment
    // has actually moved money we don't quietly mark it canceled.
    if (tx.status === 'settled' || tx.status === 'failed') return;
    await this.paymentTransactions.updateStatus(tx.id, 'canceled', {
      canceledAt: occurredAt,
    });
    // The order intentionally stays in `placed`. A customer-initiated
    // payment cancellation is distinct from an order cancellation —
    // the explicit POST /v1/orders/:id/cancel surface (later phase)
    // does the order-side transition with the right actor recorded.
  }

  private async findPaymentTransaction(
    aeropayPaymentId: string,
  ): Promise<PaymentTransaction | null> {
    return this.paymentTransactions.findByProviderRef('aeropay', aeropayPaymentId);
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

/**
 * Pull failureCode / failureReason out of the verified webhook envelope.
 * Aeropay nests these under `data.object.failure_code` / `failure_reason`
 * on `payment.failed` events; either may be absent for soft declines
 * where the upstream provider does not return a reason. We narrow with
 * runtime type checks because the verifier exposes the envelope as
 * `Record<string, unknown>` — by design — and we do not want to widen
 * `string | null` to `unknown` in the persisted row.
 */
function extractFailureDetails(raw: Readonly<Record<string, unknown>>): {
  readonly failureCode: string | null;
  readonly failureReason: string | null;
} {
  const data = raw['data'];
  if (data === null || typeof data !== 'object') return { failureCode: null, failureReason: null };
  const object = (data as Record<string, unknown>)['object'];
  if (object === null || typeof object !== 'object') {
    return { failureCode: null, failureReason: null };
  }
  const obj = object as Record<string, unknown>;
  const failureCode = typeof obj['failure_code'] === 'string' ? obj['failure_code'] : null;
  const failureReason = typeof obj['failure_reason'] === 'string' ? obj['failure_reason'] : null;
  return { failureCode, failureReason };
}

/**
 * Distribution ledger entries written when an Aeropay payment settles.
 * One balanced double-entry transaction covering two logical movements
 * the spec (Phase 6.4) calls out separately:
 *
 *   1. Settlement: Aeropay clearing → customer (clears the IOU the
 *      placement entries opened — `aeropay_clearing` DR matches the
 *      placement-time CR; `customer` CR matches the placement-time DR).
 *   2. Distribution: customer → dispensary + platform_revenue +
 *      cannabis_tax + sales_tax + driver. Re-debits the customer to
 *      fund the allocation; each party's account is credited its
 *      share. Customer's lifetime balance settles to the cumulative
 *      spend (DR placement + DR distribution - CR settlement = +total
 *      per delivered order), which the auditor reads as "what this
 *      customer's purchases have been allocated to."
 *
 * Math (the discount is routed to its funder — snapshotted on the order as
 * `discount_funded_by` at checkout — so exactly one of the two funded-discount
 * terms is non-zero):
 *   platformFee     = banker_round(subtotal * PLATFORM_FEE_RATE)
 *   dispFunded      = discount if funded_by = 'dispensary' else 0
 *   platFunded      = discount if funded_by = 'platform'   else 0
 *   dispensaryShare = subtotal - platformFee - dispFunded
 *   platformRevenue = platformFee - platFunded          (may be < 0 → a debit)
 *   driverPayout    = deliveryFee + driverTip
 *
 * dispensaryShare + platformRevenue = subtotal - dispFunded - platFunded
 *                                   = subtotal - discount.
 * So whichever party funds it, the distribution credits still sum to `total`:
 *   dispensaryShare + platformRevenue + cannabis + sales + driverPayout
 *     = (subtotal - discount) + cannabis + sales + delivery + tip
 *     = total.
 * With the settlement pair (clearing DR total / customer CR total) and the
 * customer DR total that funds distribution, Sum DR == Sum CR regardless of
 * funder or of a negative platformRevenue (emitted as a debit that grows the
 * DR side by exactly the shortfall) — the ledger stays balanced.
 *
 * Driver assignment: if `driverId` is null at settlement time (the order
 * settled before dispatch — pathological but possible) the driver
 * credit lands with `accountRef: null` so funds aren't misallocated.
 * The 6.6 payout job filters those out; a subsequent driver
 * assignment + delivery transition can move the funds to a specific
 * driver_id via reverse entries.
 *
 * Zero-leg suppression: rows with both debit and credit at 0 violate
 * the `ledger_one_side_only` CHECK, so a leg whose amount is 0 is
 * omitted. The balance still holds because `total` already reflects
 * the zero-valued component.
 */
type SettlementLedgerEntry = Omit<NewLedgerEntry, 'id'> & { readonly id?: string };

function buildSettlementEntries(order: Order, occurredAt: Date): readonly SettlementLedgerEntry[] {
  const subtotal = order.subtotalCents;
  const cannabis = order.cannabisTaxCents;
  const sales = order.salesTaxCents;
  const delivery = order.deliveryFeeCents;
  const tip = order.driverTipCents;
  const discount = order.discountCents;
  const total = order.totalCents;

  const platformFee = computePlatformFeeCents(subtotal);
  // The discount is routed to its funder (snapshotted on the order at
  // checkout). A platform-funded discount comes out of platform revenue;
  // everything else (an explicit 'dispensary' funder, or a null funder on a
  // legacy/manually-discounted order) comes out of the dispensary's share —
  // which preserves the historical default that the store funds its own
  // discounts and keeps the ledger balanced regardless of funder.
  const platformFundedDiscount = order.discountFundedBy === 'platform' ? discount : 0;
  const dispensaryFundedDiscount = discount - platformFundedDiscount;
  const dispensaryShare = subtotal - platformFee - dispensaryFundedDiscount;
  // Platform revenue nets the fee against any promo the platform funded. It
  // can go NEGATIVE (a "$15 off" platform promo on a small order exceeds the
  // 15% fee) — the platform subsidizes the difference, emitted as a debit
  // against platform_revenue below. dispensary_share is unaffected in that case
  // (the store is paid in full), which is the whole point of a platform promo.
  const platformRevenue = platformFee - platformFundedDiscount;
  const driverPayout = delivery + tip;

  if (dispensaryShare < 0) {
    // A dispensary-funded discount larger than (subtotal - platform_fee) would
    // credit the dispensary negatively, which the ledger CHECK rejects anyway.
    // Surface the cause rather than a raw Postgres error. Promo max-discount
    // caps should keep this unreachable in practice.
    throw new RepositoryError(
      `buildSettlementEntries: order ${order.id} dispensary share would be negative ` +
        `(subtotal=${String(subtotal)}, platformFee=${String(platformFee)}, ` +
        `dispensaryFundedDiscount=${String(dispensaryFundedDiscount)})`,
    );
  }

  const entries: SettlementLedgerEntry[] = [];

  // (1) Settlement leg — clears the placement-time IOU.
  entries.push({
    orderId: order.id,
    accountType: 'aeropay_clearing',
    accountRef: null,
    debitCents: total,
    creditCents: 0,
    description: `Order ${order.shortCode} settlement (clearing)`,
    occurredAt,
  });
  entries.push({
    orderId: order.id,
    accountType: 'customer',
    accountRef: order.userId,
    debitCents: 0,
    creditCents: total,
    description: `Order ${order.shortCode} settlement (customer paid)`,
    occurredAt,
  });

  // (2) Distribution leg — fund the various parties from the customer.
  entries.push({
    orderId: order.id,
    accountType: 'customer',
    accountRef: order.userId,
    debitCents: total,
    creditCents: 0,
    description: `Order ${order.shortCode} distribution`,
    occurredAt,
  });
  if (dispensaryShare > 0) {
    entries.push({
      orderId: order.id,
      accountType: 'dispensary',
      accountRef: order.dispensaryId,
      debitCents: 0,
      creditCents: dispensaryShare,
      description: `Order ${order.shortCode} dispensary share`,
      occurredAt,
    });
  }
  if (platformRevenue > 0) {
    entries.push({
      orderId: order.id,
      accountType: 'platform_revenue',
      accountRef: null,
      debitCents: 0,
      creditCents: platformRevenue,
      description: `Order ${order.shortCode} platform fee`,
      occurredAt,
    });
  } else if (platformRevenue < 0) {
    // Platform-funded promo exceeded the fee — the platform eats the
    // difference. Debit platform_revenue by the shortfall; the distribution
    // still balances (the customer DR already reflects the discounted total).
    entries.push({
      orderId: order.id,
      accountType: 'platform_revenue',
      accountRef: null,
      debitCents: -platformRevenue,
      creditCents: 0,
      description: `Order ${order.shortCode} platform-funded promo subsidy`,
      occurredAt,
    });
  }
  if (cannabis > 0) {
    entries.push({
      orderId: order.id,
      accountType: 'cannabis_tax',
      accountRef: null,
      debitCents: 0,
      creditCents: cannabis,
      description: `Order ${order.shortCode} cannabis tax`,
      occurredAt,
    });
  }
  if (sales > 0) {
    entries.push({
      orderId: order.id,
      accountType: 'sales_tax',
      accountRef: null,
      debitCents: 0,
      creditCents: sales,
      description: `Order ${order.shortCode} sales tax`,
      occurredAt,
    });
  }
  if (driverPayout > 0) {
    entries.push({
      orderId: order.id,
      accountType: 'driver',
      accountRef: order.driverId,
      debitCents: 0,
      creditCents: driverPayout,
      description: `Order ${order.shortCode} driver payout`,
      occurredAt,
    });
  }

  return entries;
}

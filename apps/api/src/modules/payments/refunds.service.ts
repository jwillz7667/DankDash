/**
 * Refunds service — owns the two-step refund lifecycle:
 *
 *   1. **Vendor initiates** (`initiate`) — a budtender/manager/owner POSTs
 *      `/v1/vendor/orders/:id/refund`. We create a `refunds` row keyed
 *      to the order, then either auto-finalize (amount ≤ $50) or leave
 *      it in `pending` for an admin to approve.
 *
 *   2. **Admin approves** (`approve`) — for refunds above the auto-approve
 *      cap, an admin POSTs `/v1/admin/refunds/:id/approve`. The DB
 *      `refunds_separation_of_duties` CHECK and a pre-flight in the
 *      repo enforce that the approver is a different user from the
 *      initiator. The same `finalize` helper that the auto-approve path
 *      uses then issues the Aeropay reverse-ACH and writes the reverse
 *      ledger entries.
 *
 * `finalize` is intentionally extracted: both the inline auto-approve
 * branch and the admin-approve branch must do the exact same thing
 * (Aeropay refundPayment + DB tx that updates the refund row, the
 * payment_transactions status, and the reverse ledger entries) — any
 * drift between the two would create a partial-refund bookkeeping bug
 * that only surfaces at reconciliation. One code path, two callers.
 *
 * Money flow on finalize: the Aeropay HTTP call happens *outside* the
 * DB transaction. Holding a row lock across a network round trip would
 * stall under upstream slowness; if Aeropay returns 5xx we mark the
 * refund row `failed` (no ledger writes) and surface a typed
 * PaymentError. The idempotency key `refund:<id>` lets a retry of the
 * same logical refund coalesce on Aeropay's side without producing a
 * duplicate upstream charge — so a transient failure followed by a
 * fresh attempt against the same `refunds.id` is safe.
 *
 * Reverse-ledger math (Phase 6.5):
 *
 *   DR refund_reserve  R   accountRef = dispensaryId
 *   CR customer        R   accountRef = userId
 *
 * Two legs, balanced. `refund_reserve` accumulates per-dispensary
 * drawdowns the payout job (6.6) deducts from the next gross. We do
 * NOT split R pro-rata across the original distribution legs (platform
 * fee, taxes, driver, dispensary share) — that level of allocation is
 * the reconciliation layer's job. The phase spec's "reverse ledger
 * entries" requirement is satisfied: every cent leaving as a refund is
 * tied back to the originating order via `refundId` + `orderId`, and
 * the dispensary obligation is tracked through `refund_reserve`.
 *
 * Why we re-derive `totalRefundedCents` inside `finalize`: the
 * `payment_transactions.status` flip depends on whether *this* refund
 * fully exhausts the charge or leaves a remainder. A vendor-initiated
 * small refund followed by an admin-approved large refund needs the
 * second one to flip the status to `refunded`; the first to
 * `partially_refunded`. The repo's `totalRefundedCents` only sums
 * `status='completed'` rows, so we add the current refund's amount
 * separately (the refund row updates to `completed` *inside* the same
 * tx, so the sum is consistent on commit).
 */
import { type AeropayPayment } from '@dankdash/aeropay';
import {
  type Database,
  type LedgerEntriesRepository,
  type NewLedgerEntry,
  type Order,
  type OrdersRepository,
  type PaymentTransaction,
  type PaymentTransactionsRepository,
  type Refund,
  type RefundsRepository,
} from '@dankdash/db';
import {
  ConflictError,
  NotFoundError,
  PaymentError,
  RepositoryError,
  ValidationError,
} from '@dankdash/types';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { REFUND_AUTO_APPROVE_LIMIT_CENTS } from './dto/refund.dto.js';
import { REFUND_ISSUED_EVENT, RefundIssuedEvent } from './refund-issued.events.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from './tokens.js';
import type { InitiateRefundRequest, RefundResponse } from './dto/index.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

/**
 * Repositories the refund-finalize path re-binds to the transactional
 * handle so the refund-row update, the payment-transactions status
 * flip, and the reverse-ledger writes commit atomically.
 */
export interface RefundScopedRepos {
  readonly refunds: RefundsRepository;
  readonly paymentTransactions: PaymentTransactionsRepository;
  readonly ledgerEntries: LedgerEntriesRepository;
}

export type RefundScopedReposFactory = (db: Database) => RefundScopedRepos;

@Injectable()
export class RefundsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly paymentTransactions: PaymentTransactionsRepository,
    private readonly refunds: RefundsRepository,
    private readonly db: Database,
    private readonly refundReposFor: RefundScopedReposFactory,
    @Inject(AEROPAY_CLIENT) private readonly aeropay: AeropayClientLike,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Vendor entry point. Creates the refund row and either finalizes
   * immediately (≤ $50) or leaves it in `pending` for an admin.
   *
   * Cross-dispensary protection: the order is looked up by id, then we
   * compare `order.dispensaryId` to `ctx.dispensaryId`. Mismatch surfaces
   * as 404 with the same shape as a genuine "no such order" response so
   * a probe cannot distinguish them.
   */
  async initiate(
    ctx: VendorContext,
    orderId: string,
    body: InitiateRefundRequest,
  ): Promise<RefundResponse> {
    const order = await this.orders.findById(orderId);
    if (order?.dispensaryId !== ctx.dispensaryId) {
      throw new NotFoundError('order', orderId);
    }

    const settledTx = await this.findRefundableTransaction(orderId);
    if (settledTx === null) {
      throw new ConflictError(
        'NO_REFUNDABLE_PAYMENT',
        'order has no settled payment that can be refunded',
        { orderId },
      );
    }

    const alreadyRefunded = await this.refunds.totalRefundedCents(orderId);
    if (alreadyRefunded + body.amountCents > settledTx.amountCents) {
      throw new ValidationError('refund amount would exceed the original charge', {
        orderId,
        requestedCents: body.amountCents,
        alreadyRefundedCents: alreadyRefunded,
        chargeCents: settledTx.amountCents,
      });
    }

    const requiresAdminApproval = body.amountCents > REFUND_AUTO_APPROVE_LIMIT_CENTS;

    const refund = await this.refunds.create({
      orderId,
      amountCents: body.amountCents,
      reasonCode: body.reasonCode,
      reasonNotes: body.reasonNotes ?? null,
      initiatedBy: ctx.userId,
      approvedBy: null,
      providerRef: null,
      status: 'pending',
    });

    if (requiresAdminApproval) {
      // Above the auto-approve cap — wait for admin to call /approve.
      // The refund row stays pending: no Aeropay call, no ledger writes.
      return projectRefund(refund, requiresAdminApproval);
    }

    const completed = await this.finalize(refund, order, settledTx);
    return projectRefund(completed, requiresAdminApproval);
  }

  /**
   * Admin entry point. Refuses to approve when:
   *   - the refund row does not exist (404),
   *   - the refund is not currently `pending` (409 — already completed,
   *     failed, or canceled and cannot be re-approved),
   *   - the approver is the same user that initiated the refund (422 —
   *     mirrors the DB CHECK so the admin sees a typed error rather
   *     than a 500 from a RangeError),
   *   - the remaining refundable budget has since been consumed by a
   *     parallel refund (422),
   *   - or the underlying payment is no longer in a refundable state
   *     (409 — e.g. someone canceled the payment between initiate and
   *     approve).
   *
   * On success the same `finalize` helper runs: Aeropay refund call,
   * then the DB tx that updates the refund row, flips the payment
   * status, and writes the reverse ledger entries.
   */
  async approve(adminUserId: string, refundId: string): Promise<RefundResponse> {
    const refund = await this.refunds.findById(refundId);
    if (refund === null) {
      throw new NotFoundError('refund', refundId);
    }
    if (refund.status !== 'pending') {
      throw new ConflictError(
        'REFUND_NOT_PENDING',
        `refund ${refundId} is already ${refund.status} and cannot be approved`,
        { refundId, status: refund.status },
      );
    }
    if (refund.initiatedBy === adminUserId) {
      // Pre-flight matches the DB-level `refunds_separation_of_duties`
      // CHECK and the repo's `approve` RangeError; surfacing it here
      // means the admin sees a typed 422 rather than the raw error.
      throw new ValidationError(
        'approver cannot be the same user that initiated the refund (separation of duties)',
        { refundId, userId: adminUserId },
      );
    }

    const order = await this.orders.findById(refund.orderId);
    if (order === null) {
      throw new RepositoryError(
        `RefundsService.approve: order ${refund.orderId} missing for refund ${refund.id}`,
      );
    }

    const settledTx = await this.findRefundableTransaction(refund.orderId);
    if (settledTx === null) {
      throw new ConflictError(
        'NO_REFUNDABLE_PAYMENT',
        'order has no settled payment that can be refunded',
        { refundId, orderId: refund.orderId },
      );
    }

    const alreadyRefunded = await this.refunds.totalRefundedCents(refund.orderId);
    if (alreadyRefunded + refund.amountCents > settledTx.amountCents) {
      throw new ValidationError(
        'refund amount would exceed the original charge after other completed refunds',
        {
          refundId,
          requestedCents: refund.amountCents,
          alreadyRefundedCents: alreadyRefunded,
          chargeCents: settledTx.amountCents,
        },
      );
    }

    const approved = await this.refunds.approve(refund.id, adminUserId);
    if (approved === null) {
      // Repo returns null when the row vanished between findById and
      // the UPDATE. Treat as a 404 from the admin's POV — the row no
      // longer exists for them to act on.
      throw new NotFoundError('refund', refundId);
    }

    const completed = await this.finalize(approved, order, settledTx);
    return projectRefund(completed, true);
  }

  /**
   * Shared finalization path used by both auto-approve and admin-approve.
   *
   * Steps:
   *   1. Call Aeropay refundPayment with `refund:<id>` as the
   *      idempotency key (outside the DB tx — see file header for why).
   *      Failure path: mark the row `failed`, surface a 502 PaymentError.
   *   2. Compute the next `payment_transactions.status`: `refunded` if
   *      the cumulative refunded amount catches up to the charge,
   *      `partially_refunded` otherwise.
   *   3. Open a tx and: update the refund row to `completed` (with the
   *      upstream id + completedAt), update the payment_transactions
   *      status, and write the two-leg reverse ledger entries.
   */
  private async finalize(
    refund: Refund,
    order: Order,
    settledTx: PaymentTransaction,
  ): Promise<Refund> {
    let upstream: AeropayPayment;
    try {
      upstream = await this.aeropay.refundPayment({
        paymentId: settledTx.providerRef,
        amountCents: refund.amountCents,
        reasonCode: refund.reasonCode,
        idempotencyKey: `refund:${refund.id}`,
      });
    } catch (cause) {
      // Mark the row failed so the vendor surface doesn't keep showing
      // it as pending. The status update is its own write — if it also
      // fails, surface the repo error with the original cause chained so
      // ops can correlate.
      const failed = await this.refunds.updateStatus(refund.id, 'failed');
      if (failed === null) {
        throw new RepositoryError(
          `RefundsService.finalize: refund ${refund.id} vanished mid-failure marking`,
          {},
          cause,
        );
      }
      throw new PaymentError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `Aeropay refundPayment failed for refund ${refund.id}`,
        { refundId: refund.id, paymentId: settledTx.providerRef },
        502,
        cause,
      );
    }

    const completedAt = new Date();
    // Cumulative refunded *including* this one — the repo only sums
    // rows already in `completed`, so add the current amount manually
    // since we're about to flip it to completed inside the tx.
    const newTotalRefunded =
      (await this.refunds.totalRefundedCents(refund.orderId)) + refund.amountCents;
    const nextTxStatus: 'refunded' | 'partially_refunded' =
      newTotalRefunded >= settledTx.amountCents ? 'refunded' : 'partially_refunded';

    const entries = buildRefundLedgerEntries(order, refund, completedAt);

    const completed = await this.db.transaction(async (txDb) => {
      const scoped = this.refundReposFor(txDb);
      const updated = await scoped.refunds.updateStatus(refund.id, 'completed', {
        providerRef: upstream.id,
        completedAt,
      });
      if (updated === null) {
        throw new RepositoryError(`RefundsService.finalize: refund ${refund.id} vanished mid-tx`);
      }
      const txUpdated = await scoped.paymentTransactions.updateStatus(settledTx.id, nextTxStatus);
      if (txUpdated === null) {
        throw new RepositoryError(
          `RefundsService.finalize: payment_transactions ${settledTx.id} vanished mid-tx`,
        );
      }
      await scoped.ledgerEntries.recordTransaction(entries);
      return updated;
    });

    // Post-commit: notify the customer their refund is on the way. Emitted
    // here (not inside the tx) so a notifier failure can't roll back the
    // money movement, which is already durable. EventEmitter2 delivery is
    // in-process and the listener swallows its own errors.
    this.events.emit(
      REFUND_ISSUED_EVENT,
      new RefundIssuedEvent({
        refundId: completed.id,
        orderId: order.id,
        userId: order.userId,
        amountCents: completed.amountCents,
        reason: refund.reasonNotes ?? 'We issued a refund for your order.',
      }),
    );

    return completed;
  }

  /**
   * Locate a payment_transactions row that still has refundable
   * principal. Eligible states: `settled` (full balance refundable) and
   * `partially_refunded` (some balance refundable). All other states —
   * `initiated`, `authorized`, `failed`, `canceled`, `refunded` — are
   * not refundable here; an `authorized` payment hasn't moved money yet
   * (cancel instead), and a fully `refunded` row has no remaining
   * principal even if a stray refund row was created.
   *
   * `listForOrder` returns rows ordered by `initiatedAt DESC`; in
   * practice an order has a single payment row, but the code stays
   * correct if a retry created an extra row.
   */
  private async findRefundableTransaction(orderId: string): Promise<PaymentTransaction | null> {
    const txs = await this.paymentTransactions.listForOrder(orderId);
    return txs.find((t) => t.status === 'settled' || t.status === 'partially_refunded') ?? null;
  }
}

function projectRefund(row: Refund, requiresAdminApproval: boolean): RefundResponse {
  return {
    id: row.id,
    orderId: row.orderId,
    amountCents: row.amountCents,
    reasonCode: row.reasonCode,
    reasonNotes: row.reasonNotes,
    initiatedBy: row.initiatedBy,
    approvedBy: row.approvedBy,
    providerRef: row.providerRef,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    requiresAdminApproval,
  };
}

/**
 * Two-leg reverse-ledger entries written on refund completion.
 *
 * `refund_reserve` is the ledger account the payout job draws against
 * to chargeback the dispensary; tagging the row with `accountRef =
 * dispensaryId` lets the payout aggregator subtract the per-dispensary
 * reserve balance from the next gross. The customer leg mirrors the
 * settlement-time customer credit (CR customer total) — refunds put
 * value back onto the customer's ledger position, exactly inverse to
 * the distribution-time DR.
 *
 * Both rows carry `refundId` so a refund audit can pull every leg by
 * the refund id alone; both also carry `orderId` so order-level totals
 * stay correct without joining through refunds.
 */
type RefundLedgerEntry = Omit<NewLedgerEntry, 'id'> & { readonly id?: string };

function buildRefundLedgerEntries(
  order: Order,
  refund: Refund,
  occurredAt: Date,
): readonly RefundLedgerEntry[] {
  return [
    {
      orderId: order.id,
      refundId: refund.id,
      accountType: 'refund_reserve',
      accountRef: order.dispensaryId,
      debitCents: refund.amountCents,
      creditCents: 0,
      description: `Order ${order.shortCode} refund (reserve)`,
      occurredAt,
    },
    {
      orderId: order.id,
      refundId: refund.id,
      accountType: 'customer',
      accountRef: order.userId,
      debitCents: 0,
      creditCents: refund.amountCents,
      description: `Order ${order.shortCode} refund (customer)`,
      occurredAt,
    },
  ];
}

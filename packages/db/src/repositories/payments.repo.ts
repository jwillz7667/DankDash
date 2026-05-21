import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, gte, isNull, lt, sql, sum } from 'drizzle-orm';
import {
  type LedgerAccountType,
  type PaymentStatus,
  type PayoutRecipient,
  type PayoutStatus,
  type RefundStatus,
} from '../schema/enums.js';
import {
  ledgerEntries,
  paymentMethods,
  paymentTransactions,
  payouts,
  refunds,
  type LedgerEntry,
  type NewLedgerEntry,
  type NewPaymentMethod,
  type NewPaymentTransaction,
  type NewPayout,
  type NewRefund,
  type PaymentMethod,
  type PaymentTransaction,
  type Payout,
  type Refund,
} from '../schema/payments.js';
import { BaseRepository, newId } from './base.js';

export class PaymentMethodsRepository extends BaseRepository {
  async findById(id: string): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, id))
      .limit(1);
    return row ?? null;
  }

  async listForUser(userId: string): Promise<readonly PaymentMethod[]> {
    return this.db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.userId, userId), isNull(paymentMethods.deletedAt)))
      .orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt));
  }

  async findDefaultForUser(userId: string): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.userId, userId),
          eq(paymentMethods.isDefault, true),
          isNull(paymentMethods.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Locate a payment method by its Aeropay-issued bank account ref. Used by
   * the webhook handler to upsert the row when `bank_account.linked` /
   * `bank_account.failed` arrive after the link-session redirect — the row
   * may already exist if a prior delivery created it.
   *
   * Returns deleted rows too so a re-link of a soft-deleted bank account
   * is detected and surfaces as a domain conflict instead of silently
   * creating a duplicate row.
   */
  async findByAeropayRef(aeropayRef: string): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.aeropayPaymentMethodRef, aeropayRef))
      .limit(1);
    return row ?? null;
  }

  async create(
    input: Omit<NewPaymentMethod, 'id'> & { readonly id?: string },
  ): Promise<PaymentMethod> {
    const [row] = await this.db
      .insert(paymentMethods)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('payment_methods insert returned no row');
    return row;
  }

  async setDefault(userId: string, paymentMethodId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(paymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(paymentMethods.userId, userId), eq(paymentMethods.isDefault, true)));
      await tx
        .update(paymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.userId, userId)));
    });
  }

  async updateStatus(id: string, status: PaymentMethod['status']): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .update(paymentMethods)
      .set({ status, updatedAt: new Date() })
      .where(eq(paymentMethods.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Rewrite the Aeropay-linked metadata on a row in one statement — used by
   * the `bank_account.linked` webhook to swap the link-session id for the
   * bank-account id and attach bank name + last 4 in the same UPDATE.
   * Splitting into status + metadata updates would race with concurrent
   * webhook deliveries; one statement keeps the row consistent.
   */
  async updateBankAccountDetails(
    id: string,
    patch: Pick<PaymentMethod, 'aeropayPaymentMethodRef' | 'bankName' | 'last4' | 'status'>,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .update(paymentMethods)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(paymentMethods.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(paymentMethods)
      .set({ deletedAt: now, updatedAt: now, isDefault: false })
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.deletedAt)));
  }
}

export class PaymentTransactionsRepository extends BaseRepository {
  async findById(id: string): Promise<PaymentTransaction | null> {
    const [row] = await this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByProviderRef(
    provider: string,
    providerRef: string,
  ): Promise<PaymentTransaction | null> {
    const [row] = await this.db
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, provider),
          eq(paymentTransactions.providerRef, providerRef),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listForOrder(orderId: string): Promise<readonly PaymentTransaction[]> {
    return this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.orderId, orderId))
      .orderBy(desc(paymentTransactions.initiatedAt));
  }

  async create(
    input: Omit<NewPaymentTransaction, 'id'> & { readonly id?: string },
  ): Promise<PaymentTransaction> {
    const [row] = await this.db
      .insert(paymentTransactions)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('payment_transactions insert returned no row');
    return row;
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    patch: Partial<
      Pick<
        NewPaymentTransaction,
        | 'authorizedAt'
        | 'settledAt'
        | 'failedAt'
        | 'canceledAt'
        | 'failureCode'
        | 'failureReason'
        | 'rawResponse'
      >
    > = {},
  ): Promise<PaymentTransaction | null> {
    const [row] = await this.db
      .update(paymentTransactions)
      .set({ ...patch, status, updatedAt: new Date() })
      .where(eq(paymentTransactions.id, id))
      .returning();
    return row ?? null;
  }
}

/**
 * Append-only repository — `ledger_entries` is guarded by a BEFORE UPDATE OR
 * DELETE trigger and the CHECK constraint enforces single-sided rows.
 * `recordTransaction` validates that supplied entries balance before insert.
 */
export class LedgerEntriesRepository extends BaseRepository {
  async record(input: Omit<NewLedgerEntry, 'id'> & { readonly id?: string }): Promise<LedgerEntry> {
    const [row] = await this.db
      .insert(ledgerEntries)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('ledger_entries insert returned no row');
    return row;
  }

  /**
   * Insert a balanced double-entry transaction. Throws if the sum of debits
   * does not equal the sum of credits — every cent must be accounted for.
   */
  async recordTransaction(
    entries: readonly (Omit<NewLedgerEntry, 'id'> & { readonly id?: string })[],
  ): Promise<readonly LedgerEntry[]> {
    if (entries.length === 0) {
      throw new RangeError('recordTransaction: at least one entry required');
    }
    let debitTotal = 0;
    let creditTotal = 0;
    for (const entry of entries) {
      debitTotal += entry.debitCents ?? 0;
      creditTotal += entry.creditCents ?? 0;
    }
    if (debitTotal !== creditTotal) {
      throw new RangeError(
        `recordTransaction: unbalanced ledger — debits=${String(debitTotal)} credits=${String(creditTotal)}`,
      );
    }
    const values = entries.map((entry) => ({ ...entry, id: entry.id ?? newId() }));
    return this.db.insert(ledgerEntries).values(values).returning();
  }

  async listForOrder(orderId: string): Promise<readonly LedgerEntry[]> {
    return this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId))
      .orderBy(ledgerEntries.occurredAt);
  }

  /**
   * Account balance = sum(debits) - sum(credits). Single round trip via
   * aggregate; returns 0 if the account has no entries yet.
   */
  async accountBalanceCents(
    accountType: LedgerAccountType,
    accountRef: string | null,
  ): Promise<number> {
    const where =
      accountRef === null
        ? and(eq(ledgerEntries.accountType, accountType), isNull(ledgerEntries.accountRef))
        : and(eq(ledgerEntries.accountType, accountType), eq(ledgerEntries.accountRef, accountRef));
    const [row] = await this.db
      .select({
        debits: sum(ledgerEntries.debitCents).mapWith(Number),
        credits: sum(ledgerEntries.creditCents).mapWith(Number),
      })
      .from(ledgerEntries)
      .where(where);
    if (row === undefined) return 0;
    return row.debits - row.credits;
  }

  /**
   * Aggregate credits − debits for every distinct accountRef of a given
   * accountType whose entries fall in the [periodStartUtc, periodEndUtc)
   * window. Used by the daily payout job to compute per-dispensary or
   * per-driver net earnings for the period in a single round trip.
   *
   * The window is half-open intentionally — `periodEndUtc` is the next
   * day's 00:00 Central converted to UTC, so an entry whose occurredAt
   * lands exactly at the boundary belongs to the *next* period, not this
   * one. This mirrors how the payouts row's `period_end` is the exclusive
   * upper bound on the date axis.
   *
   * Rows where accountRef IS NULL (platform_revenue, taxes, clearing) are
   * skipped — they have no recipient and don't roll up into a payout.
   */
  async netByAccountRefInWindow(
    accountType: LedgerAccountType,
    periodStartUtc: Date,
    periodEndUtc: Date,
  ): Promise<readonly { readonly accountRef: string; readonly netCents: number }[]> {
    const rows = await this.db
      .select({
        accountRef: ledgerEntries.accountRef,
        debits: sum(ledgerEntries.debitCents).mapWith(Number),
        credits: sum(ledgerEntries.creditCents).mapWith(Number),
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.accountType, accountType),
          gte(ledgerEntries.occurredAt, periodStartUtc),
          lt(ledgerEntries.occurredAt, periodEndUtc),
          sql`${ledgerEntries.accountRef} IS NOT NULL`,
        ),
      )
      .groupBy(ledgerEntries.accountRef);
    return rows.flatMap((row) =>
      row.accountRef === null
        ? []
        : [{ accountRef: row.accountRef, netCents: row.credits - row.debits }],
    );
  }
}

export class PayoutsRepository extends BaseRepository {
  async findById(id: string): Promise<Payout | null> {
    const [row] = await this.db.select().from(payouts).where(eq(payouts.id, id)).limit(1);
    return row ?? null;
  }

  async listForRecipient(
    recipientType: PayoutRecipient,
    recipientId: string,
    limit = 50,
  ): Promise<readonly Payout[]> {
    return this.db
      .select()
      .from(payouts)
      .where(and(eq(payouts.recipientType, recipientType), eq(payouts.recipientId, recipientId)))
      .orderBy(desc(payouts.periodEnd))
      .limit(limit);
  }

  async listByStatus(status: PayoutStatus, limit = 200): Promise<readonly Payout[]> {
    return this.db
      .select()
      .from(payouts)
      .where(eq(payouts.status, status))
      .orderBy(payouts.scheduledFor)
      .limit(limit);
  }

  async create(input: Omit<NewPayout, 'id'> & { readonly id?: string }): Promise<Payout> {
    const [row] = await this.db
      .insert(payouts)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('payouts insert returned no row');
    return row;
  }

  /**
   * Insert a payout row, or return the existing row that already covers
   * the same (recipient_type, recipient_id, period_start, period_end).
   * Backs the daily payout job's idempotency — a redeploy or worker
   * restart re-firing the cron for the same calendar day is a no-op
   * rather than a duplicate-row error.
   *
   * Returns `{ payout, created }` so the caller can decide whether to
   * issue the upstream Aeropay payout (`created === true`) or skip it
   * (the prior run already initiated and the upstream call has its own
   * idempotency key — re-calling would be safe but wasteful).
   */
  async createIfAbsent(
    input: Omit<NewPayout, 'id'> & { readonly id?: string },
  ): Promise<{ readonly payout: Payout; readonly created: boolean }> {
    const candidate = { ...input, id: input.id ?? newId() };
    const inserted = await this.db
      .insert(payouts)
      .values(candidate)
      .onConflictDoNothing({
        target: [
          payouts.recipientType,
          payouts.recipientId,
          payouts.periodStart,
          payouts.periodEnd,
        ],
      })
      .returning();
    if (inserted[0] !== undefined) {
      return { payout: inserted[0], created: true };
    }
    const [existing] = await this.db
      .select()
      .from(payouts)
      .where(
        and(
          eq(payouts.recipientType, candidate.recipientType),
          eq(payouts.recipientId, candidate.recipientId),
          eq(payouts.periodStart, candidate.periodStart),
          eq(payouts.periodEnd, candidate.periodEnd),
        ),
      )
      .limit(1);
    if (existing === undefined) {
      throw new RepositoryError(
        `payouts.createIfAbsent: conflict on insert but no existing row found for ${candidate.recipientType} ${candidate.recipientId} ${candidate.periodStart}..${candidate.periodEnd}`,
      );
    }
    return { payout: existing, created: false };
  }

  async updateStatus(
    id: string,
    status: PayoutStatus,
    patch: Partial<
      Pick<NewPayout, 'initiatedAt' | 'completedAt' | 'aeropayPayoutRef' | 'failureReason'>
    > = {},
  ): Promise<Payout | null> {
    const [row] = await this.db
      .update(payouts)
      .set({ ...patch, status, updatedAt: new Date() })
      .where(eq(payouts.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Total of `net_cents` already paid out (or in-flight) for a recipient.
   * Used by the driver cashout flow to compute available balance =
   * lifetime delivery earnings - paid-out / in-flight payouts. Failed +
   * canceled rows are excluded so a previous failure doesn't double-lock
   * the same funds.
   */
  async sumOutstandingFor(recipientType: PayoutRecipient, recipientId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${payouts.netCents}), 0)`,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.recipientType, recipientType),
          eq(payouts.recipientId, recipientId),
          sql`${payouts.status} NOT IN ('failed', 'canceled')`,
        ),
      );
    return Number(row?.total ?? '0');
  }

  /**
   * Number of payout rows persisted for a recipient. Used by the
   * driver cashout flow to derive a per-row `period_start` offset so
   * the `(recipient_type, recipient_id, period_start, period_end)`
   * unique constraint — designed for the daily payout job's
   * idempotency — does not block legitimate ad-hoc cashout requests
   * from the driver app.
   *
   * A future windowed payout job will own the period_* columns
   * outright; this counter is the Phase 20 shim while ad-hoc cashout
   * is the only writer.
   */
  async countForRecipient(recipientType: PayoutRecipient, recipientId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`COUNT(*)`,
      })
      .from(payouts)
      .where(and(eq(payouts.recipientType, recipientType), eq(payouts.recipientId, recipientId)));
    return Number(row?.total ?? '0');
  }
}

export class RefundsRepository extends BaseRepository {
  async findById(id: string): Promise<Refund | null> {
    const [row] = await this.db.select().from(refunds).where(eq(refunds.id, id)).limit(1);
    return row ?? null;
  }

  async listForOrder(orderId: string): Promise<readonly Refund[]> {
    return this.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(desc(refunds.createdAt));
  }

  async create(input: Omit<NewRefund, 'id'> & { readonly id?: string }): Promise<Refund> {
    const [row] = await this.db
      .insert(refunds)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('refunds insert returned no row');
    return row;
  }

  /**
   * Approval enforces separation of duties — the same user cannot both
   * initiate and approve. The DB-level CHECK is the ultimate guard; this
   * pre-flight prevents a needless round trip.
   */
  async approve(id: string, approverUserId: string): Promise<Refund | null> {
    const existing = await this.findById(id);
    if (existing === null) return null;
    if (existing.initiatedBy === approverUserId) {
      throw new RangeError(
        `refunds.approve: approver ${approverUserId} cannot also be initiator (separation of duties)`,
      );
    }
    const [row] = await this.db
      .update(refunds)
      .set({ approvedBy: approverUserId })
      .where(eq(refunds.id, id))
      .returning();
    return row ?? null;
  }

  async updateStatus(
    id: string,
    status: RefundStatus,
    patch: Partial<Pick<NewRefund, 'providerRef' | 'completedAt'>> = {},
  ): Promise<Refund | null> {
    const [row] = await this.db
      .update(refunds)
      .set({ ...patch, status })
      .where(eq(refunds.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Total refunded for an order across all completed refunds. Used by the
   * payments service to enforce "total refunds ≤ original charge".
   */
  async totalRefundedCents(orderId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(refunds.amountCents).mapWith(Number) })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'completed')));
    return row?.total ?? 0;
  }
}

import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull, sum } from 'drizzle-orm';
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

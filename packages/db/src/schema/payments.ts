import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ledgerAccountType,
  paymentMethodStatus,
  paymentMethodType,
  paymentStatus,
  payoutRecipient,
  payoutStatus,
  refundStatus,
} from './enums.js';
import { users } from './identity.js';
import { orders } from './orders.js';

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: paymentMethodType('type').notNull(),
    aeropayPaymentMethodRef: text('aeropay_payment_method_ref'),
    bankName: text('bank_name'),
    last4: text('last4'),
    isDefault: boolean('is_default').notNull().default(false),
    status: paymentMethodStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('payment_methods_user_idx')
      .on(table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex('payment_methods_one_default')
      .on(table.userId)
      .where(sql`${table.isDefault} = true AND ${table.deletedAt} IS NULL`),
  ],
);

export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: paymentStatus('status').notNull(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true, mode: 'date' }),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    canceledAt: timestamp('canceled_at', { withTimezone: true, mode: 'date' }),
    rawResponse: jsonb('raw_response'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('payment_transactions_provider_ref_uq').on(table.provider, table.providerRef),
    index('payment_transactions_order_idx').on(table.orderId),
  ],
);

/**
 * Double-entry ledger. Append-only — the API role has INSERT but not
 * UPDATE/DELETE on this table.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').references(() => orders.id),
    payoutId: uuid('payout_id'),
    refundId: uuid('refund_id'),
    accountType: ledgerAccountType('account_type').notNull(),
    accountRef: uuid('account_ref'),
    debitCents: integer('debit_cents').notNull().default(0),
    creditCents: integer('credit_cents').notNull().default(0),
    description: text('description').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'ledger_one_side_only',
      sql`(${table.debitCents} > 0 AND ${table.creditCents} = 0)
            OR (${table.creditCents} > 0 AND ${table.debitCents} = 0)`,
    ),
    check('ledger_nonneg', sql`${table.debitCents} >= 0 AND ${table.creditCents} >= 0`),
    index('ledger_order_idx')
      .on(table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    index('ledger_account_idx').on(table.accountType, table.accountRef, table.occurredAt),
  ],
);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientType: payoutRecipient('recipient_type').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    grossCents: integer('gross_cents').notNull(),
    feesCents: integer('fees_cents').notNull().default(0),
    netCents: integer('net_cents').notNull(),
    aeropayPayoutRef: text('aeropay_payout_ref'),
    status: payoutStatus('status').notNull().default('pending'),
    scheduledFor: date('scheduled_for').notNull(),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('payouts_recipient_idx').on(table.recipientType, table.recipientId, table.periodEnd),
    index('payouts_status_idx').on(table.status, table.scheduledFor),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    reasonCode: text('reason_code').notNull(),
    reasonNotes: text('reason_notes'),
    initiatedBy: uuid('initiated_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    providerRef: text('provider_ref'),
    status: refundStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('refunds_amount_positive', sql`${table.amountCents} > 0`),
    check(
      'refunds_separation_of_duties',
      sql`${table.initiatedBy} != ${table.approvedBy} OR ${table.approvedBy} IS NULL`,
    ),
    index('refunds_order_idx').on(table.orderId),
  ],
);

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;
export type NewPaymentTransaction = typeof paymentTransactions.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;

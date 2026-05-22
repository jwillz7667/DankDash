import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { complianceCheckType, metrcStatus, verificationContext } from './enums.js';
import { users } from './identity.js';
import { orders } from './orders.js';

export const complianceChecks = pgTable(
  'compliance_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkType: complianceCheckType('check_type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    passed: boolean('passed').notNull(),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    performedAt: timestamp('performed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    performedBy: uuid('performed_by').references(() => users.id),
  },
  (table) => [
    index('compliance_checks_subject_idx').on(
      table.subjectType,
      table.subjectId,
      table.performedAt,
    ),
    index('compliance_checks_failures_idx')
      .on(table.performedAt)
      .where(sql`${table.passed} = false`),
  ],
);

export const metrcTransactions = pgTable(
  'metrc_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: 'restrict' }),
    metrcReceiptId: text('metrc_receipt_id'),
    packageTags: text('package_tags').array().notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'date' }),
    status: metrcStatus('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    /**
     * Earliest wall-clock time the reporting worker is allowed to attempt
     * this row. Drives the 1m/5m/15m/1h/6h/24h backoff schedule per
     * DankDash-Technical-Spec.md §7.2: on each transient failure the
     * worker increments `retryCount` and pushes `nextRetryAt` forward by
     * the matching delay; on a successful claim the worker also pushes
     * `nextRetryAt` forward by the lease window so a parallel claim by
     * another worker pod cannot double-fire if this one crashes
     * mid-attempt. Default `NOW()` so a freshly-inserted row is
     * immediately due.
     */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    responsePayload: jsonb('response_payload'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('metrc_transactions_due_idx')
      .on(table.nextRetryAt)
      .where(sql`${table.status} = 'pending'`),
    index('metrc_transactions_failed_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} = 'failed'`),
  ],
);

export const ageVerifications = pgTable(
  'age_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    context: verificationContext('context').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    provider: text('provider').notNull(),
    providerSessionId: text('provider_session_id').notNull(),
    passed: boolean('passed').notNull(),
    passedAt: timestamp('passed_at', { withTimezone: true, mode: 'date' }),
    failureReason: text('failure_reason'),
    scanImageKey: text('scan_image_key'),
    selfieImageKey: text('selfie_image_key'),
    documentDobValue: date('document_dob_value'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('age_verifications_user_idx').on(table.userId, table.createdAt),
    index('age_verifications_order_idx')
      .on(table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    // Webhook idempotency: a Veriff retry storm on the same verification
    // re-inserts the same (provider, provider_session_id) pair, which the
    // repository handles via ON CONFLICT DO NOTHING.
    unique('age_verifications_provider_session_unique').on(table.provider, table.providerSessionId),
  ],
);

export type ComplianceCheck = typeof complianceChecks.$inferSelect;
export type NewComplianceCheck = typeof complianceChecks.$inferInsert;
export type MetrcTransaction = typeof metrcTransactions.$inferSelect;
export type NewMetrcTransaction = typeof metrcTransactions.$inferInsert;
export type AgeVerification = typeof ageVerifications.$inferSelect;
export type NewAgeVerification = typeof ageVerifications.$inferInsert;

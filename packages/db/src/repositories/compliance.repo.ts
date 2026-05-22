import { RepositoryError } from '@dankdash/types';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  ageVerifications,
  complianceChecks,
  metrcTransactions,
  type AgeVerification,
  type ComplianceCheck,
  type MetrcTransaction,
  type NewAgeVerification,
  type NewComplianceCheck,
  type NewMetrcTransaction,
} from '../schema/compliance.js';
import {
  type ComplianceCheckType,
  type MetrcStatus,
  type VerificationContext,
} from '../schema/enums.js';
import { BaseRepository, newId } from './base.js';

export class ComplianceChecksRepository extends BaseRepository {
  /**
   * Records the outcome of a single compliance evaluation. The full payload —
   * including individual rule results — is stored in `details` so that an
   * auditor can later reconstruct exactly which rules ran and why.
   */
  async record(
    input: Omit<NewComplianceCheck, 'id'> & { readonly id?: string },
  ): Promise<ComplianceCheck> {
    const [row] = await this.db
      .insert(complianceChecks)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('compliance_checks insert returned no row');
    return row;
  }

  async listForSubject(
    subjectType: string,
    subjectId: string,
    limit = 50,
  ): Promise<readonly ComplianceCheck[]> {
    return this.db
      .select()
      .from(complianceChecks)
      .where(
        and(
          eq(complianceChecks.subjectType, subjectType),
          eq(complianceChecks.subjectId, subjectId),
        ),
      )
      .orderBy(desc(complianceChecks.performedAt))
      .limit(limit);
  }

  async latestForSubject(
    subjectType: string,
    subjectId: string,
    checkType: ComplianceCheckType,
  ): Promise<ComplianceCheck | null> {
    const [row] = await this.db
      .select()
      .from(complianceChecks)
      .where(
        and(
          eq(complianceChecks.subjectType, subjectType),
          eq(complianceChecks.subjectId, subjectId),
          eq(complianceChecks.checkType, checkType),
        ),
      )
      .orderBy(desc(complianceChecks.performedAt))
      .limit(1);
    return row ?? null;
  }
}

export class MetrcTransactionsRepository extends BaseRepository {
  async findById(id: string): Promise<MetrcTransaction | null> {
    const [row] = await this.db
      .select()
      .from(metrcTransactions)
      .where(eq(metrcTransactions.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByOrderId(orderId: string): Promise<MetrcTransaction | null> {
    const [row] = await this.db
      .select()
      .from(metrcTransactions)
      .where(eq(metrcTransactions.orderId, orderId))
      .limit(1);
    return row ?? null;
  }

  async listByStatus(status: MetrcStatus, limit = 200): Promise<readonly MetrcTransaction[]> {
    return this.db
      .select()
      .from(metrcTransactions)
      .where(eq(metrcTransactions.status, status))
      .orderBy(metrcTransactions.createdAt)
      .limit(limit);
  }

  /**
   * Receipts the Metrc reconciliation cron compares against
   * `/sales/v2/receipts/active`. Returns every row that crossed Metrc
   * inside the window — `reported` rows we are still confirming and
   * `reconciled` rows we have already matched (so the cron is
   * idempotent and a re-run produces the same membership). Bounded by
   * `reportedAt`, not `createdAt`, because the cron compares against
   * Metrc's `lastModified` window.
   */
  async listReportedSince(since: Date, until: Date): Promise<readonly MetrcTransaction[]> {
    return this.db
      .select()
      .from(metrcTransactions)
      .where(
        and(
          inArray(metrcTransactions.status, ['reported', 'reconciled']),
          gte(metrcTransactions.reportedAt, since),
          lte(metrcTransactions.reportedAt, until),
        ),
      )
      .orderBy(asc(metrcTransactions.reportedAt));
  }

  async create(
    input: Omit<NewMetrcTransaction, 'id'> & { readonly id?: string },
  ): Promise<MetrcTransaction> {
    const [row] = await this.db
      .insert(metrcTransactions)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('metrc_transactions insert returned no row');
    return row;
  }

  /**
   * Atomically reserves up to `limit` pending rows whose `next_retry_at`
   * has elapsed, advancing each one's `next_retry_at` by `leaseMs` so a
   * concurrent claim by another worker pod cannot re-pick the same row.
   * The lease is the safety net for worker crashes: if this worker dies
   * before reporting outcome, the next cron tick after the lease window
   * re-claims the row and tries again. `SELECT … FOR UPDATE SKIP LOCKED`
   * inside the tx means competing claimers walk past locked rows
   * instead of stacking up behind them.
   *
   * Caller responsibility: every claimed row MUST be terminated by one
   * of `markReported`, `scheduleRetry`, or `markFailedTerminal` before
   * the lease elapses — otherwise the row remains in `pending` and
   * another worker re-claims it after the lease, doubling the upstream
   * call. The reporting job's per-row timeout is configured tighter
   * than the lease for exactly this reason.
   */
  async claimDueForReporting(
    now: Date,
    limit: number,
    leaseMs: number,
  ): Promise<readonly MetrcTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RepositoryError(
        `claimDueForReporting: limit must be a positive integer, got ${String(limit)}`,
      );
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new RepositoryError(
        `claimDueForReporting: leaseMs must be a positive integer, got ${String(leaseMs)}`,
      );
    }
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(metrcTransactions)
        .where(
          and(eq(metrcTransactions.status, 'pending'), lte(metrcTransactions.nextRetryAt, now)),
        )
        .orderBy(asc(metrcTransactions.nextRetryAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (locked.length === 0) return [];
      const ids = locked.map((r) => r.id);
      const leaseUntil = new Date(now.getTime() + leaseMs);
      await tx
        .update(metrcTransactions)
        .set({ nextRetryAt: leaseUntil, updatedAt: now })
        .where(inArray(metrcTransactions.id, ids));
      // Surface the leased value to the caller so the worker's logs and
      // the test harness can assert on the new schedule directly.
      return locked.map((row) => ({ ...row, nextRetryAt: leaseUntil, updatedAt: now }));
    });
  }

  /**
   * Records a successful Metrc submission. Sets `status='reported'`,
   * `reportedAt`, and the raw response payload. Metrc's
   * `POST /sales/v2/receipts` returns 200 with an empty body and does
   * not echo the freshly-minted receipt id — discovery is the
   * reconciliation cron's job, via `/sales/v2/receipts/active` on a
   * window bounded by `reportedAt`. We deliberately leave
   * `metricReceiptId` NULL here and let `markReconciled` fill it.
   *
   * Also clears `failureReason` so a subsequent admin view of the row
   * does not show a stale error from a prior retry.
   */
  async markReported(
    id: string,
    responsePayload: unknown,
    reportedAt = new Date(),
  ): Promise<MetrcTransaction | null> {
    const [row] = await this.db
      .update(metrcTransactions)
      .set({
        status: 'reported',
        responsePayload,
        reportedAt,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(metrcTransactions.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Records a transient Metrc failure and schedules the next attempt.
   * The row stays in `pending` — the backoff is encoded by pushing
   * `nextRetryAt` forward, not by flipping status. Increments
   * `retryCount` atomically so the worker's backoff-schedule lookup
   * sees the new attempt count on the next claim.
   */
  async scheduleRetry(
    id: string,
    nextRetryAt: Date,
    failureReason: string,
    responsePayload?: unknown,
  ): Promise<MetrcTransaction | null> {
    const patch: Partial<NewMetrcTransaction> = {};
    if (responsePayload !== undefined) {
      patch.responsePayload = responsePayload;
    }
    const [row] = await this.db
      .update(metrcTransactions)
      .set({
        ...patch,
        failureReason,
        nextRetryAt,
        retryCount: sql`${metrcTransactions.retryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(metrcTransactions.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Terminal failure — the worker exhausted the backoff schedule, or
   * the Metrc response was non-retryable (4xx). Status flips to
   * `failed`; admin alerting watches `metrc_transactions_failed_idx`.
   * Also increments `retryCount` so the value reflects total attempts
   * including the final one.
   */
  async markFailedTerminal(
    id: string,
    failureReason: string,
    responsePayload?: unknown,
  ): Promise<MetrcTransaction | null> {
    const patch: Partial<NewMetrcTransaction> = {};
    if (responsePayload !== undefined) {
      patch.responsePayload = responsePayload;
    }
    const [row] = await this.db
      .update(metrcTransactions)
      .set({
        ...patch,
        status: 'failed',
        failureReason,
        retryCount: sql`${metrcTransactions.retryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(metrcTransactions.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Records the outcome of the reconciliation cron matching a reported
   * row to an upstream Metrc receipt discovered via
   * `/sales/v2/receipts/active`. Sets `status='reconciled'` and stamps
   * the Metrc-assigned receipt id onto the row so admin views can
   * cross-link an order to its receipt without re-querying Metrc.
   *
   * `receiptId` is required — if reconciliation cannot identify the
   * receipt, the row stays in `reported` until the next cron tick. The
   * spec calls out emailing discrepancies to admin after the 7-day
   * window elapses without a match (Phase 11.4).
   */
  async markReconciled(id: string, receiptId: string): Promise<MetrcTransaction | null> {
    if (receiptId.length === 0) {
      throw new RepositoryError('markReconciled: receiptId must be a non-empty string');
    }
    const [row] = await this.db
      .update(metrcTransactions)
      .set({ status: 'reconciled', metrcReceiptId: receiptId, updatedAt: new Date() })
      .where(eq(metrcTransactions.id, id))
      .returning();
    return row ?? null;
  }
}

export class AgeVerificationsRepository extends BaseRepository {
  async findById(id: string): Promise<AgeVerification | null> {
    const [row] = await this.db
      .select()
      .from(ageVerifications)
      .where(eq(ageVerifications.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByProviderSessionId(
    provider: string,
    providerSessionId: string,
  ): Promise<AgeVerification | null> {
    const [row] = await this.db
      .select()
      .from(ageVerifications)
      .where(
        and(
          eq(ageVerifications.provider, provider),
          eq(ageVerifications.providerSessionId, providerSessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listForUser(userId: string, limit = 50): Promise<readonly AgeVerification[]> {
    return this.db
      .select()
      .from(ageVerifications)
      .where(eq(ageVerifications.userId, userId))
      .orderBy(desc(ageVerifications.createdAt))
      .limit(limit);
  }

  /**
   * Latest passing verification for a user in a given context. Used at
   * delivery handoff to confirm a fresh ID scan exists for the order, and
   * by signup to detect a previously-completed KYC.
   */
  async latestPassed(
    userId: string,
    context: VerificationContext,
  ): Promise<AgeVerification | null> {
    const [row] = await this.db
      .select()
      .from(ageVerifications)
      .where(
        and(
          eq(ageVerifications.userId, userId),
          eq(ageVerifications.context, context),
          eq(ageVerifications.passed, true),
        ),
      )
      .orderBy(desc(ageVerifications.passedAt))
      .limit(1);
    return row ?? null;
  }

  async findForOrder(orderId: string): Promise<AgeVerification | null> {
    const [row] = await this.db
      .select()
      .from(ageVerifications)
      .where(and(eq(ageVerifications.orderId, orderId), eq(ageVerifications.passed, true)))
      .orderBy(desc(ageVerifications.passedAt))
      .limit(1);
    return row ?? null;
  }

  async record(
    input: Omit<NewAgeVerification, 'id'> & { readonly id?: string },
  ): Promise<AgeVerification> {
    const [row] = await this.db
      .insert(ageVerifications)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('age_verifications insert returned no row');
    return row;
  }
}

import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, sql } from 'drizzle-orm';
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
   * Records a successful Metrc submission. Sets `status='reported'`,
   * `reported_at`, and the receipt id returned by the Metrc API.
   */
  async markReported(
    id: string,
    receiptId: string,
    responsePayload: unknown,
    reportedAt = new Date(),
  ): Promise<MetrcTransaction | null> {
    const [row] = await this.db
      .update(metrcTransactions)
      .set({
        status: 'reported',
        metrcReceiptId: receiptId,
        responsePayload,
        reportedAt,
        updatedAt: new Date(),
      })
      .where(eq(metrcTransactions.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Records a Metrc submission failure and atomically increments the retry
   * counter. The worker process inspects `retryCount` to decide between
   * exponential backoff and escalation to the on-call queue.
   */
  async markFailed(
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

  async markReconciled(id: string): Promise<MetrcTransaction | null> {
    const [row] = await this.db
      .update(metrcTransactions)
      .set({ status: 'reconciled', updatedAt: new Date() })
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

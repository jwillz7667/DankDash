import { RepositoryError } from '@dankdash/types';
import { and, desc, eq } from 'drizzle-orm';
import { auditLog, type AuditLogEntry, type NewAuditLogEntry } from '../schema/audit.js';
import { BaseRepository, newId } from './base.js';

/**
 * Append-only repository for the SOC-2 / regulator audit trail. The
 * underlying `audit_log` table is partitioned monthly on `occurred_at` and
 * guarded by a BEFORE UPDATE OR DELETE trigger — no row can be mutated or
 * removed once written. Queries should always filter by resource or actor
 * AND a date range to keep partition pruning effective.
 */
export class AuditLogRepository extends BaseRepository {
  async record(
    input: Omit<NewAuditLogEntry, 'id'> & { readonly id?: string },
  ): Promise<AuditLogEntry> {
    const [row] = await this.db
      .insert(auditLog)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('audit_log insert returned no row');
    return row;
  }

  async listForResource(
    resourceType: string,
    resourceId: string,
    limit = 200,
  ): Promise<readonly AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceType, resourceType), eq(auditLog.resourceId, resourceId)))
      .orderBy(desc(auditLog.occurredAt))
      .limit(limit);
  }

  async listForActor(actorUserId: string, limit = 200): Promise<readonly AuditLogEntry[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, actorUserId))
      .orderBy(desc(auditLog.occurredAt))
      .limit(limit);
  }
}

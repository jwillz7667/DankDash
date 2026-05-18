import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inet } from './custom-types.js';
import { users } from './identity.js';

/**
 * Partitioned by month on `occurred_at`. PK is `(id, occurred_at)` to satisfy
 * Postgres's partitioned-table PK rule. The partition declaration lives in
 * raw migration SQL.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').notNull().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  changes: jsonb('changes'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

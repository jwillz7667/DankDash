import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Idempotency record for inbound provider webhooks.
 *
 * The webhook controller inserts a row keyed by the provider-assigned
 * `eventId` before applying side effects. A primary-key conflict on
 * re-delivery short-circuits the request to a 204 so Aeropay's retry
 * queue drains without re-running the handler. Rows are TTL'd at 30 days
 * via the nightly cleanup job in apps/workers — `expires_at` carries the
 * deadline; the index keeps the purge selective.
 *
 * `event_id` is the PK because Aeropay event ids are globally unique. The
 * `provider` column is recorded for observability and lets a future second
 * provider land as a column-default migration rather than a PK rewrite.
 */
export const webhookEventsProcessed = pgTable(
  'webhook_events_processed',
  {
    eventId: text('event_id').primaryKey(),
    provider: text('provider').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('webhook_events_processed_expires_at_idx').on(table.expiresAt)],
);

export type WebhookEventProcessed = typeof webhookEventsProcessed.$inferSelect;
export type NewWebhookEventProcessed = typeof webhookEventsProcessed.$inferInsert;

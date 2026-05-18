import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { notificationChannel } from './enums.js';
import { users } from './identity.js';

/**
 * Partitioned by month on `created_at`. The PK is `(id, created_at)` since
 * Postgres requires the partition key in every unique constraint on a
 * partitioned table — note this deviates from spec.sql which declares
 * `id PRIMARY KEY` alone (which Postgres would reject). The partition
 * itself is created in raw migration SQL.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    templateKey: text('template_key').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    providerRef: text('provider_ref'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  () => [
    // PK and partition declared in raw migration SQL.
  ],
);

export const pushTokens = pgTable(
  'push_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    apnsToken: text('apns_token').notNull(),
    platform: text('platform').notNull(),
    appVariant: text('app_variant').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('push_tokens_user_device_app_uq').on(table.userId, table.deviceId, table.appVariant),
    index('push_tokens_active_idx')
      .on(table.userId)
      .where(sql`${table.isActive} = true`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;

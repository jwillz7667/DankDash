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

/**
 * Per-user notification delivery preferences — exactly one row per user
 * (enforced by the unique on `user_id`). The model is two-axis:
 *
 *   • category axis — `order_updates_enabled`, `promotions_enabled`. These
 *     are the only user-suppressible categories. Transactional/operational
 *     notifications (payment, refund, auth, driver dispatch, vendor ops)
 *     are never gated by this table; see `SUPPRESSIBLE_CATEGORIES` in
 *     @dankdash/notifications.
 *   • channel axis — `push_enabled`, `sms_enabled`, `email_enabled`. The
 *     `in_app` channel is intentionally absent: it is the in-app inbox
 *     record and is always written, so it has no toggle.
 *
 * A delivery is suppressed only when its category is suppressible AND the
 * user has turned off either that category or that channel. Absence of a
 * row means "all defaults" (everything on) — the dispatcher treats a
 * missing row as deliver-everything so users who never opened settings are
 * unaffected. Every column defaults to `true` for the same reason: a fresh
 * insert that only flips one toggle leaves the rest opted-in.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  orderUpdatesEnabled: boolean('order_updates_enabled').notNull().default(true),
  promotionsEnabled: boolean('promotions_enabled').notNull().default(true),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  smsEnabled: boolean('sms_enabled').notNull().default(true),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;

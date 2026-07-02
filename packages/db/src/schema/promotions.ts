import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext } from './custom-types.js';
import { dispensaries } from './dispensaries.js';
import { promoCodeScope, promoCodeType } from './enums.js';
import { users } from './identity.js';
import { orders } from './orders.js';

/**
 * Discount / promo codes — DoorDash-style, either platform-funded (global,
 * `dispensary_id` null) or dispensary-funded (scoped to one store). The
 * funding source is the `scope`: a platform code reduces the platform's
 * revenue at settlement, a dispensary code reduces that dispensary's payout.
 *
 * `code` is `citext` so lookups are case-insensitive and the unique index
 * makes `SAVE10` and `save10` the same coupon. Type-specific value semantics
 * (percent 1..100, fixed amount in cents, free delivery = 0) and the
 * scope↔dispensary_id coupling are enforced by CHECK constraints so a bad row
 * can never reach the evaluator.
 */
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: citext('code').notNull(),
    type: promoCodeType('type').notNull(),
    /** percent: 1..100; fixed_amount: cents > 0; free_delivery: 0. */
    value: integer('value').notNull(),
    scope: promoCodeScope('scope').notNull(),
    dispensaryId: uuid('dispensary_id').references(() => dispensaries.id, { onDelete: 'cascade' }),
    minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
    maxDiscountCents: integer('max_discount_cents'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    maxRedemptions: integer('max_redemptions'),
    maxRedemptionsPerUser: integer('max_redemptions_per_user').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('promo_codes_code_uq').on(table.code),
    // scope is the funding source; a dispensary-scoped code must name its
    // dispensary and a platform code must not.
    check(
      'promo_codes_scope_dispensary',
      sql`(${table.scope} = 'dispensary') = (${table.dispensaryId} IS NOT NULL)`,
    ),
    check(
      'promo_codes_value_by_type',
      sql`(${table.type} = 'percent' AND ${table.value} BETWEEN 1 AND 100)
            OR (${table.type} = 'fixed_amount' AND ${table.value} > 0)
            OR (${table.type} = 'free_delivery' AND ${table.value} = 0)`,
    ),
    check('promo_codes_min_subtotal_nonneg', sql`${table.minSubtotalCents} >= 0`),
    check(
      'promo_codes_max_discount_positive',
      sql`${table.maxDiscountCents} IS NULL OR ${table.maxDiscountCents} > 0`,
    ),
    check(
      'promo_codes_max_redemptions_positive',
      sql`${table.maxRedemptions} IS NULL OR ${table.maxRedemptions} > 0`,
    ),
    check('promo_codes_max_per_user_positive', sql`${table.maxRedemptionsPerUser} > 0`),
    check(
      'promo_codes_window',
      sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
    // Vendor "my promotions" list scopes by dispensary; partial keeps the
    // index off the platform-code rows.
    index('promo_codes_dispensary_idx')
      .on(table.dispensaryId)
      .where(sql`${table.dispensaryId} IS NOT NULL`),
  ],
);

/**
 * One row per successful redemption, written inside the checkout transaction
 * that creates the order. `order_id` is UNIQUE so a promo applies at most once
 * per order; redemption counts (global + per-user) are aggregated off this
 * table under the promo row lock at checkout, making the caps race-free.
 *
 * FKs are `RESTRICT`: a promo or order with redemption history cannot be hard
 * deleted out from under the audit trail (promos deactivate, orders tombstone).
 */
export const promoRedemptions = pgTable(
  'promo_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoId: uuid('promo_id')
      .notNull()
      .references(() => promoCodes.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    amountAppliedCents: integer('amount_applied_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('promo_redemptions_order_uq').on(table.orderId),
    check('promo_redemptions_amount_nonneg', sql`${table.amountAppliedCents} >= 0`),
    index('promo_redemptions_promo_user_idx').on(table.promoId, table.userId),
    index('promo_redemptions_promo_idx').on(table.promoId),
  ],
);

export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;
export type PromoRedemption = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemption = typeof promoRedemptions.$inferInsert;

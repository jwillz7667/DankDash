import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { dispensaryListings } from './catalog.js';
import { dispensaries } from './dispensaries.js';
import { orderStatus } from './enums.js';
import { userAddresses, users } from './identity.js';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortCode: text('short_code').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    dispensaryId: uuid('dispensary_id')
      .notNull()
      .references(() => dispensaries.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id').references(() => users.id, { onDelete: 'restrict' }),
    deliveryAddressId: uuid('delivery_address_id')
      .notNull()
      .references(() => userAddresses.id, { onDelete: 'restrict' }),

    status: orderStatus('status').notNull().default('placed'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    subtotalCents: integer('subtotal_cents').notNull(),
    cannabisTaxCents: integer('cannabis_tax_cents').notNull(),
    salesTaxCents: integer('sales_tax_cents').notNull(),
    deliveryFeeCents: integer('delivery_fee_cents').notNull(),
    driverTipCents: integer('driver_tip_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),

    complianceCheckPayload: jsonb('compliance_check_payload').notNull(),
    deliveryAddressSnapshot: jsonb('delivery_address_snapshot').notNull(),

    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    preparedAt: timestamp('prepared_at', { withTimezone: true, mode: 'date' }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    canceledAt: timestamp('canceled_at', { withTimezone: true, mode: 'date' }),
    canceledBy: uuid('canceled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),

    deliveryIdScanRef: text('delivery_id_scan_ref'),
    deliveryIdScanPassed: boolean('delivery_id_scan_passed'),
    deliveryIdScanAt: timestamp('delivery_id_scan_at', { withTimezone: true, mode: 'date' }),

    customerRating: smallint('customer_rating'),
    customerReview: text('customer_review'),
    dispensaryRating: smallint('dispensary_rating'),
    driverRating: smallint('driver_rating'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'orders_total_matches',
      sql`${table.totalCents} = ${table.subtotalCents} + ${table.cannabisTaxCents} + ${table.salesTaxCents}
            + ${table.deliveryFeeCents} + ${table.driverTipCents} - ${table.discountCents}`,
    ),
    check(
      'orders_rating_range',
      sql`(${table.customerRating} IS NULL OR ${table.customerRating} BETWEEN 1 AND 5)
            AND (${table.dispensaryRating} IS NULL OR ${table.dispensaryRating} BETWEEN 1 AND 5)
            AND (${table.driverRating} IS NULL OR ${table.driverRating} BETWEEN 1 AND 5)`,
    ),
    index('orders_user_placed_idx').on(table.userId, table.placedAt),
    index('orders_dispensary_status_idx').on(table.dispensaryId, table.status, table.placedAt),
    index('orders_driver_idx')
      .on(table.driverId)
      .where(sql`${table.driverId} IS NOT NULL`),
    index('orders_status_idx').on(table.status, table.placedAt),
    index('orders_active_idx')
      .on(table.placedAt)
      .where(sql`${table.status} NOT IN ('delivered','canceled','rejected')`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => dispensaryListings.id, { onDelete: 'restrict' }),
    productSnapshot: jsonb('product_snapshot').notNull(),
    metrcPackageTag: text('metrc_package_tag'),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    lineSubtotalCents: integer('line_subtotal_cents').notNull(),
    thcMgTotal: numeric('thc_mg_total', { precision: 12, scale: 3 }).notNull(),
    cbdMgTotal: numeric('cbd_mg_total', { precision: 12, scale: 3 }).notNull().default('0'),
    weightGramsTotal: numeric('weight_grams_total', { precision: 12, scale: 3 })
      .notNull()
      .default('0'),
    cannabisTaxCents: integer('cannabis_tax_cents').notNull(),
    salesTaxCents: integer('sales_tax_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('order_items_qty_positive', sql`${table.quantity} > 0`),
    index('order_items_order_idx').on(table.orderId),
    index('order_items_listing_idx').on(table.listingId),
  ],
);

/**
 * Append-only event log. Partitioned by month on `occurred_at`; the
 * primary key is `(id, occurred_at)` because every Postgres partitioned
 * table's PK must include the partition key.
 *
 * Drizzle does not natively emit `PARTITION BY` clauses today, so the
 * table is **defined in raw migration SQL** rather than via `pgTable`.
 * This export carries the column shape for the repository layer.
 */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').notNull().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorRole: text('actor_role'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  () => [
    // PK and partition declared in raw migration SQL. Index for repo lookups.
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type NewOrderEvent = typeof orderEvents.$inferInsert;

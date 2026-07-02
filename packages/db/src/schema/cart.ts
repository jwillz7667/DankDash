import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { dispensaryListings } from './catalog.js';
import { dispensaries } from './dispensaries.js';
import { users } from './identity.js';
import { promoCodes } from './promotions.js';

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dispensaryId: uuid('dispensary_id')
      .notNull()
      .references(() => dispensaries.id, { onDelete: 'cascade' }),
    // Applied promo, if any. `SET NULL` on delete so deactivating/removing a
    // promo never blocks on live carts — checkout re-validates authoritatively
    // regardless of what is attached here.
    promoCodeId: uuid('promo_code_id').references(() => promoCodes.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`(NOW() + interval '4 hours')`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('carts_user_dispensary_uq').on(table.userId, table.dispensaryId),
    index('carts_user_idx').on(table.userId),
    index('carts_expires_idx').on(table.expiresAt),
  ],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => dispensaryListings.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('cart_items_cart_listing_uq').on(table.cartId, table.listingId),
    check('cart_items_qty_positive', sql`${table.quantity} > 0`),
    index('cart_items_cart_idx').on(table.cartId),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

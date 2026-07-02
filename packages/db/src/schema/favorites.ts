import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { products } from './catalog.js';
import { dispensaries } from './dispensaries.js';
import { favoritableType } from './enums.js';
import { users } from './identity.js';

/**
 * Consumer favorites — the "saved dispensaries / products" list behind
 * `/v1/me/favorites`. One polymorphic table rather than two junction tables so
 * the Favorites feed reads from a single reverse-chronological source without a
 * UNION; the exclusive-arc keeps full referential integrity on both target
 * types.
 *
 * `favoritable_type` is the discriminator; `dispensary_id` / `product_id` are
 * the two arms. The CHECK constraint forces exactly one arm populated and
 * matching the discriminator, so a row can never point at both — or neither —
 * target. Both arms keep a real FK (ON DELETE CASCADE): favorites are
 * disposable derived data, so a hard-deleted target simply drops its saves.
 * Soft-deleted / inactive targets survive the FK but are filtered out at read
 * time (same 404 semantics the catalog + dispensary read paths already apply).
 *
 * `user_id` cascades with the account. The two partial unique indexes make a
 * save idempotent per (user, target) so a double-tap on the heart is a no-op,
 * and the feed index serves the only list query — newest-saved first, scoped
 * to the owner.
 */
export const userFavorites = pgTable(
  'user_favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    favoritableType: favoritableType('favoritable_type').notNull(),
    dispensaryId: uuid('dispensary_id').references(() => dispensaries.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'user_favorites_exclusive_arc',
      sql`(${table.favoritableType} = 'dispensary' AND ${table.dispensaryId} IS NOT NULL AND ${table.productId} IS NULL)
        OR (${table.favoritableType} = 'product' AND ${table.productId} IS NOT NULL AND ${table.dispensaryId} IS NULL)`,
    ),
    uniqueIndex('user_favorites_user_dispensary_uniq')
      .on(table.userId, table.dispensaryId)
      .where(sql`${table.dispensaryId} IS NOT NULL`),
    uniqueIndex('user_favorites_user_product_uniq')
      .on(table.userId, table.productId)
      .where(sql`${table.productId} IS NOT NULL`),
    // DESC ordering on (created_at, id) is emitted in the raw migration; the
    // declaration here exists for drizzle-kit parity, not as the source of truth.
    index('user_favorites_user_feed_idx').on(table.userId, table.createdAt, table.id),
  ],
);

export type UserFavorite = typeof userFavorites.$inferSelect;
export type NewUserFavorite = typeof userFavorites.$inferInsert;

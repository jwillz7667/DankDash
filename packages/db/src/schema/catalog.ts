import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tsvector } from './custom-types.js';
import { dispensaries } from './dispensaries.js';
import { productType, strainType } from './enums.js';

export const productCategories = pgTable('product_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => productCategories.id),
  displayOrder: integer('display_order').notNull().default(0),
  iconKey: text('icon_key'),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => productCategories.id),
    brand: text('brand').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    productType: productType('product_type').notNull(),
    strainType: strainType('strain_type'),
    thcMgPerUnit: numeric('thc_mg_per_unit', { precision: 10, scale: 3 }).notNull(),
    cbdMgPerUnit: numeric('cbd_mg_per_unit', { precision: 10, scale: 3 }).notNull().default('0'),
    weightGramsPerUnit: numeric('weight_grams_per_unit', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    servingCount: integer('serving_count'),
    thcMgPerServing: numeric('thc_mg_per_serving', { precision: 10, scale: 3 }),
    imageKeys: text('image_keys')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    searchVector: tsvector('search_vector'),
    effectsTags: text('effects_tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    flavorTags: text('flavor_tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('products_thc_nonnegative', sql`${table.thcMgPerUnit} >= 0`),
    check('products_cbd_nonnegative', sql`${table.cbdMgPerUnit} >= 0`),
    check('products_weight_nonnegative', sql`${table.weightGramsPerUnit} >= 0`),
    check(
      'products_beverage_potency_cap',
      sql`${table.productType} != 'beverage' OR ${table.thcMgPerServing} <= 10`,
    ),
    check(
      'products_beverage_serving_cap',
      sql`${table.productType} != 'beverage' OR ${table.servingCount} <= 2`,
    ),
    index('products_category_idx')
      .on(table.categoryId)
      .where(sql`${table.isActive} = true`),
    index('products_type_idx')
      .on(table.productType)
      .where(sql`${table.isActive} = true`),
    // GIN(search_vector) index emitted from raw migration SQL.
  ],
);

export const dispensaryListings = pgTable(
  'dispensary_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dispensaryId: uuid('dispensary_id')
      .notNull()
      .references(() => dispensaries.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    priceCents: integer('price_cents').notNull(),
    compareAtPriceCents: integer('compare_at_price_cents'),
    quantityAvailable: integer('quantity_available').notNull().default(0),
    // Per-listing image override. When non-empty, the public menu renders
    // these R2 object keys instead of the shared `products.image_keys`; an
    // empty array falls back to the canonical product photos. This lets a
    // vendor upload its own shots of the product it carries without mutating
    // the global catalog (which is admin-owned). Keys live under the
    // dispensary's own prefix — see VendorListingUploadsService.
    imageKeys: text('image_keys')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    metrcPackageTag: text('metrc_package_tag'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('dispensary_listings_disp_sku_uq').on(table.dispensaryId, table.sku),
    check('dispensary_listings_price_positive', sql`${table.priceCents} > 0`),
    check('dispensary_listings_qty_nonnegative', sql`${table.quantityAvailable} >= 0`),
    index('dispensary_listings_dispensary_active_idx')
      .on(table.dispensaryId, table.isActive)
      .where(sql`${table.quantityAvailable} > 0`),
    index('dispensary_listings_product_idx').on(table.productId),
  ],
);

export const productLabResults = pgTable(
  'product_lab_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    batchId: text('batch_id').notNull(),
    labName: text('lab_name').notNull(),
    coaDocumentKey: text('coa_document_key'),
    potencyThc: numeric('potency_thc', { precision: 6, scale: 3 }),
    potencyCbd: numeric('potency_cbd', { precision: 6, scale: 3 }),
    contaminantsPassed: boolean('contaminants_passed'),
    testedAt: date('tested_at').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [unique('product_lab_results_product_batch_uq').on(table.productId, table.batchId)],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type DispensaryListing = typeof dispensaryListings.$inferSelect;
export type NewDispensaryListing = typeof dispensaryListings.$inferInsert;
export type ProductLabResult = typeof productLabResults.$inferSelect;
export type NewProductLabResult = typeof productLabResults.$inferInsert;

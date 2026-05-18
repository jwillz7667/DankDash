import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import {
  dispensaryListings,
  productCategories,
  productLabResults,
  products,
  type DispensaryListing,
  type NewDispensaryListing,
  type NewProduct,
  type NewProductCategory,
  type NewProductLabResult,
  type Product,
  type ProductCategory,
  type ProductLabResult,
} from '../schema/catalog.js';
import { BaseRepository, newId } from './base.js';
import type { StrainType } from '../schema/enums.js';

export class ProductCategoriesRepository extends BaseRepository {
  async findById(id: string): Promise<ProductCategory | null> {
    const [row] = await this.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.id, id))
      .limit(1);
    return row ?? null;
  }

  async findBySlug(slug: string): Promise<ProductCategory | null> {
    const [row] = await this.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.slug, slug))
      .limit(1);
    return row ?? null;
  }

  async listAll(): Promise<readonly ProductCategory[]> {
    return this.db.select().from(productCategories).orderBy(productCategories.displayOrder);
  }

  async create(
    input: Omit<NewProductCategory, 'id'> & { readonly id?: string },
  ): Promise<ProductCategory> {
    const [row] = await this.db
      .insert(productCategories)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('product_categories insert returned no row');
    return row;
  }
}

export class ProductsRepository extends BaseRepository {
  async findById(id: string): Promise<Product | null> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    return row ?? null;
  }

  async listByCategory(categoryId: string): Promise<readonly Product[]> {
    return this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.categoryId, categoryId),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      );
  }

  /**
   * Plain-language search over the `search_vector` GIN index. Uses websearch
   * grammar so callers can pass user-typed queries directly.
   */
  async search(query: string): Promise<readonly Product[]> {
    return this.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.isActive, true),
          isNull(products.deletedAt),
          sql`${products.searchVector} @@ websearch_to_tsquery('english', ${query})`,
        ),
      )
      .orderBy(
        sql`ts_rank(${products.searchVector}, websearch_to_tsquery('english', ${query})) DESC`,
      )
      .limit(50);
  }

  /**
   * Faceted catalog search. Composes the same active/non-deleted filter
   * every public read uses with optional refinements:
   *
   *   - `query`         — websearch_to_tsquery against `search_vector`;
   *                       relevance-ranked when present, brand+name ordered
   *                       when absent so the endpoint still behaves like a
   *                       browse surface for unfiltered calls.
   *   - `categoryId`    — exact category match.
   *   - `strainType`    — exact strain-type enum match.
   *   - `dispensaryId`  — narrows to products carried by the named store
   *                       via a correlated EXISTS against `dispensary_listings`
   *                       (active + in-stock listings only). EXISTS keeps the
   *                       outer row set deduplicated even when a dispensary
   *                       has multiple listings for the same SKU history.
   *
   * The dispensary filter intentionally does not require the dispensary
   * itself to be active — admins listing products by store SKU expect the
   * same result regardless of operational status. Public callers funnel
   * through a service that gates on dispensary state before invoking this.
   *
   * Pagination is a simple offset/limit. The Phase 4.2 endpoint exposes
   * a max page size of 50 to bound the rank computation cost; an explicit
   * cursor design lands when listings cross the 10k-row mark per category
   * (tracked in Phase 4 follow-ups).
   */
  async searchWithFilters(input: {
    readonly query?: string | undefined;
    readonly categoryId?: string | undefined;
    readonly strainType?: StrainType | undefined;
    readonly dispensaryId?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{
    readonly results: readonly Product[];
    readonly total: number;
    readonly categoryFacets: readonly { readonly categoryId: string; readonly count: number }[];
    readonly strainTypeFacets: readonly {
      readonly strainType: StrainType;
      readonly count: number;
    }[];
  }> {
    const filters = this.buildSearchFilters(input);
    const whereClause = and(...filters);

    const orderBy: SQL =
      input.query === undefined
        ? sql`${products.brand}, ${products.name}`
        : sql`ts_rank(${products.searchVector}, websearch_to_tsquery('english', ${input.query})) DESC, ${products.id}`;

    const [rows, totalRows, categoryRows, strainRows] = await Promise.all([
      this.db
        .select()
        .from(products)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(input.limit)
        .offset(input.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(whereClause),
      this.db
        .select({
          categoryId: products.categoryId,
          count: sql<number>`count(*)::int`,
        })
        .from(products)
        .where(whereClause)
        .groupBy(products.categoryId),
      this.db
        .select({
          strainType: products.strainType,
          count: sql<number>`count(*)::int`,
        })
        .from(products)
        .where(and(whereClause, sql`${products.strainType} IS NOT NULL`))
        .groupBy(products.strainType),
    ]);

    return {
      results: rows,
      total: totalRows[0]?.count ?? 0,
      categoryFacets: categoryRows.map((r) => ({ categoryId: r.categoryId, count: r.count })),
      // strainType comes back as `StrainType | null`; the WHERE above filters
      // out nulls so the narrow is safe — assert it to keep the public type
      // strict.
      strainTypeFacets: strainRows
        .filter((r): r is { strainType: StrainType; count: number } => r.strainType !== null)
        .map((r) => ({ strainType: r.strainType, count: r.count })),
    };
  }

  private buildSearchFilters(input: {
    readonly query?: string | undefined;
    readonly categoryId?: string | undefined;
    readonly strainType?: StrainType | undefined;
    readonly dispensaryId?: string | undefined;
  }): readonly SQL[] {
    const filters: SQL[] = [eq(products.isActive, true), isNull(products.deletedAt)];
    if (input.query !== undefined) {
      filters.push(
        sql`${products.searchVector} @@ websearch_to_tsquery('english', ${input.query})`,
      );
    }
    if (input.categoryId !== undefined) {
      filters.push(eq(products.categoryId, input.categoryId));
    }
    if (input.strainType !== undefined) {
      filters.push(eq(products.strainType, input.strainType));
    }
    if (input.dispensaryId !== undefined) {
      filters.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(dispensaryListings)
            .where(
              and(
                eq(dispensaryListings.productId, products.id),
                eq(dispensaryListings.dispensaryId, input.dispensaryId),
                eq(dispensaryListings.isActive, true),
                sql`${dispensaryListings.quantityAvailable} > 0`,
              ),
            ),
        ),
      );
    }
    return filters;
  }

  async create(input: Omit<NewProduct, 'id'> & { readonly id?: string }): Promise<Product> {
    const [row] = await this.db
      .insert(products)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('products insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewProduct, 'id' | 'createdAt'>>,
  ): Promise<Product | null> {
    const [row] = await this.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(products)
      .set({ deletedAt: now, updatedAt: now, isActive: false })
      .where(and(eq(products.id, id), isNull(products.deletedAt)));
  }
}

export class DispensaryListingsRepository extends BaseRepository {
  async findById(id: string): Promise<DispensaryListing | null> {
    const [row] = await this.db
      .select()
      .from(dispensaryListings)
      .where(eq(dispensaryListings.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByDispensaryAndSku(
    dispensaryId: string,
    sku: string,
  ): Promise<DispensaryListing | null> {
    const [row] = await this.db
      .select()
      .from(dispensaryListings)
      .where(
        and(eq(dispensaryListings.dispensaryId, dispensaryId), eq(dispensaryListings.sku, sku)),
      )
      .limit(1);
    return row ?? null;
  }

  async listForDispensary(dispensaryId: string): Promise<readonly DispensaryListing[]> {
    return this.db
      .select()
      .from(dispensaryListings)
      .where(
        and(
          eq(dispensaryListings.dispensaryId, dispensaryId),
          eq(dispensaryListings.isActive, true),
        ),
      );
  }

  /**
   * Vendor surface — every listing the dispensary owns, active or not. Inactive
   * rows are still surfaced so the vendor portal can reactivate them without
   * re-creating from scratch (and re-issuing a SKU collision pre-flight).
   * Sorted by updated-then-created so a recent edit lands at the top.
   */
  async listAllForDispensary(dispensaryId: string): Promise<readonly DispensaryListing[]> {
    return this.db
      .select()
      .from(dispensaryListings)
      .where(eq(dispensaryListings.dispensaryId, dispensaryId))
      .orderBy(desc(dispensaryListings.updatedAt), desc(dispensaryListings.createdAt));
  }

  /**
   * Vendor-scoped read — returns the listing only if it belongs to the given
   * dispensary. Crossing dispensary boundaries returns `null`, which the
   * service translates to a 404 so cross-vendor probing cannot distinguish
   * "this listing does not exist" from "this listing belongs to another
   * dispensary".
   */
  async findByIdForDispensary(id: string, dispensaryId: string): Promise<DispensaryListing | null> {
    const [row] = await this.db
      .select()
      .from(dispensaryListings)
      .where(and(eq(dispensaryListings.id, id), eq(dispensaryListings.dispensaryId, dispensaryId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Public menu read — listings joined to their products in a single round
   * trip, filtered to what a customer can actually buy: active+in-stock
   * listing AND active+non-deleted product. Sorted by product brand then
   * name so the iOS menu screen has stable ordering without re-sorting.
   *
   * The join is server-side rather than two queries + Map merge so the
   * planner can pick the composite `dispensary_listings_dispensary_active_idx`
   * with a hash-join into `products` PK — confirmed via EXPLAIN under the
   * Phase 4.2 integration tests.
   */
  async listMenuForDispensary(
    dispensaryId: string,
  ): Promise<readonly { readonly listing: DispensaryListing; readonly product: Product }[]> {
    const rows = await this.db
      .select({ listing: dispensaryListings, product: products })
      .from(dispensaryListings)
      .innerJoin(products, eq(dispensaryListings.productId, products.id))
      .where(
        and(
          eq(dispensaryListings.dispensaryId, dispensaryId),
          eq(dispensaryListings.isActive, true),
          sql`${dispensaryListings.quantityAvailable} > 0`,
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
      .orderBy(products.brand, products.name);
    return rows;
  }

  async create(
    input: Omit<NewDispensaryListing, 'id'> & { readonly id?: string },
  ): Promise<DispensaryListing> {
    const [row] = await this.db
      .insert(dispensaryListings)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('dispensary_listings insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt'>>,
  ): Promise<DispensaryListing | null> {
    const [row] = await this.db
      .update(dispensaryListings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(dispensaryListings.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Vendor-scoped update — atomic combined existence + ownership check via
   * `WHERE id = ? AND dispensary_id = ?`. Cross-dispensary attempts match
   * zero rows and return `null`, which the service maps to 404 (matching
   * the find behaviour so the response does not distinguish "missing" from
   * "owned by another vendor").
   */
  async updateForDispensary(
    id: string,
    dispensaryId: string,
    patch: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt' | 'dispensaryId'>>,
  ): Promise<DispensaryListing | null> {
    const [row] = await this.db
      .update(dispensaryListings)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(dispensaryListings.id, id), eq(dispensaryListings.dispensaryId, dispensaryId)))
      .returning();
    return row ?? null;
  }

  /**
   * Vendor-scoped soft delete — flips `is_active` to false. The schema has no
   * `deleted_at` column on listings because historical orders reference the
   * row by FK (`ON DELETE RESTRICT`); deletion in this context means the
   * listing leaves the public menu surface and the SKU is released for a new
   * listing to claim. Returns `true` when the row was found and flipped,
   * `false` when no matching row exists for the dispensary.
   */
  async softDeleteForDispensary(id: string, dispensaryId: string): Promise<boolean> {
    // Match only `is_active = true` so a second delete returns false. The
    // vendor service relies on that to surface a typed 404 instead of an
    // idempotent 204 — the API contract says the second call cannot
    // distinguish "already deleted" from "never existed for this vendor".
    const [row] = await this.db
      .update(dispensaryListings)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(dispensaryListings.id, id),
          eq(dispensaryListings.dispensaryId, dispensaryId),
          eq(dispensaryListings.isActive, true),
        ),
      )
      .returning({ id: dispensaryListings.id });
    return row !== undefined;
  }

  /**
   * Atomic conditional decrement — returns the updated row only if there was
   * enough inventory. Returns `null` if the listing is missing or under-stocked.
   * The check happens server-side so concurrent decrements stay race-free.
   */
  async decrementInventory(id: string, quantity: number): Promise<DispensaryListing | null> {
    if (quantity <= 0) throw new RangeError('decrementInventory: quantity must be positive');
    const [row] = await this.db
      .update(dispensaryListings)
      .set({
        quantityAvailable: sql`${dispensaryListings.quantityAvailable} - ${quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dispensaryListings.id, id),
          sql`${dispensaryListings.quantityAvailable} >= ${quantity}`,
        ),
      )
      .returning();
    return row ?? null;
  }
}

export class ProductLabResultsRepository extends BaseRepository {
  async create(
    input: Omit<NewProductLabResult, 'id'> & { readonly id?: string },
  ): Promise<ProductLabResult> {
    const [row] = await this.db
      .insert(productLabResults)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('product_lab_results insert returned no row');
    return row;
  }

  async listForProduct(productId: string): Promise<readonly ProductLabResult[]> {
    return this.db
      .select()
      .from(productLabResults)
      .where(eq(productLabResults.productId, productId))
      .orderBy(desc(productLabResults.testedAt));
  }

  /**
   * Pre-flight duplicate-batch lookup for admin lab-result creation. Matches
   * the unique constraint `product_lab_results_product_batch_uq` so the
   * service can translate a duplicate into a typed 409 before the DB does.
   */
  async findByProductIdAndBatchId(
    productId: string,
    batchId: string,
  ): Promise<ProductLabResult | null> {
    const [row] = await this.db
      .select()
      .from(productLabResults)
      .where(
        and(eq(productLabResults.productId, productId), eq(productLabResults.batchId, batchId)),
      )
      .limit(1);
    return row ?? null;
  }
}

import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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
}

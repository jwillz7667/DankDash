/**
 * Consumer favorites orchestration.
 *
 *   addDispensary / addProduct    — gate the target on the same active-only
 *                                    404 semantics the read paths use, then
 *                                    upsert idempotently. Saving an unknown /
 *                                    tombstoned / inactive target is a 404, so
 *                                    a favorite can never dangle at a target the
 *                                    customer could not otherwise see.
 *   removeDispensary / removeProduct — idempotent unsave. Removing something
 *                                    that isn't saved is a no-op 204, not a 404
 *                                    (the resource is "not favorited" either
 *                                    way).
 *   list                          — one page of the reverse-chron feed, each
 *                                    save hydrated into a card summary through
 *                                    the owning repository (never a cross-domain
 *                                    join). Saves whose target has since gone
 *                                    inactive are dropped from the page.
 *
 * `now` is threaded so the dispensary open/closed projection is deterministic
 * under test; the controller passes `new Date()` at the boundary.
 */
import {
  DispensariesRepository,
  FavoritesRepository,
  ProductsRepository,
  type Dispensary,
  type Product,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectDispensary } from '../dispensaries/dispensaries.service.js';
import type { FavoriteItem, FavoritesQuery, FavoritesResponse } from './dto/index.js';
import type { MenuProductResponse } from '../dispensaries/dto/index.js';

@Injectable()
export class FavoritesService {
  constructor(
    private readonly favorites: FavoritesRepository,
    private readonly dispensaries: DispensariesRepository,
    private readonly products: ProductsRepository,
  ) {}

  async addDispensary(userId: string, dispensaryId: string): Promise<void> {
    const row = await this.dispensaries.findById(dispensaryId);
    if (row?.deletedAt !== null || row.status !== 'active') {
      throw new NotFoundError('Dispensary', dispensaryId);
    }
    await this.favorites.addDispensary(userId, dispensaryId);
  }

  async removeDispensary(userId: string, dispensaryId: string): Promise<void> {
    await this.favorites.removeDispensary(userId, dispensaryId);
  }

  async addProduct(userId: string, productId: string): Promise<void> {
    const row = await this.products.findById(productId);
    if (row?.deletedAt !== null || !row.isActive) {
      throw new NotFoundError('Product', productId);
    }
    await this.favorites.addProduct(userId, productId);
  }

  async removeProduct(userId: string, productId: string): Promise<void> {
    await this.favorites.removeProduct(userId, productId);
  }

  async list(
    userId: string,
    query: FavoritesQuery,
    now: Date = new Date(),
  ): Promise<FavoritesResponse> {
    const page = await this.favorites.listForUser(userId, {
      limit: query.limit,
      offset: query.offset,
    });

    const dispensaryIds = page.rows.flatMap((row) =>
      row.dispensaryId !== null ? [row.dispensaryId] : [],
    );
    const productIds = page.rows.flatMap((row) => (row.productId !== null ? [row.productId] : []));

    const [dispensaries, products] = await Promise.all([
      this.dispensaries.findManyByIds(dispensaryIds),
      this.products.findManyByIds(productIds),
    ]);

    const dispensaryById = new Map<string, Dispensary>(
      dispensaries
        .filter((row) => row.deletedAt === null && row.status === 'active')
        .map((row) => [row.id, row]),
    );
    const productById = new Map<string, Product>(
      products.filter((row) => row.deletedAt === null && row.isActive).map((row) => [row.id, row]),
    );

    const favorites: FavoriteItem[] = [];
    for (const row of page.rows) {
      const favoritedAt = row.createdAt.toISOString();
      if (row.dispensaryId !== null) {
        const dispensary = dispensaryById.get(row.dispensaryId);
        if (dispensary === undefined) continue;
        favorites.push({
          type: 'dispensary',
          favoritedAt,
          dispensary: projectDispensary(dispensary, now),
        });
      } else if (row.productId !== null) {
        const product = productById.get(row.productId);
        if (product === undefined) continue;
        favorites.push({ type: 'product', favoritedAt, product: projectFavoriteProduct(product) });
      }
    }

    return {
      favorites,
      page: { limit: query.limit, offset: query.offset, total: page.total },
    };
  }
}

/**
 * Product → card summary. Mirrors the menu-line product projection but sources
 * `imageKeys` from the canonical `products.image_keys` (a favorite carries no
 * per-dispensary listing context). Lab results are intentionally omitted — the
 * detail screen fetches them via `GET /v1/products/:id`.
 */
function projectFavoriteProduct(product: Product): MenuProductResponse {
  return {
    id: product.id,
    categoryId: product.categoryId,
    brand: product.brand,
    name: product.name,
    description: product.description,
    productType: product.productType,
    strainType: product.strainType,
    thcMgPerUnit: product.thcMgPerUnit,
    cbdMgPerUnit: product.cbdMgPerUnit,
    weightGramsPerUnit: product.weightGramsPerUnit,
    servingCount: product.servingCount,
    thcMgPerServing: product.thcMgPerServing,
    imageKeys: product.imageKeys,
    effectsTags: product.effectsTags,
    flavorTags: product.flavorTags,
  };
}

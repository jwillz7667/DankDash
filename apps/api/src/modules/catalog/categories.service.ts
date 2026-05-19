/**
 * Product category orchestration.
 *
 *   list() — projects every row of `product_categories` into the public
 *            CategoryResponse shape, preserving `display_order` so the
 *            iOS client can render its category tree without re-sorting.
 *
 * Categories are write-once-mostly: the catalog admin adds a category
 * during merchandising and almost never removes it. Read-side caching
 * lands in Phase 4.7; this service stays cache-agnostic so the cache
 * can wrap it without touching call sites.
 */
import { ProductCategoriesRepository, type ProductCategory } from '@dankdash/db';
import { Injectable } from '@nestjs/common';
import type { CategoryResponse } from './dto/index.js';

@Injectable()
export class CategoriesService {
  constructor(private readonly categories: ProductCategoriesRepository) {}

  async list(): Promise<readonly CategoryResponse[]> {
    const rows = await this.categories.listAll();
    return rows.map((row) => projectCategory(row));
  }
}

function projectCategory(row: ProductCategory): CategoryResponse {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    parentId: row.parentId,
    displayOrder: row.displayOrder,
    iconKey: row.iconKey,
  };
}

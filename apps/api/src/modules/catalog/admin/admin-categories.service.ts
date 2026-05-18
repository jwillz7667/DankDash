/**
 * Admin write-side service for product categories.
 *
 *   create() — POST /v1/admin/categories. Pre-flights the slug against
 *              the unique index so a collision surfaces as a typed 409
 *              instead of a generic 500 from the DB. Pre-flights `parentId`
 *              against `productCategories` so a typo cannot insert an
 *              orphan node (the FK would catch it too, but the typed 422
 *              is much friendlier than a Drizzle error string).
 *
 * Phase 4.3 deliberately scopes the surface to create-only — categories
 * are write-once-mostly merchandising rows. Renaming or re-slugging a
 * category in place would break every iOS deep link that already shipped
 * to a customer; corrections happen by introducing a new row and
 * migrating products onto it (a future admin tool).
 *
 * Read-back projects to the public CategoryResponse shape so the iOS
 * admin tool can refresh the local row from the same DTO the public
 * read endpoint serves — no parallel "admin shape".
 */
import { ProductCategoriesRepository, type ProductCategory } from '@dankdash/db';
import { ConflictError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type { CategoryResponse } from '../dto/index.js';
import type { CreateCategoryRequest } from './dto/index.js';

@Injectable()
export class AdminCategoriesService {
  constructor(private readonly categories: ProductCategoriesRepository) {}

  async create(body: CreateCategoryRequest): Promise<CategoryResponse> {
    const existing = await this.categories.findBySlug(body.slug);
    if (existing !== null) {
      throw new ConflictError('CATEGORY_SLUG_TAKEN', 'A category with this slug already exists', {
        slug: body.slug,
      });
    }
    if (body.parentId !== undefined && body.parentId !== null) {
      const parent = await this.categories.findById(body.parentId);
      if (parent === null) {
        throw new ValidationError('parentId references a category that does not exist', {
          parentId: body.parentId,
        });
      }
    }
    const row = await this.categories.create({
      slug: body.slug,
      displayName: body.displayName,
      parentId: body.parentId ?? null,
      ...(body.displayOrder !== undefined ? { displayOrder: body.displayOrder } : {}),
      iconKey: body.iconKey ?? null,
    });
    return projectCategory(row);
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

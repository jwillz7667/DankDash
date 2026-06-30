/**
 * Vendor write-side service for dispensary-authored products.
 *
 *   list(ctx)            — every product this dispensary owns (newest first)
 *   create(ctx, body)    — author a new product owned by ctx.dispensaryId
 *   patch(ctx, id, body) — edit one of its own products (404 if not owned)
 *   remove(ctx, id)      — soft-delete one of its own products
 *
 * This is the vendor-scoped twin of AdminProductsService. The crucial
 * differences, all enforced server-side:
 *
 *   - OWNERSHIP. Every write sets / filters on `created_by_dispensary_id =
 *     ctx.dispensaryId` (the *ForDispensary repo methods). A product owned by
 *     another tenant — or an admin-catalog row (NULL owner) — is invisible
 *     here: reads/updates/deletes return null and surface as 404, never
 *     distinguishing "missing" from "not yours". A vendor can therefore never
 *     mutate the shared global catalog.
 *   - IMAGES. Every imageKey must sit under the dispensary's own R2 prefix
 *     (isProductImageKeyOwnedBy), mirroring listing-image validation — a forged
 *     key for another store's objects is a 422.
 *   - COMPLIANCE. The create/patch Zod schemas carry the same beverage refines
 *     as the admin catalog (≤10 mg THC/serving, ≤2 servings/container). For
 *     partial patches the refine only sees the fields present, so
 *     {@link assertBeverageInvariants} re-checks the merged result against the
 *     persisted row — a vendor cannot flip productType→beverage or bump a
 *     serving count past the statutory cap with a one-field patch. Potency and
 *     weight non-negativity remain enforced by the DB CHECK constraints.
 */
import {
  ProductCategoriesRepository,
  ProductsRepository,
  type NewProduct,
  type Product,
} from '@dankdash/db';
import { NotFoundError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { BEVERAGE_LIMITS } from '../admin/dto/index.js';
import { isProductImageKeyOwnedBy } from './vendor-product-image-keys.js';
import type {
  CreateVendorProductRequest,
  PatchVendorProductRequest,
} from './dto/vendor-product.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { ProductResponse } from '../dto/index.js';

@Injectable()
export class VendorProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly categories: ProductCategoriesRepository,
  ) {}

  async list(ctx: VendorContext): Promise<readonly ProductResponse[]> {
    const rows = await this.products.listForDispensary(ctx.dispensaryId);
    return rows.map((row) => projectProduct(row));
  }

  async create(ctx: VendorContext, body: CreateVendorProductRequest): Promise<ProductResponse> {
    await this.assertCategoryExists(body.categoryId);
    if (body.imageKeys !== undefined) {
      this.assertImageKeysOwned(ctx.dispensaryId, body.imageKeys);
    }
    const row = await this.products.create({
      categoryId: body.categoryId,
      brand: body.brand,
      name: body.name,
      description: body.description ?? null,
      productType: body.productType,
      strainType: body.strainType ?? null,
      thcMgPerUnit: body.thcMgPerUnit,
      ...(body.cbdMgPerUnit !== undefined ? { cbdMgPerUnit: body.cbdMgPerUnit } : {}),
      ...(body.weightGramsPerUnit !== undefined
        ? { weightGramsPerUnit: body.weightGramsPerUnit }
        : {}),
      servingCount: body.servingCount ?? null,
      thcMgPerServing: body.thcMgPerServing ?? null,
      ...(body.imageKeys !== undefined ? { imageKeys: [...body.imageKeys] } : {}),
      ...(body.effectsTags !== undefined ? { effectsTags: [...body.effectsTags] } : {}),
      ...(body.flavorTags !== undefined ? { flavorTags: [...body.flavorTags] } : {}),
      // The ownership marker — derived from the request's dispensary context,
      // never from the body. This is what makes the product vendor-owned.
      createdByDispensaryId: ctx.dispensaryId,
    });
    return projectProduct(row);
  }

  async patch(
    ctx: VendorContext,
    id: string,
    body: PatchVendorProductRequest,
  ): Promise<ProductResponse> {
    if (Object.keys(body).length === 0) {
      throw new ValidationError('Patch body must include at least one field', { productId: id });
    }
    const existing = await this.products.findByIdForDispensary(id, ctx.dispensaryId);
    if (existing === null) {
      throw new NotFoundError('Product', id);
    }
    if (body.categoryId !== undefined && body.categoryId !== existing.categoryId) {
      await this.assertCategoryExists(body.categoryId);
    }
    assertBeverageInvariants(existing, body);
    if (body.imageKeys !== undefined) {
      this.assertImageKeysOwned(ctx.dispensaryId, body.imageKeys);
    }

    const patchInput: Partial<Omit<NewProduct, 'id' | 'createdAt' | 'createdByDispensaryId'>> = {
      ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
      ...(body.brand !== undefined ? { brand: body.brand } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.productType !== undefined ? { productType: body.productType } : {}),
      ...(body.strainType !== undefined ? { strainType: body.strainType } : {}),
      ...(body.thcMgPerUnit !== undefined ? { thcMgPerUnit: body.thcMgPerUnit } : {}),
      ...(body.cbdMgPerUnit !== undefined ? { cbdMgPerUnit: body.cbdMgPerUnit } : {}),
      ...(body.weightGramsPerUnit !== undefined
        ? { weightGramsPerUnit: body.weightGramsPerUnit }
        : {}),
      ...(body.servingCount !== undefined ? { servingCount: body.servingCount } : {}),
      ...(body.thcMgPerServing !== undefined ? { thcMgPerServing: body.thcMgPerServing } : {}),
      ...(body.imageKeys !== undefined ? { imageKeys: [...body.imageKeys] } : {}),
      ...(body.effectsTags !== undefined ? { effectsTags: [...body.effectsTags] } : {}),
      ...(body.flavorTags !== undefined ? { flavorTags: [...body.flavorTags] } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };
    const updated = await this.products.updateForDispensary(id, ctx.dispensaryId, patchInput);
    if (updated === null) throw new NotFoundError('Product', id);
    return projectProduct(updated);
  }

  async remove(ctx: VendorContext, id: string): Promise<void> {
    const deleted = await this.products.softDeleteForDispensary(id, ctx.dispensaryId);
    if (!deleted) throw new NotFoundError('Product', id);
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.categories.findById(categoryId);
    if (category === null) {
      throw new ValidationError('categoryId references a category that does not exist', {
        categoryId,
      });
    }
  }

  private assertImageKeysOwned(dispensaryId: string, keys: readonly string[]): void {
    const foreign = keys.filter((key) => !isProductImageKeyOwnedBy(dispensaryId, key));
    if (foreign.length > 0) {
      throw new ValidationError('imageKeys must reference objects uploaded under this dispensary', {
        dispensaryId,
        foreign,
      });
    }
  }
}

/**
 * Re-check the beverage statutory caps against the merged (persisted + patch)
 * result. Mirrors AdminProductsService.enforceBeverageInvariants and shares the
 * same BEVERAGE_LIMITS constant, so the cap can never drift between the admin
 * and vendor write paths.
 */
function assertBeverageInvariants(existing: Product, patch: PatchVendorProductRequest): void {
  const nextType = patch.productType ?? existing.productType;
  if (nextType !== 'beverage') return;
  const nextThcPerServing =
    patch.thcMgPerServing !== undefined ? patch.thcMgPerServing : existing.thcMgPerServing;
  if (
    nextThcPerServing !== null &&
    Number.parseFloat(nextThcPerServing) > BEVERAGE_LIMITS.MAX_MG_PER_SERVING
  ) {
    throw new ValidationError(
      `Beverages cannot exceed ${BEVERAGE_LIMITS.MAX_MG_PER_SERVING}mg THC per serving`,
      { productId: existing.id, thcMgPerServing: nextThcPerServing },
    );
  }
  const nextServingCount =
    patch.servingCount !== undefined ? patch.servingCount : existing.servingCount;
  if (nextServingCount !== null && nextServingCount > BEVERAGE_LIMITS.MAX_SERVINGS) {
    throw new ValidationError(
      `Beverages cannot exceed ${BEVERAGE_LIMITS.MAX_SERVINGS} servings per container`,
      { productId: existing.id, servingCount: nextServingCount },
    );
  }
}

function projectProduct(product: Product): ProductResponse {
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
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    // Vendors don't author COAs in this surface; lab results stay admin-owned.
    labResults: [],
  };
}

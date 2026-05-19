/**
 * Admin write-side service for the global product catalog.
 *
 *   create()         — POST /v1/admin/products. Pre-flights `categoryId`
 *                      against `product_categories` so a typo surfaces as
 *                      a typed 422 rather than a generic FK error. New
 *                      products are inserted with `isActive = true` (the
 *                      column default); admins flip it off later via patch.
 *
 *   patch()          — PATCH /v1/admin/products/:id. Empty bodies are
 *                      rejected here (not at the schema layer) so the
 *                      error message can be specific. When `productType`
 *                      changes to `beverage`, or when beverage cap fields
 *                      change, the persisted-row cross-check is run so a
 *                      partial patch cannot land an out-of-spec beverage.
 *                      Returns 404 on soft-deleted or missing rows.
 *
 *   createLabResult()— POST /v1/admin/products/:id/lab-results. Pre-flights
 *                      (productId, batchId) uniqueness so a re-upload of
 *                      the same batch surfaces as 409, matching the DB
 *                      unique index. Returns the full ProductResponse
 *                      including the new lab result so the iOS admin tool
 *                      can refresh in a single round trip.
 *
 * Read-back uniformity: every mutator returns the inflated ProductResponse
 * — same shape the public GET /v1/products/:id serves — so the iOS admin
 * tool sees no schema drift between read and write surfaces.
 */
import {
  ProductCategoriesRepository,
  ProductLabResultsRepository,
  ProductsRepository,
  type NewProduct,
  type Product,
  type ProductLabResult,
} from '@dankdash/db';
import { ConflictError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import {
  BEVERAGE_LIMITS,
  type CreateLabResultRequest,
  type CreateProductRequest,
  type PatchProductRequest,
} from './dto/index.js';
import type { LabResultResponse, ProductResponse } from '../dto/index.js';

@Injectable()
export class AdminProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly categories: ProductCategoriesRepository,
    private readonly labResults: ProductLabResultsRepository,
  ) {}

  async create(body: CreateProductRequest): Promise<ProductResponse> {
    const category = await this.categories.findById(body.categoryId);
    if (category === null) {
      throw new ValidationError('categoryId references a category that does not exist', {
        categoryId: body.categoryId,
      });
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
    });
    return projectProduct(row, []);
  }

  async patch(id: string, body: PatchProductRequest): Promise<ProductResponse> {
    if (Object.keys(body).length === 0) {
      throw new ValidationError('Patch body must include at least one field', { productId: id });
    }
    const existing = await this.products.findById(id);
    if (existing?.deletedAt !== null) {
      throw new NotFoundError('Product', id);
    }
    if (body.categoryId !== undefined && body.categoryId !== existing.categoryId) {
      const category = await this.categories.findById(body.categoryId);
      if (category === null) {
        throw new ValidationError('categoryId references a category that does not exist', {
          categoryId: body.categoryId,
        });
      }
    }
    // Cross-check beverage CHECK constraints against the persisted row when
    // only some of the relevant fields are in the patch — the schema's
    // refine can only see what the patch carries.
    this.enforceBeverageInvariants(existing, body);

    const patchInput: Partial<Omit<NewProduct, 'id' | 'createdAt'>> = {
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
    const updated = await this.products.update(id, patchInput);
    if (updated === null) throw new NotFoundError('Product', id);
    const labs = await this.labResults.listForProduct(id);
    return projectProduct(updated, labs);
  }

  async createLabResult(productId: string, body: CreateLabResultRequest): Promise<ProductResponse> {
    const existing = await this.products.findById(productId);
    if (existing?.deletedAt !== null) {
      throw new NotFoundError('Product', productId);
    }
    const dup = await this.labResults.findByProductIdAndBatchId(productId, body.batchId);
    if (dup !== null) {
      throw new ConflictError(
        'LAB_RESULT_BATCH_TAKEN',
        'A lab result for this batch already exists',
        { productId, batchId: body.batchId },
      );
    }
    await this.labResults.create({
      productId,
      batchId: body.batchId,
      labName: body.labName,
      coaDocumentKey: body.coaDocumentKey ?? null,
      potencyThc: body.potencyThc ?? null,
      potencyCbd: body.potencyCbd ?? null,
      contaminantsPassed: body.contaminantsPassed ?? null,
      testedAt: body.testedAt,
    });
    // Re-read the product so the response reflects any column the trigger
    // may have updated, and pull every lab result so the iOS admin tool can
    // refresh from a single round trip.
    const [product, labs] = await Promise.all([
      this.products.findById(productId),
      this.labResults.listForProduct(productId),
    ]);
    if (product === null) {
      throw new RepositoryError(`products ${productId} vanished mid-createLabResult`);
    }
    return projectProduct(product, labs);
  }

  private enforceBeverageInvariants(existing: Product, patch: PatchProductRequest): void {
    const nextType = patch.productType ?? existing.productType;
    if (nextType !== 'beverage') return;
    const nextThcPerServing = patch.thcMgPerServing ?? existing.thcMgPerServing;
    if (
      nextThcPerServing !== null &&
      Number.parseFloat(nextThcPerServing) > BEVERAGE_LIMITS.MAX_MG_PER_SERVING
    ) {
      throw new ValidationError(
        `Beverages cannot exceed ${BEVERAGE_LIMITS.MAX_MG_PER_SERVING}mg THC per serving`,
        { productId: existing.id, thcMgPerServing: nextThcPerServing },
      );
    }
    const nextServingCount = patch.servingCount ?? existing.servingCount;
    if (nextServingCount !== null && nextServingCount > BEVERAGE_LIMITS.MAX_SERVINGS) {
      throw new ValidationError(
        `Beverages cannot exceed ${BEVERAGE_LIMITS.MAX_SERVINGS} servings per container`,
        { productId: existing.id, servingCount: nextServingCount },
      );
    }
  }
}

function projectProduct(
  product: Product,
  labResults: readonly ProductLabResult[],
): ProductResponse {
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
    labResults: labResults.map((row) => projectLabResult(row)),
  };
}

function projectLabResult(row: ProductLabResult): LabResultResponse {
  return {
    id: row.id,
    batchId: row.batchId,
    labName: row.labName,
    coaDocumentKey: row.coaDocumentKey,
    potencyThc: row.potencyThc,
    potencyCbd: row.potencyCbd,
    contaminantsPassed: row.contaminantsPassed,
    testedAt: row.testedAt,
  };
}

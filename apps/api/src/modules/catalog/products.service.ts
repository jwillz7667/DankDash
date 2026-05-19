/**
 * Product orchestration.
 *
 *   getById(id) — projects a single product + its lab results into the
 *                 public ProductResponse shape. Soft-deleted or inactive
 *                 products surface as 404 (we never expose tombstones to
 *                 customers; admins go through dedicated read paths in
 *                 Phase 4.3).
 *
 * Lab results are fetched in parallel with the product row. The repository
 * already orders them newest-first by `tested_at` so the iOS client can
 * pluck `labResults[0]` for the headline COA without re-sorting.
 *
 * Lab-result fetches against a missing product would simply return an
 * empty array; we still issue them in parallel because the not-found check
 * happens after both promises settle. The cost is one wasted query on the
 * 404 path, which is negligible against the latency win on the hot path.
 */
import {
  ProductLabResultsRepository,
  ProductsRepository,
  type Product,
  type ProductLabResult,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type { LabResultResponse, ProductResponse } from './dto/index.js';

@Injectable()
export class ProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly labResults: ProductLabResultsRepository,
  ) {}

  async getById(id: string): Promise<ProductResponse> {
    const [product, labResults] = await Promise.all([
      this.products.findById(id),
      this.labResults.listForProduct(id),
    ]);

    if (product?.deletedAt !== null || !product.isActive) {
      throw new NotFoundError('Product', id);
    }

    return projectProduct(product, labResults);
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

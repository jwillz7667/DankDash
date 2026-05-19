/**
 * Unit tests for ProductsService.
 *
 * The service projects a raw product row + its lab-result history into the
 * public ProductResponse. The interesting behaviours to lock down:
 *
 *   - getById     → projection (numerics as strings, nullables preserved,
 *                   tsvector/searchVector and isActive/deletedAt absent),
 *                   parallel lab-result fetch, lab-result ordering trusts
 *                   the repository's newest-first sort.
 *   - 404 paths   → missing row, soft-deleted row, and inactive row all
 *                   surface as NotFoundError so a customer cannot probe the
 *                   tombstone surface.
 */
import {
  type Product,
  type ProductLabResult,
  type ProductLabResultsRepository,
  type ProductsRepository,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { ProductsService } from './products.service.js';

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = new Date('2026-05-01T12:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    categoryId: '01935f3d-0000-7000-8000-0000000000a1',
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
    description: 'A bright sativa-dominant hybrid with a citrus nose.',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '24.500',
    cbdMgPerUnit: '0.100',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: ['products/sunny-side/sour-tangie/01.jpg'],
    searchVector: null,
    effectsTags: ['uplifting', 'creative'],
    flavorTags: ['citrus', 'pine'],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeLabResult(overrides: Partial<ProductLabResult> = {}): ProductLabResult {
  return {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    productId: '01935f3d-0000-7000-8000-000000000001',
    batchId: 'BATCH-2026-05-01',
    labName: 'Northland Labs',
    coaDocumentKey: 'coas/2026/05/batch-2026-05-01.pdf',
    potencyThc: '24.500',
    potencyCbd: '0.100',
    contaminantsPassed: true,
    testedAt: '2026-04-28',
    createdAt: new Date('2026-04-28T18:00:00.000Z'),
    ...overrides,
  };
}

class FakeProductsRepo implements Pick<ProductsRepository, 'findById'> {
  public readonly rows = new Map<string, Product>();

  seed(product: Product): void {
    this.rows.set(product.id, product);
  }

  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeLabResultsRepo implements Pick<ProductLabResultsRepository, 'listForProduct'> {
  public readonly rows = new Map<string, readonly ProductLabResult[]>();

  seedFor(productId: string, results: readonly ProductLabResult[]): void {
    this.rows.set(productId, results);
  }

  listForProduct(productId: string): Promise<readonly ProductLabResult[]> {
    return Promise.resolve(this.rows.get(productId) ?? []);
  }
}

interface TestRig {
  readonly service: ProductsService;
  readonly products: FakeProductsRepo;
  readonly labResults: FakeLabResultsRepo;
}

function makeRig(): TestRig {
  const products = new FakeProductsRepo();
  const labResults = new FakeLabResultsRepo();
  const service = new ProductsService(
    products as unknown as ProductsRepository,
    labResults as unknown as ProductLabResultsRepository,
  );
  return { service, products, labResults };
}

describe('ProductsService.getById', () => {
  it('projects a complete product row + lab results into ProductResponse', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.labResults.seedFor('01935f3d-0000-7000-8000-000000000001', [makeLabResult()]);

    const res = await rig.service.getById('01935f3d-0000-7000-8000-000000000001');

    expect(res).toEqual({
      id: '01935f3d-0000-7000-8000-000000000001',
      categoryId: '01935f3d-0000-7000-8000-0000000000a1',
      brand: 'Sunny Side',
      name: 'Sour Tangie 3.5g',
      description: 'A bright sativa-dominant hybrid with a citrus nose.',
      productType: 'flower',
      strainType: 'sativa',
      thcMgPerUnit: '24.500',
      cbdMgPerUnit: '0.100',
      weightGramsPerUnit: '3.500',
      servingCount: null,
      thcMgPerServing: null,
      imageKeys: ['products/sunny-side/sour-tangie/01.jpg'],
      effectsTags: ['uplifting', 'creative'],
      flavorTags: ['citrus', 'pine'],
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
      labResults: [
        {
          id: '01935f3d-0000-7000-8000-0000000000b1',
          batchId: 'BATCH-2026-05-01',
          labName: 'Northland Labs',
          coaDocumentKey: 'coas/2026/05/batch-2026-05-01.pdf',
          potencyThc: '24.500',
          potencyCbd: '0.100',
          contaminantsPassed: true,
          testedAt: '2026-04-28',
        },
      ],
    });
  });

  it('returns null strainType for products that do not have one (e.g. accessories)', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1', productType: 'accessory', strainType: null }));

    const res = await rig.service.getById('p1');

    expect(res.strainType).toBeNull();
    expect(res.productType).toBe('accessory');
  });

  it('surfaces beverage serving metadata when present', async () => {
    const rig = makeRig();
    rig.products.seed(
      makeProduct({
        id: 'p1',
        productType: 'beverage',
        strainType: null,
        servingCount: 2,
        thcMgPerServing: '5.000',
      }),
    );

    const res = await rig.service.getById('p1');

    expect(res.servingCount).toBe(2);
    expect(res.thcMgPerServing).toBe('5.000');
  });

  it('returns an empty labResults array when no COAs have been recorded yet', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1' }));

    const res = await rig.service.getById('p1');

    expect(res.labResults).toEqual([]);
  });

  it('preserves the repository ordering of lab results (newest first)', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1' }));
    rig.labResults.seedFor('p1', [
      makeLabResult({ id: 'lr2', testedAt: '2026-05-10' }),
      makeLabResult({ id: 'lr1', testedAt: '2026-04-28' }),
    ]);

    const res = await rig.service.getById('p1');

    expect(res.labResults.map((r) => r.id)).toEqual(['lr2', 'lr1']);
  });

  it('throws NotFoundError when the product does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.getById('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the product is soft-deleted', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1', deletedAt: new Date('2026-05-15T00:00:00.000Z') }));
    await expect(rig.service.getById('p1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the product has been marked inactive', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1', isActive: false }));
    await expect(rig.service.getById('p1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

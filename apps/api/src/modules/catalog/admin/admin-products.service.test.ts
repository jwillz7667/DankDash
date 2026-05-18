/**
 * Unit tests for AdminProductsService.
 *
 * Behaviours pinned:
 *   - create()         forwards required fields, defaults nullable optionals
 *                      to null, leaves DB-default fields off the insert so
 *                      the DB column defaults fire. Returns the inflated
 *                      ProductResponse with an empty lab-results array.
 *   - create()         throws ValidationError when the categoryId FK pre-flight
 *                      fails (rather than letting the DB FK return 500).
 *   - patch()          rejects empty bodies, 404s soft-deleted and missing rows,
 *                      re-checks categoryId only when it changes, cross-checks
 *                      beverage caps against the persisted row when only some
 *                      of the relevant fields are in the patch, and forwards
 *                      only present fields to the repo update.
 *   - createLabResult() pre-flights (productId, batchId) uniqueness as 409,
 *                      404s missing/deleted products, returns the inflated
 *                      ProductResponse with the new lab row included.
 */
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AdminProductsService } from './admin-products.service.js';
import { BEVERAGE_LIMITS, type CreateProductRequest } from './dto/index.js';
import type {
  NewProduct,
  NewProductLabResult,
  Product,
  ProductCategoriesRepository,
  ProductCategory,
  ProductLabResult,
  ProductLabResultsRepository,
  ProductsRepository,
} from '@dankdash/db';

const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000001';
const CATEGORY_ID = '01935f3d-0000-7000-8000-000000000010';

function makeCategory(overrides: Partial<ProductCategory> = {}): ProductCategory {
  return {
    id: CATEGORY_ID,
    slug: 'flower',
    displayName: 'Flower',
    parentId: null,
    displayOrder: 0,
    iconKey: null,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: PRODUCT_ID,
    categoryId: CATEGORY_ID,
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    description: null,
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    cbdMgPerUnit: '0',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: [],
    searchVector: null,
    effectsTags: [],
    flavorTags: [],
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeLab(overrides: Partial<ProductLabResult> = {}): ProductLabResult {
  return {
    id: '01935f3d-0000-7000-8000-0000000000c1',
    productId: PRODUCT_ID,
    batchId: 'OCM-BATCH-001',
    labName: 'Steep Hill Minnesota',
    coaDocumentKey: null,
    potencyThc: '24.123',
    potencyCbd: '0.500',
    contaminantsPassed: true,
    testedAt: '2026-05-01',
    createdAt: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  };
}

function makeCreateBody(overrides: Partial<CreateProductRequest> = {}): CreateProductRequest {
  return {
    categoryId: CATEGORY_ID,
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
    ...overrides,
  };
}

class FakeProductsRepo implements Pick<ProductsRepository, 'findById' | 'create' | 'update'> {
  public rows = new Map<string, Product>();
  public createCalls: (Omit<NewProduct, 'id'> & { id?: string })[] = [];
  public updateCalls: { id: string; patch: Partial<NewProduct> }[] = [];
  public nextCreated: Product = makeProduct();

  seed(p: Product): void {
    this.rows.set(p.id, p);
  }

  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  create(input: Omit<NewProduct, 'id'> & { id?: string }): Promise<Product> {
    this.createCalls.push(input);
    const row: Product = {
      ...this.nextCreated,
      ...(input.id !== undefined ? { id: input.id } : {}),
      categoryId: input.categoryId,
      brand: input.brand,
      name: input.name,
      description: input.description ?? null,
      productType: input.productType,
      strainType: input.strainType ?? null,
      thcMgPerUnit: input.thcMgPerUnit,
      cbdMgPerUnit: input.cbdMgPerUnit ?? '0',
      weightGramsPerUnit: input.weightGramsPerUnit ?? '0',
      servingCount: input.servingCount ?? null,
      thcMgPerServing: input.thcMgPerServing ?? null,
      imageKeys: input.imageKeys === undefined ? [] : [...input.imageKeys],
      effectsTags: input.effectsTags === undefined ? [] : [...input.effectsTags],
      flavorTags: input.flavorTags === undefined ? [] : [...input.flavorTags],
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  update(id: string, patch: Partial<NewProduct>): Promise<Product | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Product = {
      ...existing,
      ...(patch as unknown as Partial<Product>),
      updatedAt: new Date('2026-05-18T19:00:00.000Z'),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

class FakeCategoriesRepo implements Pick<ProductCategoriesRepository, 'findById'> {
  public rows = new Map<string, ProductCategory>();

  seed(c: ProductCategory): void {
    this.rows.set(c.id, c);
  }

  findById(id: string): Promise<ProductCategory | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeLabResultsRepo implements Pick<
  ProductLabResultsRepository,
  'findByProductIdAndBatchId' | 'create' | 'listForProduct'
> {
  public rows: ProductLabResult[] = [];
  public createCalls: (Omit<NewProductLabResult, 'id'> & { id?: string })[] = [];

  seed(rows: readonly ProductLabResult[]): void {
    this.rows = [...rows];
  }

  findByProductIdAndBatchId(productId: string, batchId: string): Promise<ProductLabResult | null> {
    return Promise.resolve(
      this.rows.find((r) => r.productId === productId && r.batchId === batchId) ?? null,
    );
  }

  create(input: Omit<NewProductLabResult, 'id'> & { id?: string }): Promise<ProductLabResult> {
    this.createCalls.push(input);
    const row: ProductLabResult = {
      id: input.id ?? '01935f3d-0000-7000-8000-0000000000dd',
      productId: input.productId,
      batchId: input.batchId,
      labName: input.labName,
      coaDocumentKey: input.coaDocumentKey ?? null,
      potencyThc: input.potencyThc ?? null,
      potencyCbd: input.potencyCbd ?? null,
      contaminantsPassed: input.contaminantsPassed ?? null,
      testedAt: input.testedAt,
      createdAt: new Date('2026-05-01T12:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listForProduct(productId: string): Promise<readonly ProductLabResult[]> {
    return Promise.resolve(this.rows.filter((r) => r.productId === productId));
  }
}

interface Rig {
  readonly service: AdminProductsService;
  readonly products: FakeProductsRepo;
  readonly categories: FakeCategoriesRepo;
  readonly labs: FakeLabResultsRepo;
}

function makeRig(): Rig {
  const products = new FakeProductsRepo();
  const categories = new FakeCategoriesRepo();
  const labs = new FakeLabResultsRepo();
  categories.seed(makeCategory());
  const service = new AdminProductsService(
    products as unknown as ProductsRepository,
    categories as unknown as ProductCategoriesRepository,
    labs as unknown as ProductLabResultsRepository,
  );
  return { service, products, categories, labs };
}

describe('AdminProductsService.create', () => {
  it('forwards required fields, defaults nullable optionals to null, omits DB-defaulted fields', async () => {
    const rig = makeRig();

    const res = await rig.service.create(makeCreateBody());

    expect(rig.products.createCalls).toHaveLength(1);
    const input = rig.products.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.brand).toBe('North Star');
    expect(input.description).toBeNull();
    expect(input.servingCount).toBeNull();
    expect(input.thcMgPerServing).toBeNull();
    // DB-defaulted fields omitted so the column defaults fire.
    expect((input as { cbdMgPerUnit?: unknown }).cbdMgPerUnit).toBeUndefined();
    expect((input as { imageKeys?: unknown }).imageKeys).toBeUndefined();
    expect((input as { effectsTags?: unknown }).effectsTags).toBeUndefined();
    // Inflated projection — labResults empty for a fresh product.
    expect(res.id).toBe(PRODUCT_ID);
    expect(res.labResults).toEqual([]);
  });

  it('forwards optional arrays and decimal-string fields when supplied', async () => {
    const rig = makeRig();

    await rig.service.create(
      makeCreateBody({
        cbdMgPerUnit: '12.000',
        servingCount: 1,
        thcMgPerServing: '875.000',
        imageKeys: ['products/pe1.jpg'],
        effectsTags: ['energetic'],
        flavorTags: ['pineapple'],
        description: 'A sativa-dominant strain.',
      }),
    );

    const input = rig.products.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.cbdMgPerUnit).toBe('12.000');
    expect(input.imageKeys).toEqual(['products/pe1.jpg']);
    expect(input.effectsTags).toEqual(['energetic']);
    expect(input.description).toBe('A sativa-dominant strain.');
  });

  it('throws ValidationError when categoryId references a non-existent category', async () => {
    const rig = makeRig();

    await expect(
      rig.service.create(makeCreateBody({ categoryId: '01935f3d-0000-7000-8000-0000000000ff' })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.products.createCalls).toEqual([]);
  });
});

describe('AdminProductsService.patch', () => {
  it('throws ValidationError on an empty patch body', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    await expect(rig.service.patch(PRODUCT_ID, {})).rejects.toBeInstanceOf(ValidationError);
    expect(rig.products.updateCalls).toEqual([]);
  });

  it('throws NotFoundError when the product does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.patch('ghost', { brand: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the product is soft-deleted', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(rig.service.patch(PRODUCT_ID, { brand: 'X' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('re-validates categoryId only when it changes', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    // Same categoryId in patch — no FK check, no throw.
    await rig.service.patch(PRODUCT_ID, { categoryId: CATEGORY_ID, brand: 'Same Cat' });
    expect(rig.products.updateCalls).toHaveLength(1);

    // Different categoryId pointing at nothing — ValidationError.
    await expect(
      rig.service.patch(PRODUCT_ID, { categoryId: '01935f3d-0000-7000-8000-0000000000ff' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('forwards only present fields and surfaces the inflated projection', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.labs.seed([makeLab()]);

    const res = await rig.service.patch(PRODUCT_ID, {
      brand: 'Renamed Brand',
      isActive: false,
    });

    expect(rig.products.updateCalls).toHaveLength(1);
    const call = rig.products.updateCalls[0];
    assert(call !== undefined, 'expected update call');
    expect(call.id).toBe(PRODUCT_ID);
    expect(call.patch).toEqual({ brand: 'Renamed Brand', isActive: false });
    expect(res.brand).toBe('Renamed Brand');
    expect(res.labResults).toHaveLength(1);
  });

  it('allows nullable fields to be explicitly nulled', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ description: 'old desc', strainType: 'sativa' }));

    await rig.service.patch(PRODUCT_ID, { description: null, strainType: null });

    expect(rig.products.updateCalls[0]?.patch).toEqual({
      description: null,
      strainType: null,
    });
  });

  it('rejects a partial patch that would push a persisted beverage over the per-serving cap', async () => {
    const rig = makeRig();
    rig.products.seed(
      makeProduct({
        productType: 'beverage',
        servingCount: 2,
        thcMgPerServing: '10.000',
        thcMgPerUnit: '20.000',
      }),
    );

    await expect(
      rig.service.patch(PRODUCT_ID, {
        thcMgPerServing: String(BEVERAGE_LIMITS.MAX_MG_PER_SERVING + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a patch that flips a non-beverage to beverage with an out-of-spec serving count', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ servingCount: 10, thcMgPerServing: '5.000' }));

    await expect(rig.service.patch(PRODUCT_ID, { productType: 'beverage' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('does not enforce beverage caps when the row is and stays a non-beverage', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ productType: 'edible' }));

    await rig.service.patch(PRODUCT_ID, { servingCount: 50, thcMgPerServing: '100.000' });

    expect(rig.products.updateCalls).toHaveLength(1);
  });
});

describe('AdminProductsService.createLabResult', () => {
  it('appends a lab result and returns the inflated product projection', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    const res = await rig.service.createLabResult(PRODUCT_ID, {
      batchId: 'OCM-BATCH-001',
      labName: 'Steep Hill Minnesota',
      potencyThc: '24.123',
      testedAt: '2026-05-01',
    });

    expect(rig.labs.createCalls).toHaveLength(1);
    const input = rig.labs.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.productId).toBe(PRODUCT_ID);
    expect(input.batchId).toBe('OCM-BATCH-001');
    expect(input.coaDocumentKey).toBeNull();
    expect(input.contaminantsPassed).toBeNull();
    expect(res.labResults).toHaveLength(1);
    expect(res.labResults[0]?.batchId).toBe('OCM-BATCH-001');
  });

  it('throws NotFoundError when the product does not exist', async () => {
    const rig = makeRig();

    await expect(
      rig.service.createLabResult('ghost', {
        batchId: 'X',
        labName: 'Y',
        testedAt: '2026-05-01',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.labs.createCalls).toEqual([]);
  });

  it('throws NotFoundError when the product is soft-deleted', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(
      rig.service.createLabResult(PRODUCT_ID, {
        batchId: 'X',
        labName: 'Y',
        testedAt: '2026-05-01',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ConflictError on a duplicate (productId, batchId) pre-flight', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.labs.seed([makeLab({ batchId: 'OCM-BATCH-001' })]);

    await expect(
      rig.service.createLabResult(PRODUCT_ID, {
        batchId: 'OCM-BATCH-001',
        labName: 'Lab',
        testedAt: '2026-05-02',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(rig.labs.createCalls).toEqual([]);
  });

  it('throws RepositoryError when the product vanishes between insert and re-read', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    // Simulate the row disappearing between create and re-read.
    const realFindById = rig.products.findById.bind(rig.products);
    let calls = 0;
    rig.products.findById = (id: string): Promise<Product | null> => {
      calls += 1;
      if (calls === 1) return realFindById(id);
      return Promise.resolve(null);
    };

    await expect(
      rig.service.createLabResult(PRODUCT_ID, {
        batchId: 'OCM-BATCH-077',
        labName: 'Lab',
        testedAt: '2026-05-02',
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

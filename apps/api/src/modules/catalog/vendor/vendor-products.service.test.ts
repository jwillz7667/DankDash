/**
 * Unit tests for VendorProductsService — the vendor-scoped product authoring
 * surface. Behaviours pinned (the security + compliance ones especially):
 *   - create() stamps created_by_dispensary_id from the context, defaults
 *     nullable optionals, and projects the ProductResponse with empty labs.
 *   - create()/patch() reject imageKeys outside the dispensary's own prefix.
 *   - create() 422s an unknown categoryId before hitting the FK.
 *   - patch() 404s a product owned by another tenant (findByIdForDispensary
 *     null) and rejects an empty body.
 *   - patch() re-checks beverage caps against the persisted row so a one-field
 *     patch can't land an out-of-spec beverage (Minn. Stat. § 342.46).
 *   - remove() 404s when nothing was tombstoned (not owned).
 * Repos are faked — pure unit tests, no DB.
 */
import { NotFoundError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { VendorProductsService } from './vendor-products.service.js';
import { dispensaryProductImagePrefix } from './vendor-product-image-keys.js';
import type {
  NewProduct,
  Product,
  ProductCategoriesRepository,
  ProductCategory,
  ProductsRepository,
} from '@dankdash/db';
import type { CreateVendorProductRequest } from './dto/vendor-product.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const DISP = '01935f3d-0000-7000-8000-0000000000d1';
const OTHER_DISP = '01935f3d-0000-7000-8000-0000000000d2';
const CATEGORY_ID = '01935f3d-0000-7000-8000-000000000010';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000001';

const CTX: VendorContext = {
  dispensaryId: DISP,
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

function makeProduct(overrides: Partial<Product> = {}): Product {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: PRODUCT_ID,
    categoryId: CATEGORY_ID,
    brand: 'Boreal Gold',
    name: 'House Blend 3.5g',
    description: null,
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '700.000',
    cbdMgPerUnit: '0',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: [],
    searchVector: null,
    createdByDispensaryId: DISP,
    effectsTags: [],
    flavorTags: [],
    isActive: true,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...overrides,
  };
}

function makeCreateBody(
  overrides: Partial<CreateVendorProductRequest> = {},
): CreateVendorProductRequest {
  return {
    categoryId: CATEGORY_ID,
    brand: 'Boreal Gold',
    name: 'House Blend 3.5g',
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '700.000',
    weightGramsPerUnit: '3.500',
    ...overrides,
  };
}

class FakeProductsRepo
  implements
    Pick<
      ProductsRepository,
      'create' | 'listForDispensary' | 'findByIdForDispensary' | 'updateForDispensary' | 'softDeleteForDispensary'
    >
{
  public rows: Product[] = [];
  public createCalls: (Omit<NewProduct, 'id'> & { id?: string })[] = [];
  public updateCalls: { id: string; dispensaryId: string; patch: Partial<NewProduct> }[] = [];

  seed(p: Product): void {
    this.rows.push(p);
  }

  create(input: Omit<NewProduct, 'id'> & { id?: string }): Promise<Product> {
    this.createCalls.push(input);
    const row = makeProduct({
      categoryId: input.categoryId,
      brand: input.brand,
      name: input.name,
      productType: input.productType,
      strainType: input.strainType ?? null,
      thcMgPerUnit: input.thcMgPerUnit,
      imageKeys: input.imageKeys === undefined ? [] : [...input.imageKeys],
      createdByDispensaryId: input.createdByDispensaryId ?? null,
    });
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listForDispensary(dispensaryId: string): Promise<readonly Product[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.createdByDispensaryId === dispensaryId && r.deletedAt === null),
    );
  }

  findByIdForDispensary(id: string, dispensaryId: string): Promise<Product | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => r.id === id && r.createdByDispensaryId === dispensaryId && r.deletedAt === null,
      ) ?? null,
    );
  }

  updateForDispensary(
    id: string,
    dispensaryId: string,
    patch: Partial<NewProduct>,
  ): Promise<Product | null> {
    this.updateCalls.push({ id, dispensaryId, patch });
    const idx = this.rows.findIndex(
      (r) => r.id === id && r.createdByDispensaryId === dispensaryId && r.deletedAt === null,
    );
    if (idx === -1) return Promise.resolve(null);
    const next = { ...this.rows[idx], ...(patch as Partial<Product>) } as Product;
    this.rows[idx] = next;
    return Promise.resolve(next);
  }

  softDeleteForDispensary(id: string, dispensaryId: string): Promise<boolean> {
    const row = this.rows.find(
      (r) => r.id === id && r.createdByDispensaryId === dispensaryId && r.deletedAt === null,
    );
    if (row === undefined) return Promise.resolve(false);
    row.deletedAt = new Date();
    return Promise.resolve(true);
  }
}

class FakeCategoriesRepo implements Pick<ProductCategoriesRepository, 'findById'> {
  constructor(private readonly known: ReadonlySet<string>) {}
  findById(id: string): Promise<ProductCategory | null> {
    if (!this.known.has(id)) return Promise.resolve(null);
    return Promise.resolve({
      id,
      slug: 'flower',
      displayName: 'Flower',
      parentId: null,
      displayOrder: 0,
      iconKey: null,
    });
  }
}

function makeService(
  categories = new Set([CATEGORY_ID]),
): { svc: VendorProductsService; products: FakeProductsRepo } {
  const products = new FakeProductsRepo();
  const svc = new VendorProductsService(
    products as unknown as ProductsRepository,
    new FakeCategoriesRepo(categories) as unknown as ProductCategoriesRepository,
  );
  return { svc, products };
}

describe('VendorProductsService.create', () => {
  it('stamps created_by_dispensary_id from the context and returns the product', async () => {
    const { svc, products } = makeService();

    const res = await svc.create(CTX, makeCreateBody());

    expect(products.createCalls[0]?.createdByDispensaryId).toBe(DISP);
    expect(res.brand).toBe('Boreal Gold');
    expect(res.labResults).toEqual([]);
  });

  it('422s an unknown categoryId before the FK', async () => {
    const { svc } = makeService(new Set());
    await expect(svc.create(CTX, makeCreateBody())).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an imageKey outside the dispensary prefix', async () => {
    const { svc } = makeService();
    const foreign = `dispensaries/${OTHER_DISP}/products/x.jpg`;
    await expect(
      svc.create(CTX, makeCreateBody({ imageKeys: [foreign] })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts an imageKey under the dispensary prefix', async () => {
    const { svc } = makeService();
    const owned = `${dispensaryProductImagePrefix(DISP)}018f.jpg`;
    const res = await svc.create(CTX, makeCreateBody({ imageKeys: [owned] }));
    expect(res.imageKeys).toContain(owned);
  });
});

describe('VendorProductsService.list', () => {
  it('returns only this dispensary owned products', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ id: PRODUCT_ID, createdByDispensaryId: DISP }));
    products.seed(
      makeProduct({ id: '01935f3d-0000-7000-8000-000000000002', createdByDispensaryId: OTHER_DISP }),
    );

    const list = await svc.list(CTX);

    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(PRODUCT_ID);
  });
});

describe('VendorProductsService.patch', () => {
  it('rejects an empty body', async () => {
    const { svc } = makeService();
    await expect(svc.patch(CTX, PRODUCT_ID, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('404s a product owned by another tenant', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ createdByDispensaryId: OTHER_DISP }));
    await expect(svc.patch(CTX, PRODUCT_ID, { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forwards only present fields for an owned product', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ createdByDispensaryId: DISP }));
    await svc.patch(CTX, PRODUCT_ID, { name: 'Renamed', thcMgPerUnit: '650.000' });
    expect(products.updateCalls[0]?.patch).toEqual({ name: 'Renamed', thcMgPerUnit: '650.000' });
  });

  it('re-checks the beverage serving cap against the persisted row on a one-field patch', async () => {
    const { svc, products } = makeService();
    products.seed(
      makeProduct({ productType: 'beverage', thcMgPerServing: '5.000', servingCount: 2 }),
    );
    // Patch only bumps servingCount past the cap; productType comes from the row.
    await expect(svc.patch(CTX, PRODUCT_ID, { servingCount: 3 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects flipping a product to beverage with >10mg THC/serving', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ thcMgPerServing: '25.000', servingCount: 1 }));
    await expect(
      svc.patch(CTX, PRODUCT_ID, { productType: 'beverage' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an imageKey outside the dispensary prefix on patch', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct());
    await expect(
      svc.patch(CTX, PRODUCT_ID, { imageKeys: [`dispensaries/${OTHER_DISP}/products/x.jpg`] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('VendorProductsService.remove', () => {
  it('404s when nothing was tombstoned (not owned)', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ createdByDispensaryId: OTHER_DISP }));
    await expect(svc.remove(CTX, PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('soft-deletes an owned product', async () => {
    const { svc, products } = makeService();
    products.seed(makeProduct({ createdByDispensaryId: DISP }));
    await svc.remove(CTX, PRODUCT_ID);
    expect(products.rows[0]?.deletedAt).not.toBeNull();
  });
});

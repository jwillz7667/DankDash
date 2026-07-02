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
 *   - getListings → gates on the same 404 semantics, then projects the
 *                   cross-dispensary listing set (id → listingId, store name
 *                   resolved, internal columns dropped) and echoes the
 *                   request's limit/offset in the page envelope.
 */
import {
  type DispensaryListing,
  type Product,
  type ProductLabResult,
  type ProductLabResultsRepository,
  type ProductsRepository,
  type DispensaryListingsRepository,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { ProductsService } from './products.service.js';
import type { ProductListingsQuery } from './dto/index.js';

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
    createdByDispensaryId: null,
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

function makeListing(overrides: Partial<DispensaryListing> = {}): DispensaryListing {
  const now = new Date('2026-05-01T12:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000c1',
    dispensaryId: '01935f3d-0000-7000-8000-000000000fa1',
    productId: '01935f3d-0000-7000-8000-000000000001',
    sku: 'SS-ST-35',
    priceCents: 4500,
    compareAtPriceCents: null,
    quantityAvailable: 7,
    imageKeys: [],
    isActive: true,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as DispensaryListing;
}

interface FakeListingInput {
  readonly limit: number;
  readonly offset: number;
}

interface FakeListingPage {
  readonly results: readonly {
    readonly listing: DispensaryListing;
    readonly dispensaryName: string;
  }[];
  readonly total: number;
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

class FakeListingsRepo implements Pick<DispensaryListingsRepository, 'listAvailableForProduct'> {
  public calls: { readonly productId: string; readonly input: FakeListingInput }[] = [];
  public next: FakeListingPage = { results: [], total: 0 };

  listAvailableForProduct(productId: string, input: FakeListingInput): Promise<FakeListingPage> {
    this.calls.push({ productId, input });
    return Promise.resolve(this.next);
  }
}

interface TestRig {
  readonly service: ProductsService;
  readonly products: FakeProductsRepo;
  readonly labResults: FakeLabResultsRepo;
  readonly listings: FakeListingsRepo;
}

function makeRig(): TestRig {
  const products = new FakeProductsRepo();
  const labResults = new FakeLabResultsRepo();
  const listings = new FakeListingsRepo();
  const service = new ProductsService(
    products as unknown as ProductsRepository,
    labResults as unknown as ProductLabResultsRepository,
    listings as unknown as DispensaryListingsRepository,
  );
  return { service, products, labResults, listings };
}

const DEFAULT_LISTINGS_QUERY: ProductListingsQuery = { limit: 24, offset: 0 };

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

describe('ProductsService.getListings', () => {
  it('404s before touching the listings repo when the product is missing', async () => {
    const rig = makeRig();

    await expect(rig.service.getListings('ghost', DEFAULT_LISTINGS_QUERY)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.listings.calls).toHaveLength(0);
  });

  it('404s a soft-deleted product', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1', deletedAt: new Date('2026-05-15T00:00:00.000Z') }));

    await expect(rig.service.getListings('p1', DEFAULT_LISTINGS_QUERY)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('404s an inactive product', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ id: 'p1', isActive: false }));

    await expect(rig.service.getListings('p1', DEFAULT_LISTINGS_QUERY)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('projects listing rows into the public row shape and resolves the store name', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.listings.next = {
      results: [
        {
          listing: makeListing({
            id: '01935f3d-0000-7000-8000-0000000000c1',
            dispensaryId: '01935f3d-0000-7000-8000-000000000fa1',
            sku: 'SS-ST-35',
            priceCents: 4500,
            compareAtPriceCents: 5000,
            quantityAvailable: 7,
          }),
          dispensaryName: 'The Grove',
        },
      ],
      total: 1,
    };

    const res = await rig.service.getListings(
      '01935f3d-0000-7000-8000-000000000001',
      DEFAULT_LISTINGS_QUERY,
    );

    expect(res.listings).toEqual([
      {
        listingId: '01935f3d-0000-7000-8000-0000000000c1',
        dispensaryId: '01935f3d-0000-7000-8000-000000000fa1',
        dispensaryName: 'The Grove',
        sku: 'SS-ST-35',
        priceCents: 4500,
        compareAtPriceCents: 5000,
        quantityAvailable: 7,
      },
    ]);

    // Internal listing columns never leak into the projection.
    const projected = res.listings[0] as Record<string, unknown>;
    expect(projected['productId']).toBeUndefined();
    expect(projected['isActive']).toBeUndefined();
    expect(projected['imageKeys']).toBeUndefined();
  });

  it('passes limit/offset to the repo and echoes them plus the repo total in the page', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.listings.next = { results: [], total: 42 };

    const res = await rig.service.getListings('01935f3d-0000-7000-8000-000000000001', {
      limit: 10,
      offset: 20,
    });

    expect(rig.listings.calls[0]).toEqual({
      productId: '01935f3d-0000-7000-8000-000000000001',
      input: { limit: 10, offset: 20 },
    });
    expect(res.page).toEqual({ limit: 10, offset: 20, total: 42 });
  });

  it('returns an empty listing page for a live-but-uncarried product', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.listings.next = { results: [], total: 0 };

    const res = await rig.service.getListings(
      '01935f3d-0000-7000-8000-000000000001',
      DEFAULT_LISTINGS_QUERY,
    );

    expect(res).toEqual({ listings: [], page: { limit: 24, offset: 0, total: 0 } });
  });
});

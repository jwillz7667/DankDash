/**
 * Unit tests for VendorListingsService.
 *
 * Behaviours pinned:
 *   - list()    returns every row (active + inactive) for the dispensary,
 *               sorted updated-then-created descending.
 *   - create()  throws ValidationError when the productId references a row
 *               that does not exist, is soft-deleted, or is inactive.
 *   - create()  throws ConflictError LISTING_SKU_TAKEN when the
 *               (dispensaryId, sku) pre-flight sees a row.
 *   - create()  forwards required fields, defaults nullable optionals to
 *               null, omits DB-defaulted fields so column defaults fire,
 *               and uses the dispensaryId from the ctx (not the body).
 *   - patch()   rejects empty bodies; 404s on missing rows AND on
 *               cross-dispensary access (findByIdForDispensary returns
 *               null); 404s when updateForDispensary returns null
 *               (concurrent delete between find and update).
 *   - patch()   enforces compareAt > price against the persisted row
 *               when only one side is in the patch.
 *   - patch()   pre-flights SKU rename against the unique index; skips
 *               the pre-flight when the SKU did not change.
 *   - patch()   forwards only present fields to updateForDispensary
 *               (never `dispensaryId`, which is fixed by URL).
 *   - delete()  returns 404 when softDeleteForDispensary reports
 *               no row matched (missing or cross-vendor).
 *
 * The `withScope` GUC plumbing is covered separately by the integration
 * tests in Phase 4.8; here we fake `db.transaction` so the unit test
 * exercises the business logic without a Postgres connection.
 */
import assert from 'node:assert/strict';
import { NotFoundError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { MemoryCatalogCacheStore } from '../../catalog-cache/catalog-cache-store.js';
import { CatalogCacheService } from '../../catalog-cache/catalog-cache.service.js';
import {
  VendorListingsService,
  type ScopedRepos,
  type ScopedReposFactory,
} from './vendor-listings.service.js';
import type { PatchListingRequest } from './dto/index.js';
import type { VendorContext } from './vendor-context.types.js';
import type {
  Database,
  DispensaryListing,
  DispensaryListingsRepository,
  NewDispensaryListing,
  Product,
  ProductsRepository,
} from '@dankdash/db';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000ff';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const STAFF_ID = '01935f3d-0000-7000-8000-000000000050';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000020';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const OTHER_LISTING_ID = '01935f3d-0000-7000-8000-000000000031';

const CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: USER_ID,
  staffRole: 'manager',
  staffMemberId: STAFF_ID,
};

function makeProduct(overrides: Partial<Product> = {}): Product {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: PRODUCT_ID,
    categoryId: '01935f3d-0000-7000-8000-000000000040',
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
    createdByDispensaryId: null,
    effectsTags: [],
    flavorTags: [],
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeListing(overrides: Partial<DispensaryListing> = {}): DispensaryListing {
  const createdAt = new Date('2026-01-10T00:00:00.000Z');
  return {
    id: LISTING_ID,
    dispensaryId: DISPENSARY_ID,
    productId: PRODUCT_ID,
    sku: 'NS-PE-3.5G',
    priceCents: 4500,
    compareAtPriceCents: null,
    quantityAvailable: 10,
    imageKeys: [],
    metrcPackageTag: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

class FakeListingsRepo implements Pick<
  DispensaryListingsRepository,
  | 'listAllForDispensary'
  | 'listAllForDispensaryWithProducts'
  | 'findByIdForDispensary'
  | 'findByDispensaryAndSku'
  | 'create'
  | 'updateForDispensary'
  | 'softDeleteForDispensary'
  | 'stampActiveSyncedForDispensary'
> {
  public rows = new Map<string, DispensaryListing>();
  public createCalls: (Omit<NewDispensaryListing, 'id'> & { id?: string })[] = [];
  public updateCalls: {
    id: string;
    dispensaryId: string;
    patch: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt' | 'dispensaryId'>>;
  }[] = [];
  public deleteCalls: { id: string; dispensaryId: string }[] = [];
  public syncCalls: string[] = [];
  public stampNow: Date = new Date('2026-05-20T12:00:00.000Z');
  public productsByListing = new Map<string, Product>();

  seed(row: DispensaryListing): void {
    this.rows.set(row.id, row);
  }

  listAllForDispensary(dispensaryId: string): Promise<readonly DispensaryListing[]> {
    const rows = [...this.rows.values()].filter((r) => r.dispensaryId === dispensaryId);
    rows.sort((a, b) => {
      const u = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (u !== 0) return u;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    return Promise.resolve(rows);
  }

  listAllForDispensaryWithProducts(
    dispensaryId: string,
  ): Promise<readonly { readonly listing: DispensaryListing; readonly product: Product }[]> {
    const rows = [...this.rows.values()].filter((r) => r.dispensaryId === dispensaryId);
    rows.sort((a, b) => {
      const u = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (u !== 0) return u;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    return Promise.resolve(
      rows.map((listing) => ({
        listing,
        product: this.productsByListing.get(listing.id) ?? makeProduct({ id: listing.productId }),
      })),
    );
  }

  findByIdForDispensary(id: string, dispensaryId: string): Promise<DispensaryListing | null> {
    const row = this.rows.get(id);
    if (row?.dispensaryId !== dispensaryId) return Promise.resolve(null);
    return Promise.resolve(row);
  }

  findByDispensaryAndSku(dispensaryId: string, sku: string): Promise<DispensaryListing | null> {
    const row = [...this.rows.values()].find(
      (r) => r.dispensaryId === dispensaryId && r.sku === sku,
    );
    return Promise.resolve(row ?? null);
  }

  create(input: Omit<NewDispensaryListing, 'id'> & { id?: string }): Promise<DispensaryListing> {
    this.createCalls.push(input);
    const row: DispensaryListing = {
      id: input.id ?? '01935f3d-0000-7000-8000-0000000000aa',
      dispensaryId: input.dispensaryId,
      productId: input.productId,
      sku: input.sku,
      priceCents: input.priceCents,
      compareAtPriceCents: input.compareAtPriceCents ?? null,
      quantityAvailable: input.quantityAvailable ?? 0,
      imageKeys: input.imageKeys ?? [],
      metrcPackageTag: input.metrcPackageTag ?? null,
      lastSyncedAt: null,
      isActive: true,
      createdAt: new Date('2026-05-18T19:00:00.000Z'),
      updatedAt: new Date('2026-05-18T19:00:00.000Z'),
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  updateForDispensary(
    id: string,
    dispensaryId: string,
    patch: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt' | 'dispensaryId'>>,
  ): Promise<DispensaryListing | null> {
    this.updateCalls.push({ id, dispensaryId, patch });
    const existing = this.rows.get(id);
    if (existing?.dispensaryId !== dispensaryId) {
      return Promise.resolve(null);
    }
    const next: DispensaryListing = {
      ...existing,
      ...(patch as unknown as Partial<DispensaryListing>),
      updatedAt: new Date('2026-05-18T20:00:00.000Z'),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  softDeleteForDispensary(id: string, dispensaryId: string): Promise<boolean> {
    this.deleteCalls.push({ id, dispensaryId });
    const existing = this.rows.get(id);
    if (existing?.dispensaryId !== dispensaryId || !existing.isActive) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...existing, isActive: false, updatedAt: new Date() });
    return Promise.resolve(true);
  }

  stampActiveSyncedForDispensary(
    dispensaryId: string,
  ): Promise<{ readonly updated: number; readonly syncedAt: Date }> {
    this.syncCalls.push(dispensaryId);
    const now = this.stampNow;
    let updated = 0;
    for (const [id, row] of this.rows) {
      if (row.dispensaryId !== dispensaryId || !row.isActive) continue;
      this.rows.set(id, { ...row, lastSyncedAt: now, updatedAt: now });
      updated += 1;
    }
    return Promise.resolve({ updated, syncedAt: now });
  }
}

class FakeProductsRepo implements Pick<ProductsRepository, 'findById'> {
  public rows = new Map<string, Product>();

  seed(p: Product): void {
    this.rows.set(p.id, p);
  }

  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

/**
 * Test rig — fakes the only `Database` method the service uses
 * (`transaction(fn)`), invokes the callback with a `tx` whose
 * `.execute()` is a no-op so the `set_config(...)` SQL does not blow
 * up, and threads the in-memory FakeListingsRepo + FakeProductsRepo
 * through the scoped-repo factory.
 */
interface Rig {
  readonly service: VendorListingsService;
  readonly listings: FakeListingsRepo;
  readonly products: FakeProductsRepo;
}

function makeRig(): Rig {
  const listings = new FakeListingsRepo();
  const products = new FakeProductsRepo();
  const tx = {
    execute: (): Promise<unknown> => Promise.resolve(undefined),
  };
  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Database;
  const reposFor: ScopedReposFactory = (): ScopedRepos => ({
    listings: listings as unknown as DispensaryListingsRepository,
    products: products as unknown as ProductsRepository,
  });
  const cache = new CatalogCacheService(new MemoryCatalogCacheStore());
  const service = new VendorListingsService(fakeDb, reposFor, cache);
  return { service, listings, products };
}

describe('VendorListingsService.list', () => {
  it('returns all rows for the dispensary, sorted updated-then-created desc', async () => {
    const rig = makeRig();
    rig.listings.seed(
      makeListing({
        id: LISTING_ID,
        sku: 'A',
        updatedAt: new Date('2026-05-10T00:00:00.000Z'),
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    );
    rig.listings.seed(
      makeListing({
        id: OTHER_LISTING_ID,
        sku: 'B',
        updatedAt: new Date('2026-05-15T00:00:00.000Z'),
        createdAt: new Date('2026-05-15T00:00:00.000Z'),
      }),
    );
    // Cross-dispensary row should NOT leak into the list.
    rig.listings.seed(
      makeListing({
        id: '01935f3d-0000-7000-8000-0000000000ee',
        sku: 'C',
        dispensaryId: OTHER_DISPENSARY_ID,
      }),
    );

    const res = await rig.service.list(CTX);

    expect(res.listings.map((l) => l.sku)).toEqual(['B', 'A']);
  });

  it('returns inactive rows so the vendor portal can reactivate from the list view', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ isActive: false }));

    const res = await rig.service.list(CTX);

    expect(res.listings).toHaveLength(1);
    expect(res.listings[0]?.isActive).toBe(false);
  });

  it('serializes Date fields to ISO strings on the projection', async () => {
    const rig = makeRig();
    rig.listings.seed(
      makeListing({
        lastSyncedAt: new Date('2026-04-01T12:00:00.000Z'),
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-15T00:00:00.000Z'),
      }),
    );

    const res = await rig.service.list(CTX);

    expect(res.listings[0]?.lastSyncedAt).toBe('2026-04-01T12:00:00.000Z');
    expect(res.listings[0]?.createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(res.listings[0]?.updatedAt).toBe('2026-03-15T00:00:00.000Z');
  });

  it('embeds a product summary on every row (brand, name, type, imageKeys)', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());
    rig.listings.productsByListing.set(
      LISTING_ID,
      makeProduct({
        brand: 'North Star',
        name: 'Pineapple Express 3.5g',
        productType: 'flower',
        strainType: 'sativa',
        imageKeys: ['catalog/north-star-pe.jpg'],
        thcMgPerUnit: '875.000',
        weightGramsPerUnit: '3.500',
      }),
    );

    const res = await rig.service.list(CTX);

    expect(res.listings).toHaveLength(1);
    expect(res.listings[0]?.product).toMatchObject({
      brand: 'North Star',
      name: 'Pineapple Express 3.5g',
      productType: 'flower',
      strainType: 'sativa',
      imageKeys: ['catalog/north-star-pe.jpg'],
      thcMgPerUnit: '875.000',
      weightGramsPerUnit: '3.500',
      isActive: true,
      deletedAt: null,
    });
  });

  it('surfaces soft-deleted products so the vendor knows why the listing is hidden', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());
    rig.listings.productsByListing.set(
      LISTING_ID,
      makeProduct({
        deletedAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
    );

    const res = await rig.service.list(CTX);

    expect(res.listings[0]?.product.deletedAt).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('VendorListingsService.create', () => {
  it('inserts a row scoped to ctx.dispensaryId, defaults nullable optionals to null', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    const res = await rig.service.create(CTX, {
      productId: PRODUCT_ID,
      sku: 'NS-PE-3.5G',
      priceCents: 4500,
    });

    expect(rig.listings.createCalls).toHaveLength(1);
    const input = rig.listings.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.dispensaryId).toBe(DISPENSARY_ID);
    expect(input.compareAtPriceCents).toBeNull();
    expect(input.metrcPackageTag).toBeNull();
    expect((input as { quantityAvailable?: unknown }).quantityAvailable).toBeUndefined();
    expect(res.dispensaryId).toBe(DISPENSARY_ID);
  });

  it('forwards optional fields when supplied', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    await rig.service.create(CTX, {
      productId: PRODUCT_ID,
      sku: 'NS-PE-3.5G',
      priceCents: 4500,
      compareAtPriceCents: 5500,
      quantityAvailable: 12,
      metrcPackageTag: '1A4060300002F62000000045',
    });

    const input = rig.listings.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.compareAtPriceCents).toBe(5500);
    expect(input.quantityAvailable).toBe(12);
    expect(input.metrcPackageTag).toBe('1A4060300002F62000000045');
  });

  it('forwards imageKeys owned by the dispensary on create', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    const keys = [`dispensaries/${DISPENSARY_ID}/listings/a.jpg`];

    const res = await rig.service.create(CTX, {
      productId: PRODUCT_ID,
      sku: 'NS-PE-3.5G',
      priceCents: 4500,
      imageKeys: keys,
    });

    expect(rig.listings.createCalls[0]?.imageKeys).toEqual(keys);
    expect(res.imageKeys).toEqual(keys);
  });

  it('rejects create when an imageKey is not under the dispensary prefix (cross-tenant guard)', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    await expect(
      rig.service.create(CTX, {
        productId: PRODUCT_ID,
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
        imageKeys: [`dispensaries/${OTHER_DISPENSARY_ID}/listings/stolen.jpg`],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.listings.createCalls).toEqual([]);
  });

  it('throws ValidationError when the product does not exist', async () => {
    const rig = makeRig();

    await expect(
      rig.service.create(CTX, {
        productId: PRODUCT_ID,
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.listings.createCalls).toEqual([]);
  });

  it('throws ValidationError when the product is soft-deleted', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(
      rig.service.create(CTX, {
        productId: PRODUCT_ID,
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the product is inactive', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ isActive: false }));

    await expect(
      rig.service.create(CTX, {
        productId: PRODUCT_ID,
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ConflictError LISTING_SKU_TAKEN on duplicate (dispensaryId, sku)', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.listings.seed(makeListing({ sku: 'NS-PE-3.5G' }));

    await expect(
      rig.service.create(CTX, {
        productId: PRODUCT_ID,
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
      }),
    ).rejects.toMatchObject({
      code: 'LISTING_SKU_TAKEN',
    });
    expect(rig.listings.createCalls).toEqual([]);
  });

  it('does NOT see SKU collision when the conflicting row belongs to another dispensary', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());
    rig.listings.seed(
      makeListing({
        id: '01935f3d-0000-7000-8000-0000000000ee',
        sku: 'NS-PE-3.5G',
        dispensaryId: OTHER_DISPENSARY_ID,
      }),
    );

    const res = await rig.service.create(CTX, {
      productId: PRODUCT_ID,
      sku: 'NS-PE-3.5G',
      priceCents: 4500,
    });

    expect(res.sku).toBe('NS-PE-3.5G');
  });
});

describe('VendorListingsService.patch', () => {
  it('throws ValidationError on an empty body', async () => {
    const rig = makeRig();

    await expect(rig.service.patch(CTX, LISTING_ID, {})).rejects.toBeInstanceOf(ValidationError);
    expect(rig.listings.updateCalls).toEqual([]);
  });

  it('throws NotFoundError when the listing does not exist', async () => {
    const rig = makeRig();

    await expect(rig.service.patch(CTX, LISTING_ID, { priceCents: 5000 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFoundError when the listing belongs to another dispensary (info-leak guard)', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ dispensaryId: OTHER_DISPENSARY_ID }));

    await expect(rig.service.patch(CTX, LISTING_ID, { priceCents: 5000 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.listings.updateCalls).toEqual([]);
  });

  it('forwards only present fields to updateForDispensary, never dispensaryId', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());

    await rig.service.patch(CTX, LISTING_ID, {
      priceCents: 5000,
      quantityAvailable: 7,
      isActive: false,
    });

    expect(rig.listings.updateCalls).toHaveLength(1);
    const call = rig.listings.updateCalls[0];
    assert(call !== undefined, 'expected update call');
    expect(call.id).toBe(LISTING_ID);
    expect(call.dispensaryId).toBe(DISPENSARY_ID);
    expect(call.patch).toEqual({ priceCents: 5000, quantityAvailable: 7, isActive: false });
    expect((call.patch as { dispensaryId?: unknown }).dispensaryId).toBeUndefined();
  });

  it('allows nullable fields to be explicitly nulled', async () => {
    const rig = makeRig();
    rig.listings.seed(
      makeListing({ compareAtPriceCents: 5500, metrcPackageTag: '1A4060300002F62000000045' }),
    );

    await rig.service.patch(CTX, LISTING_ID, {
      compareAtPriceCents: null,
      metrcPackageTag: null,
    });

    expect(rig.listings.updateCalls[0]?.patch).toEqual({
      compareAtPriceCents: null,
      metrcPackageTag: null,
    });
  });

  it('rejects a price-only patch that pushes price above the persisted strike price', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ priceCents: 4500, compareAtPriceCents: 5000 }));

    // No compareAt in patch — service must merge with the persisted 5000.
    const patch: PatchListingRequest = { priceCents: 5500 };
    await expect(rig.service.patch(CTX, LISTING_ID, patch)).rejects.toBeInstanceOf(ValidationError);
    expect(rig.listings.updateCalls).toEqual([]);
  });

  it('rejects a compareAt-only patch that drops it below the persisted price', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ priceCents: 4500, compareAtPriceCents: 5500 }));

    await expect(
      rig.service.patch(CTX, LISTING_ID, { compareAtPriceCents: 4000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('treats explicit-null compareAt as a clear (no invariant check)', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ priceCents: 4500, compareAtPriceCents: 5500 }));

    await rig.service.patch(CTX, LISTING_ID, { compareAtPriceCents: null });

    expect(rig.listings.updateCalls[0]?.patch).toEqual({ compareAtPriceCents: null });
  });

  it('pre-flights SKU rename collision as ConflictError LISTING_SKU_TAKEN', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ id: LISTING_ID, sku: 'old-sku' }));
    rig.listings.seed(makeListing({ id: OTHER_LISTING_ID, sku: 'new-sku' }));

    await expect(rig.service.patch(CTX, LISTING_ID, { sku: 'new-sku' })).rejects.toMatchObject({
      code: 'LISTING_SKU_TAKEN',
    });
    expect(rig.listings.updateCalls).toEqual([]);
  });

  it('skips the SKU pre-flight when the patch leaves the SKU unchanged', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ sku: 'unchanged' }));

    await rig.service.patch(CTX, LISTING_ID, { sku: 'unchanged', priceCents: 5000 });

    expect(rig.listings.updateCalls).toHaveLength(1);
    expect(rig.listings.updateCalls[0]?.patch).toEqual({ sku: 'unchanged', priceCents: 5000 });
  });

  it('throws NotFoundError when updateForDispensary returns null (concurrent delete)', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());
    // Make updateForDispensary always return null to simulate the row being
    // gone between the find and the update.
    rig.listings.updateForDispensary = (
      _id: string,
      _dispensaryId: string,
      patch: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt' | 'dispensaryId'>>,
    ): Promise<DispensaryListing | null> => {
      rig.listings.updateCalls.push({ id: _id, dispensaryId: _dispensaryId, patch });
      return Promise.resolve(null);
    };

    await expect(rig.service.patch(CTX, LISTING_ID, { priceCents: 5000 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('surfaces the inflated projection on a successful patch', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ priceCents: 4500, sku: 'NS-PE-3.5G' }));

    const res = await rig.service.patch(CTX, LISTING_ID, { priceCents: 6000 });

    expect(res.priceCents).toBe(6000);
    expect(res.sku).toBe('NS-PE-3.5G');
  });

  it('forwards owned imageKeys on patch and reflects them on the projection', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());
    const keys = [`dispensaries/${DISPENSARY_ID}/listings/new.webp`];

    const res = await rig.service.patch(CTX, LISTING_ID, { imageKeys: keys });

    expect(rig.listings.updateCalls[0]?.patch).toEqual({ imageKeys: keys });
    expect(res.imageKeys).toEqual(keys);
  });

  it('accepts an empty imageKeys patch to clear every image', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ imageKeys: [`dispensaries/${DISPENSARY_ID}/listings/x.jpg`] }));

    const res = await rig.service.patch(CTX, LISTING_ID, { imageKeys: [] });

    expect(rig.listings.updateCalls[0]?.patch).toEqual({ imageKeys: [] });
    expect(res.imageKeys).toEqual([]);
  });

  it('rejects a patch carrying an imageKey under another dispensary prefix', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());

    await expect(
      rig.service.patch(CTX, LISTING_ID, {
        imageKeys: [`dispensaries/${OTHER_DISPENSARY_ID}/listings/stolen.jpg`],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.listings.updateCalls).toEqual([]);
  });
});

describe('VendorListingsService.delete', () => {
  it('deactivates a matching row', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing());

    await rig.service.delete(CTX, LISTING_ID);

    expect(rig.listings.deleteCalls).toEqual([{ id: LISTING_ID, dispensaryId: DISPENSARY_ID }]);
    expect(rig.listings.rows.get(LISTING_ID)?.isActive).toBe(false);
  });

  it('throws NotFoundError when the row does not exist', async () => {
    const rig = makeRig();

    await expect(rig.service.delete(CTX, LISTING_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the row belongs to another dispensary (info-leak guard)', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ dispensaryId: OTHER_DISPENSARY_ID }));

    await expect(rig.service.delete(CTX, LISTING_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('VendorListingsService.sync', () => {
  it('stamps every active listing scoped to the dispensary and returns ISO syncedAt', async () => {
    const rig = makeRig();
    rig.listings.stampNow = new Date('2026-05-20T12:00:00.000Z');
    rig.listings.seed(makeListing({ id: LISTING_ID, isActive: true }));
    rig.listings.seed(makeListing({ id: OTHER_LISTING_ID, sku: 'NS-OTHER', isActive: true }));
    rig.listings.seed(
      makeListing({ id: '01935f3d-0000-7000-8000-000000000099', sku: 'inactive', isActive: false }),
    );
    rig.listings.seed(
      makeListing({
        id: '01935f3d-0000-7000-8000-0000000000ee',
        sku: 'cross-vendor',
        dispensaryId: OTHER_DISPENSARY_ID,
      }),
    );

    const res = await rig.service.sync(CTX);

    expect(rig.listings.syncCalls).toEqual([DISPENSARY_ID]);
    expect(res).toEqual({ updated: 2, syncedAt: '2026-05-20T12:00:00.000Z' });
    // The two active rows in the dispensary should now show the new stamp.
    expect(rig.listings.rows.get(LISTING_ID)?.lastSyncedAt?.toISOString()).toBe(
      '2026-05-20T12:00:00.000Z',
    );
    expect(rig.listings.rows.get(OTHER_LISTING_ID)?.lastSyncedAt?.toISOString()).toBe(
      '2026-05-20T12:00:00.000Z',
    );
    // The inactive row in this dispensary must NOT be stamped — public menu
    // doesn't show it; stamping would be a misleading freshness signal.
    expect(rig.listings.rows.get('01935f3d-0000-7000-8000-000000000099')?.lastSyncedAt).toBeNull();
    // Cross-vendor row must not be touched.
    expect(rig.listings.rows.get('01935f3d-0000-7000-8000-0000000000ee')?.lastSyncedAt).toBeNull();
  });

  it('returns updated=0 when the dispensary has no active listings', async () => {
    const rig = makeRig();
    rig.listings.seed(makeListing({ isActive: false }));

    const res = await rig.service.sync(CTX);

    expect(res.updated).toBe(0);
    expect(typeof res.syncedAt).toBe('string');
  });
});

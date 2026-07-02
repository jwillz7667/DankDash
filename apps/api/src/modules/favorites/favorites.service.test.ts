/**
 * Unit tests for FavoritesService.
 *
 * The service gates saves on the target's existence/active-status, upserts
 * idempotently, and hydrates the reverse-chron feed by batch-loading each
 * target through its own repository (never a join). Behaviours locked down:
 *
 *   - add*        → 404 when the target is missing / soft-deleted / inactive,
 *                   before any write; otherwise delegates to the repo upsert.
 *   - remove*     → always delegates; idempotent (no 404 for an unsaved target).
 *   - list        → projects dispensary saves through the shared
 *                   `projectDispensary` (live open/closed) and product saves
 *                   into the card summary (no lab results); preserves the
 *                   repo's ordering; drops saves whose target has since gone
 *                   inactive; echoes limit/offset + the raw total in the page.
 */
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { FavoritesService } from './favorites.service.js';
import type {
  Dispensary,
  DispensariesRepository,
  FavoritesPage,
  FavoritesPageInput,
  FavoritesRepository,
  Product,
  ProductsRepository,
  UserFavorite,
} from '@dankdash/db';
import type { FavoritesQuery } from './dto/index.js';

const USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000001';
const PRODUCT_ID = '01935f3d-0000-7000-8000-0000000000d1';
// 2026-05-18 (Mon) 14:00 America/Chicago = 19:00 UTC — sample store is open.
const NOON_MONDAY = new Date('2026-05-18T19:00:00.000Z');
const DEFAULT_QUERY: FavoritesQuery = { limit: 24, offset: 0 };

const SAMPLE_HOURS = {
  mon: { open: '09:00', close: '22:00' },
  tue: { open: '09:00', close: '22:00' },
  wed: { open: '09:00', close: '22:00' },
  thu: { open: '09:00', close: '22:00' },
  fri: { open: '09:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: DISPENSARY_ID,
    legalName: 'North Star Cannabis Co.',
    dba: 'North Star',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hoursJson: SAMPLE_HOURS,
    phone: '+16125551234',
    email: 'orders@northstar.example',
    logoImageKey: 'logos/north-star.png',
    heroImageKey: 'heroes/north-star.png',
    brandColorHex: '#0E5E2A',
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: '4.87',
    ratingCount: 421,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  } as Dispensary;
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: PRODUCT_ID,
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
    effectsTags: ['uplifting'],
    flavorTags: ['citrus'],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  } as Product;
}

function dispensaryFavorite(dispensaryId: string, createdAt: Date): UserFavorite {
  return {
    id: `fav-${dispensaryId}`,
    userId: USER_ID,
    favoritableType: 'dispensary',
    dispensaryId,
    productId: null,
    createdAt,
  };
}

function productFavorite(productId: string, createdAt: Date): UserFavorite {
  return {
    id: `fav-${productId}`,
    userId: USER_ID,
    favoritableType: 'product',
    dispensaryId: null,
    productId,
    createdAt,
  };
}

class FakeFavoritesRepo {
  public added: { readonly kind: 'dispensary' | 'product'; readonly id: string }[] = [];
  public removed: { readonly kind: 'dispensary' | 'product'; readonly id: string }[] = [];
  public listInput: FavoritesPageInput | null = null;
  public page: FavoritesPage = { rows: [], total: 0 };

  addDispensary(_userId: string, dispensaryId: string): Promise<boolean> {
    this.added.push({ kind: 'dispensary', id: dispensaryId });
    return Promise.resolve(true);
  }
  removeDispensary(_userId: string, dispensaryId: string): Promise<boolean> {
    this.removed.push({ kind: 'dispensary', id: dispensaryId });
    return Promise.resolve(true);
  }
  addProduct(_userId: string, productId: string): Promise<boolean> {
    this.added.push({ kind: 'product', id: productId });
    return Promise.resolve(true);
  }
  removeProduct(_userId: string, productId: string): Promise<boolean> {
    this.removed.push({ kind: 'product', id: productId });
    return Promise.resolve(true);
  }
  listForUser(_userId: string, input: FavoritesPageInput): Promise<FavoritesPage> {
    this.listInput = input;
    return Promise.resolve(this.page);
  }
}

class FakeDispensariesRepo {
  public readonly rows = new Map<string, Dispensary>();
  seed(row: Dispensary): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findManyByIds(ids: readonly string[]): Promise<readonly Dispensary[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const row = this.rows.get(id);
        return row === undefined ? [] : [row];
      }),
    );
  }
}

class FakeProductsRepo {
  public readonly rows = new Map<string, Product>();
  seed(row: Product): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findManyByIds(ids: readonly string[]): Promise<readonly Product[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const row = this.rows.get(id);
        return row === undefined ? [] : [row];
      }),
    );
  }
}

interface Rig {
  readonly service: FavoritesService;
  readonly favorites: FakeFavoritesRepo;
  readonly dispensaries: FakeDispensariesRepo;
  readonly products: FakeProductsRepo;
}

function makeRig(): Rig {
  const favorites = new FakeFavoritesRepo();
  const dispensaries = new FakeDispensariesRepo();
  const products = new FakeProductsRepo();
  const service = new FavoritesService(
    favorites as unknown as FavoritesRepository,
    dispensaries as unknown as DispensariesRepository,
    products as unknown as ProductsRepository,
  );
  return { service, favorites, dispensaries, products };
}

describe('FavoritesService.addDispensary', () => {
  it('saves an active dispensary', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    await rig.service.addDispensary(USER_ID, DISPENSARY_ID);

    expect(rig.favorites.added).toEqual([{ kind: 'dispensary', id: DISPENSARY_ID }]);
  });

  it('404s an unknown dispensary before writing', async () => {
    const rig = makeRig();
    await expect(rig.service.addDispensary(USER_ID, DISPENSARY_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.favorites.added).toEqual([]);
  });

  it('404s a soft-deleted dispensary', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-06-01T00:00:00.000Z') }));
    await expect(rig.service.addDispensary(USER_ID, DISPENSARY_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('404s a non-active dispensary', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'paused' }));
    await expect(rig.service.addDispensary(USER_ID, DISPENSARY_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('FavoritesService.addProduct', () => {
  it('saves an active product', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct());

    await rig.service.addProduct(USER_ID, PRODUCT_ID);

    expect(rig.favorites.added).toEqual([{ kind: 'product', id: PRODUCT_ID }]);
  });

  it('404s a soft-deleted product before writing', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ deletedAt: new Date('2026-06-01T00:00:00.000Z') }));
    await expect(rig.service.addProduct(USER_ID, PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.favorites.added).toEqual([]);
  });

  it('404s an inactive product', async () => {
    const rig = makeRig();
    rig.products.seed(makeProduct({ isActive: false }));
    await expect(rig.service.addProduct(USER_ID, PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('FavoritesService.remove*', () => {
  it('removes a dispensary favorite idempotently (no target lookup, no 404)', async () => {
    const rig = makeRig();
    await rig.service.removeDispensary(USER_ID, DISPENSARY_ID);
    expect(rig.favorites.removed).toEqual([{ kind: 'dispensary', id: DISPENSARY_ID }]);
  });

  it('removes a product favorite idempotently', async () => {
    const rig = makeRig();
    await rig.service.removeProduct(USER_ID, PRODUCT_ID);
    expect(rig.favorites.removed).toEqual([{ kind: 'product', id: PRODUCT_ID }]);
  });
});

describe('FavoritesService.list', () => {
  it('hydrates a mixed feed, preserving repo order and page envelope', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.products.seed(makeProduct());
    rig.favorites.page = {
      rows: [
        dispensaryFavorite(DISPENSARY_ID, new Date('2026-06-02T00:00:00.000Z')),
        productFavorite(PRODUCT_ID, new Date('2026-06-01T00:00:00.000Z')),
      ],
      total: 2,
    };

    const res = await rig.service.list(USER_ID, DEFAULT_QUERY, NOON_MONDAY);

    expect(rig.favorites.listInput).toEqual({ limit: 24, offset: 0 });
    expect(res.page).toEqual({ limit: 24, offset: 0, total: 2 });
    expect(res.favorites).toHaveLength(2);

    const [first, second] = res.favorites;
    expect(first).toMatchObject({ type: 'dispensary', favoritedAt: '2026-06-02T00:00:00.000Z' });
    if (first?.type !== 'dispensary') throw new Error('expected dispensary item');
    expect(first.dispensary.id).toBe(DISPENSARY_ID);
    expect(first.dispensary.isOpenNow).toBe(true);

    expect(second).toMatchObject({ type: 'product', favoritedAt: '2026-06-01T00:00:00.000Z' });
    if (second?.type !== 'product') throw new Error('expected product item');
    expect(second.product.id).toBe(PRODUCT_ID);
    // Product card summary carries no lab results.
    expect((second.product as Record<string, unknown>)['labResults']).toBeUndefined();
  });

  it('drops saves whose target has gone soft-deleted / inactive but keeps the raw total', async () => {
    const rig = makeRig();
    // Dispensary is tombstoned; product is inactive — both filtered out.
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-06-05T00:00:00.000Z') }));
    rig.products.seed(makeProduct({ isActive: false }));
    rig.favorites.page = {
      rows: [
        dispensaryFavorite(DISPENSARY_ID, new Date('2026-06-02T00:00:00.000Z')),
        productFavorite(PRODUCT_ID, new Date('2026-06-01T00:00:00.000Z')),
      ],
      total: 2,
    };

    const res = await rig.service.list(USER_ID, DEFAULT_QUERY, NOON_MONDAY);

    expect(res.favorites).toEqual([]);
    expect(res.page.total).toBe(2);
  });

  it('returns an empty feed for a user with no favorites', async () => {
    const rig = makeRig();
    const res = await rig.service.list(USER_ID, { limit: 10, offset: 20 }, NOON_MONDAY);
    expect(res).toEqual({ favorites: [], page: { limit: 10, offset: 20, total: 0 } });
  });
});

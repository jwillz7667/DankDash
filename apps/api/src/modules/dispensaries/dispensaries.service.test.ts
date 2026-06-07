/**
 * Unit tests for DispensariesService.
 *
 * The interesting behaviours to lock down:
 *
 *   - list()    → projection (geo + hours intact, internal columns absent),
 *                 routes through ST_Contains when both lat & lng are given,
 *                 plain listActive when neither is given.
 *   - getById() → projection + 404 on missing/soft-deleted/non-active.
 *   - getMenu() → 404 gating (404 dispensaries cannot leak as empty menus),
 *                 listing+product join, denormalised projection.
 *
 * `now` is pinned to a Monday at 14:00 America/Chicago — well inside the
 * 09:00–22:00 window of the sample dispensary — so `isOpenNow` and `opensAt`
 * are deterministic without invoking luxon directly in the test.
 */
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { MemoryCatalogCacheStore } from '../catalog-cache/catalog-cache-store.js';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service.js';
import { DispensariesService } from './dispensaries.service.js';
import type {
  Dispensary,
  DispensariesRepository,
  DispensaryListing,
  DispensaryListingsRepository,
  GeoPoint,
  Product,
} from '@dankdash/db';

// 2026-05-18 (Mon) 14:00 America/Chicago = 19:00 UTC — store is open.
const NOON_MONDAY = new Date('2026-05-18T19:00:00.000Z');
// 2026-05-19 (Tue) 03:00 America/Chicago = 08:00 UTC — store is closed
// (Mon close at 02:00, Tue open at 09:00). Inside MN's 02:00–08:00
// statutory dark window — every dispensary is forced closed regardless
// of declared hours.
const PRE_DAWN_TUESDAY = new Date('2026-05-19T08:00:00.000Z');

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
    id: '01935f3d-0000-7000-8000-000000000001',
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
  };
}

function makeListing(overrides: Partial<DispensaryListing> = {}): DispensaryListing {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000c1',
    dispensaryId: '01935f3d-0000-7000-8000-000000000001',
    productId: '01935f3d-0000-7000-8000-0000000000d1',
    sku: 'NS-SOUR-3.5',
    priceCents: 4500,
    compareAtPriceCents: 5000,
    quantityAvailable: 12,
    imageKeys: [],
    metrcPackageTag: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
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
    effectsTags: ['uplifting'],
    flavorTags: ['citrus'],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

class FakeDispensariesRepo implements Pick<
  DispensariesRepository,
  'findById' | 'listActive' | 'listDeliveringTo'
> {
  public rows = new Map<string, Dispensary>();
  public listActiveCalls = 0;
  public listDeliveringToCalls: GeoPoint[] = [];

  seed(d: Dispensary): void {
    this.rows.set(d.id, d);
  }

  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listActive(): Promise<readonly Dispensary[]> {
    this.listActiveCalls += 1;
    return Promise.resolve(
      [...this.rows.values()].filter((d) => d.status === 'active' && d.deletedAt === null),
    );
  }

  listDeliveringTo(point: GeoPoint): Promise<readonly Dispensary[]> {
    this.listDeliveringToCalls.push(point);
    // Fake: any active row matches; assertions check that this was routed.
    return Promise.resolve(
      [...this.rows.values()].filter((d) => d.status === 'active' && d.deletedAt === null),
    );
  }
}

class FakeListingsRepo implements Pick<DispensaryListingsRepository, 'listMenuForDispensary'> {
  public menu = new Map<string, readonly { listing: DispensaryListing; product: Product }[]>();

  seedMenu(
    dispensaryId: string,
    lines: readonly { listing: DispensaryListing; product: Product }[],
  ): void {
    this.menu.set(dispensaryId, lines);
  }

  listMenuForDispensary(
    dispensaryId: string,
  ): Promise<readonly { readonly listing: DispensaryListing; readonly product: Product }[]> {
    return Promise.resolve(this.menu.get(dispensaryId) ?? []);
  }
}

interface TestRig {
  readonly service: DispensariesService;
  readonly dispensaries: FakeDispensariesRepo;
  readonly listings: FakeListingsRepo;
}

function makeRig(): TestRig {
  const dispensaries = new FakeDispensariesRepo();
  const listings = new FakeListingsRepo();
  const cache = new CatalogCacheService(new MemoryCatalogCacheStore());
  const service = new DispensariesService(
    dispensaries as unknown as DispensariesRepository,
    listings as unknown as DispensaryListingsRepository,
    cache,
  );
  return { service, dispensaries, listings };
}

describe('DispensariesService.list', () => {
  it('routes to listActive when neither lat nor lng is provided', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const res = await rig.service.list({}, NOON_MONDAY);

    expect(rig.dispensaries.listActiveCalls).toBe(1);
    expect(rig.dispensaries.listDeliveringToCalls).toEqual([]);
    expect(res).toHaveLength(1);
  });

  it('routes to listDeliveringTo with lng/lat (GeoJSON order) when both are provided', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    await rig.service.list({ lat: 44.97, lng: -93.27 }, NOON_MONDAY);

    expect(rig.dispensaries.listDeliveringToCalls).toEqual([
      { type: 'Point', coordinates: [-93.27, 44.97] },
    ]);
    expect(rig.dispensaries.listActiveCalls).toBe(0);
  });

  it('projects every dispensary row into the public DispensaryResponse shape', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const [res] = await rig.service.list({}, NOON_MONDAY);

    expect(res).toEqual({
      id: '01935f3d-0000-7000-8000-000000000001',
      legalName: 'North Star Cannabis Co.',
      dba: 'North Star',
      licenseNumber: 'OCM-12345',
      licenseType: 'retailer',
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
      hours: SAMPLE_HOURS,
      phone: '+16125551234',
      email: 'orders@northstar.example',
      logoImageKey: 'logos/north-star.png',
      heroImageKey: 'heroes/north-star.png',
      brandColorHex: '#0E5E2A',
      isAcceptingOrders: true,
      isOpenNow: true,
      opensAt: null,
      ratingAvg: '4.87',
      ratingCount: 421,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('computes isOpenNow=false and opensAt as ISO when closed at the moment', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const [res] = await rig.service.list({}, PRE_DAWN_TUESDAY);

    expect(res?.isOpenNow).toBe(false);
    // Next open is Tue 09:00 America/Chicago = 14:00 UTC.
    expect(res?.opensAt).toBe('2026-05-19T14:00:00.000Z');
  });
});

describe('DispensariesService.getById', () => {
  it('projects a single dispensary row', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const res = await rig.service.getById('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(res.id).toBe('01935f3d-0000-7000-8000-000000000001');
    expect(res.isOpenNow).toBe(true);
  });

  it('throws NotFoundError when the dispensary does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.getById('ghost', NOON_MONDAY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the dispensary is soft-deleted', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-05-15T00:00:00.000Z') }));
    await expect(
      rig.service.getById('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(['onboarding', 'paused', 'terminated'] as const)(
    'throws NotFoundError when status is %s (only active is public)',
    async (status) => {
      const rig = makeRig();
      rig.dispensaries.seed(makeDispensary({ status }));
      await expect(
        rig.service.getById('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );
});

describe('DispensariesService.getMenu', () => {
  it('projects the listing+product join into the menu response shape', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.listings.seedMenu('01935f3d-0000-7000-8000-000000000001', [
      { listing: makeListing(), product: makeProduct() },
    ]);

    const res = await rig.service.getMenu('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(res).toEqual({
      dispensaryId: '01935f3d-0000-7000-8000-000000000001',
      items: [
        {
          listingId: '01935f3d-0000-7000-8000-0000000000c1',
          sku: 'NS-SOUR-3.5',
          priceCents: 4500,
          compareAtPriceCents: 5000,
          quantityAvailable: 12,
          product: {
            id: '01935f3d-0000-7000-8000-0000000000d1',
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
            effectsTags: ['uplifting'],
            flavorTags: ['citrus'],
          },
        },
      ],
    });
  });

  it('renders per-listing imageKeys over the shared product images when present', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    const listingImages = [
      'dispensaries/01935f3d-0000-7000-8000-000000000001/listings/own-a.jpg',
      'dispensaries/01935f3d-0000-7000-8000-000000000001/listings/own-b.webp',
    ];
    rig.listings.seedMenu('01935f3d-0000-7000-8000-000000000001', [
      { listing: makeListing({ imageKeys: listingImages }), product: makeProduct() },
    ]);

    const res = await rig.service.getMenu('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    // The vendor's own photos win over the catalog default on the menu card.
    expect(res.items[0]?.product.imageKeys).toEqual(listingImages);
  });

  it('falls back to the shared product images when the listing has no override', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.listings.seedMenu('01935f3d-0000-7000-8000-000000000001', [
      { listing: makeListing({ imageKeys: [] }), product: makeProduct() },
    ]);

    const res = await rig.service.getMenu('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(res.items[0]?.product.imageKeys).toEqual(['products/sunny-side/sour-tangie/01.jpg']);
  });

  it('returns an empty items array when the dispensary carries nothing', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const res = await rig.service.getMenu('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(res.items).toEqual([]);
  });

  it('throws NotFoundError when the dispensary does not exist (no empty-menu leak)', async () => {
    const rig = makeRig();
    rig.listings.seedMenu('ghost', [{ listing: makeListing(), product: makeProduct() }]);
    await expect(rig.service.getMenu('ghost', NOON_MONDAY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the dispensary is non-active even if listings exist', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'paused' }));
    rig.listings.seedMenu('01935f3d-0000-7000-8000-000000000001', [
      { listing: makeListing(), product: makeProduct() },
    ]);
    await expect(
      rig.service.getMenu('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

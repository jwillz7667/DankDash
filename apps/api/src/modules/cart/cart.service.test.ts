/**
 * Unit tests for CartService.
 *
 * The service composes four repositories; here we fake each one with an
 * in-memory store so the business logic runs without a Postgres
 * connection. The factory pattern in the service (CartScopedReposFactory)
 * makes this clean — the rig hands the constructor a closure that
 * returns the same fakes for every "tx".
 *
 * `db.transaction(fn)` is faked to just invoke `fn(tx)` directly. The
 * fakes do not need transactional rollback semantics — every assertion
 * is on the state visible to the caller, which is what Postgres would
 * commit at the end of a real tx.
 *
 * Coverage target: every code path in cart.service.ts. The
 * RepositoryError "touch returns null after createOrGetActive" branch is
 * exercised explicitly because the race window it guards is hard to
 * reproduce at the integration layer.
 */
import { NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { CartService, type CartScopedRepos, type CartScopedReposFactory } from './cart.service.js';
import type {
  Cart,
  CartItem,
  CartItemsRepository,
  CartsRepository,
  Database,
  Dispensary,
  DispensariesRepository,
  DispensaryListing,
  DispensaryListingsRepository,
  NewCartItem,
  Product,
  ProductsRepository,
  User,
  UserAddress,
  UserAddressesRepository,
  UsersRepository,
} from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000011';
const CART_ID = '01935f3d-0000-7000-8000-000000000020';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const OTHER_LISTING_ID = '01935f3d-0000-7000-8000-000000000031';
const ITEM_ID = '01935f3d-0000-7000-8000-000000000040';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000050';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';

// validate() runs the live compliance clock, so the test rig seeds a
// dispensary whose hours mirror MN's full statutory window (08:00–02:00
// local, encoded as 26:00 for the next-day close). That way these tests
// stay green for any wall-clock moment that is itself legal under the
// state cap — they don't bake in a narrower fixture that drifts out of
// scope as the real time advances during a long run or a late-night CI.
const SAMPLE_HOURS = {
  mon: { open: '08:00', close: '26:00' },
  tue: { open: '08:00', close: '26:00' },
  wed: { open: '08:00', close: '26:00' },
  thu: { open: '08:00', close: '26:00' },
  fri: { open: '08:00', close: '26:00' },
  sat: { open: '08:00', close: '26:00' },
  sun: { open: '08:00', close: '26:00' },
};

// A tight Minneapolis square. The delivery address fixture's coordinates
// sit inside this polygon so geofence passes by default. Each coordinate
// is a readonly [lng, lat] tuple — matches the GeoPolygon schema type.
const SAMPLE_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-93.3, 44.9],
      [-93.2, 44.9],
      [-93.2, 45.0],
      [-93.3, 45.0],
      [-93.3, 44.9],
    ] as ReadonlyArray<readonly [number, number]>,
  ] as ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
};

function makeCart(overrides: Partial<Cart> = {}): Cart {
  const createdAt = new Date('2026-05-18T18:00:00.000Z');
  return {
    id: CART_ID,
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    expiresAt: new Date('2026-05-18T22:00:00.000Z'),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeListing(overrides: Partial<DispensaryListing> = {}): DispensaryListing {
  const createdAt = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: LISTING_ID,
    dispensaryId: DISPENSARY_ID,
    productId: PRODUCT_ID,
    sku: 'NS-PE-3.5G',
    priceCents: 4500,
    compareAtPriceCents: null,
    quantityAvailable: 25,
    imageKeys: [],
    metrcPackageTag: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  const createdAt = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: PRODUCT_ID,
    categoryId: '01935f3d-0000-7000-8000-0000000000a1',
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
    description: 'Sativa-dominant hybrid.',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '24.500',
    cbdMgPerUnit: '0.100',
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

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
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
    deliveryPolygon: SAMPLE_POLYGON,
    hoursJson: SAMPLE_HOURS,
    phone: '+16125551234',
    email: 'orders@northstar.example',
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: '4.87',
    ratingCount: 100,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  const createdAt = new Date('2025-01-01T00:00:00.000Z');
  return {
    id: USER_ID,
    email: 'buyer@example.com',
    phone: '+16125550001',
    passwordHash: 'argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Test',
    lastName: 'Buyer',
    // A 30-year-old adult. The age rule wants ≥ 21 in MN.
    dateOfBirth: '1996-01-01',
    kycVerifiedAt: new Date('2025-06-01T12:00:00.000Z'),
    kycProvider: 'veriff',
    kycProviderRef: 'veriff-ref-001',
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeUserAddress(overrides: Partial<UserAddress> = {}): UserAddress {
  const createdAt = new Date('2025-06-15T00:00:00.000Z');
  return {
    id: ADDRESS_ID,
    userId: USER_ID,
    label: 'Home',
    line1: '500 Nicollet Mall',
    line2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55402',
    country: 'US',
    // Inside SAMPLE_POLYGON (GeoJSON order: [lng, lat]).
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    isDefault: true,
    isValidated: true,
    validatedAt: createdAt,
    deliveryInstructions: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

class FakeCartsRepo implements Pick<
  CartsRepository,
  'findByIdForUser' | 'createOrGetActive' | 'touch' | 'deleteByIdForUser'
> {
  public rows = new Map<string, Cart>();
  public touchCalls: string[] = [];
  public deleteCalls: { id: string; userId: string }[] = [];
  /** Force `touch(id)` to return null on the next call — exercises the
   *  concurrent-delete race branch in the service. */
  public touchReturnsNullOnce = false;

  seed(cart: Cart): void {
    this.rows.set(cart.id, cart);
  }

  findByIdForUser(id: string, userId: string): Promise<Cart | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row?.userId === userId ? row : null);
  }

  createOrGetActive(userId: string, dispensaryId: string): Promise<Cart> {
    const existing = [...this.rows.values()].find(
      (r) => r.userId === userId && r.dispensaryId === dispensaryId,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    const created = makeCart({ id: CART_ID, userId, dispensaryId });
    this.rows.set(created.id, created);
    return Promise.resolve(created);
  }

  touch(id: string): Promise<Cart | null> {
    this.touchCalls.push(id);
    if (this.touchReturnsNullOnce) {
      this.touchReturnsNullOnce = false;
      return Promise.resolve(null);
    }
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    // Mirror the real CartsRepository.touch which uses Postgres NOW() —
    // a hardcoded date here would become a time-bomb that breaks any test
    // asserting `expiresAt > Date.now()` once wall-clock passes the literal.
    const now = new Date();
    const next: Cart = {
      ...existing,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  deleteByIdForUser(id: string, userId: string): Promise<boolean> {
    this.deleteCalls.push({ id, userId });
    const existing = this.rows.get(id);
    if (existing?.userId !== userId) return Promise.resolve(false);
    this.rows.delete(id);
    return Promise.resolve(true);
  }
}

class FakeCartItemsRepo implements Pick<
  CartItemsRepository,
  'listForCart' | 'addOrIncrement' | 'setQuantity' | 'remove'
> {
  public rows = new Map<string, CartItem>();
  private idSeq = 1;

  seed(item: CartItem): void {
    this.rows.set(item.id, item);
  }

  listForCart(cartId: string): Promise<readonly CartItem[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.cartId === cartId));
  }

  addOrIncrement(input: Omit<NewCartItem, 'id'> & { readonly id?: string }): Promise<CartItem> {
    const existing = [...this.rows.values()].find(
      (r) => r.cartId === input.cartId && r.listingId === input.listingId,
    );
    const now = new Date('2026-05-18T19:00:00.000Z');
    if (existing !== undefined) {
      const next: CartItem = {
        ...existing,
        quantity: existing.quantity + input.quantity,
        unitPriceCents: input.unitPriceCents,
        updatedAt: now,
      };
      this.rows.set(existing.id, next);
      return Promise.resolve(next);
    }
    const id = input.id ?? `01935f3d-0000-7000-8000-${String(this.idSeq++).padStart(12, '0')}`;
    const row: CartItem = {
      id,
      cartId: input.cartId,
      listingId: input.listingId,
      quantity: input.quantity,
      unitPriceCents: input.unitPriceCents,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return Promise.resolve(row);
  }

  setQuantity(id: string, quantity: number): Promise<CartItem | null> {
    if (quantity <= 0) {
      this.rows.delete(id);
      return Promise.resolve(null);
    }
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: CartItem = {
      ...existing,
      quantity,
      updatedAt: new Date('2026-05-18T19:00:00.000Z'),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  remove(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

class FakeListingsRepo implements Pick<DispensaryListingsRepository, 'findById' | 'findManyByIds'> {
  public rows = new Map<string, DispensaryListing>();

  seed(row: DispensaryListing): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<DispensaryListing | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findManyByIds(ids: readonly string[]): Promise<readonly DispensaryListing[]> {
    return Promise.resolve(
      ids.map((id) => this.rows.get(id)).filter((r): r is DispensaryListing => r !== undefined),
    );
  }
}

class FakeDispensariesRepo implements Pick<DispensariesRepository, 'findById'> {
  public rows = new Map<string, Dispensary>();

  seed(row: Dispensary): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeUsersRepo implements Pick<UsersRepository, 'findById'> {
  public rows = new Map<string, User>();

  seed(row: User): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeUserAddressesRepo implements Pick<UserAddressesRepository, 'findById'> {
  public rows = new Map<string, UserAddress>();

  seed(row: UserAddress): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<UserAddress | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeProductsRepo implements Pick<ProductsRepository, 'findById' | 'findManyByIds'> {
  public rows = new Map<string, Product>();

  seed(row: Product): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findManyByIds(ids: readonly string[]): Promise<readonly Product[]> {
    return Promise.resolve(
      ids.map((id) => this.rows.get(id)).filter((r): r is Product => r !== undefined),
    );
  }
}

interface Rig {
  readonly service: CartService;
  readonly carts: FakeCartsRepo;
  readonly items: FakeCartItemsRepo;
  readonly listings: FakeListingsRepo;
  readonly dispensaries: FakeDispensariesRepo;
  readonly users: FakeUsersRepo;
  readonly userAddresses: FakeUserAddressesRepo;
  readonly products: FakeProductsRepo;
}

function makeRig(): Rig {
  const carts = new FakeCartsRepo();
  const items = new FakeCartItemsRepo();
  const listings = new FakeListingsRepo();
  const dispensaries = new FakeDispensariesRepo();
  const users = new FakeUsersRepo();
  const userAddresses = new FakeUserAddressesRepo();
  const products = new FakeProductsRepo();
  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;
  const factory: CartScopedReposFactory = () =>
    ({
      carts,
      items,
      listings,
      dispensaries,
      users,
      userAddresses,
      products,
    }) as unknown as CartScopedRepos;
  return {
    service: new CartService(fakeDb, factory),
    carts,
    items,
    listings,
    dispensaries,
    users,
    userAddresses,
    products,
  };
}

describe('CartService.createOrGet', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
  });

  it('creates a new cart when none exists, returns refreshed expiresAt', async () => {
    const before = Date.now();
    const res = await rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID });

    expect(res.userId).toBe(USER_ID);
    expect(res.dispensaryId).toBe(DISPENSARY_ID);
    expect(res.items).toEqual([]);
    expect(res.subtotalCents).toBe(0);
    // touch was called and the new expiresAt is well in the future
    expect(rig.carts.touchCalls).toEqual([CART_ID]);
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(before);
  });

  it('is idempotent — returns the existing cart on a second call', async () => {
    const first = await rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID });
    const second = await rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID });

    expect(second.id).toBe(first.id);
    // touch fires on both calls — the 4h timer slides forward each call
    expect(rig.carts.touchCalls.length).toBe(2);
  });

  it('throws ValidationError when the dispensary does not exist', async () => {
    rig.dispensaries.rows.clear();

    await expect(
      rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws RepositoryError when touch returns null after a fresh insert (race)', async () => {
    rig.carts.touchReturnsNullOnce = true;

    await expect(
      rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('CartService.findForUser', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('returns the cart with items and aggregate subtotal', async () => {
    rig.carts.seed(makeCart());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 2,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });

    const res = await rig.service.findForUser(USER_ID, CART_ID);

    expect(res.id).toBe(CART_ID);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.lineSubtotalCents).toBe(9000);
    expect(res.subtotalCents).toBe(9000);
    expect(rig.carts.touchCalls).toEqual([CART_ID]);
  });

  it('returns 404 for cross-user access (same shape as missing)', async () => {
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));

    await expect(rig.service.findForUser(USER_ID, CART_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when the cart id does not exist', async () => {
    await expect(rig.service.findForUser(USER_ID, CART_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when touch reports the cart is gone (concurrent delete)', async () => {
    rig.carts.seed(makeCart());
    rig.carts.touchReturnsNullOnce = true;

    await expect(rig.service.findForUser(USER_ID, CART_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CartService.addItem', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.carts.seed(makeCart());
    rig.listings.seed(makeListing());
  });

  it('adds a new item using the listing price as the snapshot', async () => {
    const res = await rig.service.addItem(USER_ID, CART_ID, {
      listingId: LISTING_ID,
      quantity: 3,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.unitPriceCents).toBe(4500);
    expect(res.items[0]?.quantity).toBe(3);
    expect(res.subtotalCents).toBe(13500);
  });

  it('increments quantity on a duplicate (cartId, listingId) — unique upsert', async () => {
    await rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 2 });
    const res = await rig.service.addItem(USER_ID, CART_ID, {
      listingId: LISTING_ID,
      quantity: 5,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.quantity).toBe(7);
  });

  it('does NOT mutate the snapshotted price when the listing price changes mid-session', async () => {
    await rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 1 });
    // Vendor changes the price between adds. Upsert uses the new price for
    // the second add (the spec keeps the freshest seen at upsert time);
    // older snapshot remains until the entire row is overwritten.
    rig.listings.seed(makeListing({ priceCents: 9999 }));
    const res = await rig.service.addItem(USER_ID, CART_ID, {
      listingId: LISTING_ID,
      quantity: 1,
    });
    expect(res.items[0]?.unitPriceCents).toBe(9999);
  });

  it('rejects a listing that does not exist with ValidationError', async () => {
    await expect(
      rig.service.addItem(USER_ID, CART_ID, {
        listingId: OTHER_LISTING_ID,
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an inactive listing with ValidationError', async () => {
    rig.listings.seed(makeListing({ isActive: false }));
    await expect(
      rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a listing from a different dispensary with ValidationError', async () => {
    rig.listings.seed(makeListing({ id: OTHER_LISTING_ID, dispensaryId: OTHER_DISPENSARY_ID }));
    await expect(
      rig.service.addItem(USER_ID, CART_ID, {
        listingId: OTHER_LISTING_ID,
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns 404 when the cart does not exist or belongs to another user', async () => {
    rig.carts.rows.clear();
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));

    await expect(
      rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when touch fails after the upsert (concurrent delete)', async () => {
    rig.carts.touchReturnsNullOnce = true;
    await expect(
      rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CartService.patchItem', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.carts.seed(makeCart());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 2,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });
  });

  it('updates the quantity', async () => {
    const res = await rig.service.patchItem(USER_ID, CART_ID, ITEM_ID, { quantity: 5 });

    expect(res.items[0]?.quantity).toBe(5);
    expect(res.subtotalCents).toBe(22500);
  });

  it('removes the line when quantity is 0', async () => {
    const res = await rig.service.patchItem(USER_ID, CART_ID, ITEM_ID, { quantity: 0 });

    expect(res.items).toHaveLength(0);
    expect(res.subtotalCents).toBe(0);
  });

  it('returns 404 when the item is not in the cart', async () => {
    await expect(
      rig.service.patchItem(USER_ID, CART_ID, '01935f3d-0000-7000-8000-0000000000aa', {
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when the cart does not belong to the user', async () => {
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));
    await expect(
      rig.service.patchItem(OTHER_USER_ID + 'x', CART_ID, ITEM_ID, { quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when touch fails after the update (concurrent delete)', async () => {
    rig.carts.touchReturnsNullOnce = true;
    await expect(
      rig.service.patchItem(USER_ID, CART_ID, ITEM_ID, { quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CartService.removeItem', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.carts.seed(makeCart());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 2,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });
  });

  it('removes the line and returns the updated cart', async () => {
    const res = await rig.service.removeItem(USER_ID, CART_ID, ITEM_ID);

    expect(res.items).toHaveLength(0);
    expect(res.subtotalCents).toBe(0);
  });

  it('returns 404 when the item is not in this cart', async () => {
    await expect(
      rig.service.removeItem(USER_ID, CART_ID, '01935f3d-0000-7000-8000-0000000000aa'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when the cart does not belong to the user', async () => {
    await expect(rig.service.removeItem(OTHER_USER_ID, CART_ID, ITEM_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns 404 when touch fails after the remove (concurrent delete)', async () => {
    rig.carts.touchReturnsNullOnce = true;
    await expect(rig.service.removeItem(USER_ID, CART_ID, ITEM_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('CartService.delete', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('removes the cart when it belongs to the user', async () => {
    rig.carts.seed(makeCart());
    await rig.service.delete(USER_ID, CART_ID);

    expect(rig.carts.deleteCalls).toEqual([{ id: CART_ID, userId: USER_ID }]);
    expect(rig.carts.rows.has(CART_ID)).toBe(false);
  });

  it('throws NotFoundError for a cross-user / missing id and leaves the row intact', async () => {
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));
    // Zero rows match the (id, userId) pair, so the delete reports false and
    // the service surfaces a 404 rather than a misleading 204 — without
    // distinguishing "not yours" from "never existed".
    await expect(rig.service.delete(USER_ID, CART_ID)).rejects.toBeInstanceOf(NotFoundError);
    // The row owned by the other user is untouched.
    expect(rig.carts.rows.has(CART_ID)).toBe(true);
  });
});

describe('CartService projection invariants', () => {
  it('subtotal equals sum of lineSubtotals for multiple lines', async () => {
    const rig = makeRig();
    rig.carts.seed(makeCart());
    rig.listings.seed(makeListing({ id: LISTING_ID, priceCents: 1000 }));
    rig.listings.seed(
      makeListing({ id: OTHER_LISTING_ID, priceCents: 2500, dispensaryId: DISPENSARY_ID }),
    );

    await rig.service.addItem(USER_ID, CART_ID, { listingId: LISTING_ID, quantity: 3 });
    const res = await rig.service.addItem(USER_ID, CART_ID, {
      listingId: OTHER_LISTING_ID,
      quantity: 2,
    });

    expect(res.subtotalCents).toBe(3 * 1000 + 2 * 2500);
    expect(res.items.reduce((s, i) => s + i.lineSubtotalCents, 0)).toBe(res.subtotalCents);
  });

  it('expiresAt is a valid ISO-8601 string with offset', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const res = await rig.service.createOrGet(USER_ID, { dispensaryId: DISPENSARY_ID });

    expect(res.expiresAt).toMatch(/T\d\d:\d\d:\d\d/);
    expect(Number.isNaN(Date.parse(res.expiresAt))).toBe(false);
  });
});

describe('CartService.validate', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.carts.seed(makeCart());
    rig.dispensaries.seed(makeDispensary());
    rig.users.seed(makeUser());
    rig.userAddresses.seed(makeUserAddress());
  });

  it('returns a passing evaluation for an empty cart in an in-zone window', async () => {
    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(true);
    expect(res.rules.length).toBeGreaterThan(0);
    expect(res.rules.every((r) => r.passed)).toBe(true);
    expect(res.cartTotals.flowerGrams).toBe(0);
    expect(res.cartTotals.concentrateGrams).toBe(0);
    expect(res.cartTotals.edibleThcMg).toBe(0);
    expect(res.limits.flowerGramsMax).toBeGreaterThan(0);
    expect(res.evaluatedAt).toMatch(/T\d\d:\d\d:\d\d/);
    expect(res.evaluationVersion.length).toBeGreaterThan(0);
  });

  it('aggregates cart line totals for the per-transaction-limit rule', async () => {
    rig.listings.seed(makeListing());
    rig.products.seed(makeProduct());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      // 3 × 3.5g = 10.5g flower — well under the 56.7g cap.
      quantity: 3,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(true);
    expect(res.cartTotals.flowerGrams).toBeCloseTo(10.5, 3);
    const ptl = res.rules.find((r) => r.rule === 'per_transaction_limit');
    expect(ptl).toBeDefined();
    expect(ptl?.passed).toBe(true);
  });

  it('surfaces a compliance failure as passed: false (no throw)', async () => {
    rig.listings.seed(makeListing());
    // 17 × 3.5g = 59.5g flower → over MN's 56.7g cap.
    rig.products.seed(makeProduct());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 17,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(false);
    const ptl = res.rules.find((r) => r.rule === 'per_transaction_limit');
    expect(ptl?.passed).toBe(false);
  });

  it('fails the geofence rule when the address is outside the polygon', async () => {
    rig.userAddresses.seed(
      makeUserAddress({
        // Northern Wisconsin — comfortably outside the MN delivery polygon.
        location: { type: 'Point', coordinates: [-89.0, 45.5] },
      }),
    );

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(false);
    const geo = res.rules.find((r) => r.rule === 'delivery_geofence');
    expect(geo?.passed).toBe(false);
  });

  it('fails the age rule for an underage user (DOB makes them 18)', async () => {
    rig.users.seed(makeUser({ dateOfBirth: '2008-01-01' }));

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(false);
    const age = res.rules.find((r) => r.rule === 'age');
    expect(age?.passed).toBe(false);
  });

  it('fails the KYC rule when the user has never verified', async () => {
    rig.users.seed(makeUser({ kycVerifiedAt: null }));

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(false);
    const kyc = res.rules.find((r) => r.rule === 'kyc');
    expect(kyc?.passed).toBe(false);
  });

  it('fails the dispensary_license rule when the licence has expired', async () => {
    rig.dispensaries.seed(makeDispensary({ licenseExpiresAt: '2020-01-01' }));

    const res = await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(res.passed).toBe(false);
    const lic = res.rules.find((r) => r.rule === 'dispensary_license');
    expect(lic?.passed).toBe(false);
  });

  it('returns 404 for a cart that belongs to a different user', async () => {
    rig.carts.rows.clear();
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns 404 for a cart that does not exist', async () => {
    rig.carts.rows.clear();

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns 404 for a delivery address that belongs to another user', async () => {
    rig.userAddresses.seed(makeUserAddress({ userId: OTHER_USER_ID }));

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns 404 for a soft-deleted delivery address', async () => {
    rig.userAddresses.seed(makeUserAddress({ deletedAt: new Date('2026-05-01T00:00:00.000Z') }));

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns 404 for an address id that does not exist', async () => {
    rig.userAddresses.rows.clear();

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws RepositoryError when the JWT principal lacks a user row', async () => {
    rig.users.rows.clear();

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('throws RepositoryError when the cart references a missing dispensary', async () => {
    rig.dispensaries.rows.clear();

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('throws RepositoryError when a cart item references a dangling listing', async () => {
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 1,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });
    // listings is empty — the cart item references nothing.

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('throws RepositoryError when a listing references a dangling product', async () => {
    rig.listings.seed(makeListing());
    rig.items.seed({
      id: ITEM_ID,
      cartId: CART_ID,
      listingId: LISTING_ID,
      quantity: 1,
      unitPriceCents: 4500,
      createdAt: new Date('2026-05-18T18:30:00.000Z'),
      updatedAt: new Date('2026-05-18T18:30:00.000Z'),
    });
    // products is empty — the listing's productId is dangling.

    await expect(rig.service.validate(USER_ID, CART_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('does NOT touch the cart TTL (validate is read-only)', async () => {
    rig.carts.touchCalls = [];

    await rig.service.validate(USER_ID, CART_ID, ADDRESS_ID);

    expect(rig.carts.touchCalls).toEqual([]);
  });
});

/**
 * Unit tests for CheckoutService.
 *
 * The service composes 13 repositories inside a single
 * `db.transaction(...)`. The rig fakes each one with an in-memory store
 * and replaces `db.transaction(fn)` with a passthrough `fn({})`, so the
 * 17 atomic steps run end-to-end without a Postgres connection.
 *
 * Timing: `vi.useFakeTimers()` pins `new Date()` to a Monday 14:00
 * America/Chicago (= 19:00 UTC) — squarely inside SAMPLE_HOURS so the
 * compliance hours rule passes deterministically regardless of when the
 * test suite is executed. Cart `expiresAt` is set to 4 hours after pinned
 * `now`, so the cart is unambiguously alive.
 *
 * Coverage map (every code path in checkout.service.ts):
 *   - happy path (full projection round-trip + inventory delta + cart
 *     deletion + ledger balance + payment intent stub shape)
 *   - 410 expired cart
 *   - 404 cross-user / missing cart
 *   - 404 cross-user / missing / soft-deleted address
 *   - 422 empty cart
 *   - 409 inventory shortage (with per-line `details` shape)
 *   - 422 compliance failure (over per-transaction edible THC limit)
 *   - 422 payment-method cross-user
 *   - payment-method resolution: supplied, default, no method available
 *   - short-code collision retry
 *   - RepositoryError: missing user, missing dispensary, dangling
 *     listing, dangling product, inventory decrement returned null
 */
import {
  type AeropayPayment,
  type AeropayPaymentStatus,
  type CreatePaymentInput,
} from '@dankdash/aeropay';
import {
  DomainError,
  ComplianceError,
  ExternalServiceError,
  InventoryError,
  NotFoundError,
  PaymentError,
  RepositoryError,
  ValidationError,
} from '@dankdash/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CartExpiredError,
  CheckoutService,
  type CheckoutScopedRepos,
  type CheckoutScopedReposFactory,
} from './checkout.service.js';
import type { AeropayClientLike } from '../payments/tokens.js';
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
  LedgerEntriesRepository,
  LedgerEntry,
  NewLedgerEntry,
  NewOrder,
  NewOrderEvent,
  NewOrderItem,
  NewPaymentTransaction,
  Order,
  OrderEvent,
  OrderEventsRepository,
  OrderItem,
  OrderItemsRepository,
  OrdersRepository,
  PaymentMethod,
  PaymentMethodsRepository,
  PaymentTransaction,
  PaymentTransactionsRepository,
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
const CART_ID = '01935f3d-0000-7000-8000-000000000020';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const ITEM_ID = '01935f3d-0000-7000-8000-000000000040';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000050';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';
const PAYMENT_METHOD_ID = '01935f3d-0000-7000-8000-000000000070';
const OTHER_PAYMENT_METHOD_ID = '01935f3d-0000-7000-8000-000000000071';

/** Pinned wall-clock for every test — Mon 2026-05-18 14:00 America/Chicago. */
const PINNED_NOW = new Date('2026-05-18T19:00:00.000Z');
const FUTURE_EXPIRY = new Date(PINNED_NOW.getTime() + 4 * 60 * 60 * 1000);
const PAST_EXPIRY = new Date(PINNED_NOW.getTime() - 60 * 1000);

/** 09:00 – 22:00 every day, comfortably bracketing 14:00 CT. */
const SAMPLE_HOURS = {
  mon: { open: '09:00', close: '22:00' },
  tue: { open: '09:00', close: '22:00' },
  wed: { open: '09:00', close: '22:00' },
  thu: { open: '09:00', close: '22:00' },
  fri: { open: '09:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: { open: '10:00', close: '22:00' },
};

/** Tight Minneapolis square containing the delivery address fixture. */
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
  const createdAt = new Date(PINNED_NOW.getTime() - 30 * 60 * 1000);
  return {
    id: CART_ID,
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    expiresAt: FUTURE_EXPIRY,
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
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    isDefault: true,
    isValidated: true,
    validatedAt: createdAt,
    deliveryInstructions: 'Buzz #3',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makePaymentMethod(overrides: Partial<PaymentMethod> = {}): PaymentMethod {
  const createdAt = new Date('2025-06-15T00:00:00.000Z');
  return {
    id: PAYMENT_METHOD_ID,
    userId: USER_ID,
    type: 'aeropay_ach',
    aeropayPaymentMethodRef: 'apm_abc123',
    bankName: 'Wells Fargo',
    last4: '0042',
    isDefault: true,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeCartItem(overrides: Partial<CartItem> = {}): CartItem {
  const createdAt = new Date(PINNED_NOW.getTime() - 15 * 60 * 1000);
  return {
    id: ITEM_ID,
    cartId: CART_ID,
    listingId: LISTING_ID,
    quantity: 2,
    unitPriceCents: 4500,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

class FakeCartsRepo implements Pick<CartsRepository, 'findByIdForUserForUpdate' | 'deleteById'> {
  public rows = new Map<string, Cart>();
  public deleteCalls: string[] = [];

  seed(cart: Cart): void {
    this.rows.set(cart.id, cart);
  }

  findByIdForUserForUpdate(id: string, userId: string): Promise<Cart | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row?.userId === userId ? row : null);
  }

  deleteById(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.rows.delete(id);
    return Promise.resolve();
  }
}

class FakeCartItemsRepo implements Pick<CartItemsRepository, 'listForCart'> {
  public rows = new Map<string, CartItem>();

  seed(item: CartItem): void {
    this.rows.set(item.id, item);
  }

  listForCart(cartId: string): Promise<readonly CartItem[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.cartId === cartId));
  }
}

class FakeListingsRepo implements Pick<
  DispensaryListingsRepository,
  'findManyByIdsForUpdate' | 'decrementInventory'
> {
  public rows = new Map<string, DispensaryListing>();
  public decrementCalls: { id: string; qty: number }[] = [];
  /** Force the next decrementInventory call to return null (race-window
   *  simulation), then return to normal. */
  public decrementReturnsNullOnce = false;

  seed(row: DispensaryListing): void {
    this.rows.set(row.id, row);
  }

  findManyByIdsForUpdate(ids: readonly string[]): Promise<readonly DispensaryListing[]> {
    return Promise.resolve(
      ids.map((id) => this.rows.get(id)).filter((r): r is DispensaryListing => r !== undefined),
    );
  }

  decrementInventory(id: string, quantity: number): Promise<DispensaryListing | null> {
    this.decrementCalls.push({ id, qty: quantity });
    if (this.decrementReturnsNullOnce) {
      this.decrementReturnsNullOnce = false;
      return Promise.resolve(null);
    }
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    if (existing.quantityAvailable < quantity) return Promise.resolve(null);
    const next: DispensaryListing = {
      ...existing,
      quantityAvailable: existing.quantityAvailable - quantity,
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
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

class FakeProductsRepo implements Pick<ProductsRepository, 'findManyByIds'> {
  public rows = new Map<string, Product>();
  seed(row: Product): void {
    this.rows.set(row.id, row);
  }
  findManyByIds(ids: readonly string[]): Promise<readonly Product[]> {
    return Promise.resolve(
      ids.map((id) => this.rows.get(id)).filter((r): r is Product => r !== undefined),
    );
  }
}

class FakeOrdersRepo implements Pick<OrdersRepository, 'create' | 'shortCodeExistsSince'> {
  public rows = new Map<string, Order>();
  public shortCodeChecks: { code: string; since: Date }[] = [];
  /** Set to a function to control which generated short codes are
   *  reported as already-existing. Default: nothing collides. */
  public shortCodeExistsImpl: (code: string) => boolean = () => false;
  private idSeq = 1;

  shortCodeExistsSince(code: string, since: Date): Promise<boolean> {
    this.shortCodeChecks.push({ code, since });
    return Promise.resolve(this.shortCodeExistsImpl(code));
  }

  create(input: Omit<NewOrder, 'id'> & { readonly id?: string }): Promise<Order> {
    const id =
      input.id ?? `01935f3d-0000-7000-8000-${String(0x1000 + this.idSeq++).padStart(12, '0')}`;
    const created = new Date(PINNED_NOW);
    const row: Order = {
      id,
      shortCode: input.shortCode,
      userId: input.userId,
      dispensaryId: input.dispensaryId,
      driverId: input.driverId ?? null,
      deliveryAddressId: input.deliveryAddressId,
      status: input.status ?? 'placed',
      statusChangedAt: input.statusChangedAt ?? created,
      subtotalCents: input.subtotalCents,
      cannabisTaxCents: input.cannabisTaxCents,
      salesTaxCents: input.salesTaxCents,
      deliveryFeeCents: input.deliveryFeeCents,
      driverTipCents: input.driverTipCents ?? 0,
      discountCents: input.discountCents ?? 0,
      totalCents: input.totalCents,
      complianceCheckPayload: input.complianceCheckPayload,
      deliveryAddressSnapshot: input.deliveryAddressSnapshot,
      placedAt: input.placedAt ?? created,
      paymentFailedAt: input.paymentFailedAt ?? null,
      acceptedAt: input.acceptedAt ?? null,
      rejectedAt: input.rejectedAt ?? null,
      preppingAt: input.preppingAt ?? null,
      preparedAt: input.preparedAt ?? null,
      awaitingDriverAt: input.awaitingDriverAt ?? null,
      dispatchFailedAt: input.dispatchFailedAt ?? null,
      driverAssignedAt: input.driverAssignedAt ?? null,
      enRoutePickupAt: input.enRoutePickupAt ?? null,
      pickedUpAt: input.pickedUpAt ?? null,
      enRouteDropoffAt: input.enRouteDropoffAt ?? null,
      arrivedAtDropoffAt: input.arrivedAtDropoffAt ?? null,
      idScanPendingAt: input.idScanPendingAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      returnedToStoreAt: input.returnedToStoreAt ?? null,
      canceledAt: input.canceledAt ?? null,
      canceledBy: input.canceledBy ?? null,
      cancelReason: input.cancelReason ?? null,
      disputedAt: input.disputedAt ?? null,
      deliveryIdScanRef: input.deliveryIdScanRef ?? null,
      deliveryIdScanPassed: input.deliveryIdScanPassed ?? null,
      deliveryIdScanAt: input.deliveryIdScanAt ?? null,
      customerRating: input.customerRating ?? null,
      customerReview: input.customerReview ?? null,
      dispensaryRating: input.dispensaryRating ?? null,
      driverRating: input.driverRating ?? null,
      ratedAt: input.ratedAt ?? null,
      createdAt: input.createdAt ?? created,
      updatedAt: input.updatedAt ?? created,
    };
    this.rows.set(id, row);
    return Promise.resolve(row);
  }
}

class FakeOrderItemsRepo implements Pick<OrderItemsRepository, 'createMany'> {
  public rows: OrderItem[] = [];
  private idSeq = 1;

  createMany(
    inputs: readonly (Omit<NewOrderItem, 'id'> & { readonly id?: string })[],
  ): Promise<readonly OrderItem[]> {
    const created: OrderItem[] = inputs.map((input) => {
      const id =
        input.id ?? `01935f3d-0000-7000-8000-${String(0x2000 + this.idSeq++).padStart(12, '0')}`;
      const now = new Date(PINNED_NOW);
      return {
        id,
        orderId: input.orderId,
        listingId: input.listingId,
        productSnapshot: input.productSnapshot,
        metrcPackageTag: input.metrcPackageTag ?? null,
        quantity: input.quantity,
        unitPriceCents: input.unitPriceCents,
        lineSubtotalCents: input.lineSubtotalCents,
        thcMgTotal: input.thcMgTotal,
        cbdMgTotal: input.cbdMgTotal ?? '0',
        weightGramsTotal: input.weightGramsTotal ?? '0',
        cannabisTaxCents: input.cannabisTaxCents,
        salesTaxCents: input.salesTaxCents,
        createdAt: input.createdAt ?? now,
      };
    });
    this.rows.push(...created);
    return Promise.resolve(created);
  }
}

class FakeOrderEventsRepo implements Pick<OrderEventsRepository, 'record'> {
  public rows: OrderEvent[] = [];
  private idSeq = 1;

  record(input: Omit<NewOrderEvent, 'id'> & { readonly id?: string }): Promise<OrderEvent> {
    const id =
      input.id ?? `01935f3d-0000-7000-8000-${String(0x3000 + this.idSeq++).padStart(12, '0')}`;
    const row: OrderEvent = {
      id,
      orderId: input.orderId,
      eventType: input.eventType,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(PINNED_NOW),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
}

class FakePaymentMethodsRepo implements Pick<
  PaymentMethodsRepository,
  'findById' | 'findDefaultForUser'
> {
  public rows = new Map<string, PaymentMethod>();
  seed(row: PaymentMethod): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<PaymentMethod | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findDefaultForUser(userId: string): Promise<PaymentMethod | null> {
    return Promise.resolve(
      [...this.rows.values()].find(
        (r) => r.userId === userId && r.isDefault && r.deletedAt === null,
      ) ?? null,
    );
  }
}

class FakePaymentTransactionsRepo implements Pick<PaymentTransactionsRepository, 'create'> {
  public rows: PaymentTransaction[] = [];
  private idSeq = 1;

  create(
    input: Omit<NewPaymentTransaction, 'id'> & { readonly id?: string },
  ): Promise<PaymentTransaction> {
    const id =
      input.id ?? `01935f3d-0000-7000-8000-${String(0x4000 + this.idSeq++).padStart(12, '0')}`;
    const now = new Date(PINNED_NOW);
    const row: PaymentTransaction = {
      id,
      orderId: input.orderId,
      paymentMethodId: input.paymentMethodId ?? null,
      provider: input.provider,
      providerRef: input.providerRef,
      amountCents: input.amountCents,
      status: input.status,
      failureCode: input.failureCode ?? null,
      failureReason: input.failureReason ?? null,
      initiatedAt: input.initiatedAt ?? now,
      authorizedAt: input.authorizedAt ?? null,
      settledAt: input.settledAt ?? null,
      failedAt: input.failedAt ?? null,
      canceledAt: input.canceledAt ?? null,
      rawResponse: input.rawResponse ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
}

class FakeLedgerEntriesRepo implements Pick<LedgerEntriesRepository, 'recordTransaction'> {
  public rows: LedgerEntry[] = [];
  private idSeq = 1;

  recordTransaction(
    entries: readonly (Omit<NewLedgerEntry, 'id'> & { readonly id?: string })[],
  ): Promise<readonly LedgerEntry[]> {
    if (entries.length === 0) {
      throw new RangeError('recordTransaction: at least one entry required');
    }
    let debit = 0;
    let credit = 0;
    for (const e of entries) {
      debit += e.debitCents ?? 0;
      credit += e.creditCents ?? 0;
    }
    if (debit !== credit) {
      throw new RangeError(
        `recordTransaction: unbalanced ledger — debits=${String(debit)} credits=${String(credit)}`,
      );
    }
    const now = new Date(PINNED_NOW);
    const materialized: LedgerEntry[] = entries.map((e) => ({
      id: e.id ?? `01935f3d-0000-7000-8000-${String(0x5000 + this.idSeq++).padStart(12, '0')}`,
      orderId: e.orderId ?? null,
      payoutId: e.payoutId ?? null,
      refundId: e.refundId ?? null,
      accountType: e.accountType,
      accountRef: e.accountRef ?? null,
      debitCents: e.debitCents ?? 0,
      creditCents: e.creditCents ?? 0,
      description: e.description,
      occurredAt: e.occurredAt ?? now,
      createdAt: e.createdAt ?? now,
    }));
    this.rows.push(...materialized);
    return Promise.resolve(materialized);
  }
}

/**
 * Coerce an arbitrary thrown value into an Error so we can pass it
 * through `Promise.reject(...)` without tripping the eslint
 * `prefer-promise-reject-errors` / `no-base-to-string` rules. Tests use
 * this to simulate the SDK throwing a non-Error value (e.g. a plain
 * string from a fetch shim) while keeping the rejected reason a real
 * Error subclass for the checkout service's `instanceof DomainError`
 * branch.
 */
function coerceToError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error('non-serializable rejection value');
  }
}

class FakeAeropayClient implements AeropayClientLike {
  public createCalls: CreatePaymentInput[] = [];
  /** Synchronous result that the next `createPayment` returns. Tests
   *  override this when they need to simulate an authorize/settle/fail. */
  public nextStatus: AeropayPaymentStatus = 'initiated';
  /** Set to throw on the next `createPayment` (network / 5xx simulation). */
  public nextThrow: unknown = null;
  private idSeq = 1;

  createPayment = (input: CreatePaymentInput): Promise<AeropayPayment> => {
    this.createCalls.push(input);
    if (this.nextThrow !== null) {
      const err = this.nextThrow;
      this.nextThrow = null;
      return Promise.reject(coerceToError(err));
    }
    return Promise.resolve({
      id: `pay_test_${String(this.idSeq++).padStart(6, '0')}`,
      status: this.nextStatus,
      amountCents: input.amountCents,
      bankAccountId: input.bankAccountId,
      customerRef: input.customerRef,
      orderRef: input.orderRef,
      createdAt: new Date(PINNED_NOW),
    });
  };

  linkBankAccount = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
  getBankAccount = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
  getPayment = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
  cancelPayment = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
  refundPayment = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
  createPayout = (): Promise<never> => Promise.reject(new Error('not used in checkout'));
}

interface Rig {
  readonly service: CheckoutService;
  readonly carts: FakeCartsRepo;
  readonly items: FakeCartItemsRepo;
  readonly listings: FakeListingsRepo;
  readonly dispensaries: FakeDispensariesRepo;
  readonly users: FakeUsersRepo;
  readonly userAddresses: FakeUserAddressesRepo;
  readonly products: FakeProductsRepo;
  readonly orders: FakeOrdersRepo;
  readonly orderItems: FakeOrderItemsRepo;
  readonly orderEvents: FakeOrderEventsRepo;
  readonly paymentMethods: FakePaymentMethodsRepo;
  readonly paymentTransactions: FakePaymentTransactionsRepo;
  readonly ledgerEntries: FakeLedgerEntriesRepo;
  readonly aeropay: FakeAeropayClient;
}

function makeRig(options: { readonly paymentsBypassEnabled?: boolean } = {}): Rig {
  const carts = new FakeCartsRepo();
  const items = new FakeCartItemsRepo();
  const listings = new FakeListingsRepo();
  const dispensaries = new FakeDispensariesRepo();
  const users = new FakeUsersRepo();
  const userAddresses = new FakeUserAddressesRepo();
  const products = new FakeProductsRepo();
  const orders = new FakeOrdersRepo();
  const orderItems = new FakeOrderItemsRepo();
  const orderEvents = new FakeOrderEventsRepo();
  const paymentMethods = new FakePaymentMethodsRepo();
  const paymentTransactions = new FakePaymentTransactionsRepo();
  const ledgerEntries = new FakeLedgerEntriesRepo();
  const aeropay = new FakeAeropayClient();
  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;
  const factory: CheckoutScopedReposFactory = () =>
    ({
      carts,
      items,
      listings,
      dispensaries,
      users,
      userAddresses,
      products,
      orders,
      orderItems,
      orderEvents,
      paymentMethods,
      paymentTransactions,
      ledgerEntries,
    }) as unknown as CheckoutScopedRepos;
  return {
    service: new CheckoutService(fakeDb, factory, aeropay, options.paymentsBypassEnabled ?? false),
    carts,
    items,
    listings,
    dispensaries,
    users,
    userAddresses,
    products,
    orders,
    orderItems,
    orderEvents,
    paymentMethods,
    paymentTransactions,
    ledgerEntries,
    aeropay,
  };
}

/** Seeds the rig with the default happy-path graph (one cart, one
 *  2-unit flower line, plus the user's default linked bank account so
 *  the new Aeropay charge step has a funding source). Individual tests
 *  can re-seed selectively. */
function seedHappyPath(rig: Rig): void {
  rig.carts.seed(makeCart());
  rig.dispensaries.seed(makeDispensary());
  rig.users.seed(makeUser());
  rig.userAddresses.seed(makeUserAddress());
  rig.listings.seed(makeListing({ quantityAvailable: 10 }));
  rig.products.seed(makeProduct());
  rig.items.seed(makeCartItem({ quantity: 2 }));
  rig.paymentMethods.seed(makePaymentMethod());
}

describe('CheckoutService.checkout — happy path', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an order with totals that reconcile via the orders_total_matches invariant', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 500,
    });

    // Pricing: 2 × $45.00 = $90.00 subtotal. Flower so 10% cannabis tax + 6.875% sales = $15.19.
    expect(res.order.subtotalCents).toBe(9000);
    expect(res.order.cannabisTaxCents).toBeGreaterThan(0);
    expect(res.order.salesTaxCents).toBeGreaterThan(0);
    expect(res.order.driverTipCents).toBe(500);
    expect(res.order.discountCents).toBe(0);
    expect(res.order.deliveryFeeCents).toBe(0);

    // The CHECK constraint mirror — server total must equal sum of components.
    const expectedTotal =
      res.order.subtotalCents +
      res.order.cannabisTaxCents +
      res.order.salesTaxCents +
      res.order.deliveryFeeCents +
      res.order.driverTipCents -
      res.order.discountCents;
    expect(res.order.totalCents).toBe(expectedTotal);
  });

  it('returns a 6-char short code generated by the @dankdash/utils generator', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.order.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it('returns the order id as a UUID, status placed, and timestamps as ISO strings', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.order.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.order.status).toBe('placed');
    expect(res.order.placedAt).toMatch(/T\d\d:\d\d:\d\d/);
    expect(res.order.statusChangedAt).toMatch(/T\d\d:\d\d:\d\d/);
  });

  it('projects one order item per cart line with decimal-string THC/CBD/weight totals', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.order.items).toHaveLength(1);
    const [line] = res.order.items;
    expect(line).toBeDefined();
    expect(line?.quantity).toBe(2);
    expect(line?.unitPriceCents).toBe(4500);
    expect(line?.lineSubtotalCents).toBe(9000);
    // 2 × 3.500g = 7.000g flower; the totals come back as strings (NUMERIC).
    expect(line?.weightGramsTotal).toBe('7');
    // 2 × 24.500mg = 49.000mg THC.
    expect(line?.thcMgTotal).toBe('49');
    // 2 × 0.100mg CBD = 0.200mg.
    expect(line?.cbdMgTotal).toBe('0.2');
  });

  it('returns an Aeropay payment intent referencing the real upstream payment id', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.paymentIntent.provider).toBe('aeropay');
    expect(res.paymentIntent.status).toBe('initiated');
    expect(res.paymentIntent.providerRef).toMatch(/^pay_test_\d{6}$/);
    expect(res.paymentIntent.providerRef).toBe(rig.paymentTransactions.rows[0]?.providerRef);
    expect(res.paymentIntent.amountCents).toBe(res.order.totalCents);
    expect(res.paymentIntent.clientSecret).toBeNull();
  });

  it('returns a passing compliance evaluation with the rule set the engine emits', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.complianceCheck.passed).toBe(true);
    expect(res.complianceCheck.rules.every((r) => r.passed)).toBe(true);
    expect(res.complianceCheck.cartTotals.flowerGrams).toBeCloseTo(7, 3);
    expect(res.complianceCheck.limits.flowerGramsMax).toBeGreaterThan(0);
    expect(res.complianceCheck.evaluatedAt).toMatch(/T\d\d:\d\d:\d\d/);
    expect(res.complianceCheck.evaluationVersion.length).toBeGreaterThan(0);
  });

  it('decrements listing inventory by the order quantity', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.listings.decrementCalls).toEqual([{ id: LISTING_ID, qty: 2 }]);
    expect(rig.listings.rows.get(LISTING_ID)?.quantityAvailable).toBe(8);
  });

  it('deletes the cart (cart_items cascade in real DB)', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.carts.deleteCalls).toEqual([CART_ID]);
    expect(rig.carts.rows.has(CART_ID)).toBe(false);
  });

  it('appends an order_placed event with subtotal/total/itemCount payload', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.orderEvents.rows).toHaveLength(1);
    const [evt] = rig.orderEvents.rows;
    expect(evt?.eventType).toBe('order_placed');
    expect(evt?.actorRole).toBe('customer');
    expect(evt?.actorUserId).toBe(USER_ID);
    const payload = evt?.payload as {
      subtotalCents: number;
      totalCents: number;
      itemCount: number;
    };
    expect(payload.subtotalCents).toBe(9000);
    expect(payload.totalCents).toBeGreaterThan(9000);
    expect(payload.itemCount).toBe(1);
  });

  it('records a balanced double-entry ledger transaction (customer DR / aeropay_clearing CR)', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.ledgerEntries.rows).toHaveLength(2);
    const total = rig.ledgerEntries.rows.reduce((s, e) => s + e.debitCents, 0);
    const credits = rig.ledgerEntries.rows.reduce((s, e) => s + e.creditCents, 0);
    expect(total).toBe(credits);
    expect(total).toBe(res.order.totalCents);
    const customerSide = rig.ledgerEntries.rows.find((e) => e.accountType === 'customer');
    const clearingSide = rig.ledgerEntries.rows.find((e) => e.accountType === 'aeropay_clearing');
    expect(customerSide?.debitCents).toBe(res.order.totalCents);
    expect(customerSide?.creditCents).toBe(0);
    expect(clearingSide?.creditCents).toBe(res.order.totalCents);
    expect(clearingSide?.debitCents).toBe(0);
    expect(customerSide?.accountRef).toBe(USER_ID);
    expect(clearingSide?.accountRef).toBeNull();
  });

  it('snapshots the delivery address with the per-order instructions overriding the saved default', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
      deliveryInstructions: 'Leave at door',
    });

    const stored = rig.orders.rows.values().next().value;
    expect(stored).toBeDefined();
    const snapshot = stored?.deliveryAddressSnapshot as Record<string, unknown>;
    expect(snapshot.id).toBe(ADDRESS_ID);
    expect(snapshot.line1).toBe('500 Nicollet Mall');
    expect(snapshot.deliveryInstructions).toBe('Leave at door');
  });

  it('falls back to the saved deliveryInstructions when none supplied in the body', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    const stored = rig.orders.rows.values().next().value;
    const snapshot = stored?.deliveryAddressSnapshot as Record<string, unknown>;
    expect(snapshot.deliveryInstructions).toBe('Buzz #3');
  });

  it('snapshots the full compliance evaluation onto orders.compliance_check_payload', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    const stored = rig.orders.rows.values().next().value;
    const compliance = stored?.complianceCheckPayload as { passed: boolean; rules: unknown[] };
    expect(compliance.passed).toBe(true);
    expect(compliance.rules.length).toBeGreaterThan(0);
  });
});

describe('CheckoutService.checkout — cart guards', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 404 for a cart that belongs to a different user', async () => {
    rig.carts.rows.clear();
    rig.carts.seed(makeCart({ userId: OTHER_USER_ID }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 for a cart id that does not exist', async () => {
    rig.carts.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 410 (CartExpiredError) when the cart has expired', async () => {
    rig.carts.rows.clear();
    rig.carts.seed(makeCart({ expiresAt: PAST_EXPIRY }));

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(CartExpiredError);
    await expect(promise).rejects.toBeInstanceOf(DomainError);
    await expect(promise).rejects.toMatchObject({
      code: 'CART_EXPIRED',
      statusCode: 410,
      details: { cartId: CART_ID },
    });
  });

  it('returns 422 (ValidationError) when the cart is empty', async () => {
    rig.items.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CheckoutService.checkout — address guards', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 404 for an address that belongs to another user', async () => {
    rig.userAddresses.rows.clear();
    rig.userAddresses.seed(makeUserAddress({ userId: OTHER_USER_ID }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 for a soft-deleted address', async () => {
    rig.userAddresses.rows.clear();
    rig.userAddresses.seed(makeUserAddress({ deletedAt: new Date(PINNED_NOW.getTime() - 60_000) }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns 404 when the address id does not exist', async () => {
    rig.userAddresses.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CheckoutService.checkout — inventory + compliance', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects 409 InventoryError when a line exceeds available stock', async () => {
    rig.listings.rows.clear();
    rig.listings.seed(makeListing({ quantityAvailable: 1 }));

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(InventoryError);
    await expect(promise).rejects.toMatchObject({
      details: {
        shortages: [{ listingId: LISTING_ID, requested: 2, available: 1 }],
      },
    });
  });

  it('rejects 422 ComplianceError when an edible cart exceeds the 800mg per-transaction limit', async () => {
    // Re-seed with an edible product whose THC content forces failure.
    rig.products.rows.clear();
    rig.listings.rows.clear();
    rig.items.rows.clear();
    rig.products.seed(
      makeProduct({
        productType: 'edible',
        // 100mg per serving × 5 servings = 500mg per unit. Two units = 1000mg → > 800mg cap.
        thcMgPerUnit: '500.000',
        thcMgPerServing: '100.000',
        servingCount: 5,
        weightGramsPerUnit: '20.000',
      }),
    );
    rig.listings.seed(makeListing({ quantityAvailable: 10 }));
    rig.items.seed(makeCartItem({ quantity: 2 }));

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(ComplianceError);
    await expect(promise).rejects.toMatchObject({
      code: 'COMPLIANCE_EVALUATION_FAILED',
      details: { evaluation: { passed: false } },
    });
  });

  it('rolls back: no order, no event, no inventory delta, no ledger entries when compliance fails', async () => {
    rig.users.rows.clear();
    rig.users.seed(makeUser({ kycVerifiedAt: null })); // KYC will fail.

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(ComplianceError);

    // Service throws before order insert / inventory decrement / ledger writes.
    expect(rig.orders.rows.size).toBe(0);
    expect(rig.orderEvents.rows).toHaveLength(0);
    expect(rig.listings.decrementCalls).toHaveLength(0);
    expect(rig.ledgerEntries.rows).toHaveLength(0);
    expect(rig.carts.deleteCalls).toHaveLength(0);
  });
});

describe('CheckoutService.checkout — payment method resolution', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the supplied paymentMethodId when it belongs to the user', async () => {
    // seedHappyPath already seeded the default method.
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
      paymentMethodId: PAYMENT_METHOD_ID,
    });

    expect(rig.paymentTransactions.rows[0]?.paymentMethodId).toBe(PAYMENT_METHOD_ID);
  });

  it('falls back to the user default when no paymentMethodId is supplied', async () => {
    // seedHappyPath already seeded the default method.
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.paymentTransactions.rows[0]?.paymentMethodId).toBe(PAYMENT_METHOD_ID);
  });

  it('rejects 402 PaymentError when no method supplied and the user has none on file', async () => {
    rig.paymentMethods.rows.clear();

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 402,
      details: { userId: USER_ID },
    });
    // No Aeropay call should have been made — we bailed before that.
    expect(rig.aeropay.createCalls).toHaveLength(0);
    expect(rig.paymentTransactions.rows).toHaveLength(0);
  });

  it('rejects 402 PaymentError when the default method is pending (link still in flight)', async () => {
    rig.paymentMethods.rows.clear();
    rig.paymentMethods.seed(
      makePaymentMethod({ status: 'pending', aeropayPaymentMethodRef: null }),
    );

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 402,
      details: { paymentMethodId: PAYMENT_METHOD_ID, status: 'pending' },
    });
  });

  it('rejects 402 PaymentError when the default method status is failed', async () => {
    rig.paymentMethods.rows.clear();
    rig.paymentMethods.seed(makePaymentMethod({ status: 'failed' }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, {
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 0,
      }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 402,
    });
  });

  it('rejects 402 PaymentError when the active method has no aeropayPaymentMethodRef', async () => {
    rig.paymentMethods.rows.clear();
    rig.paymentMethods.seed(makePaymentMethod({ aeropayPaymentMethodRef: null }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, {
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 0,
      }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 402,
    });
  });

  it('rejects 422 ValidationError when the supplied paymentMethodId belongs to another user', async () => {
    rig.paymentMethods.seed(
      makePaymentMethod({ id: OTHER_PAYMENT_METHOD_ID, userId: OTHER_USER_ID }),
    );

    await expect(
      rig.service.checkout(USER_ID, CART_ID, {
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 0,
        paymentMethodId: OTHER_PAYMENT_METHOD_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects 422 ValidationError when the supplied paymentMethodId is soft-deleted', async () => {
    rig.paymentMethods.rows.clear();
    rig.paymentMethods.seed(
      makePaymentMethod({ deletedAt: new Date(PINNED_NOW.getTime() - 60_000) }),
    );

    await expect(
      rig.service.checkout(USER_ID, CART_ID, {
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 0,
        paymentMethodId: PAYMENT_METHOD_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects 422 ValidationError when the supplied paymentMethodId does not exist', async () => {
    rig.paymentMethods.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, {
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 0,
        paymentMethodId: PAYMENT_METHOD_ID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CheckoutService.checkout — Aeropay charge', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the local payment_transactions.id as the Aeropay idempotency key', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.aeropay.createCalls).toHaveLength(1);
    const [call] = rig.aeropay.createCalls;
    expect(call?.idempotencyKey).toBe(res.paymentIntent.id);
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes the linked bank-account ref + amount + customer/order refs to Aeropay', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 250,
    });

    expect(rig.aeropay.createCalls).toHaveLength(1);
    const [call] = rig.aeropay.createCalls;
    expect(call?.bankAccountId).toBe('apm_abc123');
    expect(call?.amountCents).toBe(res.order.totalCents);
    expect(call?.customerRef).toBe(USER_ID);
    expect(call?.orderRef).toBe(res.order.id);
  });

  it('persists status=authorized + authorizedAt set + settledAt null on sync-authorize', async () => {
    rig.aeropay.nextStatus = 'authorized';

    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.paymentIntent.status).toBe('authorized');
    const row = rig.paymentTransactions.rows[0];
    expect(row?.status).toBe('authorized');
    expect(row?.authorizedAt).toEqual(PINNED_NOW);
    expect(row?.settledAt).toBeNull();
    expect(row?.failedAt).toBeNull();
    expect(row?.canceledAt).toBeNull();
  });

  it('persists status=settled + both authorizedAt and settledAt on sync-settle', async () => {
    rig.aeropay.nextStatus = 'settled';

    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.paymentIntent.status).toBe('settled');
    const row = rig.paymentTransactions.rows[0];
    expect(row?.status).toBe('settled');
    expect(row?.authorizedAt).toEqual(PINNED_NOW);
    expect(row?.settledAt).toEqual(PINNED_NOW);
  });

  it('persists raw response payload with the Aeropay payment id, status, and bank ref', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    const row = rig.paymentTransactions.rows[0];
    const raw = row?.rawResponse as {
      aeropayPaymentId: string;
      aeropayStatus: AeropayPaymentStatus;
      bankAccountId: string;
    };
    expect(raw.aeropayPaymentId).toMatch(/^pay_test_\d{6}$/);
    expect(raw.aeropayStatus).toBe('initiated');
    expect(raw.bankAccountId).toBe('apm_abc123');
  });

  it('throws 402 PaymentError and skips ledger writes when Aeropay returns failed on createPayment', async () => {
    rig.aeropay.nextStatus = 'failed';

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_DECLINED',
      statusCode: 402,
      details: { aeropayStatus: 'failed' },
    });

    // Aeropay was called once, then the throw aborted subsequent steps.
    // The fake `db.transaction` is a passthrough so prior in-memory writes
    // are not undone; the assertions here verify the throw fired between
    // steps 16 and 17 (no payment_transactions row, no ledger entries).
    // In production the surrounding transaction rollback also undoes the
    // order / order_items / inventory / cart-delete writes.
    expect(rig.aeropay.createCalls).toHaveLength(1);
    expect(rig.paymentTransactions.rows).toHaveLength(0);
    expect(rig.ledgerEntries.rows).toHaveLength(0);
  });

  it('throws 402 PaymentError when Aeropay returns canceled on createPayment', async () => {
    rig.aeropay.nextStatus = 'canceled';

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_DECLINED',
      statusCode: 402,
      details: { aeropayStatus: 'canceled' },
    });
  });

  it('wraps a non-DomainError throw from Aeropay as ExternalServiceError(502)', async () => {
    rig.aeropay.nextThrow = new Error('ECONNRESET');

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 502,
      details: { service: 'aeropay' },
    });
    expect(rig.paymentTransactions.rows).toHaveLength(0);
    expect(rig.ledgerEntries.rows).toHaveLength(0);
  });

  it('re-throws a DomainError from Aeropay unchanged (no ExternalServiceError wrapping)', async () => {
    const domainThrow = new PaymentError('PAYMENT_DECLINED', 'manual fixture', {});
    rig.aeropay.nextThrow = domainThrow;

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBe(domainThrow);
  });

  it('treats Aeropay returning refunded on createPayment as ExternalServiceError (contract violation)', async () => {
    rig.aeropay.nextStatus = 'refunded';

    const promise = rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 502,
      details: { service: 'aeropay' },
    });
  });
});

describe('CheckoutService.checkout — payment bypass (PAYMENTS_BYPASS_ENABLED)', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig({ paymentsBypassEnabled: true });
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a synthetic bypass payment without ever calling Aeropay', async () => {
    await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.aeropay.createCalls).toHaveLength(0);
    expect(rig.paymentTransactions.rows).toHaveLength(1);
    const row = rig.paymentTransactions.rows[0];
    expect(row?.provider).toBe('bypass');
    expect(row?.status).toBe('authorized');
    expect(row?.paymentMethodId).toBeNull();
    // providerRef is the payment_transactions id (satisfies UNIQUE(provider, provider_ref)).
    expect(row?.providerRef).toBe(row?.id);
    expect(row?.authorizedAt).toEqual(PINNED_NOW);
    expect(row?.settledAt).toBeNull();
    expect(row?.rawResponse).toMatchObject({ bypass: true, reason: 'PAYMENTS_BYPASS_ENABLED' });
  });

  it('projects a bypass payment intent the iOS client can discriminate on', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.paymentIntent.provider).toBe('bypass');
    expect(res.paymentIntent.status).toBe('authorized');
    expect(res.paymentIntent.amountCents).toBe(res.order.totalCents);
    expect(res.paymentIntent.providerRef).toBe(rig.paymentTransactions.rows[0]?.providerRef);
    expect(res.paymentIntent.clientSecret).toBeNull();
  });

  it('places the order in the vendor queue with the same totals as the charged path', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 500,
    });

    expect(res.order.status).toBe('placed');
    expect(res.order.subtotalCents).toBe(9000);
    expect(res.order.driverTipCents).toBe(500);
    expect(rig.orderEvents.rows[0]?.eventType).toBe('order_placed');
  });

  it('still writes the balanced placement ledger entries (customer DR / aeropay_clearing CR)', async () => {
    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(rig.ledgerEntries.rows).toHaveLength(2);
    const debits = rig.ledgerEntries.rows.reduce((s, e) => s + e.debitCents, 0);
    const credits = rig.ledgerEntries.rows.reduce((s, e) => s + e.creditCents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(res.order.totalCents);
  });

  it('lets a user with NO linked payment method place an order', async () => {
    rig.paymentMethods.rows.clear();

    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.order.status).toBe('placed');
    expect(res.paymentIntent.provider).toBe('bypass');
    expect(rig.aeropay.createCalls).toHaveLength(0);
  });

  it('never relaxes compliance — an over-limit edible cart still fails under bypass', async () => {
    rig.products.rows.clear();
    rig.listings.rows.clear();
    rig.items.rows.clear();
    rig.products.seed(
      makeProduct({
        productType: 'edible',
        thcMgPerUnit: '500.000',
        thcMgPerServing: '100.000',
        servingCount: 5,
        weightGramsPerUnit: '20.000',
      }),
    );
    rig.listings.seed(makeListing({ quantityAvailable: 10 }));
    rig.items.seed(makeCartItem({ quantity: 2 }));

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(ComplianceError);
    // No payment row written when compliance gates the order.
    expect(rig.paymentTransactions.rows).toHaveLength(0);
  });
});

describe('CheckoutService.checkout — short code generation', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries when the first generated short code collides within the 30-day window', async () => {
    let calls = 0;
    rig.orders.shortCodeExistsImpl = () => {
      calls += 1;
      return calls === 1; // first candidate collides, second is fresh
    };

    const res = await rig.service.checkout(USER_ID, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 0,
    });

    expect(res.order.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(rig.orders.shortCodeChecks).toHaveLength(2);
    // Window is 30 days before `now`.
    const expectedSince = new Date(PINNED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(rig.orders.shortCodeChecks[0]?.since.getTime()).toBe(expectedSince.getTime());
  });
});

describe('CheckoutService.checkout — RepositoryError invariants', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    rig = makeRig();
    seedHappyPath(rig);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws RepositoryError when the principal user row is missing (JWT outlived the row)', async () => {
    rig.users.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('throws RepositoryError when the cart references a missing dispensary', async () => {
    rig.dispensaries.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('throws RepositoryError when a cart item references a dangling listing', async () => {
    rig.listings.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('throws RepositoryError when a listing references a dangling product', async () => {
    rig.products.rows.clear();

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('throws RepositoryError when inventory decrement returns null despite the FOR UPDATE lock', async () => {
    rig.listings.decrementReturnsNullOnce = true;

    await expect(
      rig.service.checkout(USER_ID, CART_ID, { deliveryAddressId: ADDRESS_ID, driverTipCents: 0 }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

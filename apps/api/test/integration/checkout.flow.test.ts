/**
 * /v1/carts/:id/checkout — end-to-end checkout against real Postgres.
 *
 * This is the highest-stakes surface in Phase 5: a single
 * `db.transaction(...)` that creates an order, decrements inventory,
 * deletes the cart, writes the payment-intent stub, and lands a balanced
 * ledger pair. Every failure path must roll the whole thing back — there
 * is no "order created, inventory not decremented" middle state in
 * production. Unit tests cover the path with fake repos; this suite
 * proves the real Postgres transaction holds the same invariants.
 *
 * Coverage map (Phase 5.7):
 *   - Happy path: order persisted with snapshot, inventory decremented,
 *     cart deleted, ledger balanced, payment-intent stub written
 *   - Compliance fail: 900mg edible THC → 422 + no DB writes
 *   - Inventory fail: requested > available → 409 + no DB writes
 *   - Concurrency: two simultaneous checkouts of the same constrained
 *     listing → exactly one succeeds, the other gets 409
 *   - Expired cart: cart.expires_at < now → 410
 *   - Cross-user: different principal probing a cart → 404 (no leak)
 *   - Empty cart: 422 with a clear code
 *   - Tip floor: driverTipCents below the $2 minimum → 422 + no DB writes
 *
 * Pattern: `seedFixtures()` reseeds in `beforeEach`. Tests that need a
 * mutated row (constrained inventory, expired cart) issue raw SQL via
 * the test pool — the seed deliberately avoids "test-specific" rows so
 * the catalog stays a realistic baseline.
 */
import {
  type AeropayPayment,
  type AeropayPaymentStatus,
  type CreatePaymentInput,
} from '@dankdash/aeropay';
import { stableUuid, type Database } from '@dankdash/db';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE_DB } from '../../src/infrastructure/drizzle.module.js';
import { createCheckoutScopedRepos } from '../../src/modules/checkout/checkout.module.js';
import { CheckoutService } from '../../src/modules/checkout/checkout.service.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../../src/modules/payments/tokens.js';
import { buildTestApp } from '../helpers/build-app.js';
import {
  SEED_IDS,
  bearer,
  freezeToBusinessHours,
  getPool,
  resetRateLimit,
  restoreClock,
  seedFixtures,
  signTokenFor,
} from './setup.js';

/**
 * Wrap an arbitrary thrown value in an Error so `Promise.reject` always
 * receives an Error instance (avoids @typescript-eslint/no-base-to-string
 * on raw `String(unknown)` and prefer-promise-reject-errors).
 */
function coerceToError(value: unknown): Error {
  if (value instanceof Error) return value;
  try {
    return new Error(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return new Error('Non-serializable thrown value');
  }
}

/**
 * In-test Aeropay client. Records every call so assertions can inspect
 * the idempotency key + bank-account ref the checkout service forwarded,
 * and returns a synthetic `pay_test_*` id with the configured next-status
 * (defaults to `initiated`). Keeps the integration suite hermetic — no
 * outbound network to api.aeropay.com — while still exercising the real
 * NestJS DI graph, real Postgres transaction, and real
 * payment_transactions persistence.
 */
class FakeAeropayClient implements AeropayClientLike {
  public readonly createCalls: CreatePaymentInput[] = [];
  public nextStatus: AeropayPaymentStatus = 'initiated';
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
      createdAt: new Date(),
    });
  };

  // Webhook + payment-method paths aren't exercised by /v1/carts/:id/checkout
  // — they have their own integration tests. Reject loudly if anything in
  // checkout calls them so we notice the change rather than silently no-op.
  linkBankAccount = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.linkBankAccount: not used in checkout flow'));
  getBankAccount = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.getBankAccount: not used in checkout flow'));
  getPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.getPayment: not used in checkout flow'));
  cancelPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.cancelPayment: not used in checkout flow'));
  refundPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.refundPayment: not used in checkout flow'));
  createPayout = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.createPayout: not used in checkout flow'));
}

const ALICE_ADDRESS_ID = stableUuid('address', 'addr-alice-home');
const MPLS_DARK_CHOCOLATE_LISTING_ID = stableUuid('listing', 'mpls-p-edible-nl-1');
const MPLS_NORTHERN_LIGHTS_LISTING_ID = SEED_IDS.listing.mplsNorthernLights7g;
const ALICE_PAYMENT_METHOD_ID = stableUuid('payment-method', 'pm-alice');

interface CartBody {
  readonly id: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly listingId: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
    readonly lineSubtotalCents: number;
  }>;
  readonly subtotalCents: number;
}

interface CheckoutBody {
  readonly order: {
    readonly id: string;
    readonly shortCode: string;
    readonly userId: string;
    readonly dispensaryId: string;
    readonly status: string;
    readonly subtotalCents: number;
    readonly cannabisTaxCents: number;
    readonly salesTaxCents: number;
    readonly driverTipCents: number;
    readonly totalCents: number;
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly listingId: string;
      readonly quantity: number;
      readonly productSnapshot: Record<string, unknown>;
    }>;
  };
  readonly paymentIntent: {
    readonly id: string;
    readonly orderId: string;
    readonly provider: string;
    readonly providerRef: string;
    readonly status: string;
    readonly amountCents: number;
  };
  readonly complianceCheck: {
    readonly passed: boolean;
    readonly rules: ReadonlyArray<{ readonly rule: string; readonly passed: boolean }>;
  };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

describe('/v1/carts/:id/checkout — atomic transaction', () => {
  let app: NestFastifyApplication;
  let aeropay: FakeAeropayClient;

  beforeAll(async () => {
    aeropay = new FakeAeropayClient();
    app = await buildTestApp({
      overrides: [{ token: AEROPAY_CLIENT, value: aeropay }],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Pin the clock inside MN sale hours so the server-authoritative
    // compliance check can't flake when CI runs in the 2–8 AM dead zone.
    freezeToBusinessHours();
    await seedFixtures();
    await force24HourHours();
    // The frozen clock never advances the rate-limit window, so clear it
    // between tests to stop hits accumulating across the suite.
    resetRateLimit(app);
    // Reset the fake between tests so per-test next* config doesn't bleed.
    aeropay.createCalls.length = 0;
    aeropay.nextStatus = 'initiated';
    aeropay.nextThrow = null;
  });

  afterEach(() => {
    restoreClock();
  });

  it('happy path — creates order, decrements inventory, deletes cart, writes balanced ledger, charges Aeropay with idempotency key', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, token, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 2 },
    ]);

    const inventoryBefore = await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: {
        deliveryAddressId: ALICE_ADDRESS_ID,
        paymentMethodId: ALICE_PAYMENT_METHOD_ID,
        driverTipCents: 500,
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<CheckoutBody>();

    // Response shape — money reconciles to the CHECK constraint.
    expect(body.order.status).toBe('placed');
    expect(body.order.shortCode).toHaveLength(6);
    expect(body.order.userId).toBe(SEED_IDS.user.customer1);
    expect(body.order.dispensaryId).toBe(SEED_IDS.dispensary.mpls);
    expect(body.order.driverTipCents).toBe(500);
    expect(body.order.items).toHaveLength(1);
    expect(body.paymentIntent.provider).toBe('aeropay');
    // Real Aeropay payment id, persisted as payment_transactions.provider_ref.
    // The synthetic `pay_test_*` shape comes from the FakeAeropayClient
    // overriding AEROPAY_CLIENT in buildTestApp.
    expect(body.paymentIntent.providerRef).toMatch(/^pay_test_\d{6}$/);
    expect(body.paymentIntent.amountCents).toBe(body.order.totalCents);
    // The checkout service must have forwarded the local
    // payment_transactions.id as Aeropay's idempotency key so a network
    // retry coalesces to the same upstream charge.
    const aeropayCall = aeropay.createCalls.at(-1);
    expect(aeropayCall?.idempotencyKey).toBe(body.paymentIntent.id);
    expect(aeropayCall?.bankAccountId).toBe('aeropay-pm-alice');
    expect(aeropayCall?.amountCents).toBe(body.order.totalCents);
    expect(aeropayCall?.customerRef).toBe(SEED_IDS.user.customer1);
    expect(aeropayCall?.orderRef).toBe(body.order.id);
    expect(body.complianceCheck.passed).toBe(true);
    const subtotal = body.order.subtotalCents;
    const computedTotal =
      subtotal + body.order.cannabisTaxCents + body.order.salesTaxCents + body.order.driverTipCents;
    expect(body.order.totalCents).toBe(computedTotal);

    // Persisted row matches the projection.
    const orderRow = await fetchOrderRow(body.order.id);
    expect(orderRow.short_code).toBe(body.order.shortCode);
    expect(Number(orderRow.subtotal_cents)).toBe(subtotal);
    expect(Number(orderRow.total_cents)).toBe(body.order.totalCents);
    expect(orderRow.user_id).toBe(SEED_IDS.user.customer1);

    // Inventory decremented by exactly the line quantity.
    const inventoryAfter = await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID);
    expect(inventoryAfter).toBe(inventoryBefore - 2);

    // Cart and its items removed (cart_items cascades).
    const cartRows = await countRows('carts', `id = $1`, [cart.id]);
    expect(cartRows).toBe(0);
    const cartItemRows = await countRows('cart_items', `cart_id = $1`, [cart.id]);
    expect(cartItemRows).toBe(0);

    // Order placed event recorded.
    const eventRows = await countRows(
      'order_events',
      `order_id = $1 AND event_type = 'order_placed'`,
      [body.order.id],
    );
    expect(eventRows).toBe(1);

    // Ledger: balanced double-entry, two rows for this order, sums equal.
    const ledger = await fetchLedgerForOrder(body.order.id);
    expect(ledger).toHaveLength(2);
    const totalDebits = ledger.reduce((acc, r) => acc + Number(r.debit_cents), 0);
    const totalCredits = ledger.reduce((acc, r) => acc + Number(r.credit_cents), 0);
    expect(totalDebits).toBe(totalCredits);
    expect(totalDebits).toBe(body.order.totalCents);

    // Payment transaction row persisted with the Aeropay payment id.
    const intentRows = await fetchPaymentTransactionsForOrder(body.order.id);
    expect(intentRows).toHaveLength(1);
    expect(intentRows[0]?.provider_ref).toBe(body.paymentIntent.providerRef);
    expect(intentRows[0]?.status).toBe('initiated');
  });

  it('compliance fail — 900mg edible THC cart rejects with 422 and writes no order rows', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, token, [
      { listingId: MPLS_DARK_CHOCOLATE_LISTING_ID, quantity: 9 },
    ]);

    const inventoryBefore = await readListingQuantity(MPLS_DARK_CHOCOLATE_LISTING_ID);
    const ordersBefore = await countRows('orders', `user_id = $1`, [SEED_IDS.user.customer1]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(422);
    const body = resp.json<ErrorBody>();
    expect(body.error.code).toBe('COMPLIANCE_EVALUATION_FAILED');

    // No side effects: inventory unchanged, no order rows, cart still alive.
    expect(await readListingQuantity(MPLS_DARK_CHOCOLATE_LISTING_ID)).toBe(inventoryBefore);
    expect(await countRows('orders', `user_id = $1`, [SEED_IDS.user.customer1])).toBe(ordersBefore);
    expect(await countRows('carts', `id = $1`, [cart.id])).toBe(1);
  });

  it('inventory fail — requesting more than available rejects with 409, leaves no order rows', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });

    // Constrain the listing to 3 available, then ask for 5.
    await setListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID, 3);
    const cart = await buildCart(app, token, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 5 },
    ]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(409);
    const body = resp.json<ErrorBody>();
    expect(body.error.code).toBe('INSUFFICIENT_INVENTORY');

    // Inventory still 3; cart still alive.
    expect(await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID)).toBe(3);
    expect(await countRows('orders', `user_id = $1`, [SEED_IDS.user.customer1])).toBe(0);
    expect(await countRows('carts', `id = $1`, [cart.id])).toBe(1);
  });

  it('expired cart — checkout returns 410 Gone with CART_EXPIRED code', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, token, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 1 },
    ]);

    // Force the cart's expires_at to 1 minute before the FROZEN now so the
    // checkout service's `cart.expiresAt.getTime() <= now.getTime()` trips.
    // The check compares against `new Date()` (frozen), so the fixture must
    // be tied to the frozen instant, not the DB wall clock — `Date.now()`
    // here already returns the frozen value.
    // postgres-js `.unsafe` binds parameters over the wire protocol and does
    // NOT serialize a JS Date — pass an ISO-8601 string for the timestamptz.
    await getPool().sql.unsafe(`UPDATE carts SET expires_at = $2 WHERE id = $1`, [
      cart.id,
      new Date(Date.now() - 60_000).toISOString(),
    ]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(410);
    expect(resp.json<ErrorBody>().error.code).toBe('CART_EXPIRED');
  });

  it('cross-user — a different principal probing a cart gets 404 (not 403)', async () => {
    const aliceToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer1,
      role: 'customer',
    });
    const cart = await buildCart(app, aliceToken, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 1 },
    ]);

    // mplsOwner is a different user principal; the role 'customer' lets
    // them through the role guard so the response is whatever the cart
    // ownership check returns. The check returns 404 to avoid leaking
    // cart existence.
    const otherToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsOwner,
      role: 'customer',
    });
    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(otherToken), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('empty cart — checkout returns 422 with VALIDATION_FAILED', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = create.json<CartBody>();

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('tip floor — driverTipCents below the $2 minimum rejects with 422 and writes no order rows', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, token, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 1 },
    ]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 199 },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');

    // Rejected at the DTO boundary — nothing reached the transaction.
    expect(await countRows('orders', `user_id = $1`, [SEED_IDS.user.customer1])).toBe(0);
    expect(await countRows('carts', `id = $1`, [cart.id])).toBe(1);
  });

  it('concurrency — two parallel checkouts of the same constrained listing: exactly one succeeds, one gets 409', async () => {
    // Constrain the shared listing to 4 units. Both carts ask for 3, so
    // total demand (6) exceeds supply by 2 — exactly one should land.
    await setListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID, 4);

    // Alice (customer-1) and the MPLS owner principal both place carts
    // on MPLS. Different users so each gets their own cart row via the
    // (user_id, dispensary_id) uniqueness — neither cart blocks the
    // other at the cart layer; the contention is at the listing
    // FOR UPDATE lock.
    const aliceToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer1,
      role: 'customer',
    });
    const aliceCart = await buildCart(app, aliceToken, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 3 },
    ]);
    // Use Derek (customer-4) as the second principal — also active +
    // KYC verified, has a seeded address, but the address is in St.
    // Paul which is outside the MPLS polygon. For this contention test
    // we point Derek's checkout at Alice's address via a probe — actually
    // no, the address must belong to the principal. Use Derek's own
    // address; geofence will fail and the checkout returns 422 before
    // touching inventory. That defeats the concurrency check.
    //
    // Better: have Alice's principal place TWO carts against TWO
    // different dispensaries… but the listing is per-dispensary, so the
    // constrained listing only lives on one dispensary.
    //
    // Correct approach: create a second user address for Derek that
    // sits inside the MPLS polygon, then point Derek's checkout there.
    const derekAddressId = stableUuid('address', 'addr-derek-mpls-test');
    await getPool().sql.unsafe(
      `INSERT INTO user_addresses (id, user_id, label, line1, city, region, postal_code, country, location, is_default, is_validated, validated_at)
       VALUES ($1, $2, 'Test', '100 Hennepin', 'Minneapolis', 'MN', '55401', 'US',
               ST_SetSRID(ST_MakePoint(-93.276, 44.974), 4326)::geography, false, true, NOW())`,
      [derekAddressId, SEED_IDS.user.customer4],
    );

    const derekToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer4,
      role: 'customer',
    });
    const derekCart = await buildCart(app, derekToken, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 3 },
    ]);

    const [aliceResp, derekResp] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/carts/${aliceCart.id}/checkout`,
        headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
        payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/carts/${derekCart.id}/checkout`,
        headers: { ...bearer(derekToken), 'content-type': 'application/json' },
        payload: { deliveryAddressId: derekAddressId, driverTipCents: 200 },
      }),
    ]);

    const codes = [aliceResp.statusCode, derekResp.statusCode].sort();
    expect(codes).toEqual([201, 409]);

    const loser = aliceResp.statusCode === 409 ? aliceResp : derekResp;
    expect(loser.json<ErrorBody>().error.code).toBe('INSUFFICIENT_INVENTORY');

    // Final inventory: 4 - 3 (winner) = 1.
    expect(await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID)).toBe(1);
    // Exactly one order written across both users.
    const orderCount = await countRows('orders', `user_id IN ($1, $2)`, [
      SEED_IDS.user.customer1,
      SEED_IDS.user.customer4,
    ]);
    expect(orderCount).toBe(1);
  });
});

describe('/v1/carts/:id/checkout — PAYMENTS_BYPASS_ENABLED test mode', () => {
  let app: NestFastifyApplication;
  let aeropay: FakeAeropayClient;

  beforeAll(async () => {
    // PAYMENTS_BYPASS_ENABLED is snapshotted at ConfigModule import time
    // (the validate() call runs once when app.module.js is first loaded),
    // so it cannot be flipped per-test via process.env. Instead override
    // the CheckoutService provider with one constructed with the flag
    // forced on, reusing the production scoped-repo factory so the wiring
    // can't drift. AEROPAY_CLIENT is still faked and injected into the
    // override so an accidental charge attempt is caught (we assert zero
    // createPayment calls below).
    aeropay = new FakeAeropayClient();
    app = await buildTestApp({
      overrides: [
        { token: AEROPAY_CLIENT, value: aeropay },
        {
          token: CheckoutService,
          inject: [DRIZZLE_DB, AEROPAY_CLIENT, EventEmitter2],
          factory: (db, ap, eventEmitter) =>
            new CheckoutService(
              db as Database,
              createCheckoutScopedRepos,
              ap as AeropayClientLike,
              true,
              eventEmitter as EventEmitter2,
            ),
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    freezeToBusinessHours();
    await seedFixtures();
    await force24HourHours();
    resetRateLimit(app);
    aeropay.createCalls.length = 0;
    aeropay.nextStatus = 'initiated';
    aeropay.nextThrow = null;
  });

  afterEach(() => {
    restoreClock();
  });

  it('places an order WITHOUT a linked bank account, recording a bypass payment and never charging Aeropay', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });

    // Remove every funding source for the principal. Under the normal
    // path this forces a 402 PAYMENT_METHOD_INVALID; a 201 here proves the
    // bypass skipped the linked-method requirement entirely.
    await getPool().sql.unsafe(`DELETE FROM payment_methods WHERE user_id = $1`, [
      SEED_IDS.user.customer1,
    ]);

    const cart = await buildCart(app, token, [
      { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 2 },
    ]);
    const inventoryBefore = await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 500 },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json<CheckoutBody>();

    // Order reaches the vendor queue exactly as the charged path would.
    expect(body.order.status).toBe('placed');
    expect(body.order.driverTipCents).toBe(500);
    expect(body.paymentIntent.provider).toBe('bypass');
    expect(body.paymentIntent.status).toBe('authorized');
    expect(body.paymentIntent.amountCents).toBe(body.order.totalCents);

    // Aeropay was never contacted.
    expect(aeropay.createCalls).toHaveLength(0);

    // payment_transactions row is the synthetic bypass record (no method ref).
    const intentRows = await fetchPaymentTransactionsForOrder(body.order.id);
    expect(intentRows).toHaveLength(1);
    expect(intentRows[0]?.provider).toBe('bypass');
    expect(intentRows[0]?.status).toBe('authorized');
    expect(intentRows[0]?.payment_method_id).toBeNull();
    expect(intentRows[0]?.provider_ref).toBe(body.paymentIntent.providerRef);

    // Inventory decremented and cart cleared — full placement still ran.
    expect(await readListingQuantity(MPLS_NORTHERN_LIGHTS_LISTING_ID)).toBe(inventoryBefore - 2);
    expect(await countRows('carts', `id = $1`, [cart.id])).toBe(0);

    // Placement ledger pair is still balanced.
    const ledger = await fetchLedgerForOrder(body.order.id);
    expect(ledger).toHaveLength(2);
    const debits = ledger.reduce((acc, r) => acc + Number(r.debit_cents), 0);
    const credits = ledger.reduce((acc, r) => acc + Number(r.credit_cents), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(body.order.totalCents);
  });

  it('still enforces compliance — a 900mg edible cart is rejected with 422 even under bypass', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, token, [
      { listingId: MPLS_DARK_CHOCOLATE_LISTING_ID, quantity: 9 },
    ]);

    const resp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { deliveryAddressId: ALICE_ADDRESS_ID, driverTipCents: 200 },
    });
    expect(resp.statusCode).toBe(422);
    expect(resp.json<ErrorBody>().error.code).toBe('COMPLIANCE_EVALUATION_FAILED');
    expect(await countRows('orders', `user_id = $1`, [SEED_IDS.user.customer1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers — small, test-local, no abstractions hiding what the test is doing.
// ---------------------------------------------------------------------------

async function force24HourHours(): Promise<void> {
  await getPool().sql.unsafe(`UPDATE dispensaries SET hours_json = $1::jsonb`, [
    JSON.stringify({
      mon: { open: '00:00', close: '23:59' },
      tue: { open: '00:00', close: '23:59' },
      wed: { open: '00:00', close: '23:59' },
      thu: { open: '00:00', close: '23:59' },
      fri: { open: '00:00', close: '23:59' },
      sat: { open: '00:00', close: '23:59' },
      sun: { open: '00:00', close: '23:59' },
    }),
  ]);
}

async function buildCart(
  app: NestFastifyApplication,
  token: string,
  lines: ReadonlyArray<{ readonly listingId: string; readonly quantity: number }>,
): Promise<CartBody> {
  const create = await app.inject({
    method: 'POST',
    url: '/v1/carts',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { dispensaryId: SEED_IDS.dispensary.mpls },
  });
  let cart = create.json<CartBody>();
  for (const line of lines) {
    const add = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/items`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { listingId: line.listingId, quantity: line.quantity },
    });
    // 201 is the contract for POST /v1/carts/:id/items. Anything else
    // means a fixture bug — surface it as a hard assertion failure with
    // the response body so the test report tells you what went wrong.
    expect(add.statusCode, `add item ${line.listingId}: ${add.body}`).toBe(201);
    cart = add.json<CartBody>();
  }
  return cart;
}

async function readListingQuantity(listingId: string): Promise<number> {
  const rows = await getPool().sql.unsafe<{ quantity_available: number }[]>(
    `SELECT quantity_available FROM dispensary_listings WHERE id = $1`,
    [listingId],
  );
  return rows[0]!.quantity_available;
}

async function setListingQuantity(listingId: string, quantity: number): Promise<void> {
  await getPool().sql.unsafe(
    `UPDATE dispensary_listings SET quantity_available = $1 WHERE id = $2`,
    [quantity, listingId],
  );
}

interface OrderRow {
  readonly id: string;
  readonly short_code: string;
  readonly user_id: string;
  readonly subtotal_cents: number | string;
  readonly total_cents: number | string;
}
async function fetchOrderRow(orderId: string): Promise<OrderRow> {
  const rows = await getPool().sql.unsafe<OrderRow[]>(
    `SELECT id, short_code, user_id, subtotal_cents, total_cents FROM orders WHERE id = $1`,
    [orderId],
  );
  return rows[0]!;
}

interface LedgerRow {
  readonly debit_cents: number | string;
  readonly credit_cents: number | string;
  readonly account_type: string;
}
async function fetchLedgerForOrder(orderId: string): Promise<readonly LedgerRow[]> {
  return getPool().sql.unsafe<LedgerRow[]>(
    `SELECT debit_cents, credit_cents, account_type FROM ledger_entries WHERE order_id = $1`,
    [orderId],
  );
}

interface PaymentTransactionRow {
  readonly provider: string;
  readonly provider_ref: string;
  readonly status: string;
  readonly amount_cents: number | string;
  readonly payment_method_id: string | null;
}
async function fetchPaymentTransactionsForOrder(
  orderId: string,
): Promise<readonly PaymentTransactionRow[]> {
  return getPool().sql.unsafe<PaymentTransactionRow[]>(
    `SELECT provider, provider_ref, status, amount_cents, payment_method_id
       FROM payment_transactions WHERE order_id = $1`,
    [orderId],
  );
}

async function countRows(
  table: string,
  whereClause: string,
  params: readonly string[],
): Promise<number> {
  // Table name is hard-coded at the call site (never user-controlled).
  const rows = await getPool().sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${whereClause}`,
    [...params],
  );
  return Number(rows[0]!.count);
}

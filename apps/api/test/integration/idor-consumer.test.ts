/**
 * IDOR (Insecure Direct Object Reference) coverage for the consumer
 * authenticated surface.
 *
 * Maintenance discipline: when a new authenticated consumer route is
 * added to `apps/api/src/modules/{orders,cart,checkout,identity,
 * payments}/`, an entry MUST be added here. The route table is the
 * source of truth — adding the endpoint without coverage is the
 * regression we are guarding against (a `WHERE` clause forgotten on
 * the new repo method, an ownership check dropped, an admin-only
 * shortcut that bleeds into the customer surface). The shape of
 * every case is the same:
 *
 *   1. Customer A creates a row (cart, address, payment-method, …).
 *   2. Customer B (different `userId` JWT principal) attempts to read
 *      or mutate that row.
 *   3. The expected status is 404 (NOT 403 — same shape as a missing
 *      record so an attacker cannot distinguish ownership-fail from
 *      existence-fail).
 *
 * Cross-role tests (e.g. an `owner` token hitting a consumer route)
 * are covered separately; this file is strictly about same-role
 * cross-tenant isolation, which is the IDOR class proper.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

interface CartBody {
  readonly id: string;
  readonly items: ReadonlyArray<{ readonly id: string }>;
}
interface AddressBody {
  readonly id: string;
}
interface ErrorBody {
  readonly error: { readonly code: string };
}

describe('IDOR — consumer surface (cross-user 404)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    // The validate path runs the compliance engine which honours
    // dispensary hours. Force 24-hour ops so the IDOR contract is the
    // only behaviour under test — wall-clock should not change the
    // result of a cross-tenant probe.
    const pool = getPool();
    await pool.sql.unsafe(`UPDATE dispensaries SET hours_json = $1::jsonb`, [
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
  });

  // --------------------------------------------------------------------
  // /v1/orders — GET /:id
  // --------------------------------------------------------------------
  it('GET /v1/orders/:id → 404 when probed by a different customer', async () => {
    // Insert a minimal order directly. The full checkout flow is
    // exercised by checkout.flow.test.ts; here we only need a row
    // owned by customer1 to probe.
    const pool = getPool();
    const aliceAddress = await pool.sql.unsafe<{ id: string }[]>(
      `SELECT id FROM user_addresses WHERE user_id = $1 LIMIT 1`,
      [SEED_IDS.user.customer1],
    );
    await pool.sql.unsafe(
      `INSERT INTO orders (id, short_code, user_id, dispensary_id, delivery_address_id,
                           subtotal_cents, cannabis_tax_cents, sales_tax_cents,
                           delivery_fee_cents, total_cents,
                           compliance_check_payload, delivery_address_snapshot)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
               1000, 100, 87, 599, 1786,
               '{}'::jsonb,
               '{"line1":"123 Main St","line2":null,"city":"Minneapolis","region":"MN","postalCode":"55401","location":{"type":"Point","coordinates":[-93.265,44.978]},"deliveryInstructions":null}'::jsonb)`,
      [
        '01935f3d-0000-7000-9000-000000000aa1',
        // 6-char short code + a well-formed delivery snapshot: GET
        // /v1/orders/:id now projects the full CustomerOrderDetailResponse
        // (order + dispensary pin + dropoff pin), validated by strict Zod
        // schemas. A real checkout always writes these; the IDOR contract
        // under test (cross-customer probe → 404) is unchanged.
        'IDORC1',
        SEED_IDS.user.customer1,
        SEED_IDS.dispensary.mpls,
        aliceAddress[0]!.id,
      ],
    );

    const aliceToken = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/orders/01935f3d-0000-7000-9000-000000000aa1',
      headers: bearer(aliceToken),
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const probeToken = signTokenFor(app, { userId: SEED_IDS.user.customer4, role: 'customer' });
    const probe = await app.inject({
      method: 'GET',
      url: '/v1/orders/01935f3d-0000-7000-9000-000000000aa1',
      headers: bearer(probeToken),
    });
    expect(probe.statusCode).toBe(404);
    expect(probe.json<ErrorBody>().error.code).toBe('ORDER_NOT_FOUND');
  });

  // --------------------------------------------------------------------
  // /v1/carts — GET, POST item, PATCH item, DELETE item, validate, DELETE
  // --------------------------------------------------------------------
  describe('/v1/carts — cross-user mutation probes', () => {
    async function aliceCart(): Promise<CartBody> {
      const aliceToken = signTokenFor(app, {
        userId: SEED_IDS.user.customer1,
        role: 'customer',
      });
      const create = await app.inject({
        method: 'POST',
        url: '/v1/carts',
        headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
        payload: { dispensaryId: SEED_IDS.dispensary.mpls },
      });
      expect(create.statusCode, create.body).toBe(201);
      const cart = create.json<CartBody>();
      const add = await app.inject({
        method: 'POST',
        url: `/v1/carts/${cart.id}/items`,
        headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
        payload: { listingId: SEED_IDS.listing.mplsNorthernLights7g, quantity: 1 },
      });
      expect(add.statusCode, add.body).toBe(201);
      return add.json<CartBody>();
    }

    function intruderToken(): string {
      return signTokenFor(app, { userId: SEED_IDS.user.customer4, role: 'customer' });
    }

    it('GET /:id → 404', async () => {
      const cart = await aliceCart();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/carts/${cart.id}`,
        headers: bearer(intruderToken()),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    });

    it('POST /:id/items → 404', async () => {
      const cart = await aliceCart();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/carts/${cart.id}/items`,
        headers: { ...bearer(intruderToken()), 'content-type': 'application/json' },
        payload: { listingId: SEED_IDS.listing.mplsDurban5Pack, quantity: 1 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /:id/items/:itemId → 404', async () => {
      const cart = await aliceCart();
      const itemId = cart.items[0]!.id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/carts/${cart.id}/items/${itemId}`,
        headers: { ...bearer(intruderToken()), 'content-type': 'application/json' },
        payload: { quantity: 2 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /:id/items/:itemId → 404', async () => {
      const cart = await aliceCart();
      const itemId = cart.items[0]!.id;
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/carts/${cart.id}/items/${itemId}`,
        headers: bearer(intruderToken()),
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /:id/validate → 404', async () => {
      const cart = await aliceCart();
      // deliveryAddressId is a required, strict query param — without it the
      // request 422s at the ZodValidationPipe before the ownership check ever
      // runs, so the probe must be well-formed to exercise the real 404 path.
      // Any syntactically-valid uuid works: the cart ownership guard fires
      // before the address is resolved.
      const res = await app.inject({
        method: 'POST',
        url: `/v1/carts/${cart.id}/validate?deliveryAddressId=01935f3d-0000-7000-8000-000000000060`,
        headers: bearer(intruderToken()),
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /:id → 404', async () => {
      const cart = await aliceCart();
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/carts/${cart.id}`,
        headers: bearer(intruderToken()),
      });
      expect(res.statusCode).toBe(404);

      // Alice's cart must still exist after the failed cross-user delete.
      const aliceToken = signTokenFor(app, {
        userId: SEED_IDS.user.customer1,
        role: 'customer',
      });
      const verify = await app.inject({
        method: 'GET',
        url: `/v1/carts/${cart.id}`,
        headers: bearer(aliceToken),
      });
      expect(verify.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------
  // /v1/addresses — PATCH /:id
  // --------------------------------------------------------------------
  it('PATCH /v1/addresses/:id → 404 when probed by a different customer', async () => {
    const aliceToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer1,
      role: 'customer',
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
      payload: {
        label: 'Home',
        line1: '100 Main St',
        city: 'Minneapolis',
        region: 'MN',
        postalCode: '55401',
        country: 'US',
        latitude: 44.978,
        longitude: -93.265,
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const address = create.json<AddressBody>();

    const probeToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer4,
      role: 'customer',
    });
    const probe = await app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${address.id}`,
      headers: { ...bearer(probeToken), 'content-type': 'application/json' },
      payload: { label: 'Hijacked' },
    });
    expect(probe.statusCode).toBe(404);

    // Alice's original label survives the failed cross-user patch.
    const verify = await app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: bearer(aliceToken),
    });
    const list = verify.json<{ addresses: ReadonlyArray<{ id: string; label: string }> }>();
    const row = list.addresses.find((a) => a.id === address.id);
    expect(row?.label).toBe('Home');
  });

  // --------------------------------------------------------------------
  // /v1/payment-methods — DELETE /:id
  // --------------------------------------------------------------------
  it('DELETE /v1/payment-methods/:id → 404 when probed by a different customer', async () => {
    // Seed a payment method directly. The Aeropay link flow is an
    // async webhook chain; for this contract test we only need a row
    // owned by customer1 whose deletion is gated on ownership.
    const pool = getPool();
    await pool.sql.unsafe(
      `INSERT INTO payment_methods (id, user_id, type, status,
                                    aeropay_payment_method_ref,
                                    bank_name, last4)
       VALUES ($1::uuid, $2::uuid, 'aeropay_ach', 'active',
               'aeropay_pm_ext_001',
               'Wells Fargo', '1234')`,
      ['01935f3d-0000-7000-9000-000000000bb1', SEED_IDS.user.customer1],
    );

    const probeToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer4,
      role: 'customer',
    });
    const probe = await app.inject({
      method: 'DELETE',
      url: '/v1/payment-methods/01935f3d-0000-7000-9000-000000000bb1',
      headers: bearer(probeToken),
    });
    expect(probe.statusCode).toBe(404);

    // Row must still be active after the failed cross-user delete.
    const rows = await pool.sql.unsafe<{ status: string }[]>(
      `SELECT status FROM payment_methods WHERE id = $1::uuid`,
      ['01935f3d-0000-7000-9000-000000000bb1'],
    );
    expect(rows[0]?.status).toBe('active');
  });
});

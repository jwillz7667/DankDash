/**
 * IDOR coverage for the driver-app authenticated surface
 * (`/v1/driver/*`).
 *
 * The driver-orders service pairs `(orderId, driverUserId)` in the
 * WHERE clause of `findByIdForDriver`. That is the primary guard;
 * RLS on `orders` is defense in depth. This file asserts the visible
 * contract — a different driver user, even one who legitimately
 * exists in the system, sees a 404 indistinguishable from a missing
 * order. The same shape applies to earnings + cashout: numbers
 * surfaced through those endpoints are scoped to the principal, never
 * to a foreign driver.
 *
 * Maintenance discipline: when a new authenticated driver route is
 * added under `apps/api/src/modules/drivers/controllers/`, an entry
 * MUST be added here.
 */
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

const DRIVER_1_USER_ID = stableUuid('user', 'driver-1');
const DRIVER_2_USER_ID = stableUuid('user', 'driver-2');
const ORDER_ID_DRIVER_1 = '01935f3d-0000-7000-9000-000000000ca1';

interface ErrorBody {
  readonly error: { readonly code: string };
}
interface EarningsBody {
  readonly availableCents: number;
  readonly pendingCents: number;
}

describe('IDOR — driver surface (cross-driver 404 + no earnings leak)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    // Insert an order that is currently assigned to driver-1. This is
    // the row driver-2 will try (and fail) to access.
    const pool = getPool();
    const aliceAddress = await pool.sql.unsafe<{ id: string }[]>(
      `SELECT id FROM user_addresses WHERE user_id = $1 LIMIT 1`,
      [SEED_IDS.user.customer1],
    );
    await pool.sql.unsafe(
      `INSERT INTO orders (id, short_code, user_id, dispensary_id, driver_id,
                           delivery_address_id, status,
                           subtotal_cents, cannabis_tax_cents, sales_tax_cents,
                           delivery_fee_cents, total_cents,
                           compliance_check_payload, delivery_address_snapshot)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
               $6::uuid, 'driver_assigned',
               1000, 100, 87, 599, 1786,
               '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        ORDER_ID_DRIVER_1,
        'IDOR-D1',
        SEED_IDS.user.customer1,
        SEED_IDS.dispensary.mpls,
        DRIVER_1_USER_ID,
        aliceAddress[0]!.id,
      ],
    );
  });

  // --------------------------------------------------------------------
  // /v1/driver/orders/:id — GET
  // --------------------------------------------------------------------
  it('GET /v1/driver/orders/:id → 200 for the assigned driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_1_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}`,
      headers: bearer(token),
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('GET /v1/driver/orders/:id → 404 for a different driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  // --------------------------------------------------------------------
  // /v1/driver/orders/:id/pickup-confirm — POST
  //
  // A cross-driver POST must NOT distinguish itself from a missing
  // order; specifically it must NEVER return 409 (state-mismatch),
  // which would confirm to the probe that the order is in some state
  // other than the one they asked for.
  // --------------------------------------------------------------------
  it('POST /v1/driver/orders/:id/pickup-confirm → 404 for a different driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}/pickup-confirm`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { location: { latitude: 44.978, longitude: -93.265 } },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  // --------------------------------------------------------------------
  // /v1/driver/orders/:id/delivery-confirm — POST
  // --------------------------------------------------------------------
  it('POST /v1/driver/orders/:id/delivery-confirm → 404 for a different driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}/delivery-confirm`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { location: { latitude: 44.978, longitude: -93.265 }, note: 'left at door' },
    });
    expect(res.statusCode).toBe(404);
  });

  // --------------------------------------------------------------------
  // /v1/driver/orders/:id/id-scan-session — POST
  // --------------------------------------------------------------------
  it('POST /v1/driver/orders/:id/id-scan-session → 404 for a different driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}/id-scan-session`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
  });

  // --------------------------------------------------------------------
  // /v1/driver/orders/:id/id-scan-result — POST
  // --------------------------------------------------------------------
  it('POST /v1/driver/orders/:id/id-scan-result → 404 for a different driver', async () => {
    const token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${ORDER_ID_DRIVER_1}/id-scan-result`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { sessionId: 'srv-not-real', status: 'approved' },
    });
    expect(res.statusCode).toBe(404);
  });

  // --------------------------------------------------------------------
  // /v1/driver/earnings — GET
  //
  // Driver earnings are scoped strictly to the principal. driver-1's
  // delivered orders' tips must not appear in driver-2's payload —
  // not even as an aggregate that could leak the existence of
  // driver-1 deliveries.
  // --------------------------------------------------------------------
  it('GET /v1/driver/earnings — driver-2 does not see driver-1 earnings', async () => {
    // Mark the driver-1 order as delivered with a tip, and add ledger
    // entries the earnings service reads from.
    const pool = getPool();
    await pool.sql.unsafe(
      `UPDATE orders
         SET status = 'delivered',
             delivered_at = NOW(),
             driver_tip_cents = 500,
             total_cents = subtotal_cents + cannabis_tax_cents + sales_tax_cents
                           + delivery_fee_cents + 500 - discount_cents
       WHERE id = $1::uuid`,
      [ORDER_ID_DRIVER_1],
    );

    const driver2Token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/driver/earnings',
      headers: bearer(driver2Token),
    });
    // Driver-2 has no orders; both gauges must be zero.
    expect(res.statusCode).toBe(200);
    const body = res.json<EarningsBody>();
    expect(body.availableCents).toBe(0);
    expect(body.pendingCents).toBe(0);
  });

  // --------------------------------------------------------------------
  // /v1/driver/cashout — POST
  //
  // Driver-2 with zero earnings cannot cash out an amount that only
  // exists in driver-1's ledger.
  // --------------------------------------------------------------------
  it('POST /v1/driver/cashout — driver-2 cannot drain driver-1 balance', async () => {
    const driver2Token = signTokenFor(app, { userId: DRIVER_2_USER_ID, role: 'driver' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/driver/cashout',
      headers: { ...bearer(driver2Token), 'content-type': 'application/json' },
      payload: { amountCents: 50_000 },
    });
    // The exact error code depends on whether the driver record exists
    // for driver-2; the IDOR-relevant assertion is that the call never
    // succeeds with money attributed to driver-1.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

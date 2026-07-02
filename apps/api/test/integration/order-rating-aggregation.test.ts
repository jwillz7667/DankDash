/**
 * Rating aggregation — end to end against real Postgres through the
 * customer `POST /v1/orders/:id/rate` HTTP surface.
 *
 * Proves the wiring closed on this branch: a post-delivery rating not only
 * writes the per-order columns but folds the driver and dispensary scores
 * into `drivers.rating_avg/rating_count` and
 * `dispensaries.rating_avg/rating_count` — the rollups the dispatch scorer
 * and menu ranking read, which were previously inert at their defaults.
 *
 * The fold is incremental SQL — `newAvg = (avg*count + rating)/(count+1)` —
 * computed on the row in the same transaction as the order write, so this
 * suite asserts the arithmetic against the real NUMERIC(3,2) columns (not a
 * JS re-derivation). Seed baselines: MPLS dispensary is 4.80 over 214
 * ratings; driver-1 starts unrated (NULL avg, 0 count).
 *
 * Orders are seeded straight into `delivered` via raw SQL (the established
 * `idor-driver` pattern) — the subject here is the rating write, not the
 * lifecycle that produces a delivered order, which is covered elsewhere.
 */
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

const DRIVER_1_USER_ID = stableUuid('user', 'driver-1');
const ORDER_A = stableUuid('order', 'rating-agg-a');
const ORDER_B = stableUuid('order', 'rating-agg-b');

const DROPOFF_SNAPSHOT = JSON.stringify({
  line1: '123 Main St',
  line2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.265, 44.978] },
  deliveryInstructions: null,
});

interface RatingRow {
  readonly rating_avg: string | null;
  readonly rating_count: number;
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

describe('rating aggregation — POST /v1/orders/:id/rate folds driver + dispensary scores', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    await seedDeliveredOrder(ORDER_A, 'RATEA1');
    await seedDeliveredOrder(ORDER_B, 'RATEB1');
  });

  function rate(orderId: string, body: Record<string, unknown>) {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    return app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/rate`,
      headers: bearer(token),
      payload: body,
    });
  }

  it('folds both the driver and dispensary ratings into their running aggregates', async () => {
    const res = await rate(ORDER_A, { driverRating: 4, dispensaryRating: 5 });
    expect(res.statusCode, res.body).toBe(200);

    // Driver-1 started unrated: first rating becomes the average, count 1.
    const driver = await driverRating(DRIVER_1_USER_ID);
    expect(driver.rating_avg).toBe('4.00');
    expect(driver.rating_count).toBe(1);

    // MPLS started at 4.80 over 214: (4.80*214 + 5)/215 = 4.8009… → 4.80.
    const dispensary = await dispensaryRating(SEED_IDS.dispensary.mpls);
    expect(dispensary.rating_avg).toBe('4.80');
    expect(dispensary.rating_count).toBe(215);
  });

  it('rejects a second rating with 409 and leaves the aggregates unchanged', async () => {
    const first = await rate(ORDER_A, { driverRating: 4, dispensaryRating: 5 });
    expect(first.statusCode, first.body).toBe(200);

    const second = await rate(ORDER_A, { driverRating: 1, dispensaryRating: 1 });
    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorBody>().error.code).toBe('ORDER_ALREADY_RATED');

    // Exactly one fold survived — the rejected retry never touched a row.
    const driver = await driverRating(DRIVER_1_USER_ID);
    expect(driver.rating_avg).toBe('4.00');
    expect(driver.rating_count).toBe(1);

    const dispensary = await dispensaryRating(SEED_IDS.dispensary.mpls);
    expect(dispensary.rating_avg).toBe('4.80');
    expect(dispensary.rating_count).toBe(215);
  });

  it('does not touch the driver aggregate when only the dispensary is rated', async () => {
    const res = await rate(ORDER_B, { dispensaryRating: 3 });
    expect(res.statusCode, res.body).toBe(200);

    // Driver-1 stays exactly at its unrated default.
    const driver = await driverRating(DRIVER_1_USER_ID);
    expect(driver.rating_avg).toBeNull();
    expect(driver.rating_count).toBe(0);

    // MPLS: (4.80*214 + 3)/215 = 4.7916… → 4.79.
    const dispensary = await dispensaryRating(SEED_IDS.dispensary.mpls);
    expect(dispensary.rating_avg).toBe('4.79');
    expect(dispensary.rating_count).toBe(215);
  });
});

/**
 * Insert one delivered order owned by customer-1 against MPLS, assigned to
 * driver-1. Money fields satisfy the orders total CHECK
 * (total = subtotal + cannabis_tax + sales_tax + delivery_fee + tip − discount).
 * short_code is pinned to 6 chars (OrderResponseSchema.length(6)).
 */
async function seedDeliveredOrder(orderId: string, shortCode: string): Promise<void> {
  const pool = getPool();
  const [address] = await pool.sql.unsafe<{ id: string }[]>(
    `SELECT id FROM user_addresses WHERE user_id = $1 LIMIT 1`,
    [SEED_IDS.user.customer1],
  );
  await pool.sql.unsafe(
    `INSERT INTO orders (id, short_code, user_id, dispensary_id, driver_id,
                         delivery_address_id, status,
                         subtotal_cents, cannabis_tax_cents, sales_tax_cents,
                         delivery_fee_cents, driver_tip_cents, total_cents,
                         delivered_at,
                         compliance_check_payload, delivery_address_snapshot)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, 'delivered',
             1000, 100, 87, 599, 0, 1786,
             now(),
             '{}'::jsonb, $7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      orderId,
      shortCode,
      SEED_IDS.user.customer1,
      SEED_IDS.dispensary.mpls,
      DRIVER_1_USER_ID,
      address!.id,
      DROPOFF_SNAPSHOT,
    ],
  );
}

async function driverRating(userId: string): Promise<RatingRow> {
  const rows = await getPool().sql.unsafe<RatingRow[]>(
    `SELECT rating_avg, rating_count FROM drivers WHERE user_id = $1::uuid`,
    [userId],
  );
  return rows[0]!;
}

async function dispensaryRating(dispensaryId: string): Promise<RatingRow> {
  const rows = await getPool().sql.unsafe<RatingRow[]>(
    `SELECT rating_avg, rating_count FROM dispensaries WHERE id = $1::uuid`,
    [dispensaryId],
  );
  return rows[0]!;
}

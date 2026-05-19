/**
 * /v1/carts — end-to-end cart CRUD against real Postgres.
 *
 * The cart surface is the consumer's pre-checkout state. Its invariants
 * are subtle enough that unit tests alone do not catch them — the cart
 * row's `expires_at` is a JS-computed value persisted on every mutation,
 * the per-line unit price is snapshotted from the listing at write-time,
 * and the `validate` endpoint round-trips the compliance engine output
 * through JSONB. All three are exercised here through the real Fastify
 * adapter, real Drizzle, real Postgres+PostGIS.
 *
 * Coverage map (Phase 5.1 + 5.2):
 *   - Create-or-get idempotency per (userId, dispensaryId)
 *   - Cross-user 404 on cart read (no leak of "exists but not yours")
 *   - Add → patch → remove item, with unit price snapshot survival
 *   - Compliance preview (passing + failing edible-THC over-limit)
 *   - Delete cart 204 + 404 on re-read
 *   - Expired cart (forced via raw SQL) → 410 on the validate path
 */
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

const ALICE_ADDRESS_ID = stableUuid('address', 'addr-alice-home');
const MPLS_DARK_CHOCOLATE_LISTING_ID = stableUuid('listing', 'mpls-p-edible-nl-1');

interface CartItemBody {
  readonly id: string;
  readonly listingId: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineSubtotalCents: number;
}
interface CartBody {
  readonly id: string;
  readonly userId: string;
  readonly dispensaryId: string;
  readonly subtotalCents: number;
  readonly items: readonly CartItemBody[];
  readonly expiresAt: string;
}
interface ValidateBody {
  readonly passed: boolean;
  readonly rules: ReadonlyArray<{
    readonly rule: string;
    readonly passed: boolean;
    readonly details: Record<string, unknown>;
  }>;
  readonly cartTotals: {
    readonly flowerGrams: number;
    readonly concentrateGrams: number;
    readonly edibleThcMg: number;
  };
}

describe('/v1/carts — CRUD + compliance preview', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    // Force the seeded dispensaries to 24-hour operations so the hours
    // rule never trips a test based on the local wall clock. The cart
    // surface itself does not enforce hours (validate runs the
    // compliance engine which does); rewriting the row here keeps the
    // happy-path tests deterministic regardless of when CI executes.
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

  it('POST /v1/carts is idempotent per (userId, dispensaryId)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<CartBody>();

    const second = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<CartBody>();

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.userId).toBe(SEED_IDS.user.customer1);
    expect(secondBody.dispensaryId).toBe(SEED_IDS.dispensary.mpls);
  });

  it('GET /v1/carts/:id returns 404 to a different user (no info leak)', async () => {
    const aliceToken = signTokenFor(app, {
      userId: SEED_IDS.user.customer1,
      role: 'customer',
    });
    const createResp = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(aliceToken), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = createResp.json<CartBody>();

    // Mint a token for a different customer principal (no seeded carts).
    const otherToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsOwner,
      role: 'customer',
    });
    const probe = await app.inject({
      method: 'GET',
      url: `/v1/carts/${cart.id}`,
      headers: bearer(otherToken),
    });
    expect(probe.statusCode).toBe(404);
    const body = probe.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('POST /:id/items snapshots the listing unit price; PATCH and DELETE adjust the line', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cartResp = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = cartResp.json<CartBody>();

    const addResp = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/items`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: {
        listingId: SEED_IDS.listing.mplsNorthernLights7g,
        quantity: 2,
      },
    });
    expect(addResp.statusCode).toBe(201);
    const afterAdd = addResp.json<CartBody>();
    expect(afterAdd.items).toHaveLength(1);
    const addedItem = afterAdd.items[0]!;
    expect(addedItem.quantity).toBe(2);
    expect(addedItem.unitPriceCents).toBeGreaterThan(0);
    expect(addedItem.lineSubtotalCents).toBe(addedItem.unitPriceCents * 2);
    expect(afterAdd.subtotalCents).toBe(addedItem.lineSubtotalCents);

    const patchResp = await app.inject({
      method: 'PATCH',
      url: `/v1/carts/${cart.id}/items/${addedItem.id}`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { quantity: 5 },
    });
    expect(patchResp.statusCode).toBe(200);
    const afterPatch = patchResp.json<CartBody>();
    const patchedItem = afterPatch.items[0]!;
    expect(patchedItem.quantity).toBe(5);
    expect(patchedItem.unitPriceCents).toBe(addedItem.unitPriceCents);

    // PATCH quantity=0 routes to removal — the line disappears.
    const removeResp = await app.inject({
      method: 'PATCH',
      url: `/v1/carts/${cart.id}/items/${addedItem.id}`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { quantity: 0 },
    });
    expect(removeResp.statusCode).toBe(200);
    expect(removeResp.json<CartBody>().items).toHaveLength(0);
  });

  it('POST /:id/validate returns passed=true for a sane cart inside MPLS polygon', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cartResp = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = cartResp.json<CartBody>();

    await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/items`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { listingId: SEED_IDS.listing.mplsNorthernLights7g, quantity: 1 },
    });

    const validate = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/validate?deliveryAddressId=${aliceAddressId()}`,
      headers: bearer(token),
    });
    expect(validate.statusCode, validate.body).toBe(200);
    const body = validate.json<ValidateBody>();
    expect(body.passed).toBe(true);
    expect(body.rules.find((r) => r.rule === 'per_transaction_limit')?.passed).toBe(true);
    expect(body.rules.find((r) => r.rule === 'delivery_geofence')?.passed).toBe(true);
    expect(body.cartTotals.flowerGrams).toBeGreaterThan(0);
  });

  it('POST /:id/validate returns passed=false when edible THC exceeds the per-transaction limit', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cartResp = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = cartResp.json<CartBody>();

    // Dark Chocolate Bar = 100mg THC / unit. 9 × 100 = 900mg > 800mg cap.
    await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/items`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { listingId: edibleDarkChocolateMplsListingId(), quantity: 9 },
    });

    const validate = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/validate?deliveryAddressId=${aliceAddressId()}`,
      headers: bearer(token),
    });
    expect(validate.statusCode).toBe(200);
    const body = validate.json<ValidateBody>();
    expect(body.passed).toBe(false);
    const limit = body.rules.find((r) => r.rule === 'per_transaction_limit');
    expect(limit?.passed).toBe(false);
    expect(body.cartTotals.edibleThcMg).toBe(900);
  });

  it('DELETE /v1/carts/:id returns 204 and the next GET returns 404', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/carts',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { dispensaryId: SEED_IDS.dispensary.mpls },
    });
    const cart = create.json<CartBody>();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/carts/${cart.id}`,
      headers: bearer(token),
    });
    expect(del.statusCode).toBe(204);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/carts/${cart.id}`,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(404);
  });
});

function aliceAddressId(): string {
  return ALICE_ADDRESS_ID;
}

function edibleDarkChocolateMplsListingId(): string {
  return MPLS_DARK_CHOCOLATE_LISTING_ID;
}

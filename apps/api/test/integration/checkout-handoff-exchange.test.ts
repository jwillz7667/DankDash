/**
 * POST /v1/auth/checkout-handoff/exchange — the Apple §10.4 checkout-web
 * exchange leg, end-to-end against real Postgres + Redis.
 *
 * The flow this proves:
 *   1. The iOS app mints a single-shot hand-off token
 *      (`POST /v1/auth/checkout-handoff`, authenticated as the customer).
 *   2. checkout-web (here, a raw request — no auth header) exchanges that
 *      token for a normal access-token session
 *      (`POST /v1/auth/checkout-handoff/exchange`).
 *   3. The returned access token authenticates against the customer cart
 *      surface, so checkout-web can read the cart and place the order.
 *
 * Security invariants asserted:
 *   - The exchange is one-shot: a second exchange of the same token → 401
 *     (the `jti` was atomically claimed in Redis by `consume`).
 *   - A malformed / unsigned token → 401, never a session.
 */
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, resetRateLimit, seedFixtures, signTokenFor } from './setup.js';

const ALICE_ADDRESS_ID = stableUuid('address', 'addr-alice-handoff-exchange');
const MPLS_NORTHERN_LIGHTS_LISTING_ID = SEED_IDS.listing.mplsNorthernLights7g;

interface CartBody {
  readonly id: string;
}
interface HandoffBody {
  readonly handoffToken: string;
  readonly exchangeUrl: string;
  readonly expiresAt: string;
}
interface ExchangeBody {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresInSeconds: number;
  readonly cartId: string;
  readonly deliveryAddressId: string;
}
interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

async function insertAliceAddress(): Promise<void> {
  // is_default = false: the seed already gives customer1 a default address,
  // and `user_addresses_one_default` is a partial unique index (one default
  // per user). The hand-off only needs the address to exist and be owned.
  await getPool().sql.unsafe(
    `INSERT INTO user_addresses (id, user_id, label, line1, city, region, postal_code, country, location, is_default, is_validated, validated_at)
     VALUES ($1, $2, 'Home', '100 Hennepin', 'Minneapolis', 'MN', '55401', 'US',
             ST_SetSRID(ST_MakePoint(-93.276, 44.974), 4326)::geography, false, true, NOW())`,
    [ALICE_ADDRESS_ID, SEED_IDS.user.customer1],
  );
}

async function buildCart(app: NestFastifyApplication, token: string): Promise<CartBody> {
  const create = await app.inject({
    method: 'POST',
    url: '/v1/carts',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { dispensaryId: SEED_IDS.dispensary.mpls },
  });
  const cart = create.json<CartBody>();
  const add = await app.inject({
    method: 'POST',
    url: `/v1/carts/${cart.id}/items`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 1 },
  });
  expect(add.statusCode, `add item: ${add.body}`).toBe(201);
  return cart;
}

async function issueHandoff(
  app: NestFastifyApplication,
  token: string,
  cartId: string,
): Promise<HandoffBody> {
  const resp = await app.inject({
    method: 'POST',
    url: '/v1/auth/checkout-handoff',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { cartId, deliveryAddressId: ALICE_ADDRESS_ID },
  });
  expect(resp.statusCode, `issue handoff: ${resp.body}`).toBe(201);
  return resp.json<HandoffBody>();
}

function exchange(app: NestFastifyApplication, handoff: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/checkout-handoff/exchange',
    headers: { 'content-type': 'application/json' },
    payload: { handoff },
  });
}

describe('POST /v1/auth/checkout-handoff/exchange', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    await insertAliceAddress();
    resetRateLimit(app);
  });

  it('exchanges a fresh hand-off token for a working access-token session', async () => {
    const customerToken = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, customerToken);
    const handoff = await issueHandoff(app, customerToken, cart.id);

    const resp = await exchange(app, handoff.handoffToken);
    expect(resp.statusCode, resp.body).toBe(200);
    const body = resp.json<ExchangeBody>();

    expect(body.tokenType).toBe('Bearer');
    expect(body.cartId).toBe(cart.id);
    expect(body.deliveryAddressId).toBe(ALICE_ADDRESS_ID);
    expect(body.expiresInSeconds).toBeGreaterThan(0);
    expect(body.accessToken.split('.')).toHaveLength(3);

    // The minted token must authenticate against the customer cart surface —
    // this is exactly what checkout-web does next.
    const cartRead = await app.inject({
      method: 'GET',
      url: `/v1/carts/${cart.id}`,
      headers: bearer(body.accessToken),
    });
    expect(cartRead.statusCode, cartRead.body).toBe(200);
    expect(cartRead.json<CartBody>().id).toBe(cart.id);
  });

  it('is one-shot — a second exchange of the same token is rejected', async () => {
    const customerToken = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const cart = await buildCart(app, customerToken);
    const handoff = await issueHandoff(app, customerToken, cart.id);

    const first = await exchange(app, handoff.handoffToken);
    expect(first.statusCode).toBe(200);

    const second = await exchange(app, handoff.handoffToken);
    expect(second.statusCode).toBe(401);
    expect(second.json<ErrorBody>().error.code).toBe('TOKEN_REVOKED');
  });

  it('rejects a malformed hand-off token with 401', async () => {
    const resp = await exchange(app, 'not-a-real-jwt');
    expect(resp.statusCode).toBe(401);
    expect(resp.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an empty hand-off token at the validation layer (422)', async () => {
    const resp = await exchange(app, '');
    expect(resp.statusCode).toBe(422);
  });
});

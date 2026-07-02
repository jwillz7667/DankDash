/**
 * Public catalog read endpoints — happy + 404 paths.
 *
 *   GET /v1/categories             — flat list, ordered by display_order.
 *   GET /v1/products/:id           — product detail + lab results.
 *   GET /v1/products/:id/listings  — cross-dispensary listings, paginated.
 *   GET /v1/dispensaries/:id       — single dispensary, 404 for unknown.
 *   GET /v1/dispensaries/:id/menu  — menu, 404 for unknown dispensary.
 *
 * Two things matter to assert here:
 *
 *   1. The public surface is reachable with no Authorization header —
 *      `@Public()` is honoured by JwtAuthGuard.
 *   2. The 404 path returns a clean ErrorEnvelope with `error.code = 'NOT_FOUND'`,
 *      not a leaked stack trace or empty body.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, seedFixtures } from './setup.js';

const UNKNOWN_UUID = '00000000-0000-7000-8000-0000000000aa';

describe('public catalog endpoints', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await seedFixtures();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/categories returns the seeded categories ordered by display_order', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/categories' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      categories: ReadonlyArray<{ id: string; slug: string; displayOrder: number }>;
    }>();
    expect(body.categories.length).toBeGreaterThanOrEqual(9);
    // Ordering: each row's displayOrder is ≥ the previous row's.
    for (let i = 1; i < body.categories.length; i++) {
      const previous = body.categories[i - 1]!;
      const current = body.categories[i]!;
      expect(current.displayOrder).toBeGreaterThanOrEqual(previous.displayOrder);
    }
  });

  it('GET /v1/products/:id returns the product when it is active and not deleted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/${SEED_IDS.product.northernLights7g}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string }>();
    expect(body.id).toBe(SEED_IDS.product.northernLights7g);
    expect(body.name).toMatch(/Northern Lights/u);
  });

  it('GET /v1/products/:id returns 404 for a well-formed UUID that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/products/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/products/:id returns 400 for a malformed UUID (ParseUUIDPipe)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/products/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/products/:id/listings returns every active in-stock store carrying the product', async () => {
    // Northern Lights is seeded at both North Loop (mpls) and Capitol (stp),
    // stp priced at 0.95× — a genuine multi-dispensary product.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/${SEED_IDS.product.northernLights7g}/listings`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      listings: ReadonlyArray<{
        listingId: string;
        dispensaryId: string;
        dispensaryName: string;
        priceCents: number;
        quantityAvailable: number;
      }>;
      page: { limit: number; offset: number; total: number };
    }>();

    expect(body.listings.length).toBeGreaterThanOrEqual(2);
    expect(body.page.total).toBeGreaterThanOrEqual(2);
    for (const listing of body.listings) {
      expect(listing.dispensaryName.length).toBeGreaterThan(0);
      expect(listing.quantityAvailable).toBeGreaterThan(0);
      expect(listing.priceCents).toBeGreaterThan(0);
    }
    // Deterministic price-ascending order — the client's "cheapest" default
    // picks listings[0].
    for (let i = 1; i < body.listings.length; i++) {
      expect(body.listings[i]!.priceCents).toBeGreaterThanOrEqual(body.listings[i - 1]!.priceCents);
    }
  });

  it('GET /v1/products/:id/listings honours limit/offset pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/${SEED_IDS.product.northernLights7g}/listings?limit=1&offset=0`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      listings: ReadonlyArray<{ listingId: string }>;
      page: { limit: number; offset: number; total: number };
    }>();
    expect(body.listings).toHaveLength(1);
    expect(body.page.limit).toBe(1);
    expect(body.page.total).toBeGreaterThanOrEqual(2);
  });

  it('GET /v1/products/:id/listings returns 404 for an unknown product (no listing probe)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/${UNKNOWN_UUID}/listings`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/dispensaries/:id returns the dispensary for a known active id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/dispensaries/${SEED_IDS.dispensary.mpls}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string; legalName: string }>();
    expect(body.id).toBe(SEED_IDS.dispensary.mpls);
    expect(body.status).toBe('active');
    expect(body.legalName).toMatch(/North Loop/u);
  });

  it('GET /v1/dispensaries/:id returns 404 for an unknown UUID', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/dispensaries/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /v1/dispensaries/:id/menu returns the seeded menu for a known dispensary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/dispensaries/${SEED_IDS.dispensary.mpls}/menu`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      dispensaryId: string;
      items: ReadonlyArray<{ listingId: string; product: { name: string } }>;
    }>();
    expect(body.dispensaryId).toBe(SEED_IDS.dispensary.mpls);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('GET /v1/dispensaries/:id/menu returns 404 for an unknown dispensary id (no tombstone leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/dispensaries/${UNKNOWN_UUID}/menu`,
    });
    expect(res.statusCode).toBe(404);
  });
});

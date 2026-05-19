/**
 * /v1/vendor/listings — RLS + VendorContextGuard integration.
 *
 * Three things to lock down end-to-end:
 *
 *   1. Header gate — VendorContextGuard rejects requests without a
 *      well-formed X-Dispensary-Id (422), and requests whose principal
 *      is not an active staff member of that dispensary (403).
 *
 *   2. Cross-vendor data isolation — an STP owner addressing a known
 *      MPLS listing id MUST receive 404, never 200 with someone else's
 *      row leaked. The repo's `WHERE dispensary_id = ?` filter is the
 *      primary guard; this asserts the visible behaviour.
 *
 *   3. Role guard — `customer` / `driver` JWT roles cannot reach the
 *      vendor surface even with a valid header, since RolesGuard
 *      narrows to staff-ish roles.
 *
 * Tests mint tokens via the live JwtService and address routes via
 * `app.inject()` — the full guard chain (JwtAuthGuard, RateLimitGuard,
 * VendorContextGuard, RolesGuard) runs exactly as in production.
 */
import { randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, seedFixtures, signTokenFor } from './setup.js';

describe('/v1/vendor/listings — vendor context + RLS', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
  });

  it('rejects a request with no X-Dispensary-Id header (422)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vendor/listings',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/X-Dispensary-Id/u);
  });

  it('rejects a malformed X-Dispensary-Id header (422)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vendor/listings',
      headers: { ...bearer(token), 'x-dispensary-id': 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a principal who does not staff the requested dispensary (403)', async () => {
    // MPLS owner pointed at STP — header references a dispensary they
    // are not staff of. Should 403 (authenticated, just not for this
    // context). Returning 404 would leak whether STP exists.
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vendor/listings',
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.stp },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a customer role on vendor routes (403)', async () => {
    // Even with valid header + valid dispensary membership (no membership
    // exists for a customer userId, but role guard runs after vendor
    // context — actually role guard is after vendor context guard, so it
    // never even reaches role guard here; expect 403 from vendor guard.)
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vendor/listings',
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.mpls },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows the MPLS owner to list their own dispensary listings (200)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vendor/listings',
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.mpls },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      listings: ReadonlyArray<{ id: string; dispensaryId: string }>;
    }>();
    expect(body.listings.length).toBeGreaterThan(0);
    for (const row of body.listings) {
      expect(row.dispensaryId).toBe(SEED_IDS.dispensary.mpls);
    }
  });

  it('returns 404 when STP owner tries to PATCH an MPLS listing (no cross-vendor leak)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.stpOwner, role: 'owner' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vendor/listings/${SEED_IDS.listing.mplsDurban5Pack}`,
      headers: {
        ...bearer(token),
        'x-dispensary-id': SEED_IDS.dispensary.stp,
        'content-type': 'application/json',
      },
      payload: { priceCents: 1234 },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when STP owner tries to DELETE an MPLS listing', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.stpOwner, role: 'owner' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/vendor/listings/${SEED_IDS.listing.mplsDurban5Pack}`,
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.stp },
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows the MPLS owner to delete a listing they own (204), and then 404 on a second delete', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const firstResp = await app.inject({
      method: 'DELETE',
      url: `/v1/vendor/listings/${SEED_IDS.listing.mplsDurban5Pack}`,
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.mpls },
    });
    expect(firstResp.statusCode).toBe(204);

    // Repository's softDeleteForDispensary only matches isActive=true; a
    // second delete returns false → service throws NotFoundError → 404.
    const secondResp = await app.inject({
      method: 'DELETE',
      url: `/v1/vendor/listings/${SEED_IDS.listing.mplsDurban5Pack}`,
      headers: { ...bearer(token), 'x-dispensary-id': SEED_IDS.dispensary.mpls },
    });
    expect(secondResp.statusCode).toBe(404);
  });

  it('rejects POST with malformed body fields (422 from ZodValidationPipe)', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vendor/listings',
      headers: {
        ...bearer(token),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: {
        productId: 'not-a-uuid',
        sku: 'TEST',
        priceCents: -1,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('allows the MPLS owner to create a listing for a real product, and rejects duplicate SKU with 409', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const sku = `INT-TEST-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/vendor/listings',
      headers: {
        ...bearer(token),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: {
        productId: SEED_IDS.product.sunsetSherbet,
        sku,
        priceCents: 4500,
      },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json<{ id: string; dispensaryId: string; sku: string }>();
    expect(body.dispensaryId).toBe(SEED_IDS.dispensary.mpls);
    expect(body.sku).toBe(sku);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/vendor/listings',
      headers: {
        ...bearer(token),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: {
        productId: SEED_IDS.product.northernLights7g,
        sku,
        priceCents: 5000,
      },
    });
    expect(second.statusCode).toBe(409);
  });
});

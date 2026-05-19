/**
 * GET /v1/dispensaries — PostGIS geo-filter integration.
 *
 * The unfiltered feed cache makes the test order matter: if we exercised
 * the unfiltered call first the second (geo) call would still hit Postgres,
 * but a future regression that accidentally cached geo queries would
 * silently start serving the wrong projection. We therefore drop the
 * unfiltered path entirely after the seed and assert only on the geo
 * path, which by design bypasses the cache.
 *
 * Seed fixtures pin three dispensaries with non-overlapping polygons:
 *
 *   MPLS  ≈ [-93.33..-93.18, 44.88..45.06]
 *   STP   ≈ [-93.18..-93.02, 44.88..45.03]
 *   MG    ≈ [-93.52..-93.38, 45.02..45.15]
 *
 * Test points:
 *   Downtown Minneapolis     (lat=44.987, lng=-93.273) → MPLS only.
 *   Downtown Saint Paul      (lat=44.954, lng=-93.090) → STP only.
 *   Maple Grove              (lat=45.073, lng=-93.456) → MG only.
 *   Downtown Los Angeles     (lat=34.052, lng=-118.244) → empty (outside MN).
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, seedFixtures } from './setup.js';

describe('GET /v1/dispensaries — geo filter', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await seedFixtures();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('returns only MPLS for a point inside the MPLS delivery polygon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dispensaries?lat=44.987&lng=-93.273',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispensaries: ReadonlyArray<{ id: string; legalName: string }> }>();
    const ids = body.dispensaries.map((d) => d.id);
    expect(ids).toEqual([SEED_IDS.dispensary.mpls]);
  });

  it('returns only STP for a point inside the STP delivery polygon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dispensaries?lat=44.954&lng=-93.090',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispensaries: ReadonlyArray<{ id: string }> }>();
    expect(body.dispensaries.map((d) => d.id)).toEqual([SEED_IDS.dispensary.stp]);
  });

  it('returns only MG for a point inside the Maple Grove polygon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dispensaries?lat=45.073&lng=-93.456',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispensaries: ReadonlyArray<{ id: string }> }>();
    expect(body.dispensaries.map((d) => d.id)).toEqual([SEED_IDS.dispensary.mg]);
  });

  it('returns empty for a point outside every MN polygon (LA)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dispensaries?lat=34.052&lng=-118.244',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ dispensaries: ReadonlyArray<unknown> }>();
    expect(body.dispensaries).toEqual([]);
  });

  it('rejects a half-specified geo query (lat without lng) with 422', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dispensaries?lat=44.987' });
    expect(res.statusCode).toBe(422);
  });

  it('rejects out-of-range coordinates with 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dispensaries?lat=91&lng=0',
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns the active dispensaries with the expected isOpenNow shape (unfiltered)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dispensaries' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      dispensaries: ReadonlyArray<{ id: string; status: string; isOpenNow: boolean }>;
    }>();
    expect(body.dispensaries.length).toBeGreaterThanOrEqual(3);
    for (const row of body.dispensaries) {
      expect(row.status).toBe('active');
      expect(typeof row.isOpenNow).toBe('boolean');
    }
  });
});

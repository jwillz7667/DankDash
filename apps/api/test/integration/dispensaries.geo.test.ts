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
 * Seed fixtures give all three dispensaries the shared Twin Cities metro
 * delivery polygon (`TWIN_CITIES_METRO_DELIVERY_POLYGON` in
 * `packages/db/src/seed.ts`) — Minneapolis, St. Paul, and the surrounding
 * suburbs, clipped to stay inside Minnesota because the geofence doubles
 * as the interstate guard.
 *
 * Test points:
 *   Downtown Minneapolis     (lat=44.987, lng=-93.273) → all three.
 *   Bloomington (suburb)     (lat=44.840, lng=-93.300) → all three.
 *   Woodbury (east suburb)   (lat=44.920, lng=-92.920) → all three.
 *   Rochester MN (out-state) (lat=44.020, lng=-92.480) → empty (in MN, off-metro).
 *   Hudson WI (interstate)   (lat=44.970, lng=-92.750) → empty (the polygon
 *                            is the only WI/IA/SD/ND guard — this must hold).
 *   Downtown Los Angeles     (lat=34.052, lng=-118.244) → empty.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, seedFixtures } from './setup.js';

const ALL_DISPENSARY_IDS = [
  SEED_IDS.dispensary.mpls,
  SEED_IDS.dispensary.stp,
  SEED_IDS.dispensary.mg,
].sort();

async function deliverableIds(app: NestFastifyApplication, lat: number, lng: number) {
  const res = await app.inject({ method: 'GET', url: `/v1/dispensaries?lat=${lat}&lng=${lng}` });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ dispensaries: ReadonlyArray<{ id: string }> }>();
  return body.dispensaries.map((d) => d.id).sort();
}

describe('GET /v1/dispensaries — geo filter', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await seedFixtures();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('returns all three dispensaries for downtown Minneapolis', async () => {
    expect(await deliverableIds(app, 44.987, -93.273)).toEqual(ALL_DISPENSARY_IDS);
  });

  it('returns all three dispensaries for a south-metro suburb (Bloomington)', async () => {
    expect(await deliverableIds(app, 44.84, -93.3)).toEqual(ALL_DISPENSARY_IDS);
  });

  it('returns all three dispensaries for an east-metro suburb (Woodbury)', async () => {
    expect(await deliverableIds(app, 44.92, -92.92)).toEqual(ALL_DISPENSARY_IDS);
  });

  it('returns empty for a Minnesota point outside the metro (Rochester)', async () => {
    expect(await deliverableIds(app, 44.02, -92.48)).toEqual([]);
  });

  it('returns empty across the Wisconsin line (Hudson) — interstate guard', async () => {
    expect(await deliverableIds(app, 44.97, -92.75)).toEqual([]);
  });

  it('returns empty for a point outside every MN polygon (LA)', async () => {
    expect(await deliverableIds(app, 34.052, -118.244)).toEqual([]);
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

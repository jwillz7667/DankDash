/**
 * POST /v1/admin/dispensaries/:id/activate — activation gate integration.
 *
 * Phase 4.3 specifies two preconditions enforced server-side at the
 * moment of activation:
 *
 *   1. License has not yet expired (license_expires_at > today UTC).
 *   2. At least one staff member is attached with role='owner' AND
 *      acceptedAt is non-null (an invited-but-unaccepted owner is not
 *      enough).
 *
 * Both gates surface as 422 ValidationError. The DB rejects activation
 * silently otherwise (e.g. status='active' is allowed for any row), so
 * these two server-side checks are the actual compliance teeth.
 *
 * Each subcase creates its own dispensary via POST so the seed's
 * already-active stores cannot accidentally satisfy the precondition.
 */
import { randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { bearer, seedFixtures, signTokenFor } from './setup.js';

const HOURS = {
  mon: { open: '09:00', close: '21:00' },
  tue: { open: '09:00', close: '21:00' },
  wed: { open: '09:00', close: '21:00' },
  thu: { open: '09:00', close: '21:00' },
  fri: { open: '09:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: { open: '10:00', close: '20:00' },
} as const;

const POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-93.33, 44.88],
      [-93.33, 45.06],
      [-93.18, 45.06],
      [-93.18, 44.88],
      [-93.33, 44.88],
    ],
  ],
};

const POINT = { type: 'Point' as const, coordinates: [-93.273, 44.987] };

function createDispensaryBody(overrides: {
  readonly licenseNumber: string;
  readonly licenseIssuedAt?: string;
  readonly licenseExpiresAt?: string;
}): Record<string, unknown> {
  return {
    legalName: 'Integration Test Co LLC',
    licenseNumber: overrides.licenseNumber,
    licenseType: 'retailer',
    licenseIssuedAt: overrides.licenseIssuedAt ?? '2024-01-01',
    licenseExpiresAt: overrides.licenseExpiresAt ?? '2030-12-31',
    addressLine1: '1 Test St',
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: POINT,
    deliveryPolygon: POLYGON,
    hours: HOURS,
  };
}

describe('POST /v1/admin/dispensaries/:id/activate — activation gate', () => {
  let app: NestFastifyApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    adminToken = signTokenFor(app, { userId: randomUUID(), role: 'admin' });
  });

  it('rejects activation when no accepted owner staff member exists (422)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/dispensaries',
      headers: { ...bearer(adminToken), 'content-type': 'application/json' },
      payload: createDispensaryBody({ licenseNumber: 'MN-INT-001-NoOwner' }),
    });
    expect(created.statusCode).toBe(201);
    const dispensaryId = created.json<{ id: string }>().id;

    const activated = await app.inject({
      method: 'POST',
      url: `/v1/admin/dispensaries/${dispensaryId}/activate`,
      headers: bearer(adminToken),
    });
    expect(activated.statusCode).toBe(422);
    const body = activated.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/owner/iu);
  });

  it('rejects activation when the license has already expired (422)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/dispensaries',
      headers: { ...bearer(adminToken), 'content-type': 'application/json' },
      payload: createDispensaryBody({
        licenseNumber: 'MN-INT-002-Expired',
        licenseIssuedAt: '2020-01-01',
        licenseExpiresAt: '2022-01-01',
      }),
    });
    expect(created.statusCode).toBe(201);
    const dispensaryId = created.json<{ id: string }>().id;

    const activated = await app.inject({
      method: 'POST',
      url: `/v1/admin/dispensaries/${dispensaryId}/activate`,
      headers: bearer(adminToken),
    });
    expect(activated.statusCode).toBe(422);
    const body = activated.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/expired/iu);
  });

  it('rejects a license window with end ≤ start (422 — schema refine)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/dispensaries',
      headers: { ...bearer(adminToken), 'content-type': 'application/json' },
      payload: createDispensaryBody({
        licenseNumber: 'MN-INT-003-BadDates',
        licenseIssuedAt: '2025-01-01',
        licenseExpiresAt: '2025-01-01',
      }),
    });
    expect(created.statusCode).toBe(422);
  });

  it('rejects non-admin role on admin routes with 403', async () => {
    const budtenderToken = signTokenFor(app, { userId: randomUUID(), role: 'budtender' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dispensaries',
      headers: { ...bearer(budtenderToken), 'content-type': 'application/json' },
      payload: createDispensaryBody({ licenseNumber: 'MN-INT-004-Forbidden' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects missing Authorization on admin routes with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dispensaries',
      headers: { 'content-type': 'application/json' },
      payload: createDispensaryBody({ licenseNumber: 'MN-INT-005-NoAuth' }),
    });
    expect(res.statusCode).toBe(401);
  });
});

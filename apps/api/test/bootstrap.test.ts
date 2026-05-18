/**
 * Bootstrap smoke test — proves the Fastify + NestJS wiring actually starts
 * and serves the three health-check endpoints with the request id header
 * round-tripped through the response. Other features pile their tests on
 * top of this same buildTestApp helper so they get the full pipeline
 * (filters, interceptors, validation) wired exactly as production does.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/build-app.js';

describe('apps/api bootstrap', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/health', '/health/live', '/health/ready'])('GET %s returns 200 ok', async (path) => {
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; service: string; checkedAt: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('apps/api');
    expect(new Date(body.checkedAt).toString()).not.toBe('Invalid Date');
  });

  it('echoes a caller-supplied X-Request-Id header', async () => {
    const incoming = 'req-from-client-123';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': incoming },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(incoming);
  });

  it('mints an X-Request-Id when none is supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('404s on an unknown route via the global filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/this-route-does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

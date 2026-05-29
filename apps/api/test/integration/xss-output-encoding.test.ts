/**
 * Output-encoding contract for XSS-sensitive surfaces.
 *
 * The API ships JSON only — no HTML rendering, no server-side
 * templates. JSON's native escaping treats `<`, `>`, `&`, `'`, `"` as
 * ordinary characters, so an XSS payload stored in a free-text column
 * survives storage and is reflected verbatim in the response body.
 * That is the correct contract for a JSON API: the *consumer* (iOS,
 * portal) is responsible for safe rendering, not the wire format.
 *
 * What we DO need to lock down is:
 *
 *   1. The response Content-Type is `application/json` — never
 *      `text/html` — so a browser pointed at the URL renders the
 *      payload as text rather than executing it.
 *   2. The payload round-trips byte-for-byte through the storage
 *      layer so the client receives exactly what was stored (no
 *      partial double-encoding that could land a payload in an
 *      unexpected sink).
 *   3. Surrounding headers do not inadvertently allow embedding
 *      (`X-Content-Type-Options: nosniff` from helmet, `X-Frame-
 *      Options: DENY`).
 *
 * Coverage targets:
 *
 *   - PATCH /v1/addresses/:id (label, deliveryInstructions)
 *   - GET   /v1/addresses (list reflection)
 *   - POST  /v1/carts/:id/items (no free text, but a fixed-format
 *     numeric field is included to confirm the same headers apply)
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, seedFixtures, signTokenFor } from './setup.js';

const XSS_PAYLOADS: ReadonlyArray<string> = [
  '<script>alert(1)</script>',
  "'><script>alert(1)</script>",
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  'javascript:alert(1)',
  '<iframe src="javascript:alert(1)">',
  '"autofocus onfocus=alert(1) x="',
  // Polyglot from OWASP
  'jaVasCript:/*-/*`/*\\`/*\'/*"/**/(/* */oNcliCk=alert() )//',
] as const;

interface AddressBody {
  readonly id: string;
  readonly label: string | null;
  readonly deliveryInstructions: string | null;
}
interface ListBody {
  readonly addresses: ReadonlyArray<AddressBody>;
}

describe('XSS output encoding — JSON contract + safe response headers', () => {
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

  it.each(XSS_PAYLOADS)(
    'PATCH /v1/addresses/:id round-trips XSS payload %# unchanged, in JSON, with safe headers',
    async (payload) => {
      const token = signTokenFor(app, {
        userId: SEED_IDS.user.customer1,
        role: 'customer',
      });

      // Create a fresh address each time so the test is independent.
      const create = await app.inject({
        method: 'POST',
        url: '/v1/addresses',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        payload: {
          label: 'Home',
          line1: '100 Main St',
          city: 'Minneapolis',
          region: 'MN',
          postalCode: '55401',
          country: 'US',
          latitude: 44.978,
          longitude: -93.265,
        },
      });
      expect(create.statusCode, create.body).toBe(201);
      const address = create.json<AddressBody>();

      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/addresses/${address.id}`,
        headers: { ...bearer(token), 'content-type': 'application/json' },
        payload: {
          label: payload,
          deliveryInstructions: payload,
        },
      });
      expect(patch.statusCode, patch.body).toBe(200);

      // 1. Content-Type is application/json — never text/html.
      expect(patch.headers['content-type']).toMatch(/application\/json/u);
      expect(patch.headers['content-type']).not.toMatch(/text\/html/u);

      // 2. helmet emits the nosniff + frame-deny headers.
      expect(patch.headers['x-content-type-options']).toBe('nosniff');
      expect(patch.headers['x-frame-options']).toBe('DENY');

      // 3. Payload round-trips byte-for-byte through storage.
      const updated = patch.json<AddressBody>();
      expect(updated.label).toBe(payload);
      expect(updated.deliveryInstructions).toBe(payload);

      // 4. Same payload survives the list reflection unchanged.
      const list = await app.inject({
        method: 'GET',
        url: '/v1/addresses',
        headers: bearer(token),
      });
      expect(list.statusCode).toBe(200);
      expect(list.headers['content-type']).toMatch(/application\/json/u);
      const row = list.json<ListBody>().addresses.find((a) => a.id === address.id);
      expect(row?.label).toBe(payload);
    },
  );

  it('GET /v1/products/search reflects an XSS-shaped q param without setting text/html', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/search?q=${encodeURIComponent('<script>alert(1)</script>')}`,
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/application\/json/u);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

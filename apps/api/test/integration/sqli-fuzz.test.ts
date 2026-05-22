/**
 * SQL injection fuzz over the public search and authenticated address
 * surfaces.
 *
 * The API talks to Postgres exclusively through Drizzle + the `postgres`
 * driver in parameterised mode (prepared statements are off only to
 * keep pgbouncer tx-mode happy — query parameters are still bound, not
 * concatenated). That means SQLi cannot land via the documented client
 * shapes; this suite proves the contract by trying to land it.
 *
 * Coverage:
 *
 *   1. /v1/products/search?q=...           (public free-text)
 *   2. /v1/addresses                         (authenticated free-text)
 *
 * For each payload we assert:
 *
 *   - The response is 200/201/422 (validation may legitimately reject
 *     an over-length payload), but NEVER 500 — a 5xx would indicate a
 *     SQL parse error reached the Postgres engine, which would be the
 *     bug.
 *   - The Content-Type is `application/json` so the payload cannot be
 *     reflected as HTML if a downstream surface mistakenly renders it.
 *
 * The payload set is the OWASP SQLi cheat-sheet's union/comment/auth-
 * bypass classics. We do not include time-based blind payloads
 * (`pg_sleep`, `WAITFOR`) — those would slow the suite without
 * adding signal, since the parameterisation contract is already
 * shown by the syntactic payloads.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, seedFixtures, signTokenFor } from './setup.js';

const SQLI_PAYLOADS: ReadonlyArray<string> = [
  // Boolean / tautology
  "' OR '1'='1",
  "' OR 1=1--",
  "' OR 1=1#",
  '" OR "1"="1',
  // Comment / terminator
  "'; --",
  "';--",
  '/*',
  '*/',
  '-- ',
  '#',
  // UNION / stacked
  "' UNION SELECT NULL--",
  "' UNION SELECT username, password FROM users--",
  "'; DROP TABLE users--",
  "'; SELECT * FROM pg_user--",
  "'; SHUTDOWN--",
  // Auth bypass classics
  "admin'--",
  "admin' #",
  "admin'/*",
  "' or 1=1 limit 1 -- -",
  "' or 1=1 limit 1,1 -- -",
  // Postgres-specific
  "'); SELECT pg_sleep(0)--",
  "'; COPY users TO '/tmp/x'--",
  '$$ OR 1=1; --',
  "1' OR pg_read_file('/etc/passwd')--",
  "' OR current_user::text = ''--",
  // Encoding tricks
  '%27%20OR%201%3D1--',
  '\\x27 OR 1=1--',
  // Quote-escape probes
  "''",
  '""',
  '\\',
] as const;

interface ErrorBody {
  readonly error?: { readonly code: string };
}

describe('SQLi fuzz — public search + authenticated address', () => {
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

  describe('/v1/products/search?q=<payload>', () => {
    it.each(SQLI_PAYLOADS)('payload %#: never 500', async (payload) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/products/search?q=${encodeURIComponent(payload)}`,
      });
      expect(res.statusCode, `payload=${payload} body=${res.body}`).not.toBe(500);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.headers['content-type']).toMatch(/application\/json/u);

      // Any 4xx must be a structured error envelope — never a stack
      // trace or raw DB error. The standard envelope always includes
      // `error.code` (uppercase identifier).
      if (res.statusCode >= 400) {
        const body = res.json<ErrorBody>();
        expect(body.error?.code).toMatch(/^[A-Z_]+$/u);
      }
    });
  });

  describe('/v1/addresses — line1 + city + label + deliveryInstructions', () => {
    it.each(SQLI_PAYLOADS)('payload %#: never 500', async (payload) => {
      const token = signTokenFor(app, {
        userId: SEED_IDS.user.customer1,
        role: 'customer',
      });
      // Inject the payload into every free-text field at once. If
      // string concatenation lurks anywhere in the address repo, the
      // chance of catching it goes up multiplicatively.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/addresses',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        payload: {
          label: payload.slice(0, 80),
          line1: payload.slice(0, 200),
          city: payload.slice(0, 120) || 'X',
          region: 'MN',
          postalCode: '55401',
          country: 'US',
          latitude: 44.978,
          longitude: -93.265,
          deliveryInstructions: payload.slice(0, 500),
        },
      });
      // 201 (accepted) or 422 (validation rejected) are fine; 500 is the
      // failure we are guarding against.
      expect(res.statusCode, `payload=${payload} body=${res.body}`).not.toBe(500);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.headers['content-type']).toMatch(/application\/json/u);
    });
  });
});

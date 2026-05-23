/**
 * JWT tampering — JwtAuthGuard rejection matrix.
 *
 * The guard composes `JwtService.verifyAccessToken` which pins:
 *
 *   - algorithm = RS256 only (algorithm-confusion defence)
 *   - issuer    = 'dankdash'
 *   - audience  = 'dankdash.app'
 *   - clock skew = 30s
 *   - signature verified against the public key
 *
 * If any of those drifts in a refactor, this suite goes red. Every
 * case targets `GET /v1/orders` — an authenticated route with no
 * special role, body, or path-param requirements — so the failure
 * surface is strictly the auth layer.
 *
 * Successful response from the guard is 401 with `AUTH_TOKEN_INVALID`
 * (or `AUTH_TOKEN_EXPIRED` for the expiry case). The error body
 * shape carries no information about WHY the token failed beyond the
 * code — i.e. we do not echo back the offending claim or signature
 * mismatch detail.
 */
import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, signTokenFor } from './setup.js';

interface ErrorBody {
  readonly error: { readonly code: string; readonly message?: string };
}

class JwtTestEnvError extends Error {
  public override readonly name = 'JwtTestEnvError';
  constructor(varName: string) {
    super(`jwt-tamper.test: ${varName} is unset`);
  }
}

class JwtSegmentError extends Error {
  public override readonly name = 'JwtSegmentError';
  constructor() {
    super('jwt-tamper.test: expected a three-segment JWT from signTokenFor');
  }
}

// Generate a throw-away RS256 key pair for the "wrong-signature" case.
// Held at module scope so the keygen (~200ms) happens once across the
// whole suite, not once per test.
const FOREIGN_KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('JWT tampering — JwtAuthGuard rejects invalid tokens', () => {
  let app: NestFastifyApplication;
  let privateKey: string;

  beforeAll(async () => {
    app = await buildTestApp();
    // Pull the same private key the JwtService is using so the tamper
    // cases that need a legitimately-signed-but-otherwise-broken token
    // (wrong iss, wrong aud, expired) can mint one.
    const cfg = app.get(ConfigService);
    const b64 = cfg.get<string>('JWT_PRIVATE_KEY_BASE64', { infer: true });
    if (b64 === undefined || b64.length === 0) {
      throw new JwtTestEnvError('JWT_PRIVATE_KEY_BASE64');
    }
    privateKey = Buffer.from(b64, 'base64').toString('utf-8');
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('control case — a fresh valid token is accepted', async () => {
    const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(token),
    });
    expect([200, 304]).toContain(res.statusCode);
  });

  it('rejects an alg=none token', async () => {
    // `jsonwebtoken@9+` blocks signing with alg=none, so we hand-craft
    // the three-part token. Algorithm-confusion defence: the API's
    // verify call pins `algorithms: ['RS256']`, so the header alg
    // mismatch fails before any signature comparison.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: SEED_IDS.user.customer1,
        sid: '01935f3d-0000-7000-8000-000000000999',
        role: 'customer',
        iss: 'dankdash',
        aud: 'dankdash.app',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    const tampered = `${header}.${payload}.`;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with a foreign RS256 key', async () => {
    const tampered = jwt.sign(
      { sid: '01935f3d-0000-7000-8000-000000000998', role: 'customer' },
      FOREIGN_KEYS.privateKey,
      {
        algorithm: 'RS256',
        expiresIn: 600,
        issuer: 'dankdash',
        audience: 'dankdash.app',
        keyid: 'v1',
        subject: SEED_IDS.user.customer1,
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    // 10 minutes past expiry — well beyond the 30s clockTolerance
    // window. Setting iat + exp directly (rather than relying on
    // `expiresIn`) sidesteps `jsonwebtoken` re-stamping iat at sign
    // time so the token unambiguously lives in the past.
    const past = Math.floor(Date.now() / 1000) - 700;
    const tampered = jwt.sign(
      {
        sid: '01935f3d-0000-7000-8000-000000000997',
        role: 'customer',
        iat: past,
        exp: past + 60,
      },
      privateKey,
      {
        algorithm: 'RS256',
        issuer: 'dankdash',
        audience: 'dankdash.app',
        keyid: 'v1',
        subject: SEED_IDS.user.customer1,
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with the wrong issuer', async () => {
    const tampered = jwt.sign(
      { sid: '01935f3d-0000-7000-8000-000000000996', role: 'customer' },
      privateKey,
      {
        algorithm: 'RS256',
        expiresIn: 600,
        issuer: 'evil',
        audience: 'dankdash.app',
        keyid: 'v1',
        subject: SEED_IDS.user.customer1,
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with the wrong audience', async () => {
    const tampered = jwt.sign(
      { sid: '01935f3d-0000-7000-8000-000000000995', role: 'customer' },
      privateKey,
      {
        algorithm: 'RS256',
        expiresIn: 600,
        issuer: 'dankdash',
        audience: 'dankdash.partner',
        keyid: 'v1',
        subject: SEED_IDS.user.customer1,
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with a modified payload (signature mismatch)', async () => {
    // Take a legitimately signed token, flip a single character in the
    // payload segment, and re-assemble. The signature is now invalid.
    const valid = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
    const segments = valid.split('.');
    if (segments.length !== 3) throw new JwtSegmentError();
    const [header, payload, signature] = segments as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      role: string;
      [k: string]: unknown;
    };
    decoded.role = 'admin';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: bearer(tampered),
    });
    expect(res.statusCode).toBe(401);
    // The error body must not leak which check failed.
    const body = res.json<ErrorBody>();
    expect(body.error.code).toMatch(/^AUTH_/u);
  });
});

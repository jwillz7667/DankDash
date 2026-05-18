/**
 * Unit tests for JwtService.
 *
 * Generates a throwaway RSA key pair per suite so tests are self-contained
 * and don't depend on the env. Production parameters: 2048 bits (matches
 * what the Railway secret manager holds). Tests cover the round-trip happy
 * path and every documented rejection path — including the algorithm-
 * confusion attack against the public key, which is the classic JWT
 * mistake worth a dedicated regression test.
 */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { AuthError } from '@dankdash/types';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from './jwt.service.js';

function makeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

describe('JwtService', () => {
  let service: JwtService;
  let keys: ReturnType<typeof makeKeyPair>;

  beforeAll(() => {
    keys = makeKeyPair();
    service = new JwtService({
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
      accessTtlSeconds: 900,
    });
  });

  describe('signAccessToken + verifyAccessToken', () => {
    it('round-trips a token with all claims preserved', () => {
      const token = service.signAccessToken({
        userId: 'user-123',
        sessionId: 'sess-456',
        role: 'customer',
      });
      const claims = service.verifyAccessToken(token);
      expect(claims.sub).toBe('user-123');
      expect(claims.sid).toBe('sess-456');
      expect(claims.role).toBe('customer');
      expect(claims.iss).toBe('dankdash');
      expect(claims.aud).toBe('dankdash.app');
      expect(claims.exp).toBeGreaterThan(claims.iat);
      expect(claims.exp - claims.iat).toBe(900);
    });

    it('produces RS256-typed JWT headers', () => {
      const token = service.signAccessToken({
        userId: 'u',
        sessionId: 's',
        role: 'driver',
      });
      const header = JSON.parse(
        Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(header['alg']).toBe('RS256');
      expect(header['typ']).toBe('JWT');
      expect(header['kid']).toBe('v1');
    });
  });

  describe('rejection paths', () => {
    it('rejects an expired token with TOKEN_EXPIRED', () => {
      const shortService = new JwtService({
        privateKeyPem: keys.privateKeyPem,
        publicKeyPem: keys.publicKeyPem,
        accessTtlSeconds: 1,
      });
      // Sign with a backdated iat so the token is already expired beyond
      // the 30s clock-skew tolerance.
      const expired = jwt.sign(
        { sid: 's', role: 'r', iat: Math.floor(Date.now() / 1000) - 1000 },
        keys.privateKeyPem,
        {
          algorithm: 'RS256',
          expiresIn: 1,
          issuer: 'dankdash',
          audience: 'dankdash.app',
          keyid: 'v1',
          subject: 'u',
          noTimestamp: true,
        },
      );
      try {
        shortService.verifyAccessToken(expired);
        expect.unreachable('expected AuthError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_EXPIRED');
      }
    });

    it('rejects a token with the wrong audience', () => {
      const wrongAud = jwt.sign({ sid: 's', role: 'r' }, keys.privateKeyPem, {
        algorithm: 'RS256',
        expiresIn: 60,
        issuer: 'dankdash',
        audience: 'evil.example',
        keyid: 'v1',
        subject: 'u',
      });
      expect(() => service.verifyAccessToken(wrongAud)).toThrow(AuthError);
    });

    it('rejects a token with the wrong issuer', () => {
      const wrongIss = jwt.sign({ sid: 's', role: 'r' }, keys.privateKeyPem, {
        algorithm: 'RS256',
        expiresIn: 60,
        issuer: 'someone-else',
        audience: 'dankdash.app',
        keyid: 'v1',
        subject: 'u',
      });
      expect(() => service.verifyAccessToken(wrongIss)).toThrow(AuthError);
    });

    it('rejects a token whose signature was tampered', () => {
      const token = service.signAccessToken({
        userId: 'u',
        sessionId: 's',
        role: 'r',
      });
      const parts = token.split('.');
      const tampered = `${parts[0] ?? ''}.${parts[1] ?? ''}.AAAA${(parts[2] ?? '').slice(4)}`;
      expect(() => service.verifyAccessToken(tampered)).toThrow(AuthError);
    });

    it('rejects an HS256 forgery using the public key as HMAC secret', () => {
      // Classic algorithm-confusion attack: attacker takes the public key
      // (which is, well, public) and forges an HS256 token. A naive verify
      // that trusts the alg header would accept it. Ours explicitly pins
      // RS256, so this must reject.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'v1' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'u',
          sid: 's',
          role: 'admin',
          iss: 'dankdash',
          aud: 'dankdash.app',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      ).toString('base64url');
      const sig = createHmac('sha256', keys.publicKeyPem)
        .update(`${header}.${payload}`)
        .digest('base64url');
      const forged = `${header}.${payload}.${sig}`;
      expect(() => service.verifyAccessToken(forged)).toThrow(AuthError);
    });

    it('rejects a structurally invalid JWT', () => {
      expect(() => service.verifyAccessToken('not.a.jwt')).toThrow(AuthError);
    });

    it('rejects a token whose payload is missing required claims', () => {
      // Sign with valid envelope but no `sid` / `role` claims.
      const malformed = jwt.sign({}, keys.privateKeyPem, {
        algorithm: 'RS256',
        expiresIn: 60,
        issuer: 'dankdash',
        audience: 'dankdash.app',
        keyid: 'v1',
        subject: 'u',
      });
      try {
        service.verifyAccessToken(malformed);
        expect.unreachable('expected AuthError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_INVALID');
      }
    });
  });
});

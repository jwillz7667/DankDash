/**
 * Unit tests for PasswordService.
 *
 * Argon2id with production parameters (64 MiB, t=3) takes ~150ms per call,
 * which would make the suite take minutes if we used defaults. Tests use
 * `m=512 KiB, t=1, p=1` which exercises the same code paths in <5ms while
 * still producing a valid `$argon2id$...` output that's wire-compatible
 * with production hashes. This is the conventional pattern for argon2 unit
 * tests — production parameters belong in a dedicated benchmark or load
 * test, not in CI.
 */
import { PasswordError } from '@dankdash/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

const FAST_OPTS = { memoryCost: 512, timeCost: 1, parallelism: 1, hashLength: 32 } as const;
const PEPPER_A = 'a'.repeat(32);
const PEPPER_B = 'b'.repeat(32);

function svc(pepper: string = PEPPER_A): PasswordService {
  return new PasswordService({ pepper, hashOptions: FAST_OPTS });
}

describe('PasswordService', () => {
  describe('construction', () => {
    it('rejects a pepper shorter than 32 bytes', () => {
      expect(() => new PasswordService({ pepper: 'short', hashOptions: FAST_OPTS })).toThrow(
        PasswordError,
      );
    });

    it('accepts a pepper exactly 32 bytes long', () => {
      expect(
        () => new PasswordService({ pepper: 'x'.repeat(32), hashOptions: FAST_OPTS }),
      ).not.toThrow();
    });
  });

  describe('hash + verify round trip', () => {
    let service: PasswordService;
    let hashed: string;

    beforeAll(async () => {
      service = svc();
      hashed = await service.hash('correct horse battery staple');
    });

    it('produces a standard argon2id-encoded string', () => {
      expect(hashed.startsWith('$argon2id$')).toBe(true);
    });

    it('verifies the correct password', async () => {
      await expect(service.verify('correct horse battery staple', hashed)).resolves.toBe(true);
    });

    it('rejects an incorrect password', async () => {
      await expect(service.verify('wrong password', hashed)).resolves.toBe(false);
    });

    it('produces distinct hashes for the same input across calls (random salt)', async () => {
      const a = await service.hash('same input');
      const b = await service.hash('same input');
      expect(a).not.toBe(b);
      await expect(service.verify('same input', a)).resolves.toBe(true);
      await expect(service.verify('same input', b)).resolves.toBe(true);
    });
  });

  describe('pepper isolation', () => {
    it('a hash made with pepper A does not verify under pepper B', async () => {
      const aSvc = svc(PEPPER_A);
      const bSvc = svc(PEPPER_B);
      const hashed = await aSvc.hash('shared password');
      await expect(bSvc.verify('shared password', hashed)).resolves.toBe(false);
    });
  });

  describe('input validation', () => {
    let service: PasswordService;

    beforeAll(() => {
      service = svc();
    });

    it('rejects an empty password at hash time', async () => {
      await expect(service.hash('')).rejects.toBeInstanceOf(PasswordError);
    });

    it('rejects an empty password at verify time', async () => {
      const hashed = await service.hash('something');
      await expect(service.verify('', hashed)).rejects.toBeInstanceOf(PasswordError);
    });

    it('rejects a password larger than the defensive ceiling', async () => {
      const huge = 'a'.repeat(1025);
      await expect(service.hash(huge)).rejects.toBeInstanceOf(PasswordError);
    });

    it('accepts a password exactly at the ceiling', async () => {
      const max = 'a'.repeat(1024);
      const hashed = await service.hash(max);
      await expect(service.verify(max, hashed)).resolves.toBe(true);
    });

    it('accepts unicode input correctly', async () => {
      const pwd = 'pässwörd-🔐';
      const hashed = await service.hash(pwd);
      await expect(service.verify(pwd, hashed)).resolves.toBe(true);
    });
  });

  describe('malformed hash detection', () => {
    let service: PasswordService;

    beforeAll(() => {
      service = svc();
    });

    it('rejects a non-argon2 string at verify', async () => {
      await expect(service.verify('whatever', 'not-an-argon2-hash')).rejects.toMatchObject({
        code: 'PASSWORD_HASH_MALFORMED',
      });
    });

    it('rejects an argon2id string with corrupted parameter header', async () => {
      const hashed = await service.hash('some pw');
      // Replace the encoded params (`$m=...,t=...,p=...$`) with garbage so
      // the prefix is preserved (so `verify` enters the argon2 path) but the
      // parser fails downstream.
      const corrupted = hashed.replace(/\$m=[^$]+/u, '$m=garbage,t=garbage,p=garbage');
      await expect(service.verify('some pw', corrupted)).rejects.toBeInstanceOf(PasswordError);
    });
  });

  describe('needsRehash', () => {
    it('returns false for a hash with matching parameters', async () => {
      const service = svc();
      const hashed = await service.hash('pw');
      expect(service.needsRehash(hashed)).toBe(false);
    });

    it('returns true when stored parameters are weaker than current', async () => {
      const weak = new PasswordService({
        pepper: PEPPER_A,
        hashOptions: { memoryCost: 256, timeCost: 1, parallelism: 1, hashLength: 32 },
      });
      const hashed = await weak.hash('pw');
      const strong = new PasswordService({
        pepper: PEPPER_A,
        hashOptions: { memoryCost: 2048, timeCost: 2, parallelism: 1, hashLength: 32 },
      });
      expect(strong.needsRehash(hashed)).toBe(true);
    });

    it('returns true when stored hash is unparseable (force-rehash safety)', () => {
      const service = svc();
      expect(service.needsRehash('not-a-hash')).toBe(true);
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal-length, equal-content buffers', () => {
      const a = Buffer.from('abcdef');
      const b = Buffer.from('abcdef');
      expect(PasswordService.constantTimeEqual(a, b)).toBe(true);
    });

    it('returns false for different content of the same length', () => {
      const a = Buffer.from('abcdef');
      const b = Buffer.from('abcdeg');
      expect(PasswordService.constantTimeEqual(a, b)).toBe(false);
    });

    it('returns false for different lengths (without timing leak)', () => {
      const a = Buffer.from('abc');
      const b = Buffer.from('abcdef');
      expect(PasswordService.constantTimeEqual(a, b)).toBe(false);
    });
  });
});

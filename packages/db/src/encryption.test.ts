/**
 * Unit tests for the column-encryption helper. No database required — runs
 * in milliseconds even though vitest's globalSetup boots the test container
 * for the suite as a whole.
 */
import { randomBytes } from 'node:crypto';
import { EncryptionError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  createEncryptionService,
  createEncryptionServiceFromBase64,
  ENCRYPTION_CONTEXT,
  generateMasterKeyBase64,
} from './encryption.js';

function makeService() {
  const masterKey = randomBytes(32);
  return { masterKey, service: createEncryptionService({ masterKey }) };
}

describe('createEncryptionService', () => {
  it('round-trips a UTF-8 string under a stable context', () => {
    const { service } = makeService();
    const plaintext = 'JBSWY3DPEHPK3PXP'; // an example TOTP secret
    const ct = service.encryptString(plaintext, ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    const recovered = service.decryptString(ct, ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(recovered).toBe(plaintext);
  });

  it('round-trips raw bytes', () => {
    const { service } = makeService();
    const plaintext = randomBytes(64);
    const ct = service.encryptBytes(plaintext, ENCRYPTION_CONTEXT.DISPENSARY_METRC_API_KEY);
    const recovered = service.decryptBytes(ct, ENCRYPTION_CONTEXT.DISPENSARY_METRC_API_KEY);
    expect(Buffer.from(recovered).equals(plaintext)).toBe(true);
  });

  it('emits different ciphertexts for the same plaintext + context (random DEK/IV)', () => {
    const { service } = makeService();
    const a = service.encryptString('repeat-me', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    const b = service.encryptString('repeat-me', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('handles empty plaintext', () => {
    const { service } = makeService();
    const ct = service.encryptString('', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(service.decryptString(ct, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toBe('');
  });

  it('handles a 1 MiB payload', () => {
    const { service } = makeService();
    const plaintext = randomBytes(1024 * 1024);
    const ct = service.encryptBytes(plaintext, ENCRYPTION_CONTEXT.DISPENSARY_POS_CREDENTIALS);
    const recovered = service.decryptBytes(ct, ENCRYPTION_CONTEXT.DISPENSARY_POS_CREDENTIALS);
    expect(Buffer.from(recovered).equals(plaintext)).toBe(true);
  });

  it('produces ciphertext whose length is plaintext + fixed 89-byte overhead', () => {
    const { service } = makeService();
    for (const size of [1, 16, 32, 256, 4096]) {
      const ct = service.encryptBytes(randomBytes(size), ENCRYPTION_CONTEXT.USER_MFA_SECRET);
      expect(ct.length).toBe(size + 89);
    }
  });

  it('writes the v1 version byte as the first byte', () => {
    const { service } = makeService();
    const ct = service.encryptString('hello', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(Buffer.from(ct).readUInt8(0)).toBe(0x01);
  });

  it('rejects decryption with a different context (AAD mismatch)', () => {
    const { service } = makeService();
    const ct = service.encryptString('secret', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(() => service.decryptString(ct, ENCRYPTION_CONTEXT.DISPENSARY_METRC_API_KEY)).toThrow(
      EncryptionError,
    );
  });

  it('rejects decryption under a different master key', () => {
    const { service } = makeService();
    const ct = service.encryptString('secret', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    const other = createEncryptionService({ masterKey: randomBytes(32) });
    expect(() => other.decryptString(ct, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      EncryptionError,
    );
  });

  function flipBit(buf: Buffer, offset: number, mask: number): Buffer {
    const copy = Buffer.from(buf);
    copy.writeUInt8(copy.readUInt8(offset) ^ mask, offset);
    return copy;
  }

  it('rejects ciphertext whose data payload has been bit-flipped', () => {
    const { service } = makeService();
    const ct = service.encryptString('tampered?', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    const tampered = flipBit(Buffer.from(ct), Buffer.from(ct).length - 1, 0x01);
    expect(() => service.decryptString(tampered, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      EncryptionError,
    );
  });

  it('rejects ciphertext whose wrapped DEK has been bit-flipped', () => {
    const { service } = makeService();
    const ct = service.encryptString('payload', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    // Wrapped DEK lives at offset 29..61. Flip a bit in the middle.
    const tampered = flipBit(Buffer.from(ct), 45, 0x80);
    expect(() => service.decryptString(tampered, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      EncryptionError,
    );
  });

  it('rejects ciphertext whose data auth tag has been bit-flipped', () => {
    const { service } = makeService();
    const ct = service.encryptString('payload', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    // Data auth tag lives at offset 73..89.
    const tampered = flipBit(Buffer.from(ct), 80, 0x10);
    expect(() => service.decryptString(tampered, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      EncryptionError,
    );
  });

  it('rejects ciphertext that is too short to hold the header', () => {
    const { service } = makeService();
    const tooShort = new Uint8Array(80);
    expect(() => service.decryptString(tooShort, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      /Ciphertext too short/,
    );
  });

  it('rejects an unknown envelope version byte', () => {
    const { service } = makeService();
    const ct = service.encryptString('payload', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    const tampered = Buffer.from(ct);
    tampered[0] = 0xff;
    expect(() => service.decryptString(tampered, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toThrow(
      /Unsupported envelope version: 0xff/,
    );
  });

  it('throws ENCRYPTION_CONFIG_INVALID for a master key of the wrong length', () => {
    expect(() => createEncryptionService({ masterKey: randomBytes(16) })).toThrow(EncryptionError);
    try {
      createEncryptionService({ masterKey: randomBytes(16) });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionError);
      expect((err as EncryptionError).code).toBe('ENCRYPTION_CONFIG_INVALID');
    }
  });

  it('rejects encryption with an empty context', () => {
    const { service } = makeService();
    expect(() => service.encryptString('x', '')).toThrow(EncryptionError);
  });

  it('rejects decryption with an empty context', () => {
    const { service } = makeService();
    const ct = service.encryptString('x', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(() => service.decryptString(ct, '')).toThrow(EncryptionError);
  });
});

describe('createEncryptionServiceFromBase64', () => {
  it('builds an equivalent service from a base64 key', () => {
    const base64 = generateMasterKeyBase64();
    const service = createEncryptionServiceFromBase64(base64);
    const ct = service.encryptString('round-trip', ENCRYPTION_CONTEXT.USER_MFA_SECRET);
    expect(service.decryptString(ct, ENCRYPTION_CONTEXT.USER_MFA_SECRET)).toBe('round-trip');
  });

  it('rejects a base64 string that decodes to fewer than 32 bytes', () => {
    const tooShort = Buffer.from(randomBytes(16)).toString('base64');
    expect(() => createEncryptionServiceFromBase64(tooShort)).toThrow(EncryptionError);
  });

  it('emits a base64 key that decodes to exactly 32 bytes', () => {
    const base64 = generateMasterKeyBase64();
    expect(Buffer.from(base64, 'base64').length).toBe(32);
  });
});

describe('ENCRYPTION_CONTEXT', () => {
  it('exposes stable, dotted column qualifiers (table.column)', () => {
    for (const ctx of Object.values(ENCRYPTION_CONTEXT)) {
      expect(ctx).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('has no duplicate values across distinct columns', () => {
    const values = Object.values(ENCRYPTION_CONTEXT);
    expect(new Set(values).size).toBe(values.length);
  });
});

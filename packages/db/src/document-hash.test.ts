import { randomBytes } from 'node:crypto';
import { EncryptionError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { createDocumentHasher, createDocumentHasherFromBase64 } from './document-hash.js';

const PEPPER = new Uint8Array(randomBytes(32));

describe('createDocumentHasher', () => {
  it('produces a 32-byte tag', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const out = hasher.hash('DL-12345', 'drivers.license_number');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });

  it('is deterministic for the same value + context + pepper', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const a = hasher.hash('DL-12345', 'drivers.license_number');
    const b = hasher.hash('DL-12345', 'drivers.license_number');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('differs when the context changes (cross-column collision protection)', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const a = hasher.hash('12345', 'drivers.license_number');
    const b = hasher.hash('12345', 'user_id_documents.document_number');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('differs when the pepper changes (pepper actually contributes)', () => {
    const hasherA = createDocumentHasher({ pepper: PEPPER });
    const hasherB = createDocumentHasher({ pepper: new Uint8Array(randomBytes(32)) });
    const a = hasherA.hash('DL-12345', 'drivers.license_number');
    const b = hasherB.hash('DL-12345', 'drivers.license_number');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('normalizes case and trims whitespace before hashing', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const a = hasher.hash('dl-12345', 'drivers.license_number');
    const b = hasher.hash(' DL-12345 ', 'drivers.license_number');
    const c = hasher.hash('DL-12345', 'drivers.license_number');
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true);
    expect(Buffer.from(b).equals(Buffer.from(c))).toBe(true);
  });

  it('rejects a pepper shorter than 32 bytes', () => {
    expect(() => createDocumentHasher({ pepper: new Uint8Array(16) })).toThrow(EncryptionError);
  });

  it('rejects an empty context', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    expect(() => hasher.hash('DL-12345', '')).toThrow(EncryptionError);
  });

  it('rejects an empty value', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    expect(() => hasher.hash('', 'drivers.license_number')).toThrow(EncryptionError);
  });
});

describe('DocumentHasher.matches', () => {
  it('returns true for the correct value + context', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const stored = hasher.hash('DL-12345', 'drivers.license_number');
    expect(hasher.matches(stored, 'DL-12345', 'drivers.license_number')).toBe(true);
  });

  it('returns true after normalization (operator searches with stray case)', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const stored = hasher.hash('DL-12345', 'drivers.license_number');
    expect(hasher.matches(stored, ' dl-12345 ', 'drivers.license_number')).toBe(true);
  });

  it('returns false for the wrong value', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const stored = hasher.hash('DL-12345', 'drivers.license_number');
    expect(hasher.matches(stored, 'DL-99999', 'drivers.license_number')).toBe(false);
  });

  it('returns false for the wrong context (cross-column probing fails)', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    const stored = hasher.hash('12345', 'drivers.license_number');
    expect(hasher.matches(stored, '12345', 'user_id_documents.document_number')).toBe(false);
  });

  it('returns false when the stored hash is the wrong length', () => {
    const hasher = createDocumentHasher({ pepper: PEPPER });
    expect(hasher.matches(new Uint8Array(16), 'DL-12345', 'drivers.license_number')).toBe(false);
  });
});

describe('createDocumentHasherFromBase64', () => {
  it('decodes the pepper from base64 and produces the same hash as the raw constructor', () => {
    const base64 = Buffer.from(PEPPER).toString('base64');
    const a = createDocumentHasher({ pepper: PEPPER }).hash('DL-12345', 'drivers.license_number');
    const b = createDocumentHasherFromBase64(base64).hash('DL-12345', 'drivers.license_number');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('rejects a base64 that decodes to fewer than 32 bytes', () => {
    expect(() => createDocumentHasherFromBase64(Buffer.from('short').toString('base64'))).toThrow(
      EncryptionError,
    );
  });
});

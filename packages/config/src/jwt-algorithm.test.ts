import { generateKeyPairSync } from 'node:crypto';
import { ConfigError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { deriveJwsAlgorithm } from './jwt-algorithm.js';

function rsaPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function ecPair(namedCurve: string): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve });
  return {
    privatePem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('deriveJwsAlgorithm', () => {
  it('maps an RSA private key to RS256', () => {
    expect(deriveJwsAlgorithm(rsaPair().privatePem)).toBe('RS256');
  });

  it('maps an RSA public key to RS256 (verify-only services hold the public half)', () => {
    expect(deriveJwsAlgorithm(rsaPair().publicPem)).toBe('RS256');
  });

  it('maps an EC P-256 keypair to ES256 (both halves)', () => {
    const { privatePem, publicPem } = ecPair('prime256v1');
    expect(deriveJwsAlgorithm(privatePem)).toBe('ES256');
    expect(deriveJwsAlgorithm(publicPem)).toBe('ES256');
  });

  it('maps an EC P-384 keypair to ES384', () => {
    const { privatePem, publicPem } = ecPair('secp384r1');
    expect(deriveJwsAlgorithm(privatePem)).toBe('ES384');
    expect(deriveJwsAlgorithm(publicPem)).toBe('ES384');
  });

  it('maps an EC P-521 keypair to ES512', () => {
    const { privatePem, publicPem } = ecPair('secp521r1');
    expect(deriveJwsAlgorithm(privatePem)).toBe('ES512');
    expect(deriveJwsAlgorithm(publicPem)).toBe('ES512');
  });

  it('throws ConfigError on an unsupported key type (Ed25519)', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      deriveJwsAlgorithm(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError on a malformed PEM', () => {
    expect(() => deriveJwsAlgorithm('not a pem')).toThrow(ConfigError);
  });

  it('throws ConfigError on an unsupported EC curve', () => {
    const { privatePem } = ecPair('secp256k1');
    expect(() => deriveJwsAlgorithm(privatePem)).toThrow(ConfigError);
  });
});

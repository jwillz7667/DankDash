import { ExternalServiceError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { buildBasicAuthHeader } from '../src/auth.js';

describe('buildBasicAuthHeader', () => {
  it('encodes vendor:user as base64 with the Basic scheme', () => {
    const header = buildBasicAuthHeader('vendor-123', 'user-abc');
    expect(header).toBe(`Basic ${Buffer.from('vendor-123:user-abc', 'utf8').toString('base64')}`);
  });

  it('handles UTF-8 characters in the user key (escaped via Buffer)', () => {
    const header = buildBasicAuthHeader('v', 'üsr');
    expect(header.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe('v:üsr');
  });

  it('rejects an empty vendor key', () => {
    expect(() => buildBasicAuthHeader('', 'user')).toThrow(ExternalServiceError);
    expect(() => buildBasicAuthHeader('', 'user')).toThrow(/vendor/);
  });

  it('rejects an empty user key', () => {
    expect(() => buildBasicAuthHeader('vendor', '')).toThrow(ExternalServiceError);
    expect(() => buildBasicAuthHeader('vendor', '')).toThrow(/user/);
  });

  it('attaches the service tag on the wrapped error so the worker can route alerts', () => {
    try {
      buildBasicAuthHeader('', 'user');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      const e = err as ExternalServiceError;
      expect((e.details as { service: string }).service).toBe('metrc');
    }
  });
});

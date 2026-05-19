import { describe, expect, it } from 'vitest';
import { checkKyc } from '../../src/index.js';
import { makeContext, makeUser } from '../fixtures.js';

describe('checkKyc', () => {
  it('passes when kycVerifiedAt is set', () => {
    const verifiedAt = new Date('2025-01-01T00:00:00Z');
    const ctx = makeContext({ user: makeUser({ kycVerifiedAt: verifiedAt }) });

    const res = checkKyc(ctx);

    expect(res.passed).toBe(true);
    expect(res.details['verified']).toBe(true);
    expect(res.details['verifiedAt']).toBe('2025-01-01T00:00:00.000Z');
  });

  it('fails when kycVerifiedAt is null', () => {
    const ctx = makeContext({ user: makeUser({ kycVerifiedAt: null }) });

    const res = checkKyc(ctx);

    expect(res.passed).toBe(false);
    expect(res.details['verified']).toBe(false);
    expect(res.details['verifiedAt']).toBeNull();
  });
});

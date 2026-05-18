import { describe, expect, it } from 'vitest';
import { checkLicense } from '../../src/index.js';
import { makeContext, makeDispensary } from '../fixtures.js';

const NOW = new Date('2026-05-18T12:00:00Z');

describe('checkLicense', () => {
  it('passes when the license expires tomorrow', () => {
    const ctx = makeContext({
      dispensary: makeDispensary({ licenseExpiresAt: new Date('2026-05-19T12:00:00Z') }),
    });

    const res = checkLicense(ctx, NOW);

    expect(res.passed).toBe(true);
  });

  it('fails when the license expired yesterday', () => {
    const ctx = makeContext({
      dispensary: makeDispensary({ licenseExpiresAt: new Date('2026-05-17T12:00:00Z') }),
    });

    const res = checkLicense(ctx, NOW);

    expect(res.passed).toBe(false);
  });

  it('fails when the license expires exactly at now (half-open boundary)', () => {
    const ctx = makeContext({ dispensary: makeDispensary({ licenseExpiresAt: NOW }) });

    const res = checkLicense(ctx, NOW);

    expect(res.passed).toBe(false);
  });

  it('echoes expiresAt and now in details for audit', () => {
    const exp = new Date('2026-12-31T23:59:59Z');
    const ctx = makeContext({ dispensary: makeDispensary({ licenseExpiresAt: exp }) });

    const res = checkLicense(ctx, NOW);

    expect(res.details['expiresAt']).toBe('2026-12-31T23:59:59.000Z');
    expect(res.details['now']).toBe('2026-05-18T12:00:00.000Z');
  });
});

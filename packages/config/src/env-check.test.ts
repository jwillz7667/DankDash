/**
 * Unit tests for the env-check rules. Pure functions in / pure assertions
 * out — no testcontainers, no I/O, runs instantly in any environment.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type EnvIssue,
  checkFeatureFlagCoherence,
  checkJwtKeyPair,
  checkProductionStrict,
  checkTwilioSenderCoherence,
  formatIssueReport,
  runAllChecks,
} from './env-check.js';

interface TestKeyPair {
  readonly privBase64: string;
  readonly pubBase64: string;
  readonly otherPubBase64: string;
}

function pemBase64(key: KeyObject, format: 'pkcs8' | 'spki'): string {
  const pem = key.export({ type: format, format: 'pem' });
  return Buffer.from(pem as string).toString('base64');
}

function generateTestPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { publicKey: otherPublic } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privBase64: pemBase64(privateKey, 'pkcs8'),
    pubBase64: pemBase64(publicKey, 'spki'),
    otherPubBase64: pemBase64(otherPublic, 'spki'),
  };
}

const VALID_PROD_BASE: Readonly<Record<string, unknown>> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://db.railway.internal:5432/dankdash',
  REDIS_URL: 'redis://redis.railway.internal:6379',
  CHECKOUT_BASE_URL: 'https://app.dankdash.com',
  LOG_LEVEL: 'info',
  SENTRY_DSN: 'https://abc@o123.ingest.sentry.io/456',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
  ENABLE_AEROPAY: 'false',
  ENABLE_METRC: 'false',
  ENABLE_PERSONA: 'false',
  ENABLE_VERIFF: 'false',
  TWILIO_MESSAGING_SERVICE_SID: 'MG0123456789',
};

function findIssue(issues: readonly EnvIssue[], path: string): EnvIssue | undefined {
  return issues.find((issue) => issue.path === path);
}

describe('checkProductionStrict', () => {
  it('accepts a fully populated production env', () => {
    expect(checkProductionStrict(VALID_PROD_BASE)).toEqual([]);
  });

  it('flags NODE_ENV that is not exactly "production"', () => {
    const issues = checkProductionStrict({ ...VALID_PROD_BASE, NODE_ENV: 'staging' });
    expect(findIssue(issues, 'NODE_ENV')).toBeDefined();
  });

  it('flags localhost DATABASE_URL / REDIS_URL / CHECKOUT_BASE_URL', () => {
    const issues = checkProductionStrict({
      ...VALID_PROD_BASE,
      DATABASE_URL: 'postgres://localhost:5432/dankdash',
      REDIS_URL: 'redis://127.0.0.1:6379',
      CHECKOUT_BASE_URL: 'http://localhost:3000',
    });
    expect(findIssue(issues, 'DATABASE_URL')).toBeDefined();
    expect(findIssue(issues, 'REDIS_URL')).toBeDefined();
    expect(findIssue(issues, 'CHECKOUT_BASE_URL')).toBeDefined();
  });

  it('flags LOG_LEVEL=debug in production', () => {
    const issues = checkProductionStrict({ ...VALID_PROD_BASE, LOG_LEVEL: 'debug' });
    expect(findIssue(issues, 'LOG_LEVEL')).toBeDefined();
  });

  it('flags LOG_LEVEL=trace in production', () => {
    const issues = checkProductionStrict({ ...VALID_PROD_BASE, LOG_LEVEL: 'trace' });
    expect(findIssue(issues, 'LOG_LEVEL')).toBeDefined();
  });

  it('flags missing SENTRY_DSN', () => {
    const { SENTRY_DSN: _omit, ...rest } = VALID_PROD_BASE;
    const issues = checkProductionStrict(rest);
    expect(findIssue(issues, 'SENTRY_DSN')).toBeDefined();
  });

  it('flags missing OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const { OTEL_EXPORTER_OTLP_ENDPOINT: _omit, ...rest } = VALID_PROD_BASE;
    const issues = checkProductionStrict(rest);
    expect(findIssue(issues, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBeDefined();
  });

  it('accepts info/warn/error/fatal LOG_LEVEL values', () => {
    for (const level of ['info', 'warn', 'error', 'fatal']) {
      const issues = checkProductionStrict({ ...VALID_PROD_BASE, LOG_LEVEL: level });
      expect(findIssue(issues, 'LOG_LEVEL')).toBeUndefined();
    }
  });
});

describe('checkFeatureFlagCoherence', () => {
  it('requires AEROPAY credentials when ENABLE_AEROPAY=true', () => {
    const issues = checkFeatureFlagCoherence({
      ENABLE_AEROPAY: 'true',
      AEROPAY_API_BASE_URL: 'https://api.aeropay.com',
    });
    expect(findIssue(issues, 'AEROPAY_CLIENT_ID')).toBeDefined();
    expect(findIssue(issues, 'AEROPAY_CLIENT_SECRET')).toBeDefined();
    expect(findIssue(issues, 'AEROPAY_WEBHOOK_SECRET')).toBeDefined();
  });

  it('flags test-prefixed AEROPAY credentials when ENABLE_AEROPAY=true', () => {
    const issues = checkFeatureFlagCoherence({
      ENABLE_AEROPAY: 'true',
      AEROPAY_CLIENT_ID: 'test_abc123',
      AEROPAY_CLIENT_SECRET: 'sandbox_def456',
      AEROPAY_WEBHOOK_SECRET: 'whsec_real',
      AEROPAY_API_BASE_URL: 'https://api.aeropay.com',
    });
    expect(findIssue(issues, 'AEROPAY_CLIENT_ID')?.message).toMatch(/test credential/);
    expect(findIssue(issues, 'AEROPAY_CLIENT_SECRET')?.message).toMatch(/test credential/);
    expect(findIssue(issues, 'AEROPAY_WEBHOOK_SECRET')).toBeUndefined();
  });

  it('flags sandbox AEROPAY base URL when ENABLE_AEROPAY=true', () => {
    const issues = checkFeatureFlagCoherence({
      ENABLE_AEROPAY: 'true',
      AEROPAY_CLIENT_ID: 'live_id',
      AEROPAY_CLIENT_SECRET: 'live_secret',
      AEROPAY_WEBHOOK_SECRET: 'whsec_real',
      AEROPAY_API_BASE_URL: 'https://sandbox.aeropay.com',
    });
    expect(findIssue(issues, 'AEROPAY_API_BASE_URL')).toBeDefined();
  });

  it('does not flag anything when feature flag is off', () => {
    expect(
      checkFeatureFlagCoherence({
        ENABLE_AEROPAY: 'false',
        ENABLE_METRC: 'false',
        ENABLE_PERSONA: 'false',
        ENABLE_VERIFF: 'false',
      }),
    ).toEqual([]);
  });

  it('flags METRC/PERSONA/VERIFF credentials when their flags are on', () => {
    const issues = checkFeatureFlagCoherence({
      ENABLE_METRC: 'true',
      ENABLE_PERSONA: 'true',
      ENABLE_VERIFF: 'true',
      METRC_API_BASE_URL: 'https://api-mn.metrc.com',
      VERIFF_API_BASE_URL: 'https://stationapi.veriff.com',
    });
    expect(findIssue(issues, 'METRC_API_KEY')).toBeDefined();
    expect(findIssue(issues, 'METRC_USER_KEY')).toBeDefined();
    expect(findIssue(issues, 'PERSONA_API_KEY')).toBeDefined();
    expect(findIssue(issues, 'PERSONA_WEBHOOK_SECRET')).toBeDefined();
    expect(findIssue(issues, 'PERSONA_TEMPLATE_ID')).toBeDefined();
    expect(findIssue(issues, 'VERIFF_API_KEY')).toBeDefined();
    expect(findIssue(issues, 'VERIFF_WEBHOOK_SECRET')).toBeDefined();
  });

  it('flags AEROPAY_LIVE with test creds even when ENABLE_AEROPAY=false', () => {
    const issues = checkFeatureFlagCoherence({
      ENABLE_AEROPAY: 'false',
      AEROPAY_LIVE: 'true',
      AEROPAY_CLIENT_ID: 'test_abc',
      AEROPAY_CLIENT_SECRET: 'live_secret',
      AEROPAY_API_BASE_URL: 'https://sandbox.aeropay.com',
    });
    expect(findIssue(issues, 'AEROPAY_CLIENT_ID')?.message).toMatch(/AEROPAY_LIVE=true/);
    expect(findIssue(issues, 'AEROPAY_API_BASE_URL')?.message).toMatch(/AEROPAY_LIVE=true/);
  });
});

describe('checkTwilioSenderCoherence', () => {
  it('flags when both Twilio sender variables are unset', () => {
    const issues = checkTwilioSenderCoherence({});
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/exactly one/);
  });

  it('flags when both Twilio sender variables are set', () => {
    const issues = checkTwilioSenderCoherence({
      TWILIO_MESSAGING_SERVICE_SID: 'MG0123',
      TWILIO_FROM_NUMBER: '+15551234567',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/ambiguous/);
  });

  it('accepts exactly the messaging service SID', () => {
    expect(checkTwilioSenderCoherence({ TWILIO_MESSAGING_SERVICE_SID: 'MG0123' })).toEqual([]);
  });

  it('accepts exactly the from-number', () => {
    expect(checkTwilioSenderCoherence({ TWILIO_FROM_NUMBER: '+15551234567' })).toEqual([]);
  });
});

describe('checkJwtKeyPair', () => {
  let pair: TestKeyPair;

  beforeAll(() => {
    pair = generateTestPair();
  });

  it('accepts a matched JWT pair', () => {
    expect(
      checkJwtKeyPair({
        JWT_PRIVATE_KEY_BASE64: pair.privBase64,
        JWT_PUBLIC_KEY_BASE64: pair.pubBase64,
      }),
    ).toEqual([]);
  });

  it('flags a mismatched JWT pair', () => {
    const issues = checkJwtKeyPair({
      JWT_PRIVATE_KEY_BASE64: pair.privBase64,
      JWT_PUBLIC_KEY_BASE64: pair.otherPubBase64,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/does not match/);
  });

  it('flags non-PEM key material', () => {
    const issues = checkJwtKeyPair({
      JWT_PRIVATE_KEY_BASE64: Buffer.from('not a pem').toString('base64'),
      JWT_PUBLIC_KEY_BASE64: pair.pubBase64,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/not valid PEM/);
  });

  it('is a no-op when either key is absent', () => {
    expect(checkJwtKeyPair({ JWT_PRIVATE_KEY_BASE64: pair.privBase64 })).toEqual([]);
    expect(checkJwtKeyPair({ JWT_PUBLIC_KEY_BASE64: pair.pubBase64 })).toEqual([]);
    expect(checkJwtKeyPair({})).toEqual([]);
  });
});

describe('runAllChecks', () => {
  it('runs only JWT check when NODE_ENV is not production', () => {
    const pair = generateTestPair();
    const issues = runAllChecks({
      NODE_ENV: 'development',
      JWT_PRIVATE_KEY_BASE64: pair.privBase64,
      JWT_PUBLIC_KEY_BASE64: pair.otherPubBase64,
      DATABASE_URL: 'postgres://localhost/dankdash', // would fail in prod but not flagged here
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('JWT_*_KEY_BASE64');
  });

  it('runs JWT + strict overlay when NODE_ENV=production', () => {
    const pair = generateTestPair();
    const issues = runAllChecks({
      ...VALID_PROD_BASE,
      JWT_PRIVATE_KEY_BASE64: pair.privBase64,
      JWT_PUBLIC_KEY_BASE64: pair.otherPubBase64,
      DATABASE_URL: 'postgres://localhost/dankdash',
    });
    expect(findIssue(issues, 'JWT_*_KEY_BASE64')).toBeDefined();
    expect(findIssue(issues, 'DATABASE_URL')).toBeDefined();
  });

  it('accepts a fully valid production env', () => {
    const pair = generateTestPair();
    const issues = runAllChecks({
      ...VALID_PROD_BASE,
      JWT_PRIVATE_KEY_BASE64: pair.privBase64,
      JWT_PUBLIC_KEY_BASE64: pair.pubBase64,
    });
    expect(issues).toEqual([]);
  });
});

describe('formatIssueReport', () => {
  it('formats a single-issue report with the path/message convention', () => {
    const report = formatIssueReport([{ path: 'SENTRY_DSN', message: 'must be set' }]);
    expect(report).toContain('env-check: FAILED');
    expect(report).toContain('  - SENTRY_DSN: must be set');
  });

  it('formats an empty list cleanly (header + trailing newline only)', () => {
    expect(formatIssueReport([])).toBe('env-check: FAILED\n');
  });
});

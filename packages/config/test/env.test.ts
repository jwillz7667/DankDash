/**
 * loadEnv tests, focused on the production partial-env guard.
 *
 * Partial mode (ALLOW_PARTIAL_ENV=1 or `allowPartial: true`) relaxes every
 * required secret to optional so CI entrypoints can boot. The guard ensures
 * that relaxation can never take effect when NODE_ENV=production, so a
 * misconfigured production deploy fails loudly on a missing secret instead of
 * silently serving traffic with no signing/encryption key.
 */
import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/env.js';

// A complete, schema-valid source. Tests delete keys from a clone to exercise
// the missing-secret paths. Lengths satisfy the min() constraints (the base64
// key fields only check string length, not decodability).
const KEY_44 = 'A'.repeat(44);
function validSource(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/dankdash',
    REDIS_URL: 'redis://localhost:6379',
    JWT_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
    JWT_PUBLIC_KEY_BASE64: 'cHVibGlj',
    PASSWORD_PEPPER: 'p'.repeat(32),
    COLUMN_ENCRYPTION_KEY_BASE64: KEY_44,
    DOCUMENT_HASH_PEPPER_BASE64: KEY_44,
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'akid',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket',
    AEROPAY_CLIENT_ID: 'ap-client',
    AEROPAY_CLIENT_SECRET: 'ap-secret',
    AEROPAY_WEBHOOK_SECRET: 'ap-webhook',
    PERSONA_API_KEY: 'persona-key',
    PERSONA_WEBHOOK_SECRET: 'persona-webhook',
    PERSONA_TEMPLATE_ID: 'persona-template',
    VERIFF_API_KEY: 'veriff-key',
    VERIFF_WEBHOOK_SECRET: 'veriff-webhook',
    METRC_API_KEY: 'metrc-key',
    METRC_USER_KEY: 'metrc-user',
    MAPBOX_ACCESS_TOKEN: 'mapbox-token',
    TWILIO_ACCOUNT_SID: 'twilio-sid',
    TWILIO_AUTH_TOKEN: 'twilio-token',
    TWILIO_PROXY_SERVICE_SID: 'twilio-proxy',
    RESEND_API_KEY: 'resend-key',
    APNS_KEY_ID: 'apns-key-id',
    APNS_TEAM_ID: 'apns-team',
    APNS_BUNDLE_ID: 'apns-bundle',
    APNS_PRIVATE_KEY_BASE64: 'apns-key',
    ...overrides,
  };
}

describe('loadEnv partial-mode production guard', () => {
  it('honors ALLOW_PARTIAL_ENV outside production: a missing secret is tolerated', () => {
    const source = validSource({ NODE_ENV: 'development', ALLOW_PARTIAL_ENV: '1' });
    delete source['JWT_PRIVATE_KEY_BASE64'];

    const env = loadEnv({ source });

    expect(env.JWT_PRIVATE_KEY_BASE64).toBeUndefined();
    expect(env.NODE_ENV).toBe('development');
  });

  it('refuses ALLOW_PARTIAL_ENV in production: a missing secret fails loudly', () => {
    const source = validSource({ NODE_ENV: 'production', ALLOW_PARTIAL_ENV: '1' });
    delete source['JWT_PRIVATE_KEY_BASE64'];

    expect(() => loadEnv({ source })).toThrow(EnvValidationError);
    try {
      loadEnv({ source });
      expect.unreachable('loadEnv should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const paths = (err as EnvValidationError).issues.map((i) => i.path);
      expect(paths).toContain('JWT_PRIVATE_KEY_BASE64');
    }
  });

  it('refuses an explicit allowPartial:true in production too', () => {
    const source = validSource({ NODE_ENV: 'production' });
    delete source['COLUMN_ENCRYPTION_KEY_BASE64'];

    expect(() => loadEnv({ source, allowPartial: true })).toThrow(EnvValidationError);
  });

  it('a leftover ALLOW_PARTIAL_ENV in production is harmless when all secrets are present', () => {
    const source = validSource({ NODE_ENV: 'production', ALLOW_PARTIAL_ENV: '1' });

    const env = loadEnv({ source });

    expect(env.NODE_ENV).toBe('production');
    expect(env.JWT_PRIVATE_KEY_BASE64).toBe('cHJpdmF0ZQ==');
  });

  it('strict mode (no opt-in) still throws on a missing secret outside production', () => {
    const source = validSource({ NODE_ENV: 'staging' });
    delete source['PASSWORD_PEPPER'];

    expect(() => loadEnv({ source })).toThrow(EnvValidationError);
  });
});

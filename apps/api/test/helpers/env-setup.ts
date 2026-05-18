/**
 * Side-effect-only import. Seeds `process.env` with the minimum viable
 * fixture values that `loadEnv` requires, so anything depending on
 * @nestjs/config can be imported without booting the real deployment.
 *
 * MUST be the very first import in any test helper that pulls in
 * AppModule (transitively or directly) — ConfigModule.forRoot validates
 * env synchronously at module-declaration time, so env vars must already
 * exist before AppModule is evaluated.
 *
 * Each value here is deterministic and clearly fake — production secrets
 * never go through this path. Services that need real signing/keying for
 * a given test override locally.
 */
const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY_BASE64: Buffer.from('test-private-key-placeholder').toString('base64'),
  JWT_PUBLIC_KEY_BASE64: Buffer.from('test-public-key-placeholder').toString('base64'),
  PASSWORD_PEPPER: 'a'.repeat(32),
  COLUMN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  R2_ACCOUNT_ID: 'test',
  R2_ACCESS_KEY_ID: 'test',
  R2_SECRET_ACCESS_KEY: 'test',
  R2_BUCKET_NAME: 'test',
  AEROPAY_CLIENT_ID: 'test',
  AEROPAY_CLIENT_SECRET: 'test',
  AEROPAY_WEBHOOK_SECRET: 'test',
  PERSONA_API_KEY: 'test',
  PERSONA_WEBHOOK_SECRET: 'test',
  PERSONA_TEMPLATE_ID: 'tmpl_test',
  VERIFF_API_KEY: 'test',
  VERIFF_WEBHOOK_SECRET: 'test',
  METRC_API_KEY: 'test',
  METRC_USER_KEY: 'test',
  MAPBOX_ACCESS_TOKEN: 'test',
  TWILIO_ACCOUNT_SID: 'test',
  TWILIO_AUTH_TOKEN: 'test',
  TWILIO_PROXY_SERVICE_SID: 'test',
  RESEND_API_KEY: 'test',
  APNS_KEY_ID: 'test',
  APNS_TEAM_ID: 'test',
  APNS_BUNDLE_ID: 'com.dankdash.test',
  APNS_PRIVATE_KEY_BASE64: Buffer.from('test-apns-key').toString('base64'),
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  process.env[key] ??= value;
}

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
import { generateKeyPairSync } from 'node:crypto';

// AuthJwtModule decodes JWT_*_KEY_BASE64 at boot and rejects anything that
// is not a real PEM block. A throwaway 2048-bit RSA keypair is fast to
// generate (~50ms) and lets AppModule wire up without faking the module.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// NotificationsModule builds a real `apn.Provider` at boot, and node-apn
// eagerly signs a provider JWT with ES256 — which only succeeds against a
// genuine EC P-256 private key (the format of an Apple `.p8`). A base64 of
// an arbitrary string throws "secretOrPrivateKey must be an asymmetric key
// when using ES256" and takes down every integration suite that boots
// AppModule. Mint a throwaway P-256 key (Apple's curve) so construction
// succeeds; it is never used to sign against real Apple infrastructure.
const { privateKey: apnsPrivateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY_BASE64: Buffer.from(
    privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  ).toString('base64'),
  JWT_PUBLIC_KEY_BASE64: Buffer.from(
    publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  ).toString('base64'),
  PASSWORD_PEPPER: 'a'.repeat(32),
  COLUMN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  DOCUMENT_HASH_PEPPER_BASE64: Buffer.alloc(32, 2).toString('base64'),
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
  APNS_PRIVATE_KEY_BASE64: Buffer.from(
    apnsPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ).toString('base64'),
  AEROPAY_LIVE: 'false',
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  process.env[key] ??= value;
}

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
 *
 * Registered as the suite's `setupFiles` entry, so it also installs the
 * one global hook every test file shares: a `vi.useRealTimers()` after
 * each test. The api suite runs single-fork (`pool: 'forks'`,
 * `singleFork: true`), so every test file shares one worker and one
 * global timer state. A unit test that calls `vi.useFakeTimers()` in a
 * `beforeEach` without restoring leaks the fake clock into the next
 * file — and the next compliance-gated integration file's
 * `beforeAll(buildTestApp)` then hangs forever (Nest/Fastify bootstrap
 * awaits a real `setTimeout`/`setImmediate` that the frozen clock never
 * fires). This guard resets to real timers after every test so no file
 * can poison the next; tests that want a fake clock re-arm it in their
 * own `beforeEach`, so the reset is invisible to them.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, vi } from 'vitest';

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

// DATABASE_URL / REDIS_URL are provided by the testcontainers that
// `test/global-setup.ts` boots once per run — it force-assigns them BEFORE
// the workers fork, so the values below are only fallbacks for pure-unit
// runs that opt out of the containers (VITEST_SKIP_TESTCONTAINER=1). These
// stay `??=` so a container URL always wins.
const CONTAINER_PROVIDED: Record<string, string> = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};
for (const [key, value] of Object.entries(CONTAINER_PROVIDED)) {
  process.env[key] ??= value;
}

// Everything else is a deterministic, clearly-fake TEST value that MUST take
// precedence over anything the host runtime injected into `process.env`.
//
// This matters because the remote execution environment seeds real
// deployment secrets — a real DATABASE_URL / REDIS_URL, an EC JWT keypair,
// and `ENABLE_*=false` flags — into the process. A plain `??=` would let
// those leak into the suite and (a) point integration tests at production
// infra, (b) make the RS-vs-ES signing algorithm depend on the host's key
// type, and (c) disable the very providers the payment/KYC suites exercise
// (`ENABLE_AEROPAY=false` → checkout/refund/webhook routes 503
// `FEATURE_DISABLED`). Force-assigning (`=`, not `??=`) keeps the suite
// hermetic: the only inputs from the host are the two container URLs above.
const FORCED: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  // Throwaway RSA keypair → the algorithm-aware JwtService derives RS256 and
  // every JWT surface (signTokenFor, jwt-tamper's direct jwt.sign, the guard)
  // stays consistent on one algorithm regardless of the host's JWT key type.
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
  // Feature flags pinned to the intended TEST posture (the env schema
  // defaults AEROPAY/PERSONA/VERIFF on and METRC off; CI inherits those).
  // Aeropay/Persona/Veriff stay ON because the payment / KYC / driver suites
  // exercise the real providers (with only the *_CLIENT/_API creds faked
  // above). Twilio and Resend are forced OFF: the Twilio SDK validates the
  // account SID in its constructor and throws "accountSid must start with AC"
  // at boot, and Resend would attempt live HTTP on dispatch — no test
  // exercises SMS/email, so NotificationsModule wires NullNotificationProvider
  // and the DI graph boots clean. AEROPAY_LIVE OFF so no real ACH is moved.
  ENABLE_AEROPAY: 'true',
  ENABLE_PERSONA: 'true',
  ENABLE_VERIFF: 'true',
  ENABLE_METRC: 'false',
  ENABLE_TWILIO: 'false',
  ENABLE_RESEND: 'false',
  AEROPAY_LIVE: 'false',
};

for (const [key, value] of Object.entries(FORCED)) {
  process.env[key] = value;
}

// Single-fork safety net: never let one test file's fake clock survive
// into the next. Idempotent when timers are already real.
afterEach(() => {
  vi.useRealTimers();
});

import { z } from 'zod';

const booleanFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value): boolean => {
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1' || value === 'yes';
  });

const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

    DATABASE_URL: z.string().url(),
    DATABASE_URL_TEST: z.string().url().optional(),
    DATABASE_POOL_SIZE: positiveInt.default(10),
    DATABASE_SLOW_QUERY_MS: positiveInt.default(500),

    REDIS_URL: z.string().url(),

    JWT_PRIVATE_KEY_BASE64: z.string().min(1),
    JWT_PUBLIC_KEY_BASE64: z.string().min(1),
    JWT_ACCESS_TTL_SECONDS: positiveInt.default(900),
    JWT_REFRESH_TTL_SECONDS: positiveInt.default(2_592_000),
    // Apple §10.4 checkout handoff. The iOS consumer hits POST
    // /v1/auth/checkout-handoff and opens the returned `exchangeUrl`
    // inside SFSafariViewController; checkout-web is the only surface
    // that touches the payment flow. CHECKOUT_BASE_URL is the
    // fully-qualified prefix the API embeds in the response so iOS
    // never composes its own URL — pinned per environment so a misconfigured
    // staging build cannot accidentally redirect to production checkout.
    // The handoff token is single-shot with a tight TTL; 5 minutes is the
    // Apple-spec-aligned default (one cold-start + one retry budget).
    CHECKOUT_BASE_URL: z.string().url().default('https://app.dankdash.com'),
    CHECKOUT_HANDOFF_TTL_SECONDS: positiveInt.default(300),
    PASSWORD_PEPPER: z.string().min(32, 'PASSWORD_PEPPER must be at least 32 bytes'),

    COLUMN_ENCRYPTION_KEY_BASE64: z
      .string()
      .min(44, 'COLUMN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes'),

    DOCUMENT_HASH_PEPPER_BASE64: z
      .string()
      .min(44, 'DOCUMENT_HASH_PEPPER_BASE64 must decode to at least 32 bytes'),

    R2_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET_NAME: z.string().min(1),
    R2_PUBLIC_BASE_URL: z.string().url().optional(),

    AEROPAY_CLIENT_ID: z.string().min(1),
    AEROPAY_CLIENT_SECRET: z.string().min(1),
    AEROPAY_WEBHOOK_SECRET: z.string().min(1),
    AEROPAY_API_BASE_URL: z.string().url().default('https://api.aeropay.com'),

    PERSONA_API_KEY: z.string().min(1),
    PERSONA_WEBHOOK_SECRET: z.string().min(1),
    PERSONA_TEMPLATE_ID: z.string().min(1),

    VERIFF_API_KEY: z.string().min(1),
    VERIFF_WEBHOOK_SECRET: z.string().min(1),

    METRC_API_KEY: z.string().min(1),
    METRC_USER_KEY: z.string().min(1),
    METRC_API_BASE_URL: z.string().url().default('https://api-mn.metrc.com'),

    MAPBOX_ACCESS_TOKEN: z.string().min(1),

    TWILIO_ACCOUNT_SID: z.string().min(1),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    // Used by the masked-number Proxy product for driver↔customer calls
    // and texts during an active delivery — distinct from the messaging
    // service used for transactional SMS (`TWILIO_MESSAGING_SERVICE_SID`).
    TWILIO_PROXY_SERVICE_SID: z.string().min(1),
    // Outbound transactional SMS (order updates, payment failures, refund
    // notices). Either a Messaging Service SID (`MGxxxx`, preferred — lets
    // Twilio pick the best sender from a pool) or, when unset, the
    // provider falls back to `TWILIO_FROM_NUMBER`. Exactly one must be
    // configured for SMS delivery to be enabled at runtime.
    TWILIO_MESSAGING_SERVICE_SID: z.string().min(1).optional(),
    TWILIO_FROM_NUMBER: z
      .string()
      .regex(/^\+\d{8,15}$/u, 'TWILIO_FROM_NUMBER must be in E.164 format')
      .optional(),

    RESEND_API_KEY: z.string().min(1),
    RESEND_FROM_EMAIL: z.string().email().default('orders@dankdash.com'),

    APNS_KEY_ID: z.string().min(1),
    APNS_TEAM_ID: z.string().min(1),
    APNS_BUNDLE_ID: z.string().min(1),
    APNS_PRIVATE_KEY_BASE64: z.string().min(1),

    SENTRY_DSN: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    PORT: portSchema.default(3000),
    REALTIME_PORT: portSchema.default(3001),

    ENABLE_AEROPAY: booleanFromString.default(true),
    ENABLE_METRC: booleanFromString.default(false),
    ENABLE_PERSONA: booleanFromString.default(true),
    ENABLE_VERIFF: booleanFromString.default(true),
    // Twilio (transactional SMS) and Resend (transactional email) are
    // surfaced as feature flags so deployments without those creds can
    // boot. When the flag is `false` the API installs a no-op provider
    // that records a non-retryable skip on every send — the order
    // lifecycle continues, the notification row carries the reason.
    ENABLE_TWILIO: booleanFromString.default(true),
    ENABLE_RESEND: booleanFromString.default(true),
    // Swagger UI + the generated OpenAPI document expose the full internal
    // API surface (including compliance-gated paths). Non-production
    // environments always mount it for developer convenience; production
    // mounts it only when this flag is explicitly set, so a default prod
    // deploy never leaks the schema. See apps/api/src/main.ts.
    ENABLE_API_DOCS: booleanFromString.default(false),

    // Browser origins permitted to read API responses — the vendor portal
    // (Vercel) and the consumer checkout web app. Comma-separated exact
    // matches; no wildcards. Empty/unset leaves CORS disabled, which is
    // correct for the native iOS clients since CORS is a browser-only
    // concern. Consumed by apps/api/src/main.ts.
    CORS_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((value): readonly string[] =>
        value === undefined
          ? []
          : value
              .split(',')
              .map((origin) => origin.trim())
              .filter((origin) => origin.length > 0),
      ),
  })
  // `process.env` is necessarily polluted with PATH, HOME, npm_*, RAILWAY_*,
  // VSCODE_*, etc. The validator should care about *required* keys, not
  // forbid unknown ones; passthrough preserves them in the parsed object
  // for libraries (Sentry, OTEL) that read directly from process.env.
  .passthrough();

export type Env = z.infer<typeof EnvSchema>;

export interface LoadEnvOptions {
  readonly source?: NodeJS.ProcessEnv;
  /**
   * When `true`, missing optional secrets are tolerated. Used in CI lint /
   * typecheck / test entrypoints that don't actually call third-party APIs.
   *
   * When omitted, the loader falls back to `source.ALLOW_PARTIAL_ENV === '1'`
   * so a single env-var opt-in works uniformly for every call site —
   * including module factories (drizzle, redis, rate-limit) that invoke
   * `loadEnv()` with no arguments and the NestJS `ConfigModule.validate`
   * bootstrap callback that receives `raw` but never explicit options.
   *
   * Set to `false` explicitly to force strict mode even when the env var
   * is present.
   */
  readonly allowPartial?: boolean;
}

export class EnvValidationError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const summary = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
    super(`Environment validation failed:\n${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Like `schema.partial()` but preserves `.default(...)` semantics.
 *
 * `ZodObject.partial()` wraps every field in `ZodOptional`, which causes
 * Zod to short-circuit on `undefined` *before* the inner `ZodDefault`
 * has a chance to apply. The net effect is that env keys with sensible
 * defaults silently become `undefined` whenever the partial path is taken
 * — for example `SOCKET_CORS_ORIGINS` (defaults to `''`) crashed the
 * realtime bootstrap with "Cannot read properties of undefined (reading
 * 'trim')" when ALLOW_PARTIAL_ENV=1 was set.
 *
 * This helper only relaxes fields that are not already tolerant of
 * `undefined` (`ZodDefault`, `ZodOptional`, `ZodNullable`). Required
 * secrets become optional; defaulted/optional fields keep their existing
 * shape so the default value is honored.
 *
 * Exported so per-app slim schemas (e.g. `apps/realtime/src/env.ts`)
 * can use the same partial semantics as the shared loader.
 */
export function partialKeepingDefaults<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const f = field;
    const typeName = (f._def as { typeName?: string }).typeName;
    const tolerantOfUndefined =
      typeName === 'ZodDefault' || typeName === 'ZodOptional' || typeName === 'ZodNullable';
    shape[key] = tolerantOfUndefined ? f : f.optional();
  }
  return z.object(shape).passthrough();
}

export function loadEnv(options: LoadEnvOptions = {}): Env {
  const source = options.source ?? process.env;
  const requestedPartial = options.allowPartial ?? source['ALLOW_PARTIAL_ENV'] === '1';

  // Partial mode relaxes every required secret (JWT keys, column-encryption
  // key, payment/identity creds) to optional so CI lint/typecheck/test
  // entrypoints can boot without real secrets. In production that same
  // relaxation is a critical failure: the process would silently come up
  // with no auth signing key or no encryption key and serve traffic. So the
  // opt-in is refused whenever NODE_ENV resolves to production — regardless
  // of the env var OR an explicit `allowPartial: true` — and production
  // always validates strictly, failing loudly via EnvValidationError on any
  // missing secret. NODE_ENV is read from the same source; a leftover
  // ALLOW_PARTIAL_ENV=1 in prod is harmless when all secrets are present and
  // produces a clear validation error when they are not.
  const isProduction = source['NODE_ENV'] === 'production';
  const allowPartial = requestedPartial && !isProduction;

  const schema = allowPartial ? partialKeepingDefaults(EnvSchema) : EnvSchema;
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }

  return result.data as Env;
}

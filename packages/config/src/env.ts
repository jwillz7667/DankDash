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
    PASSWORD_PEPPER: z.string().min(32, 'PASSWORD_PEPPER must be at least 32 bytes'),

    COLUMN_ENCRYPTION_KEY_BASE64: z
      .string()
      .min(44, 'COLUMN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes'),

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
    TWILIO_PROXY_SERVICE_SID: z.string().min(1),

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
   * When true, missing optional secrets are tolerated even in production.
   * Only safe for the typecheck/lint/test entrypoints in CI — production
   * boot must always fail fast.
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

export function loadEnv(options: LoadEnvOptions = {}): Env {
  const source = options.source ?? process.env;
  const schema = options.allowPartial === true ? EnvSchema.partial() : EnvSchema;
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

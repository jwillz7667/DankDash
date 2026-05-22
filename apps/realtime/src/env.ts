/**
 * Realtime-service env validation.
 *
 * The Socket.io process needs a strict subset of the full @dankdash/config
 * env surface — it never signs JWTs (verify-only), never touches R2/Aeropay,
 * and only talks to Postgres for membership lookups (validates that a
 * connecting vendor is on a dispensary's staff, that a connecting driver
 * owns the claimed driver id). Keeping the schema slim means the process
 * boots without dragging the API's external-vendor secrets into the
 * realtime pod's address space.
 *
 * Boot policy mirrors the API: hard-fail on a missing required var unless
 * ALLOW_PARTIAL_ENV=1 (CI / local typecheck only). The pino redaction
 * paths from @dankdash/config/logger are inherited automatically because
 * we use createLogger from there.
 */
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const portSchema = z.coerce.number().int().min(1).max(65535);

export const RealtimeEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_SIZE: positiveInt.default(4),
    DATABASE_SLOW_QUERY_MS: positiveInt.default(500),

    REDIS_URL: z.string().url(),

    JWT_PUBLIC_KEY_BASE64: z.string().min(1),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Realtime defaults to 4000 — the api defaults to 3000, workers bind
    // nothing. Single port keeps Railway's healthcheck routing simple.
    PORT: portSchema.default(4000),

    // Socket.io consumer-group identity. Each pod runs one consumer in
    // the `realtime` group; the consumer name is per-pod so XPENDING
    // attribution is meaningful in incidents. Defaulted from POD or
    // hostname so Railway pods get distinct names without per-deploy
    // config.
    REALTIME_CONSUMER_GROUP: z.string().min(1).default('realtime'),
    REALTIME_CONSUMER_NAME: z.string().min(1).optional(),

    // Rate limit for client → server `driver:location:update` events.
    // 1 message per 1000ms per socket matches the spec; the bucket size
    // of 2 lets a short stall absorb without a single drop.
    DRIVER_LOCATION_RATE_PER_SECOND: positiveInt.default(1),
    DRIVER_LOCATION_BURST: positiveInt.default(2),

    // Socket.io engine.io ping interval / timeout — short enough that a
    // dead client gets reaped before its driver assignment goes stale,
    // long enough to absorb a mobile network handoff.
    SOCKET_PING_INTERVAL_MS: positiveInt.default(25_000),
    SOCKET_PING_TIMEOUT_MS: positiveInt.default(20_000),

    // CORS allow-list — comma-separated. Empty (the default) means
    // same-origin only, which is what production wants behind the
    // Railway TCP proxy. Test/dev sets the values they need.
    SOCKET_CORS_ORIGINS: z.string().default(''),
  })
  .passthrough();

export type RealtimeEnv = z.infer<typeof RealtimeEnvSchema>;

export interface LoadEnvOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly allowPartial?: boolean;
}

export class RealtimeEnvValidationError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>;
  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(`Realtime env validation failed:\n${summary}`);
    this.name = 'RealtimeEnvValidationError';
    this.issues = issues;
  }
}

export function loadRealtimeEnv(options: LoadEnvOptions = {}): RealtimeEnv {
  const source = options.source ?? process.env;
  // Mirror @dankdash/config's loadEnv: if the caller didn't pass an
  // explicit allowPartial, fall back to the ALLOW_PARTIAL_ENV=1 opt-in.
  const allowPartial = options.allowPartial ?? source['ALLOW_PARTIAL_ENV'] === '1';
  const schema = allowPartial ? RealtimeEnvSchema.partial() : RealtimeEnvSchema;
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new RealtimeEnvValidationError(issues);
  }
  return result.data as RealtimeEnv;
}

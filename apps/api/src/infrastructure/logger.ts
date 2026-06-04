/**
 * Bootstrap logger factory. The API process uses a single pino logger
 * configured from @dankdash/config (which owns the PII redaction paths from
 * spec §8). This module is intentionally tiny so main.ts can build the
 * logger before the NestJS DI container exists.
 *
 * The `requestContextMixin` from `@dankdash/observability` injects the
 * ALS-bound request/trace/span/user/dispensary fields onto every
 * record — so deep code can `log.info(...)` without threading the
 * request through. Pino runs the mixin per-call; it returns `{}`
 * when no ALS context is active, so background work outside a
 * request boundary stays unaffected.
 */
import { createLogger, type Env, type Logger } from '@dankdash/config';
import { requestContextMixin } from '@dankdash/observability';

export function resolveLogger(env: Env): Logger {
  return createLogger({
    name: 'apps/api',
    level: env.LOG_LEVEL,
    environment: env.NODE_ENV,
    mixin: requestContextMixin,
  });
}

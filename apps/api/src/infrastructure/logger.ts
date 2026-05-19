/**
 * Bootstrap logger factory. The API process uses a single pino logger
 * configured from @dankdash/config (which owns the PII redaction paths from
 * spec §8). This module is intentionally tiny so main.ts can build the
 * logger before the NestJS DI container exists.
 */
import { createLogger, type Env, type Logger } from '@dankdash/config';

export function resolveLogger(env: Env): Logger {
  return createLogger({
    name: 'apps/api',
    level: env.LOG_LEVEL,
    environment: env.NODE_ENV,
  });
}

/**
 * @dankdash/observability — shared observability primitives.
 *
 * Three subsurfaces:
 *
 *   - context: AsyncLocalStorage-backed RequestContext (requestId,
 *     userId, dispensaryId, traceId, spanId). Wired into every
 *     runtime's request boundary; consumed by `logging` and `errors`.
 *
 *   - logging: pino mixin that reads the context and adds the fields
 *     to every log record. Pair with the existing PII redaction in
 *     `packages/config/src/logger.ts`.
 *
 *   - metrics: Prom-client registry, http histograms, db gauges,
 *     redis gauges, domain counters. Exposed at `/metrics` per
 *     runtime.
 *
 *   - otel: NodeSDK init + graceful shutdown + DankDash semantic
 *     attribute constants. Must be initialized before NestFactory or
 *     any instrumented import.
 *
 *   - errors: Sentry init that consumes ALS context for tagging.
 */
export {
  enterRequestContext,
  getRequestContext,
  getRequestId,
  runWithRequestContext,
  updateRequestContext,
} from './context/als.js';
export type { RequestContext, WithRequestId } from './context/request-context.js';

export { requestContextMixin } from './logging/pino-mixin.js';
export type { PinoMixinFields } from './logging/pino-mixin.js';

export {
  RegistryNotConfiguredError,
  configureRegistry,
  getRegistry,
  resetRegistry,
} from './metrics/registry.js';
export type { RegistryConfig } from './metrics/registry.js';
export { createHttpHistograms, statusFamily } from './metrics/http-histograms.js';
export type { HttpHistograms } from './metrics/http-histograms.js';
export { createDbMetrics } from './metrics/db-gauges.js';
export type { DbMetrics, PoolSnapshot } from './metrics/db-gauges.js';
export { createRedisMetrics } from './metrics/redis-gauges.js';
export type { RedisMetrics, RedisSnapshot } from './metrics/redis-gauges.js';
export { createDomainCounters } from './metrics/domain-counters.js';
export type { DomainCounters } from './metrics/domain-counters.js';
export { createExceptionCounters } from './metrics/exception-counters.js';
export type { ExceptionCounters, ExceptionKind } from './metrics/exception-counters.js';

export { initOtel } from './otel/sdk.js';
export type { OtelHandle, OtelInitConfig } from './otel/sdk.js';
export { registerGracefulShutdown } from './otel/shutdown.js';
export type { ShutdownConfig } from './otel/shutdown.js';
export { DANKDASH_ATTRS } from './otel/attributes.js';
export type { DankDashAttrKey, DankDashAttrName } from './otel/attributes.js';

export { initSentry } from './errors/sentry.js';
export type { SentryHandle, SentryInitConfig } from './errors/sentry.js';

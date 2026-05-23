/**
 * Pino mixin that injects request-context fields into every log record.
 *
 * Wire-up (per runtime):
 *
 *   import { requestContextMixin } from '@dankdash/observability/logging';
 *   const logger = pino({ mixin: requestContextMixin });
 *
 * The mixin runs synchronously per log call, so it must not perform
 * any IO. It reads from ALS only; if ALS has no active store the
 * mixin returns an empty object and the log record has no context
 * fields — that is the intended behaviour for code paths that run
 * outside a request boundary (cron firings, process startup, etc.).
 *
 * Field names match the OpenTelemetry log-record conventions
 * (`trace_id`, `span_id`) so downstream log-to-trace correlation in
 * Grafana works without a transform. `request_id`, `user_id`, and
 * `dispensary_id` are repo-local conventions consistent with the
 * existing pino redaction paths in `packages/config/src/logger.ts`.
 */
import { getRequestContext } from '../context/als.js';

export interface PinoMixinFields {
  readonly request_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly user_id?: string;
  readonly dispensary_id?: string;
}

/**
 * Mixin function compatible with `pino`'s `mixin` option. Returns a
 * plain object that pino merges into the log record at write time.
 *
 * Implementation note: returning the empty object literal `{}` is the
 * pino-recommended way to signal "no extra fields" — returning
 * `undefined` works but the type signature is awkward and recent pino
 * versions warn on it.
 */
export function requestContextMixin(): PinoMixinFields {
  const ctx = getRequestContext();
  if (ctx === undefined) return {};

  const fields: {
    request_id?: string;
    trace_id?: string;
    span_id?: string;
    user_id?: string;
    dispensary_id?: string;
  } = {
    request_id: ctx.requestId,
  };
  if (ctx.traceId !== undefined) fields.trace_id = ctx.traceId;
  if (ctx.spanId !== undefined) fields.span_id = ctx.spanId;
  if (ctx.userId !== undefined) fields.user_id = ctx.userId;
  if (ctx.dispensaryId !== undefined) fields.dispensary_id = ctx.dispensaryId;
  return fields;
}

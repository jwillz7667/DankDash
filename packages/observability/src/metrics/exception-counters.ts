/**
 * Exception counters surfaced from the API's global exception filter.
 *
 * The HTTP histograms already capture per-route latency + status family,
 * but a dedicated counter for *exceptions* makes two things cheaper:
 *
 *   1. The "5xx rate ever > 0" alert reads a single time-series instead
 *      of summing a histogram quantile.
 *   2. The label `kind` distinguishes expected failures (DomainError,
 *      HttpException — both are 4xx/5xx but represent application
 *      control flow) from genuinely unexpected failures (anything else
 *      — these are the ones that should page on-call).
 *
 * The Sentry hop is paired with the `unhandled` increment in the filter
 * itself, so the alert can rely on this counter as the canonical
 * "should a human look at this?" signal.
 *
 * `kind` is a closed three-valued enum so cardinality stays bounded:
 *   - `domain`     — thrown DomainError subclass (declared statusCode + code)
 *   - `http`       — Nest HttpException (BadRequest, NotFound, etc.)
 *   - `unhandled`  — everything else; the Sentry-capturing branch
 */
import { Counter, type Registry } from 'prom-client';

export type ExceptionKind = 'domain' | 'http' | 'unhandled';

export interface ExceptionCounters {
  readonly exceptionsTotal: Counter<'kind' | 'status_family'>;
}

export function createExceptionCounters(registry: Registry): ExceptionCounters {
  const exceptionsTotal = new Counter({
    name: 'http_exceptions_total',
    help: 'HTTP exceptions surfaced by the global exception filter, by kind and status family.',
    labelNames: ['kind', 'status_family'],
    registers: [registry],
  });
  return { exceptionsTotal };
}

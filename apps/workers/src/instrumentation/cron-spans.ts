/**
 * Cron-job span + duration + outcome metrics.
 *
 * The workers runtime is `node-cron`, not BullMQ — so the standard
 * BullMQ "queue depth" gauge does not apply. Phase 21 spec §21.2
 * replaces it with three per-job metrics:
 *
 *   - `worker_job_duration_seconds{job}` — histogram. Tracks how long
 *     each invocation takes; the buckets cover the realistic range
 *     for our two current jobs (payouts ~5–30s, webhook cleanup
 *     <1s).
 *   - `worker_job_runs_total{job,outcome}` — counter, `outcome` ∈
 *     {success, failure}. Phase 21 alerts on
 *     `rate(worker_job_runs_total{outcome="failure"}[1h]) > 0` so a
 *     single failed run pages the on-call.
 *   - `worker_job_last_run_timestamp_seconds{job}` — gauge in unix
 *     seconds. Lets Grafana detect "scheduler is dead" (timestamp
 *     stops advancing) which is different from "scheduler is
 *     failing" (failure counter climbs).
 *
 * The OTel span side is straightforward: `tracer.startActiveSpan` so
 * the Pg / IORedis / Undici autoinstrumentations bind their child
 * spans to the right cron-job trace. We set status from the outcome
 * (OK / ERROR) plus a `worker.job.name` attribute so the Tempo /
 * Jaeger UI groups by job.
 */
import { type Tracer, trace, SpanStatusCode } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

const TRACER_NAME = 'dankdash-workers/cron';

/**
 * Closed set of job names. Adding a new cron-driven job means
 * extending this union — the cardinality of the `job` label is
 * therefore fixed at typecheck time, which keeps the metric series
 * count predictable.
 */
export type WorkerJobName = 'payouts' | 'webhook-events-cleanup';

export interface CronMetrics {
  readonly durationSeconds: Histogram;
  readonly runsTotal: Counter;
  readonly lastRunTimestampSeconds: Gauge;
}

export function createCronMetrics(registry: Registry): CronMetrics {
  const durationSeconds = new Histogram({
    name: 'worker_job_duration_seconds',
    help: 'Wall-clock duration of a single cron-job invocation, by job.',
    labelNames: ['job'],
    // Tuned for our actual workload: payouts ~5–30s, cleanup <1s.
    buckets: [0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const runsTotal = new Counter({
    name: 'worker_job_runs_total',
    help: 'Cron-job invocation outcomes; `outcome` is success|failure.',
    labelNames: ['job', 'outcome'],
    registers: [registry],
  });
  const lastRunTimestampSeconds = new Gauge({
    name: 'worker_job_last_run_timestamp_seconds',
    help: 'Unix timestamp of the most recent invocation of this job.',
    labelNames: ['job'],
    registers: [registry],
  });
  return { durationSeconds, runsTotal, lastRunTimestampSeconds };
}

export interface RunWithCronSpanOptions {
  readonly name: WorkerJobName;
  readonly metrics: CronMetrics;
  /** Optional injected tracer — defaults to the OTel global. Test seam. */
  readonly tracer?: Tracer;
}

/**
 * Wraps an async cron handler with an active span + duration timer +
 * outcome counter. The wrapped function never throws — failures are
 * recorded on the span and the counter; the caller's outer
 * `.catch()` therefore continues to be the orchestration boundary.
 */
export async function runWithCronSpan<T>(
  options: RunWithCronSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  const stopTimer = options.metrics.durationSeconds.startTimer({ job: options.name });
  return tracer.startActiveSpan(`cron.${options.name}`, async (span) => {
    span.setAttribute('worker.job.name', options.name);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      options.metrics.runsTotal.inc({ job: options.name, outcome: 'success' });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(err instanceof Error ? err : new Error(message));
      options.metrics.runsTotal.inc({ job: options.name, outcome: 'failure' });
      throw err;
    } finally {
      stopTimer();
      options.metrics.lastRunTimestampSeconds.set(
        { job: options.name },
        Math.floor(Date.now() / 1000),
      );
      span.end();
    }
  });
}

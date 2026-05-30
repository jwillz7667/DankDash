/**
 * Unit tests for runWithCronSpan + createCronMetrics.
 *
 * These exercise the wiring contract — that a successful run increments
 * `outcome="success"`, a failing run increments `outcome="failure"`,
 * the duration histogram records a positive observation, the
 * last-run-timestamp gauge advances, and the OTel span gets the right
 * status + recorded exception. A fake tracer lets us inspect span
 * lifecycle without spinning up the real SDK.
 */
import { type Span, type SpanStatus, type Tracer, SpanStatusCode } from '@opentelemetry/api';
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createCronMetrics, runWithCronSpan } from './cron-spans.js';

interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  status?: SpanStatus;
  ended: boolean;
  readonly exceptions: Error[];
}

function createFakeTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const startActiveSpan = (name: string, ...rest: unknown[]): unknown => {
    const fn = rest[rest.length - 1] as (span: Span) => unknown;
    const record: RecordedSpan = {
      name,
      attributes: {},
      ended: false,
      exceptions: [],
    };
    spans.push(record);
    const span: Span = {
      setAttribute: (key: string, value: unknown): Span => {
        record.attributes[key] = value;
        return span;
      },
      setAttributes: (attrs: Record<string, unknown>): Span => {
        Object.assign(record.attributes, attrs);
        return span;
      },
      setStatus: (status: SpanStatus): Span => {
        record.status = status;
        return span;
      },
      recordException: (err: Error | string): void => {
        record.exceptions.push(typeof err === 'string' ? new Error(err) : err);
      },
      addEvent: (): Span => span,
      addLink: (): Span => span,
      addLinks: (): Span => span,
      updateName: (): Span => span,
      end: (): void => {
        record.ended = true;
      },
      isRecording: (): boolean => true,
      spanContext: () => ({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 0,
      }),
    };
    return fn(span);
  };
  // Only startActiveSpan is exercised; startSpan is left out via the
  // single cast rather than constructing a no-op Span stub that the
  // suite never touches.
  const tracer = { startActiveSpan } as unknown as Tracer;
  return { tracer, spans };
}

async function readMetric(registry: Registry, name: string): Promise<string> {
  const text = await registry.metrics();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name) && !l.startsWith('#'))
    .join('\n');
}

const LAST_RUN_RE = /worker_job_last_run_timestamp_seconds\{job="payouts"\} (\d+)/;

describe('runWithCronSpan', () => {
  it('records success outcome + OK status + duration on a passing run', async () => {
    const registry = new Registry();
    const metrics = createCronMetrics(registry);
    const { tracer, spans } = createFakeTracer();

    const result = await runWithCronSpan({ name: 'payouts', metrics, tracer }, () =>
      Promise.resolve(42),
    );

    expect(result).toBe(42);

    const runs = await readMetric(registry, 'worker_job_runs_total');
    expect(runs).toContain('worker_job_runs_total{job="payouts",outcome="success"} 1');
    expect(runs).not.toContain('outcome="failure"');

    const duration = await readMetric(registry, 'worker_job_duration_seconds_count');
    expect(duration).toContain('worker_job_duration_seconds_count{job="payouts"} 1');

    const lastRun = await readMetric(registry, 'worker_job_last_run_timestamp_seconds');
    const match = LAST_RUN_RE.exec(lastRun);
    expect(match).not.toBeNull();
    const recorded = Number(match?.[1] ?? 0);
    expect(recorded).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('cron.payouts');
    expect(spans[0]?.attributes['worker.job.name']).toBe('payouts');
    expect(spans[0]?.status?.code).toBe(SpanStatusCode.OK);
    expect(spans[0]?.ended).toBe(true);
  });

  it('records failure outcome + ERROR status + recorded exception on a thrown error', async () => {
    const registry = new Registry();
    const metrics = createCronMetrics(registry);
    const { tracer, spans } = createFakeTracer();

    const boom = new Error('aeropay timeout');
    await expect(
      runWithCronSpan({ name: 'webhook-events-cleanup', metrics, tracer }, () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);

    const runs = await readMetric(registry, 'worker_job_runs_total');
    expect(runs).toContain(
      'worker_job_runs_total{job="webhook-events-cleanup",outcome="failure"} 1',
    );
    expect(runs).not.toContain('outcome="success"');

    const duration = await readMetric(registry, 'worker_job_duration_seconds_count');
    expect(duration).toContain('worker_job_duration_seconds_count{job="webhook-events-cleanup"} 1');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('cron.webhook-events-cleanup');
    expect(spans[0]?.attributes['worker.job.name']).toBe('webhook-events-cleanup');
    expect(spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.status?.message).toBe('aeropay timeout');
    expect(spans[0]?.exceptions).toHaveLength(1);
    expect(spans[0]?.exceptions[0]?.message).toBe('aeropay timeout');
    expect(spans[0]?.ended).toBe(true);
  });

  it('coerces non-Error throws to a recorded Error so the OTel span still has a message', async () => {
    const registry = new Registry();
    const metrics = createCronMetrics(registry);
    const { tracer, spans } = createFakeTracer();

    // The whole point of this test is to verify behavior when a legacy
    // path rejects with a non-Error value; the lint rule is correct in
    // general but is precisely what we are exercising here.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejectNonError = (): Promise<never> => Promise.reject('legacy string throw');
    await expect(
      runWithCronSpan({ name: 'payouts', metrics, tracer }, rejectNonError),
    ).rejects.toBe('legacy string throw');

    expect(spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.status?.message).toBe('legacy string throw');
    expect(spans[0]?.exceptions[0]?.message).toBe('legacy string throw');
  });

  it('keeps success + failure counters independent on mixed runs', async () => {
    const registry = new Registry();
    const metrics = createCronMetrics(registry);
    const { tracer } = createFakeTracer();

    await runWithCronSpan({ name: 'payouts', metrics, tracer }, () => Promise.resolve());
    await runWithCronSpan({ name: 'payouts', metrics, tracer }, () => Promise.resolve());
    await expect(
      runWithCronSpan({ name: 'payouts', metrics, tracer }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    const runs = await readMetric(registry, 'worker_job_runs_total');
    expect(runs).toContain('worker_job_runs_total{job="payouts",outcome="success"} 2');
    expect(runs).toContain('worker_job_runs_total{job="payouts",outcome="failure"} 1');
  });
});

/**
 * scheduleMetrcReportingJob wiring tests. Mirrors the partition + webhook
 * scheduler tests — pins the cron expression constant and verifies the
 * (expression, fn) pair handed to node-cron. The fn itself is wrapped to
 * swallow per-tick errors so the cron continues firing; we assert that
 * behavior by handing it a deps-shape whose `claimDueForReporting` throws
 * and confirming the wrapper logs but does not re-throw.
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const { METRC_REPORTING_CRON_EXPRESSION, scheduleMetrcReportingJob } =
  await import('./metrc-reporting.scheduler.js');

interface LoggerStub {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => LoggerStub;
}

function makeLogger(): LoggerStub {
  const stub: LoggerStub = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => stub,
  };
  return stub;
}

describe('METRC_REPORTING_CRON_EXPRESSION', () => {
  it('fires every minute — the lower bound of the spec retry ladder', () => {
    expect(METRC_REPORTING_CRON_EXPRESSION).toBe('*/1 * * * *');
  });
});

describe('scheduleMetrcReportingJob', () => {
  it('registers a node-cron task at the metrc reporting expression', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      metricTransactions: {} as never,
      orders: {} as never,
      orderItems: {} as never,
      dispensaries: {} as never,
      metrc: {} as never,
      encryption: {} as never,
      logger: makeLogger() as never,
    };

    scheduleMetrcReportingJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('*/1 * * * *');
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });

  it('swallows orchestration failures and logs at error level (cron keeps firing)', async () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const claimErr = new Error('postgres pool drained');
    const logger = makeLogger();
    const deps = {
      // Only `metricTransactions.claimDueForReporting` is touched by the
      // job's first await — every other dep can stay an empty shell.
      metricTransactions: {
        claimDueForReporting: () => Promise.reject(claimErr),
      } as never,
      orders: {} as never,
      orderItems: {} as never,
      dispensaries: {} as never,
      metrc: {} as never,
      encryption: {} as never,
      logger: logger as never,
    };

    scheduleMetrcReportingJob(deps);
    const tickFn = scheduleMock.mock.calls[0]?.[1] as () => void;
    expect(tickFn).toBeDefined();

    // Invoke the wrapper synchronously; await a microtask flush so the
    // .catch() arm has a chance to run before we assert.
    tickFn();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ err: 'postgres pool drained' });
  });
});

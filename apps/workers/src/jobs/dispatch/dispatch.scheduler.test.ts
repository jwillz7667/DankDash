/**
 * scheduleDispatchJob wiring tests. The scheduler module is a thin
 * wrapper around node-cron — these tests pin the constants and the
 * orchestration-level error-handling contract (an orchestration
 * failure logs via deps.logger.error rather than crashing the tick).
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const { DISPATCH_CRON_EXPRESSION, scheduleDispatchJob } = await import('./dispatch.scheduler.js');

describe('DISPATCH_CRON_EXPRESSION', () => {
  it('fires every 5 seconds (6-field cron with seconds in the leading position)', () => {
    expect(DISPATCH_CRON_EXPRESSION).toBe('*/5 * * * * *');
  });
});

describe('scheduleDispatchJob', () => {
  it('registers a node-cron task with the dispatch expression and no timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      orders: {} as never,
      drivers: {} as never,
      dispatchOffers: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({}) } as never,
    };

    scheduleDispatchJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('*/5 * * * * *');
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
    // Sub-minute cron passes no timezone option (node-cron 5-vs-6 field
    // parser disambiguates on the absence of options).
    expect(scheduleMock.mock.calls[0]?.[2]).toBeUndefined();
  });
});

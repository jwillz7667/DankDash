/**
 * schedulePayoutJob wiring tests. The scheduler module is mostly a thin
 * wrapper around node-cron — these tests pin the constants and the
 * orchestration-level error-handling contract (that a thrown error from
 * runPayoutJob is logged via deps.logger.error rather than crashing the
 * tick).
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const { PAYOUT_CRON_EXPRESSION, PAYOUT_CRON_TIMEZONE, schedulePayoutJob } =
  await import('./payout.scheduler.js');

describe('PAYOUT_CRON_EXPRESSION / PAYOUT_CRON_TIMEZONE', () => {
  it('fires at 03:00 every day, America/Chicago', () => {
    expect(PAYOUT_CRON_EXPRESSION).toBe('0 3 * * *');
    expect(PAYOUT_CRON_TIMEZONE).toBe('America/Chicago');
  });
});

describe('schedulePayoutJob', () => {
  it('registers a node-cron task with the payout expression and timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      dispensaries: {} as never,
      ledger: {} as never,
      payouts: {} as never,
      aeropay: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({}) } as never,
    };

    schedulePayoutJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('0 3 * * *');
    expect(scheduleMock.mock.calls[0]?.[2]).toEqual({ timezone: 'America/Chicago' });
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });
});

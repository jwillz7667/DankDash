/**
 * schedulePayoutReconciliationJob wiring tests. Pins the cron constants and
 * that the scheduler registers a node-cron task with the right expression +
 * timezone (the orchestration-level error handling is covered by the job's
 * own per-row isolation).
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const {
  PAYOUT_RECONCILIATION_CRON_EXPRESSION,
  PAYOUT_RECONCILIATION_CRON_TIMEZONE,
  schedulePayoutReconciliationJob,
} = await import('./payout-reconciliation.scheduler.js');

describe('PAYOUT_RECONCILIATION_CRON_EXPRESSION / TIMEZONE', () => {
  it('fires every 30 minutes, America/Chicago', () => {
    expect(PAYOUT_RECONCILIATION_CRON_EXPRESSION).toBe('*/30 * * * *');
    expect(PAYOUT_RECONCILIATION_CRON_TIMEZONE).toBe('America/Chicago');
  });
});

describe('schedulePayoutReconciliationJob', () => {
  it('registers a node-cron task with the reconciliation expression and timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      payouts: {} as never,
      aeropay: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({}) } as never,
    };

    schedulePayoutReconciliationJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('*/30 * * * *');
    expect(scheduleMock.mock.calls[0]?.[2]).toEqual({ timezone: 'America/Chicago' });
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });
});

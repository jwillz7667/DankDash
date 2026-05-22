/**
 * schedulePartitionManagementJob wiring tests. Mirrors the webhook
 * cleanup scheduler test: pins the cron constants and verifies that
 * node-cron is invoked with the right (expression, fn, options) triple.
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const {
  PARTITION_MANAGEMENT_CRON_EXPRESSION,
  PARTITION_MANAGEMENT_CRON_TIMEZONE,
  schedulePartitionManagementJob,
} = await import('./partition-management.scheduler.js');

describe('PARTITION_MANAGEMENT_CRON constants', () => {
  it('fires at 02:30 every Sunday, America/Chicago', () => {
    expect(PARTITION_MANAGEMENT_CRON_EXPRESSION).toBe('30 2 * * 0');
    expect(PARTITION_MANAGEMENT_CRON_TIMEZONE).toBe('America/Chicago');
  });
});

describe('schedulePartitionManagementJob', () => {
  it('registers a node-cron task with the partition-management expression and timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      partitions: {} as never,
      archiver: {} as never,
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        child: (): unknown => ({
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          child: vi.fn(),
        }),
      } as never,
      clock: () => new Date('2026-05-17T07:30:00.000Z'),
    };

    schedulePartitionManagementJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('30 2 * * 0');
    expect(scheduleMock.mock.calls[0]?.[2]).toEqual({ timezone: 'America/Chicago' });
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });
});

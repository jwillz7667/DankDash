/**
 * scheduleMonthlyPartitionRolloverJob wiring tests. Mirrors the
 * partition-management scheduler test: pins the cron constants and verifies
 * node-cron is invoked with the right (expression, fn, options) triple —
 * here the options carry `runOnInit: true`, which is the distinguishing
 * behavior for this self-healing job.
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const {
  MONTHLY_PARTITION_ROLLOVER_CRON_EXPRESSION,
  MONTHLY_PARTITION_ROLLOVER_CRON_TIMEZONE,
  scheduleMonthlyPartitionRolloverJob,
} = await import('./monthly-partition-rollover.scheduler.js');

function makeDeps(): {
  partitions: never;
  logger: never;
  clock: () => Date;
} {
  return {
    partitions: { rolloverMonthlyPartitions: vi.fn() } as never,
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
    clock: () => new Date('2026-05-29T07:15:00.000Z'),
  };
}

describe('MONTHLY_PARTITION_ROLLOVER_CRON constants', () => {
  it('fires daily at 02:15, America/Chicago', () => {
    expect(MONTHLY_PARTITION_ROLLOVER_CRON_EXPRESSION).toBe('15 2 * * *');
    expect(MONTHLY_PARTITION_ROLLOVER_CRON_TIMEZONE).toBe('America/Chicago');
  });
});

describe('scheduleMonthlyPartitionRolloverJob', () => {
  it('registers a node-cron task with the rollover expression, timezone, and runOnInit', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    scheduleMonthlyPartitionRolloverJob(makeDeps());

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('15 2 * * *');
    expect(scheduleMock.mock.calls[0]?.[2]).toEqual({
      timezone: 'America/Chicago',
      runOnInit: true,
    });
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });

  it('the registered callback swallows runOnce rejections via the scheduler logger', async () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const errorSpy = vi.fn();
    const deps = makeDeps();
    deps.logger = {
      error: errorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      child: (): unknown => ({
        // The service's own child logger rejects when runOnce delegates.
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        child: vi.fn(),
      }),
    } as never;
    deps.partitions = {
      rolloverMonthlyPartitions: vi.fn().mockRejectedValue(new Error('db down')),
    } as never;

    scheduleMonthlyPartitionRolloverJob(deps);

    const registered = scheduleMock.mock.calls[0]?.[1] as () => void;
    registered();
    // Allow the rejected promise's .catch to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'monthly_partition_rollover.scheduler_failed',
      err: 'db down',
    });
  });
});

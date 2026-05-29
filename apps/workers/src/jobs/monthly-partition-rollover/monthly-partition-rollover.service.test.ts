/**
 * Pure unit tests for MonthlyPartitionRolloverService.
 *
 * Mirrors the partition-management service suite: capture-logger + fake
 * repository + injected clock, no Postgres in the loop. The integration
 * test (packages/db/test/integration/partitions.test.ts) exercises the real
 * dankdash_rollover_monthly_partitions() function against testcontainers —
 * here we verify the orchestration: a single delegated call, the derived
 * duration, and the start/complete log pair.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type MonthlyPartitionRolloverDeps,
  MonthlyPartitionRolloverService,
} from './monthly-partition-rollover.service.js';

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function loggerInner(logs: CapturedLog[]): {
  child: (fields: Record<string, unknown>) => unknown;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
} {
  return {
    child: (): unknown => loggerInner(logs),
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
  };
}

function makeLogger(): {
  readonly logger: MonthlyPartitionRolloverDeps['logger'];
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    logger: loggerInner(logs) as unknown as MonthlyPartitionRolloverDeps['logger'],
    logs,
  };
}

function makePartitions(
  rolloverMonthlyPartitions: ReturnType<typeof vi.fn>,
): MonthlyPartitionRolloverDeps['partitions'] {
  return { rolloverMonthlyPartitions } as unknown as MonthlyPartitionRolloverDeps['partitions'];
}

describe('MonthlyPartitionRolloverService', () => {
  it('delegates exactly once to rolloverMonthlyPartitions', async () => {
    const rollover = vi.fn().mockResolvedValue(undefined);
    const { logger } = makeLogger();
    const service = new MonthlyPartitionRolloverService({
      partitions: makePartitions(rollover),
      logger,
      clock: () => new Date('2026-05-29T07:15:00.000Z'),
    });

    await service.runOnce();

    expect(rollover).toHaveBeenCalledTimes(1);
    expect(rollover).toHaveBeenCalledWith();
  });

  it('reports the elapsed duration from the injected clock', async () => {
    const rollover = vi.fn().mockResolvedValue(undefined);
    const { logger } = makeLogger();
    const ticks = [
      new Date('2026-05-29T07:15:00.000Z'), // started
      new Date('2026-05-29T07:15:00.000Z'), // info(horizon)
      new Date('2026-05-29T07:15:02.500Z'), // completed
    ];
    let i = 0;
    const service = new MonthlyPartitionRolloverService({
      partitions: makePartitions(rollover),
      logger,
      clock: () => ticks[Math.min(i++, ticks.length - 1)]!,
    });

    const summary = await service.runOnce();

    expect(summary.durationMs).toBe(2500);
  });

  it('logs a start and a completion record', async () => {
    const rollover = vi.fn().mockResolvedValue(undefined);
    const { logger, logs } = makeLogger();
    const service = new MonthlyPartitionRolloverService({
      partitions: makePartitions(rollover),
      logger,
      clock: () => new Date('2026-05-29T07:15:00.000Z'),
    });

    await service.runOnce();

    const messages = logs.map((l) => l.message);
    expect(messages).toContain('monthly partition rollover started');
    expect(messages).toContain('monthly partition rollover completed');
    expect(logs.every((l) => l.level === 'info')).toBe(true);
  });

  it('propagates a repository failure to the caller (the scheduler logs it)', async () => {
    const rollover = vi.fn().mockRejectedValue(new Error('connection terminated'));
    const { logger } = makeLogger();
    const service = new MonthlyPartitionRolloverService({
      partitions: makePartitions(rollover),
      logger,
      clock: () => new Date('2026-05-29T07:15:00.000Z'),
    });

    await expect(service.runOnce()).rejects.toThrow('connection terminated');
  });
});

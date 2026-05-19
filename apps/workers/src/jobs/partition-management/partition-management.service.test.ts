/**
 * Pure unit tests for PartitionLifecycleService.
 *
 * Mirrors the geofence/eta observer suites: capture-logger + fake
 * repository + fake archiver, no Postgres in the loop. The integration
 * test (packages/db/test/integration/partitions.test.ts) exercises the
 * real catalog queries against testcontainers — here we verify the
 * orchestration: orphan-drop, lookahead creation, and the
 * archive → detach → drop pipeline including each step's failure
 * isolation.
 */
import { type PartitionInfo, type PartitionsRepository } from '@dankdash/db';
import { describe, expect, it, vi } from 'vitest';
import {
  type ArchiveOutcome,
  type PartitionArchiver,
  PartitionLifecycleService,
  formatPartitionName,
  isoWeekStart,
} from './partition-management.service.js';

interface CapturedLog {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function loggerInner(logs: CapturedLog[]): {
  child: (fields: Record<string, unknown>) => unknown;
  trace: (fields: Record<string, unknown>, message: string) => void;
  debug: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
  fatal: (fields: Record<string, unknown>, message: string) => void;
} {
  return {
    child: (): unknown => loggerInner(logs),
    trace: (fields, message): void => {
      logs.push({ level: 'trace', fields, message });
    },
    debug: (fields, message): void => {
      logs.push({ level: 'debug', fields, message });
    },
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
    fatal: (fields, message): void => {
      logs.push({ level: 'fatal', fields, message });
    },
  };
}

function makeLogger(): {
  readonly logger: ConstructorParameters<typeof PartitionLifecycleService>[0]['logger'];
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    logger: loggerInner(logs) as unknown as ConstructorParameters<
      typeof PartitionLifecycleService
    >[0]['logger'],
    logs,
  };
}

interface RepoCalls {
  readonly createWeekPartition: ReturnType<typeof vi.fn>;
  readonly listWeekPartitions: ReturnType<typeof vi.fn>;
  readonly detachPartition: ReturnType<typeof vi.fn>;
  readonly dropTable: ReturnType<typeof vi.fn>;
  readonly listDetachedOrphans: ReturnType<typeof vi.fn>;
}

function makeRepo(
  overrides: {
    partitions?: readonly PartitionInfo[];
    orphans?: readonly string[];
    createWeekPartition?: ReturnType<typeof vi.fn>;
    detachPartition?: ReturnType<typeof vi.fn>;
    dropTable?: ReturnType<typeof vi.fn>;
    listWeekPartitions?: ReturnType<typeof vi.fn>;
    listDetachedOrphans?: ReturnType<typeof vi.fn>;
  } = {},
): { readonly partitions: PartitionsRepository; readonly calls: RepoCalls } {
  const createWeekPartition = overrides.createWeekPartition ?? vi.fn().mockResolvedValue(undefined);
  const listWeekPartitions =
    overrides.listWeekPartitions ?? vi.fn().mockResolvedValue(overrides.partitions ?? []);
  const detachPartition = overrides.detachPartition ?? vi.fn().mockResolvedValue(undefined);
  const dropTable = overrides.dropTable ?? vi.fn().mockResolvedValue(undefined);
  const listDetachedOrphans =
    overrides.listDetachedOrphans ?? vi.fn().mockResolvedValue(overrides.orphans ?? []);

  const calls: RepoCalls = {
    createWeekPartition,
    listWeekPartitions,
    detachPartition,
    dropTable,
    listDetachedOrphans,
  };
  const repo = calls as unknown as PartitionsRepository;
  return { partitions: repo, calls };
}

function makeArchiver(
  outcomes: Partial<Record<string, ArchiveOutcome | Error>> = {},
  defaultOutcome: ArchiveOutcome = { objectKey: 'archives/default', rowCount: 0, bytes: 0 },
): { readonly archiver: PartitionArchiver; readonly archive: ReturnType<typeof vi.fn> } {
  const archive = vi.fn(
    (input: {
      readonly parentTable: string;
      readonly partitionName: string;
      readonly partitionStart: Date;
      readonly partitionEnd: Date;
    }): Promise<ArchiveOutcome> => {
      const hit = outcomes[input.partitionName];
      if (hit instanceof Error) return Promise.reject(hit);
      if (hit !== undefined) return Promise.resolve(hit);
      return Promise.resolve(defaultOutcome);
    },
  );
  return { archiver: { archive }, archive };
}

function partition(name: string, rangeStart: string, rangeEnd: string): PartitionInfo {
  return {
    partitionName: name,
    rangeStart: new Date(rangeStart),
    rangeEnd: new Date(rangeEnd),
  };
}

// Reference moment used by most cases: Tuesday 2026-05-19 14:00 UTC. ISO
// week 21 (Mon 2026-05-18 → Mon 2026-05-25). Retention cutoff at 90 days
// is 2026-02-18T14:00:00Z.
const NOW = new Date('2026-05-19T14:00:00.000Z');

describe('PartitionLifecycleService.runOnce', () => {
  it('returns a structured summary with all phase counts and a duration', async () => {
    const { logger } = makeLogger();
    const { partitions } = makeRepo();
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(summary).toMatchObject({
      createdPartitions: expect.any(Array),
      archivedPartitions: expect.any(Array),
      droppedPartitions: expect.any(Array),
      droppedOrphans: expect.any(Array),
      skipped: expect.any(Array),
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('PartitionLifecycleService — orphan cleanup', () => {
  it('drops every orphan returned by the repo and reports them in the summary', async () => {
    const { logger, logs } = makeLogger();
    const { partitions, calls } = makeRepo({
      orphans: ['driver_location_history_2026_w03', 'driver_location_history_2026_w04'],
    });
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(calls.dropTable.mock.calls.map((c) => c[0])).toEqual([
      'driver_location_history_2026_w03',
      'driver_location_history_2026_w04',
    ]);
    expect(summary.droppedOrphans).toEqual([
      'driver_location_history_2026_w03',
      'driver_location_history_2026_w04',
    ]);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('dropped orphan'))).toBe(true);
  });

  it('continues past a per-orphan drop failure and records nothing for it', async () => {
    const { logger, logs } = makeLogger();
    const dropTable = vi
      .fn()
      .mockRejectedValueOnce(new Error('orphan A locked by analytics job'))
      .mockResolvedValueOnce(undefined);
    const { partitions } = makeRepo({
      orphans: ['driver_location_history_2026_w03', 'driver_location_history_2026_w04'],
      dropTable,
    });
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(dropTable).toHaveBeenCalledTimes(2);
    expect(summary.droppedOrphans).toEqual(['driver_location_history_2026_w04']);
    expect(
      logs.some(
        (l) =>
          l.level === 'error' &&
          l.message.includes('failed to drop orphan') &&
          l.fields.partition === 'driver_location_history_2026_w03',
      ),
    ).toBe(true);
  });

  it('does nothing for orphans when the repo reports none', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo({ orphans: [] });
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(calls.dropTable).not.toHaveBeenCalled();
    expect(summary.droppedOrphans).toEqual([]);
  });
});

describe('PartitionLifecycleService — future-partition lookahead', () => {
  it('creates the current week plus N lookahead weeks (default N=4 → 5 calls)', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo();
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(calls.createWeekPartition).toHaveBeenCalledTimes(5);
    const weekStarts = calls.createWeekPartition.mock.calls.map((c) =>
      (c[1] as Date).toISOString(),
    );
    expect(weekStarts).toEqual([
      '2026-05-18T00:00:00.000Z',
      '2026-05-25T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-06-08T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    ]);
    expect(summary.createdPartitions).toEqual([
      'driver_location_history_2026_w21',
      'driver_location_history_2026_w22',
      'driver_location_history_2026_w23',
      'driver_location_history_2026_w24',
      'driver_location_history_2026_w25',
    ]);
  });

  it('respects an explicit creationLookaheadWeeks override', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo();
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
      creationLookaheadWeeks: 1,
    });

    await service.runOnce();

    expect(calls.createWeekPartition).toHaveBeenCalledTimes(2);
  });

  it('continues past a single createWeekPartition failure and records the rest', async () => {
    const { logger, logs } = makeLogger();
    const createWeekPartition = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('deadlock with concurrent DDL'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { partitions } = makeRepo({ createWeekPartition });
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(createWeekPartition).toHaveBeenCalledTimes(5);
    expect(summary.createdPartitions).toEqual([
      'driver_location_history_2026_w21',
      'driver_location_history_2026_w23',
      'driver_location_history_2026_w24',
      'driver_location_history_2026_w25',
    ]);
    expect(
      logs.some((l) => l.level === 'error' && l.message.includes('createWeekPartition failed')),
    ).toBe(true);
  });
});

describe('PartitionLifecycleService — archive + drop expired', () => {
  // 90-day cutoff from NOW = 2026-02-18T14:00:00Z.
  // Three partitions: w03 (well past), w07 (at boundary), w20 (still hot).
  const past = partition(
    'driver_location_history_2026_w03',
    '2026-01-12T00:00:00.000Z',
    '2026-01-19T00:00:00.000Z',
  );
  const atBoundary = partition(
    'driver_location_history_2026_w07',
    '2026-02-09T00:00:00.000Z',
    '2026-02-16T00:00:00.000Z',
  );
  const hot = partition(
    'driver_location_history_2026_w20',
    '2026-05-11T00:00:00.000Z',
    '2026-05-18T00:00:00.000Z',
  );

  it('archives + detaches + drops every partition whose rangeEnd is past the cutoff', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo({ partitions: [past, atBoundary, hot] });
    const { archiver, archive } = makeArchiver({
      driver_location_history_2026_w03: {
        objectKey: 'archives/w03.parquet',
        rowCount: 1_234,
        bytes: 500_000,
      },
      driver_location_history_2026_w07: {
        objectKey: 'archives/w07.parquet',
        rowCount: 5_678,
        bytes: 800_000,
      },
    });
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(archive).toHaveBeenCalledTimes(2);
    expect(
      archive.mock.calls.map((c) => (c[0] as { partitionName: string }).partitionName),
    ).toEqual(['driver_location_history_2026_w03', 'driver_location_history_2026_w07']);

    expect(calls.detachPartition.mock.calls.map((c) => c[1])).toEqual([
      'driver_location_history_2026_w03',
      'driver_location_history_2026_w07',
    ]);
    // 5 lookahead-related dropTable calls? No — only the expired archives drop, no orphans configured.
    expect(calls.dropTable.mock.calls.map((c) => c[0])).toEqual([
      'driver_location_history_2026_w03',
      'driver_location_history_2026_w07',
    ]);

    expect(summary.archivedPartitions).toEqual([
      { name: 'driver_location_history_2026_w03', bytes: 500_000, rowCount: 1_234 },
      { name: 'driver_location_history_2026_w07', bytes: 800_000, rowCount: 5_678 },
    ]);
    expect(summary.droppedPartitions).toEqual([
      'driver_location_history_2026_w03',
      'driver_location_history_2026_w07',
    ]);
    expect(summary.skipped).toEqual([]);
  });

  it('treats rangeEnd > cutoff as still-hot and does NOT archive', async () => {
    const { logger } = makeLogger();
    // hotEdge ends one millisecond after the cutoff — must be retained.
    const hotEdge = partition(
      'driver_location_history_2026_w07_edge',
      '2026-02-09T00:00:00.000Z',
      '2026-02-18T14:00:00.001Z',
    );
    const { partitions, calls } = makeRepo({ partitions: [hotEdge] });
    const { archiver, archive } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(archive).not.toHaveBeenCalled();
    expect(calls.detachPartition).not.toHaveBeenCalled();
    expect(calls.dropTable).not.toHaveBeenCalled();
    expect(summary.archivedPartitions).toEqual([]);
  });

  it('skips detach + drop when archive fails — partition stays attached for retry', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo({ partitions: [past] });
    const { archiver, archive } = makeArchiver({
      driver_location_history_2026_w03: new Error('R2 putObject 503'),
    });
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(archive).toHaveBeenCalledTimes(1);
    expect(calls.detachPartition).not.toHaveBeenCalled();
    expect(calls.dropTable).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { name: 'driver_location_history_2026_w03', reason: 'archive_failed' },
    ]);
    expect(summary.archivedPartitions).toEqual([]);
    expect(summary.droppedPartitions).toEqual([]);
  });

  it('skips drop when detach fails — archive already done, partition retained', async () => {
    const { logger } = makeLogger();
    const detachPartition = vi.fn().mockRejectedValue(new Error('lock timeout'));
    const { partitions, calls } = makeRepo({
      partitions: [past],
      detachPartition,
    });
    const { archiver, archive } = makeArchiver({
      driver_location_history_2026_w03: {
        objectKey: 'archives/w03.parquet',
        rowCount: 100,
        bytes: 4_000,
      },
    });
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(archive).toHaveBeenCalledTimes(1);
    expect(detachPartition).toHaveBeenCalledTimes(1);
    expect(calls.dropTable).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { name: 'driver_location_history_2026_w03', reason: 'detach_failed' },
    ]);
    expect(summary.archivedPartitions).toHaveLength(1);
    expect(summary.droppedPartitions).toEqual([]);
  });

  it('records drop_failed when archive + detach succeeded but drop raised — orphan handled next week', async () => {
    const { logger } = makeLogger();
    const dropTable = vi.fn().mockRejectedValue(new Error('catalog write failed'));
    const { partitions } = makeRepo({
      partitions: [past],
      dropTable,
    });
    const { archiver } = makeArchiver({
      driver_location_history_2026_w03: {
        objectKey: 'archives/w03.parquet',
        rowCount: 100,
        bytes: 4_000,
      },
    });
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(dropTable).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toEqual([
      { name: 'driver_location_history_2026_w03', reason: 'drop_failed' },
    ]);
    expect(summary.droppedPartitions).toEqual([]);
  });

  it('archives + drops the next partition even when the first one failed at archive', async () => {
    const { logger } = makeLogger();
    const { partitions } = makeRepo({ partitions: [past, atBoundary] });
    const { archiver, archive } = makeArchiver({
      driver_location_history_2026_w03: new Error('R2 putObject 503'),
      driver_location_history_2026_w07: {
        objectKey: 'archives/w07.parquet',
        rowCount: 200,
        bytes: 5_000,
      },
    });
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
    });

    const summary = await service.runOnce();

    expect(archive).toHaveBeenCalledTimes(2);
    expect(summary.archivedPartitions).toEqual([
      { name: 'driver_location_history_2026_w07', bytes: 5_000, rowCount: 200 },
    ]);
    expect(summary.droppedPartitions).toEqual(['driver_location_history_2026_w07']);
    expect(summary.skipped).toEqual([
      { name: 'driver_location_history_2026_w03', reason: 'archive_failed' },
    ]);
  });

  it('uses the configured retentionDays override when computing the cutoff', async () => {
    const { logger } = makeLogger();
    // A 30-day retention shifts the cutoff to 2026-04-19. The "atBoundary"
    // partition (ends 2026-02-16) is now well past, and so is past w03.
    // hot (ends 2026-05-18) is still hot.
    const { partitions } = makeRepo({ partitions: [past, atBoundary, hot] });
    const { archiver, archive } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
      retentionDays: 30,
    });

    await service.runOnce();

    expect(
      archive.mock.calls.map((c) => (c[0] as { partitionName: string }).partitionName),
    ).toEqual(['driver_location_history_2026_w03', 'driver_location_history_2026_w07']);
  });

  it('honours a parentTable override across repo calls and partition naming', async () => {
    const { logger } = makeLogger();
    const { partitions, calls } = makeRepo();
    const { archiver } = makeArchiver();
    const service = new PartitionLifecycleService({
      partitions,
      archiver,
      logger,
      clock: () => NOW,
      parentTable: 'custom_hot_table',
      creationLookaheadWeeks: 0,
    });

    const summary = await service.runOnce();

    expect(calls.listDetachedOrphans).toHaveBeenCalledWith('custom_hot_table');
    expect(calls.listWeekPartitions).toHaveBeenCalledWith('custom_hot_table');
    expect(calls.createWeekPartition).toHaveBeenCalledWith('custom_hot_table', expect.any(Date));
    expect(summary.createdPartitions).toEqual(['custom_hot_table_2026_w21']);
  });
});

describe('isoWeekStart', () => {
  it('returns Monday 00:00 UTC for a mid-week input', () => {
    // Tuesday 2026-05-19 14:00Z → Monday 2026-05-18 00:00Z
    expect(isoWeekStart(new Date('2026-05-19T14:00:00.000Z')).toISOString()).toBe(
      '2026-05-18T00:00:00.000Z',
    );
  });

  it('returns the same Monday when input is already Monday 00:00 UTC', () => {
    expect(isoWeekStart(new Date('2026-05-18T00:00:00.000Z')).toISOString()).toBe(
      '2026-05-18T00:00:00.000Z',
    );
  });

  it('rolls a Sunday back to the prior Monday', () => {
    // Sun 2026-05-24 → Mon 2026-05-18
    expect(isoWeekStart(new Date('2026-05-24T23:59:00.000Z')).toISOString()).toBe(
      '2026-05-18T00:00:00.000Z',
    );
  });
});

describe('formatPartitionName', () => {
  it('produces parent_isoyear_wNN with a zero-padded week number', () => {
    expect(
      formatPartitionName('driver_location_history', new Date('2026-05-18T00:00:00.000Z')),
    ).toBe('driver_location_history_2026_w21');
    expect(
      formatPartitionName('driver_location_history', new Date('2026-01-05T00:00:00.000Z')),
    ).toBe('driver_location_history_2026_w02');
  });

  it('uses ISO-week-numbering year, not Gregorian, around the new-year boundary', () => {
    // Mon 2024-12-30 belongs to ISO week 2025-w01 (the Thursday of that
    // week is 2025-01-02). Postgres extract(isoyear) agrees → 2025.
    expect(
      formatPartitionName('driver_location_history', new Date('2024-12-30T00:00:00.000Z')),
    ).toBe('driver_location_history_2025_w01');
    // Mon 2027-01-04 is the start of ISO week 2027-w01.
    expect(
      formatPartitionName('driver_location_history', new Date('2027-01-04T00:00:00.000Z')),
    ).toBe('driver_location_history_2027_w01');
    // Mon 2025-12-29 starts ISO week 2026-w01 (Thursday is 2026-01-01).
    expect(
      formatPartitionName('driver_location_history', new Date('2025-12-29T00:00:00.000Z')),
    ).toBe('driver_location_history_2026_w01');
  });
});

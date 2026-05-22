/**
 * Unit tests for ParquetPartitionArchiver.
 *
 * The interesting surface here isn't the orchestration (already proven
 * by the lifecycle service tests with a fake PartitionArchiver); it's
 * that the streaming pipeline (Postgres rows → Parquet writer →
 * byte-counting passthrough → R2 upload) actually produces a valid
 * Parquet file with the right rows and a non-zero byte count.
 *
 * We mock `storage.putObjectStream` with a drain-to-buffer helper, then
 * round-trip the produced bytes through ParquetReader.openBuffer to
 * confirm the encoding. This catches schema mismatches and row-shape
 * regressions that would silently produce empty / malformed archives.
 */
import { type DriverLocationHistoryArchiveRow, type PartitionsRepository } from '@dankdash/db';
import { type R2Storage } from '@dankdash/storage';
import parquet from '@dsnp/parquetjs';
import { describe, expect, it, vi } from 'vitest';
import { ParquetPartitionArchiver } from './parquet-archiver.js';
import type { Readable } from 'node:stream';

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): {
  readonly logger: ConstructorParameters<typeof ParquetPartitionArchiver>[0]['logger'];
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  const innerFactory = (): {
    child: (fields: Record<string, unknown>) => unknown;
    info: (fields: Record<string, unknown>, message: string) => void;
    warn: (fields: Record<string, unknown>, message: string) => void;
    error: (fields: Record<string, unknown>, message: string) => void;
  } => ({
    child: (): unknown => innerFactory(),
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
  });
  const logger = innerFactory() as unknown as ConstructorParameters<
    typeof ParquetPartitionArchiver
  >[0]['logger'];
  return { logger, logs };
}

function sampleRow(
  overrides: Partial<DriverLocationHistoryArchiveRow> = {},
): DriverLocationHistoryArchiveRow {
  return {
    id: '1',
    driverId: '01900000-0000-7000-8000-00000000000a',
    orderId: '01900000-0000-7000-8000-00000000aaaa',
    lat: 44.978,
    lng: -93.265,
    accuracyMeters: 5.5,
    speedMps: 8.3,
    headingDeg: 270,
    batteryPct: 87,
    recordedAt: new Date('2026-02-09T01:00:00.000Z'),
    ...overrides,
  };
}

function makePartitionsRepo(rows: readonly DriverLocationHistoryArchiveRow[]): {
  readonly partitions: PartitionsRepository;
  readonly streamCalls: { partitionName: string; batchSize: number }[];
} {
  const streamCalls: { partitionName: string; batchSize: number }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const stream = async function* (
    partitionName: string,
    batchSize: number,
  ): AsyncGenerator<readonly DriverLocationHistoryArchiveRow[], void, void> {
    streamCalls.push({ partitionName, batchSize });
    // Honor batchSize so the test can cover the loop's batch boundary.
    for (let i = 0; i < rows.length; i += batchSize) {
      yield rows.slice(i, i + batchSize);
    }
  };
  const partitions = {
    streamPartitionRows: stream,
  } as unknown as PartitionsRepository;
  return { partitions, streamCalls };
}

function makeStorage(
  override?: (key: string, body: Readable, contentType?: string) => Promise<void>,
): {
  readonly storage: R2Storage;
  readonly captured: { key: string; bytes: Buffer; contentType: string | undefined }[];
  readonly putObjectStream: ReturnType<typeof vi.fn>;
} {
  const captured: { key: string; bytes: Buffer; contentType: string | undefined }[] = [];
  const putObjectStream = vi.fn(
    async (key: string, body: Readable, contentType?: string): Promise<void> => {
      if (override !== undefined) {
        return override(key, body, contentType);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(chunk as Buffer);
      }
      captured.push({ key, bytes: Buffer.concat(chunks), contentType });
    },
  );
  const storage = { putObjectStream } as unknown as R2Storage;
  return { storage, captured, putObjectStream };
}

describe('ParquetPartitionArchiver.archive', () => {
  it('writes a Parquet file at archives/<prefix>/<partition>.parquet with the right content type', async () => {
    const { logger } = makeLogger();
    const { partitions } = makePartitionsRepo([sampleRow()]);
    const { storage, captured } = makeStorage();

    const archiver = new ParquetPartitionArchiver({ partitions, storage, logger });
    const outcome = await archiver.archive({
      parentTable: 'driver_location_history',
      partitionName: 'driver_location_history_2026_w03',
      partitionStart: new Date('2026-01-12T00:00:00.000Z'),
      partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.key).toBe(
      'archives/driver_location_history/driver_location_history_2026_w03.parquet',
    );
    expect(captured[0]?.contentType).toBe('application/vnd.apache.parquet');
    expect(outcome).toMatchObject({
      objectKey: 'archives/driver_location_history/driver_location_history_2026_w03.parquet',
      rowCount: 1,
    });
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(outcome.bytes).toBe(captured[0]?.bytes.length);
  });

  it('round-trips multiple rows through Parquet with all columns intact', async () => {
    const { logger } = makeLogger();
    const rows: DriverLocationHistoryArchiveRow[] = [
      sampleRow({ id: '1', lat: 44.978, lng: -93.265, batteryPct: 91 }),
      sampleRow({
        id: '2',
        lat: 44.985,
        lng: -93.27,
        accuracyMeters: 3.2,
        speedMps: 12.1,
        headingDeg: 95,
        batteryPct: 90,
        recordedAt: new Date('2026-02-09T01:00:05.000Z'),
      }),
      sampleRow({
        id: '3',
        orderId: null,
        accuracyMeters: null,
        speedMps: null,
        headingDeg: null,
        batteryPct: null,
        lat: 44.99,
        lng: -93.272,
        recordedAt: new Date('2026-02-09T01:00:10.000Z'),
      }),
    ];
    const { partitions } = makePartitionsRepo(rows);
    const { storage, captured } = makeStorage();

    const archiver = new ParquetPartitionArchiver({ partitions, storage, logger });
    await archiver.archive({
      parentTable: 'driver_location_history',
      partitionName: 'driver_location_history_2026_w03',
      partitionStart: new Date('2026-01-12T00:00:00.000Z'),
      partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
    });

    const buf = captured[0]?.bytes;
    expect(buf).toBeInstanceOf(Buffer);
    if (!(buf instanceof Buffer)) return;

    const reader = await parquet.ParquetReader.openBuffer(buf);
    const cursor = reader.getCursor();
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const r = (await cursor.next()) as Record<string, unknown> | null;
      if (r === null) break;
      out.push(r);
    }
    await reader.close();

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: '1',
      driver_id: '01900000-0000-7000-8000-00000000000a',
      lat: 44.978,
      lng: -93.265,
      battery_pct: 91,
    });
    // optional null surface — parquetjs omits the key on read when the
    // definition level says "null". Confirm both presence in row 1 and
    // absence (or null) in row 3.
    expect(out[1]).toMatchObject({
      id: '2',
      accuracy_meters: 3.2,
      speed_mps: 12.1,
      heading_deg: 95,
    });
    const row3 = out[2]!;
    expect(row3['id']).toBe('3');
    expect(row3['order_id'] ?? null).toBeNull();
    expect(row3['accuracy_meters'] ?? null).toBeNull();
    expect(row3['speed_mps'] ?? null).toBeNull();
    expect(row3['heading_deg'] ?? null).toBeNull();
    expect(row3['battery_pct'] ?? null).toBeNull();
  });

  it('honours a custom keyPrefix and normalises a trailing slash', async () => {
    const { logger } = makeLogger();
    const { partitions } = makePartitionsRepo([sampleRow()]);
    const { storage, captured } = makeStorage();

    const archiver = new ParquetPartitionArchiver({
      partitions,
      storage,
      logger,
      keyPrefix: 'cold/dlh', // no trailing slash on purpose
    });
    const outcome = await archiver.archive({
      parentTable: 'driver_location_history',
      partitionName: 'driver_location_history_2026_w03',
      partitionStart: new Date('2026-01-12T00:00:00.000Z'),
      partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
    });

    expect(captured[0]?.key).toBe('cold/dlh/driver_location_history_2026_w03.parquet');
    expect(outcome.objectKey).toBe('cold/dlh/driver_location_history_2026_w03.parquet');
  });

  it('passes the configured streamBatchSize to the partition repository', async () => {
    const { logger } = makeLogger();
    const { partitions, streamCalls } = makePartitionsRepo([sampleRow()]);
    const { storage } = makeStorage();

    const archiver = new ParquetPartitionArchiver({
      partitions,
      storage,
      logger,
      streamBatchSize: 2_500,
    });
    await archiver.archive({
      parentTable: 'driver_location_history',
      partitionName: 'driver_location_history_2026_w03',
      partitionStart: new Date('2026-01-12T00:00:00.000Z'),
      partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
    });

    expect(streamCalls).toEqual([
      { partitionName: 'driver_location_history_2026_w03', batchSize: 2_500 },
    ]);
  });

  it('reports rowCount = 0 for an empty partition and still produces a valid Parquet header', async () => {
    const { logger } = makeLogger();
    const { partitions } = makePartitionsRepo([]);
    const { storage, captured } = makeStorage();

    const archiver = new ParquetPartitionArchiver({ partitions, storage, logger });
    const outcome = await archiver.archive({
      parentTable: 'driver_location_history',
      partitionName: 'driver_location_history_2026_w03',
      partitionStart: new Date('2026-01-12T00:00:00.000Z'),
      partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
    });

    expect(outcome.rowCount).toBe(0);
    expect(outcome.bytes).toBeGreaterThan(0);
    const buf = captured[0]?.bytes;
    expect(buf).toBeInstanceOf(Buffer);
    // Parquet files start with "PAR1" magic.
    expect(buf!.subarray(0, 4).toString('ascii')).toBe('PAR1');
  });

  it('propagates an upload failure from storage.putObjectStream', async () => {
    const { logger } = makeLogger();
    const { partitions } = makePartitionsRepo([sampleRow()]);
    const { storage } = makeStorage((_key, body) => {
      // Drain so the writer doesn't block on backpressure forever, then
      // reject as if R2 returned 5xx.
      body.on('data', () => undefined);
      return Promise.reject(new Error('R2 putObject 503'));
    });

    const archiver = new ParquetPartitionArchiver({ partitions, storage, logger });
    await expect(
      archiver.archive({
        parentTable: 'driver_location_history',
        partitionName: 'driver_location_history_2026_w03',
        partitionStart: new Date('2026-01-12T00:00:00.000Z'),
        partitionEnd: new Date('2026-01-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('R2 putObject 503');
  });
});

/**
 * Streaming Parquet → R2 archiver for `driver_location_history`
 * partitions detached by the lifecycle service.
 *
 * Why streaming end-to-end:
 *
 *   - A production week of pings is ~1–10M rows. Buffering the whole
 *     encoded Parquet in memory before upload would put the worker into
 *     a 200–500MB heap spike once a week — survivable, but pointless
 *     when streaming costs nothing extra here.
 *
 *   - `@aws-sdk/lib-storage` Upload accepts a node Readable and handles
 *     multipart automatically (5MB chunks, configurable concurrency).
 *     `@dsnp/parquetjs` ParquetWriter.openStream accepts any object with
 *     `write` + `end` — a PassThrough satisfies that. Wire them with a
 *     byte-counting Transform in the middle and the bytes-written field
 *     in the summary is free.
 *
 * Object key shape: `<prefix>/<partitionName>.parquet`. Content-addressed
 * by partition name → re-running an archive after a detach failure
 * produces the same key, which gives us idempotency without extra
 * bookkeeping: R2 simply overwrites with identical bytes.
 *
 * Schema notes:
 *
 *   - `id` is encoded as UTF8 even though it's a bigserial. Avoids the
 *     `number | BigInt` ambiguity in parquetjs INT64 handling and lets
 *     Athena/DuckDB cast back if they need an integer sort key. Loss-
 *     less for our use case (audit / regulatory export).
 *
 *   - `recorded_at` is TIMESTAMP_MILLIS — Parquet's native ms-since-epoch
 *     UTC timestamp. The DB column is timestamptz; JS Date.getTime()
 *     already returns UTC ms, so the conversion is direct.
 *
 *   - Geography is unpacked to `(lat, lng)` doubles upstream (see
 *     PartitionsRepository.streamPartitionRows) — Parquet has no native
 *     geometry type and analytics consumers (Athena/DuckDB) treat
 *     paired doubles natively.
 *
 *   - Compression is GZIP rather than SNAPPY: cold archive bytes are
 *     transferred to R2 once and read at-most-rarely (regulator export
 *     queries), so we optimize for storage density over decode speed.
 */
import { PassThrough, Transform, type TransformCallback } from 'node:stream';
import { type Logger } from '@dankdash/config';
import { type DriverLocationHistoryArchiveRow, type PartitionsRepository } from '@dankdash/db';
import { type R2Storage } from '@dankdash/storage';
import parquet from '@dsnp/parquetjs';
import { type ArchiveOutcome, type PartitionArchiver } from './partition-management.service.js';

export interface ParquetArchiverDeps {
  readonly partitions: PartitionsRepository;
  readonly storage: R2Storage;
  readonly logger: Logger;
  /** Object key prefix. Defaults to `archives/driver_location_history/`. */
  readonly keyPrefix?: string;
  /** Row batch size used when iterating the partition. Defaults to 5_000. */
  readonly streamBatchSize?: number;
}

const DEFAULT_KEY_PREFIX = 'archives/driver_location_history/';
const DEFAULT_STREAM_BATCH_SIZE = 5_000;
const CONTENT_TYPE = 'application/vnd.apache.parquet';

const archiveSchema = new parquet.ParquetSchema({
  id: { type: 'UTF8', compression: 'GZIP' },
  driver_id: { type: 'UTF8', compression: 'GZIP' },
  order_id: { type: 'UTF8', optional: true, compression: 'GZIP' },
  lat: { type: 'DOUBLE', compression: 'GZIP' },
  lng: { type: 'DOUBLE', compression: 'GZIP' },
  accuracy_meters: { type: 'DOUBLE', optional: true, compression: 'GZIP' },
  speed_mps: { type: 'DOUBLE', optional: true, compression: 'GZIP' },
  heading_deg: { type: 'DOUBLE', optional: true, compression: 'GZIP' },
  battery_pct: { type: 'INT32', optional: true, compression: 'GZIP' },
  recorded_at: { type: 'TIMESTAMP_MILLIS', compression: 'GZIP' },
});

export class ParquetPartitionArchiver implements PartitionArchiver {
  private readonly partitions: PartitionsRepository;
  private readonly storage: R2Storage;
  private readonly logger: Logger;
  private readonly keyPrefix: string;
  private readonly streamBatchSize: number;

  constructor(deps: ParquetArchiverDeps) {
    this.partitions = deps.partitions;
    this.storage = deps.storage;
    this.logger = deps.logger.child({ component: 'parquet_partition_archiver' });
    this.keyPrefix = (deps.keyPrefix ?? DEFAULT_KEY_PREFIX).replace(/\/*$/, '/');
    this.streamBatchSize = deps.streamBatchSize ?? DEFAULT_STREAM_BATCH_SIZE;
  }

  async archive(input: {
    readonly parentTable: string;
    readonly partitionName: string;
    readonly partitionStart: Date;
    readonly partitionEnd: Date;
  }): Promise<ArchiveOutcome> {
    const objectKey = `${this.keyPrefix}${input.partitionName}.parquet`;

    // Set up the pipeline: parquet writer → byte counter → S3 Upload.
    // The counter is a passthrough that tallies the encoded size so we
    // can report it in the summary without a HEAD on the uploaded object.
    const counter = new ByteCountingPassThrough();
    const uploadPromise = this.storage.putObjectStream(objectKey, counter, CONTENT_TYPE);

    let rowCount = 0;
    let writer: parquet.ParquetWriter | null = null;
    try {
      // parquetjs types `outputStream` as `Pick<WriteStream, 'write' | 'end'>`
      // which surfaces `end(): WriteStream` in the return type and excludes
      // Transform at compile time. Runtime contract is just `write/end`
      // (which Transform implements faithfully), so the cast is safe.
      writer = await parquet.ParquetWriter.openStream(
        archiveSchema,
        counter as unknown as Parameters<typeof parquet.ParquetWriter.openStream>[1],
      );

      for await (const batch of this.partitions.streamPartitionRows(
        input.partitionName,
        this.streamBatchSize,
      )) {
        for (const row of batch) {
          await writer.appendRow(toParquetRow(row));
          rowCount += 1;
        }
      }

      // close() flushes the file footer and calls .end() on the underlying
      // stream, which propagates EOF to lib-storage Upload's reader and
      // lets uploadPromise resolve.
      await writer.close();
      writer = null;
    } catch (err) {
      // If the writer is still open, force-end the stream so the Upload
      // promise rejects instead of hanging. The thrown error from this
      // try-block surfaces first; the upload error becomes a noisy log.
      if (writer !== null) {
        try {
          await writer.close();
        } catch {
          counter.destroy();
        }
      } else {
        counter.destroy();
      }
      throw err;
    }

    await uploadPromise;

    this.logger.info(
      {
        partition: input.partitionName,
        objectKey,
        rowCount,
        bytes: counter.bytesWritten,
      },
      'parquet archive complete',
    );

    return {
      objectKey,
      rowCount,
      bytes: counter.bytesWritten,
    };
  }
}

/**
 * Convert a DB-row to the column shape the Parquet schema expects.
 * Parquet's `optional` columns accept `null` directly; the writer
 * encodes the definition level accordingly.
 */
function toParquetRow(row: DriverLocationHistoryArchiveRow): Record<string, unknown> {
  return {
    id: row.id,
    driver_id: row.driverId,
    order_id: row.orderId,
    lat: row.lat,
    lng: row.lng,
    accuracy_meters: row.accuracyMeters,
    speed_mps: row.speedMps,
    heading_deg: row.headingDeg,
    battery_pct: row.batteryPct,
    recorded_at: row.recordedAt,
  };
}

/**
 * Transform that counts bytes flowing through but otherwise behaves
 * exactly like PassThrough — pass it where lib-storage expects a
 * Readable and where parquetjs expects a `{ write, end }` writable.
 *
 * We extend Transform rather than PassThrough because Transform gives
 * us a hook (`_transform`) before the chunk is forwarded; PassThrough's
 * 'data' event would force flowing mode and race with Upload's reader.
 */
class ByteCountingPassThrough extends Transform {
  private _bytesWritten = 0;

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this._bytesWritten += buffer.length;
    callback(null, buffer);
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }
}

// Unused export — kept so the byte-counter is testable in isolation
// without exposing the implementation detail through the public archiver
// surface. Internal helpers may be referenced from sibling unit tests.
export const __test = { ByteCountingPassThrough, PassThrough, archiveSchema };

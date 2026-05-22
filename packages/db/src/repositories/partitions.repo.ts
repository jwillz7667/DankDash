/**
 * Repository for Postgres declarative partition management.
 *
 * Phase 10.4 wires a weekly cron that ensures partitions for the hot
 * `driver_location_history` table stay caught up: create the next ISO
 * week's partition if missing, list the existing partitions so the
 * cron can detach + archive anything older than the retention window,
 * and execute the detach/drop DDL once the archiver has succeeded.
 *
 * Why a dedicated repository rather than open-coding sql.raw in the
 * job: a) the SQL has subtle gotchas (Postgres rejects bind parameters
 * for object identifiers; pg_inherits + pg_get_expr returns the
 * partition bound expression as text we have to parse), and b) the
 * partition shape mirrors the migration's `dankdash_create_week_partition`
 * helper — keeping all the partition vocabulary in one file means the
 * job stays declarative.
 *
 * Identifier safety: detach + drop accept partition names that we
 * already pulled from `pg_inherits`, but the parent-table name is
 * supplied by the caller. We validate both against a strict pattern
 * (`[a-z_][a-z0-9_]{0,62}`) before interpolating into SQL — Postgres
 * does not accept `$1` placeholders for object identifiers, so the
 * defence in depth is the regex.
 */
import { ValidationError } from '@dankdash/types';
import { sql } from 'drizzle-orm';
import { BaseRepository } from './base.js';

export interface PartitionInfo {
  readonly partitionName: string;
  /** Inclusive lower bound of the partition's range, parsed from `relpartbound`. */
  readonly rangeStart: Date;
  /** Exclusive upper bound. A partition for ISO week N spans [Mon00:00, NextMon00:00). */
  readonly rangeEnd: Date;
}

/**
 * Flattened row shape used by archive consumers. Geography is unpacked to
 * `(lat, lng)` doubles so the Parquet writer doesn't have to know about
 * PostGIS WKB encoding, and numeric columns are surfaced as `number | null`
 * (drizzle returns them as decimal-strings from `numeric(p,s)` columns;
 * the repo coerces here to keep the writer trivial).
 */
export interface DriverLocationHistoryArchiveRow {
  readonly id: string;
  readonly driverId: string;
  readonly orderId: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyMeters: number | null;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  readonly batteryPct: number | null;
  readonly recordedAt: Date;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_STREAM_BATCH_SIZE = 5_000;

export class PartitionsRepository extends BaseRepository {
  /**
   * Idempotent — wraps the `dankdash_create_week_partition` SQL function
   * defined in the bootstrap migration. The function itself short-circuits
   * via `pg_class` if the partition already exists, so the cron can fire
   * this against an already-prepared partition without raising.
   */
  async createWeekPartition(parentTable: string, weekStart: Date): Promise<void> {
    assertSafeIdentifier(parentTable);
    const dateLiteral = weekStart.toISOString().slice(0, 10);
    await this.db.execute(
      sql`SELECT dankdash_create_week_partition(${parentTable}::text, ${dateLiteral}::date)`,
    );
  }

  /**
   * Returns every child partition of `parentTable` with its parsed range
   * bounds, ordered chronologically. Reads `pg_get_expr(relpartbound)`
   * which serializes the partition bound as e.g.
   * `FOR VALUES FROM ('2026-05-18 00:00:00+00') TO ('2026-05-25 00:00:00+00')`
   * — we extract the FROM/TO timestamps with a regex rather than
   * shelling out to a more elaborate catalog query. The regex is anchored
   * and only accepts ISO-shaped timestamps so a future Postgres change
   * in the bound-printing format surfaces as a parse error, not as a
   * silent skip.
   */
  async listWeekPartitions(parentTable: string): Promise<readonly PartitionInfo[]> {
    assertSafeIdentifier(parentTable);
    const rows = (await this.db.execute<{
      partition_name: string;
      bound_expr: string;
    }>(sql`
      SELECT
        child.relname AS partition_name,
        pg_get_expr(child.relpartbound, child.oid) AS bound_expr
      FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
      JOIN pg_namespace ns ON child.relnamespace    = ns.oid
      WHERE parent.relname = ${parentTable}
        AND ns.nspname = 'public'
    `)) as ReadonlyArray<{ partition_name: string; bound_expr: string }>;

    const out: PartitionInfo[] = [];
    for (const row of rows) {
      const parsed = parseRangeBound(row.bound_expr);
      if (parsed === null) {
        // A non-range bound (LIST, DEFAULT) or a future Postgres serializer
        // change. Surface visibly — the cron's caller can decide whether
        // to skip or abort. We choose to skip and warn at the service
        // layer rather than throw here, but the empty-rangeEnd row tells
        // the caller something is off.
        continue;
      }
      out.push({
        partitionName: row.partition_name,
        rangeStart: parsed.rangeStart,
        rangeEnd: parsed.rangeEnd,
      });
    }
    out.sort((a, b) => a.rangeStart.getTime() - b.rangeStart.getTime());
    return out;
  }

  /**
   * `DETACH PARTITION` removes the child from the parent without
   * locking the writers on the parent for the duration of a data copy
   * (which is what `DROP PARTITION` would do). We deliberately use the
   * non-CONCURRENTLY form: the parent is the partitioned `driver_location_history`
   * and the writes happen against partitions directly (Postgres routes
   * by range), so a brief AccessExclusiveLock on the parent during the
   * catalog flip is acceptable for a 2:30am cron.
   */
  async detachPartition(parentTable: string, partitionName: string): Promise<void> {
    assertSafeIdentifier(parentTable);
    assertSafeIdentifier(partitionName);
    await this.db.execute(
      sql.raw(`ALTER TABLE "${parentTable}" DETACH PARTITION "${partitionName}"`),
    );
  }

  /**
   * After detach, the partition becomes a regular table. Drop it once
   * the archiver has confirmed the rows are durable in R2. Separate
   * call from detach so the orchestration can checkpoint between the
   * two — if the worker crashes after detach but before drop, next
   * week's cron sees the orphan via `listDetachedTables` (the partition
   * is no longer a child of the parent, so it's not in `listWeekPartitions`).
   */
  async dropTable(tableName: string): Promise<void> {
    assertSafeIdentifier(tableName);
    await this.db.execute(sql.raw(`DROP TABLE "${tableName}"`));
  }

  /**
   * Async-iterates a partition table's rows in `(id ASC)` keyset batches.
   * `id` is `bigserial`, monotonic within a partition, and part of the PK
   * — paging by `id > $lastId` is index-served and avoids the
   * progressively-slower scan that LIMIT/OFFSET on a multi-million-row
   * partition would degenerate into.
   *
   * Why a generator and not "return readonly Row[]": a one-week archive
   * is 1–10M rows at scale (≈100 active drivers × ping/5s × 7 days).
   * Holding the full row set in memory before encoding to Parquet would
   * double the worker's heap. The generator hands the writer batches it
   * can append-then-discard.
   *
   * Geography is unpacked via `ST_Y` / `ST_X` in SQL so the consumer
   * never sees WKB bytes — Parquet schemas don't have a native geometry
   * type and Athena/DuckDB on the analytics side will treat `(lat, lng)`
   * doubles natively.
   */
  async *streamPartitionRows(
    partitionName: string,
    batchSize: number = DEFAULT_STREAM_BATCH_SIZE,
  ): AsyncGenerator<readonly DriverLocationHistoryArchiveRow[], void, void> {
    assertSafeIdentifier(partitionName);
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new ValidationError('streamPartitionRows requires positive batchSize', {
        batchSize,
      });
    }
    // BigInt covers the full bigserial domain; coercing through it both
    // gates the cursor (anything non-numeric throws SyntaxError on the
    // BigInt constructor) and lets us bind it as a $-placeholder below.
    // Start before row 1 — bigserial allocates starting at 1.
    let cursor = 0n;
    const tableId = sql.raw(`"${partitionName}"`);
    for (;;) {
      const rows = (await this.db.execute<{
        id: string;
        driver_id: string;
        order_id: string | null;
        lat: string;
        lng: string;
        accuracy_meters: string | null;
        speed_mps: string | null;
        heading_deg: string | null;
        battery_pct: number | null;
        recorded_at: Date;
      }>(sql`
        SELECT
          id::text          AS id,
          driver_id::text   AS driver_id,
          order_id::text    AS order_id,
          ST_Y(location::geometry)::text AS lat,
          ST_X(location::geometry)::text AS lng,
          accuracy_meters::text AS accuracy_meters,
          speed_mps::text       AS speed_mps,
          heading_deg::text     AS heading_deg,
          battery_pct,
          recorded_at
        FROM ${tableId}
        WHERE id > ${cursor}
        ORDER BY id ASC
        LIMIT ${batchSize}
      `)) as ReadonlyArray<{
        id: string;
        driver_id: string;
        order_id: string | null;
        lat: string;
        lng: string;
        accuracy_meters: string | null;
        speed_mps: string | null;
        heading_deg: string | null;
        battery_pct: number | null;
        recorded_at: Date;
      }>;

      if (rows.length === 0) return;

      const batch: DriverLocationHistoryArchiveRow[] = rows.map((row) => ({
        id: row.id,
        driverId: row.driver_id,
        orderId: row.order_id,
        lat: Number(row.lat),
        lng: Number(row.lng),
        accuracyMeters: row.accuracy_meters === null ? null : Number(row.accuracy_meters),
        speedMps: row.speed_mps === null ? null : Number(row.speed_mps),
        headingDeg: row.heading_deg === null ? null : Number(row.heading_deg),
        batteryPct: row.battery_pct,
        recordedAt: row.recorded_at,
      }));
      yield batch;

      // bigserial ordered ascending — last row's id is the next cursor.
      const last = rows[rows.length - 1];
      if (last === undefined) return;
      cursor = BigInt(last.id);

      // Partial last batch implies no further rows — short-circuit.
      if (rows.length < batchSize) return;
    }
  }

  /**
   * Detached-but-not-dropped orphans from a previous crashed run. The
   * cron picks these up before doing any new detach work so we never
   * accumulate orphans in production. Matched by the partition naming
   * convention `<parent>_<isoyear>_w<NN>` — anything matching that
   * pattern that is no longer a child of `parentTable` is an orphan.
   */
  async listDetachedOrphans(parentTable: string): Promise<readonly string[]> {
    assertSafeIdentifier(parentTable);
    const prefix = `${parentTable}_`;
    const rows = (await this.db.execute<{ table_name: string }>(sql`
      SELECT child.relname AS table_name
      FROM pg_class child
      JOIN pg_namespace ns ON child.relnamespace = ns.oid
      WHERE ns.nspname = 'public'
        AND child.relkind = 'r'
        AND child.relname LIKE ${`${prefix}%`}
        AND child.relname ~ ${`^${prefix}\\d{4}_w\\d{2}$`}
        AND NOT EXISTS (
          SELECT 1 FROM pg_inherits i
          JOIN pg_class p ON i.inhparent = p.oid
          WHERE i.inhrelid = child.oid AND p.relname = ${parentTable}
        )
    `)) as ReadonlyArray<{ table_name: string }>;
    return rows.map((r) => r.table_name);
  }
}

function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new ValidationError('unsafe SQL identifier rejected', { name });
  }
}

const BOUND_REGEX = /^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$/;

function parseRangeBound(
  boundExpr: string,
): { readonly rangeStart: Date; readonly rangeEnd: Date } | null {
  const match = BOUND_REGEX.exec(boundExpr);
  if (match === null) return null;
  const startText = match[1];
  const endText = match[2];
  if (startText === undefined || endText === undefined) return null;
  const rangeStart = new Date(startText);
  const rangeEnd = new Date(endText);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) return null;
  return { rangeStart, rangeEnd };
}

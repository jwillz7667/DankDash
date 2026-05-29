/**
 * Integration tests for PartitionsRepository against a real Postgres.
 *
 * Exercises the catalog-aware paths that pure unit tests can't reach:
 *   - createWeekPartition writes a real partition that pg_inherits
 *     reports as a child of the parent.
 *   - listWeekPartitions parses the `relpartbound` text expression back
 *     into typed ranges.
 *   - detachPartition flips the catalog so the table is no longer a
 *     child but is still a regular table that can be queried + dropped.
 *   - dropTable removes the detached orphan.
 *   - listDetachedOrphans only matches `<parent>_YYYY_wNN` tables that
 *     are no longer in pg_inherits.
 *   - streamPartitionRows pages through a populated partition with
 *     batch sizes smaller than the row count.
 *
 * Setup: we run against the shared seeded container, then create a
 * dedicated child partition for an out-of-range week so we don't fight
 * the bootstrap migration's pre-created 26 weeks.
 */
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { PartitionsRepository } from '../../src/index.js';
import { getPool, seedDefault } from '../setup.js';

const PARENT = 'driver_location_history';
// Use a week far from the bootstrap's pre-created range so cleanup is
// safe and the partition is unambiguously ours. Mon 2030-01-07 is ISO
// week 2 of 2030.
const FUTURE_WEEK_START = new Date('2030-01-07T00:00:00.000Z');
const FUTURE_PARTITION = 'driver_location_history_2030_w02';
const FUTURE_RANGE_END = new Date('2030-01-14T00:00:00.000Z');

describe('PartitionsRepository (integration)', () => {
  beforeAll(async () => {
    await seedDefault();
    // Clean up any leftovers from a previous failed run so the test is
    // idempotent against rerunning a developer machine.
    const pool = getPool();
    await pool.db
      .execute(sql.raw(`DROP TABLE IF EXISTS "${FUTURE_PARTITION}"`))
      .catch(() => undefined);
  }, 60_000);

  describe('createWeekPartition', () => {
    it('creates a child partition that pg_inherits attributes to the parent', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await repo.createWeekPartition(PARENT, FUTURE_WEEK_START);

      const all = await repo.listWeekPartitions(PARENT);
      const ours = all.find((p) => p.partitionName === FUTURE_PARTITION);
      expect(ours).toBeDefined();
      expect(ours?.rangeStart.toISOString()).toBe(FUTURE_WEEK_START.toISOString());
      expect(ours?.rangeEnd.toISOString()).toBe(FUTURE_RANGE_END.toISOString());
    });

    it('is idempotent — calling twice does not raise', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await expect(repo.createWeekPartition(PARENT, FUTURE_WEEK_START)).resolves.toBeUndefined();
    });

    it('rejects unsafe parent identifiers without touching the database', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await expect(
        repo.createWeekPartition('foo"; DROP TABLE x; --', FUTURE_WEEK_START),
      ).rejects.toThrow();
    });
  });

  describe('streamPartitionRows', () => {
    it('paginates through inserted rows in id-ascending batches', async () => {
      const pool = getPool();
      const repo = new PartitionsRepository(pool.db);

      // Insert 7 rows across the future partition. Use unique recorded_at
      // values so PG routes them into our weekly partition (which it does
      // because the partition range covers them) and they appear in the
      // table we created above.
      const baseTime = FUTURE_WEEK_START.getTime() + 60_000;
      // Insert into the partition directly so we don't fight the migration's
      // location-only NOT NULL.
      for (let i = 0; i < 7; i += 1) {
        await pool.db.execute(
          sql.raw(`
          INSERT INTO "${FUTURE_PARTITION}"
            (driver_id, order_id, location, accuracy_meters, speed_mps,
             heading_deg, battery_pct, recorded_at)
          VALUES (
            '00000000-0000-7000-8000-00000000000a'::uuid,
            NULL,
            ST_SetSRID(ST_MakePoint(-93.265, 44.978 + ${i * 0.0001}), 4326)::geography,
            ${5 + i}.0,
            ${10 + i}.0,
            ${90 + i}.0,
            ${95 - i},
            '${new Date(baseTime + i * 1000).toISOString()}'
          )
        `),
        );
      }

      const batches: number[][] = [];
      for await (const batch of repo.streamPartitionRows(FUTURE_PARTITION, 3)) {
        batches.push(batch.map((r) => Number(r.id)));
      }
      // 7 rows in batches of 3 → [3, 3, 1].
      expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
      // ids monotonic across batches.
      const flat = batches.flat();
      const sorted = [...flat].sort((a, b) => a - b);
      expect(flat).toEqual(sorted);

      // Spot-check that lat/lng decoded properly.
      const firstBatch = batches[0];
      expect(firstBatch).toBeDefined();
      const rowsAgain: { lat: number; lng: number }[] = [];
      for await (const batch of repo.streamPartitionRows(FUTURE_PARTITION, 100)) {
        for (const row of batch) {
          rowsAgain.push({ lat: row.lat, lng: row.lng });
        }
      }
      expect(rowsAgain).toHaveLength(7);
      expect(rowsAgain[0]?.lat).toBeCloseTo(44.978, 4);
      expect(rowsAgain[0]?.lng).toBeCloseTo(-93.265, 4);
    });

    it('rejects a non-positive batchSize', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await expect(repo.streamPartitionRows(FUTURE_PARTITION, 0).next()).rejects.toThrow();
      await expect(repo.streamPartitionRows(FUTURE_PARTITION, -5).next()).rejects.toThrow();
    });
  });

  describe('detach + drop + listDetachedOrphans', () => {
    it('detaches the child, lists it as an orphan, then drops it cleanly', async () => {
      const repo = new PartitionsRepository(getPool().db);

      const beforeDetach = await repo.listWeekPartitions(PARENT);
      expect(beforeDetach.some((p) => p.partitionName === FUTURE_PARTITION)).toBe(true);

      await repo.detachPartition(PARENT, FUTURE_PARTITION);

      const afterDetach = await repo.listWeekPartitions(PARENT);
      expect(afterDetach.some((p) => p.partitionName === FUTURE_PARTITION)).toBe(false);

      // Now the detached table should appear as an orphan — it matches
      // the naming pattern and is no longer in pg_inherits for the parent.
      const orphans = await repo.listDetachedOrphans(PARENT);
      expect(orphans).toContain(FUTURE_PARTITION);

      await repo.dropTable(FUTURE_PARTITION);
      const orphansAfterDrop = await repo.listDetachedOrphans(PARENT);
      expect(orphansAfterDrop).not.toContain(FUTURE_PARTITION);
    });

    it('rejects unsafe partition names at detach + drop boundaries', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await expect(repo.detachPartition(PARENT, 'bad name')).rejects.toThrow();
      await expect(repo.dropTable("bad'name")).rejects.toThrow();
    });
  });

  describe('rolloverMonthlyPartitions', () => {
    const MONTHLY_PARENTS = [
      'order_events',
      'order_status_history',
      'notifications',
      'audit_log',
    ] as const;

    // True iff a MONTH-shaped partition (`<parent>_YYYY_MM`) exists for the
    // month `monthsAhead` from now. The suffix is computed in SQL with the
    // exact date math dankdash_create_month_partition uses, so the assertion
    // can't drift from the function's clock or the test runner's timezone.
    async function monthPartitionExists(parent: string, monthsAhead: number): Promise<boolean> {
      const rows = (await getPool().db.execute<{ present: boolean }>(
        sql.raw(`
          SELECT EXISTS (
            SELECT 1 FROM pg_class
            WHERE relname = '${parent}_' || to_char(
              (date_trunc('month', NOW()) + interval '${monthsAhead} months')::date,
              'YYYY_MM'
            )
          ) AS present
        `),
      )) as ReadonlyArray<{ present: boolean }>;
      return rows[0]?.present === true;
    }

    it('runs without raising — the pre-fix function tripped the driver_location_history overlap', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await expect(repo.rolloverMonthlyPartitions()).resolves.toBeUndefined();
    });

    it('is idempotent — a second call is a no-op, not an error', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await repo.rolloverMonthlyPartitions();
      await expect(repo.rolloverMonthlyPartitions()).resolves.toBeUndefined();
    });

    it('guarantees the current month plus a three-month look-ahead for every monthly table', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await repo.rolloverMonthlyPartitions();

      for (const parent of MONTHLY_PARENTS) {
        for (let monthsAhead = 0; monthsAhead <= 3; monthsAhead += 1) {
          expect(
            await monthPartitionExists(parent, monthsAhead),
            `${parent} +${monthsAhead}mo partition`,
          ).toBe(true);
        }
      }
    });

    it('does not create a monthly partition for the week-partitioned driver_location_history', async () => {
      const repo = new PartitionsRepository(getPool().db);
      await repo.rolloverMonthlyPartitions();

      // A `driver_location_history_YYYY_MM` table (no `w`) would be the
      // overlapping monthly partition the old function tried to make.
      for (let monthsAhead = 0; monthsAhead <= 3; monthsAhead += 1) {
        expect(await monthPartitionExists('driver_location_history', monthsAhead)).toBe(false);
      }
    });
  });
});

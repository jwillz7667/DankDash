/**
 * Weekly partition lifecycle for the hot `driver_location_history` table.
 *
 * The table is range-partitioned by `recorded_at` at ISO-week boundaries
 * (see `0000_init.sql`). The bootstrap migration pre-creates 26 weeks of
 * partitions so the freshly-restored dev DB is never in a "no partition
 * for value" failure state — but production needs an ongoing cron to
 * keep that runway intact and to archive+drop partitions past the
 * retention horizon.
 *
 * The job runs once a week at 02:30 America/Chicago (see scheduler.ts).
 * Per run:
 *
 *   1. Drop any orphans left over from a crashed previous run. An
 *      orphan is a `<parent>_YYYY_wNN` table that no longer appears in
 *      `pg_inherits` for its parent — typically because a previous run
 *      detached but then crashed before drop. Re-running the archiver
 *      is unsafe (the data is no longer in a partition the read path
 *      sees), so the orphan-drop path skips archive and just drops; the
 *      previous attempt should have archived before detaching.
 *
 *   2. Ensure the next N weeks of partitions exist. N defaults to 4 so
 *      a 3-week cron outage doesn't immediately page anyone. Each
 *      `createWeekPartition` call is idempotent via `IF NOT EXISTS` in
 *      the SQL helper.
 *
 *   3. List the existing partitions and pick out the ones whose
 *      `rangeEnd` is older than `now - retentionDays`. The exclusive
 *      upper bound is the right boundary: a partition for week N holds
 *      `[Mon00:00, NextMon00:00)`, so we want to retain it until 90
 *      days after `NextMon00:00`.
 *
 *   4. For each retention-eligible partition: archive → detach → drop.
 *      Each step's failure short-circuits the rest for that partition
 *      and logs — the next week's run will retry from wherever we
 *      stopped. The archive is content-addressed (same partition name
 *      → same R2 key) so a re-archive after a detach-failure is safe.
 *
 * No transactions wrap any of this — DDL in Postgres commits implicitly
 * at statement boundaries and the steps are deliberately re-entrant.
 */
import { type Logger } from '@dankdash/config';
import { type PartitionInfo, type PartitionsRepository } from '@dankdash/db';

export interface PartitionArchiver {
  /**
   * Read every row from `partitionName`, encode to Parquet, and durably
   * land the file in object storage. Returns an `ArchiveOutcome` summary
   * for telemetry. Throws on any non-recoverable failure — the lifecycle
   * job will skip the detach+drop steps for the partition that failed.
   */
  archive(input: {
    readonly parentTable: string;
    readonly partitionName: string;
    readonly partitionStart: Date;
    readonly partitionEnd: Date;
  }): Promise<ArchiveOutcome>;
}

export interface ArchiveOutcome {
  /** Storage key under which the archive landed. */
  readonly objectKey: string;
  /** Number of source rows written into the archive. */
  readonly rowCount: number;
  /** Encoded byte size of the archive object. */
  readonly bytes: number;
}

export interface PartitionLifecycleDeps {
  readonly partitions: PartitionsRepository;
  readonly archiver: PartitionArchiver;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** Defaults to `driver_location_history`. */
  readonly parentTable?: string;
  /** Defaults to 90 days per spec § 10.4. */
  readonly retentionDays?: number;
  /** Defaults to 4 weeks of look-ahead. */
  readonly creationLookaheadWeeks?: number;
}

export interface PartitionLifecycleSummary {
  readonly createdPartitions: readonly string[];
  readonly archivedPartitions: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly rowCount: number;
  }[];
  readonly droppedPartitions: readonly string[];
  readonly droppedOrphans: readonly string[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly durationMs: number;
}

const DEFAULT_PARENT_TABLE = 'driver_location_history';
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CREATION_LOOKAHEAD_WEEKS = 4;
const MS_PER_DAY = 86_400_000;

export class PartitionLifecycleService {
  private readonly partitions: PartitionsRepository;
  private readonly archiver: PartitionArchiver;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly parentTable: string;
  private readonly retentionDays: number;
  private readonly creationLookaheadWeeks: number;

  constructor(deps: PartitionLifecycleDeps) {
    this.partitions = deps.partitions;
    this.archiver = deps.archiver;
    this.logger = deps.logger.child({ job: 'partition_management' });
    this.clock = deps.clock;
    this.parentTable = deps.parentTable ?? DEFAULT_PARENT_TABLE;
    this.retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.creationLookaheadWeeks = deps.creationLookaheadWeeks ?? DEFAULT_CREATION_LOOKAHEAD_WEEKS;
  }

  async runOnce(): Promise<PartitionLifecycleSummary> {
    const startedAt = Date.now();
    const now = this.clock();
    this.logger.info(
      {
        parentTable: this.parentTable,
        retentionDays: this.retentionDays,
        creationLookaheadWeeks: this.creationLookaheadWeeks,
        horizon: now.toISOString(),
      },
      'partition management started',
    );

    const droppedOrphans = await this.dropOrphans();
    const createdPartitions = await this.ensureFuturePartitions(now);
    const { archived, dropped, skipped } = await this.archiveAndDropExpired(now);

    const summary: PartitionLifecycleSummary = {
      createdPartitions,
      archivedPartitions: archived,
      droppedPartitions: dropped,
      droppedOrphans,
      skipped,
      durationMs: Date.now() - startedAt,
    };
    this.logger.info(
      {
        created: createdPartitions.length,
        archived: archived.length,
        dropped: dropped.length,
        orphansDropped: droppedOrphans.length,
        skipped: skipped.length,
        durationMs: summary.durationMs,
      },
      'partition management completed',
    );
    return summary;
  }

  private async dropOrphans(): Promise<readonly string[]> {
    const orphans = await this.partitions.listDetachedOrphans(this.parentTable);
    const dropped: string[] = [];
    for (const orphan of orphans) {
      try {
        await this.partitions.dropTable(orphan);
        dropped.push(orphan);
        this.logger.warn(
          { partition: orphan },
          'partition management: dropped orphan from previous crashed run',
        );
      } catch (err) {
        this.logger.error(
          {
            partition: orphan,
            err: err instanceof Error ? err.message : String(err),
          },
          'partition management: failed to drop orphan — will retry next week',
        );
      }
    }
    return dropped;
  }

  private async ensureFuturePartitions(now: Date): Promise<readonly string[]> {
    const created: string[] = [];
    const thisWeekStart = isoWeekStart(now);
    for (let i = 0; i <= this.creationLookaheadWeeks; i += 1) {
      const weekStart = new Date(thisWeekStart.getTime() + i * 7 * MS_PER_DAY);
      try {
        await this.partitions.createWeekPartition(this.parentTable, weekStart);
        created.push(formatPartitionName(this.parentTable, weekStart));
      } catch (err) {
        this.logger.error(
          {
            weekStart: weekStart.toISOString(),
            err: err instanceof Error ? err.message : String(err),
          },
          'partition management: createWeekPartition failed — will retry next week',
        );
      }
    }
    return created;
  }

  private async archiveAndDropExpired(now: Date): Promise<{
    readonly archived: readonly {
      readonly name: string;
      readonly bytes: number;
      readonly rowCount: number;
    }[];
    readonly dropped: readonly string[];
    readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  }> {
    const cutoff = new Date(now.getTime() - this.retentionDays * MS_PER_DAY);
    const all = await this.partitions.listWeekPartitions(this.parentTable);
    const expired = all.filter((p) => p.rangeEnd.getTime() <= cutoff.getTime());

    const archived: { name: string; bytes: number; rowCount: number }[] = [];
    const dropped: string[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const partition of expired) {
      const outcome = await this.tryArchive(partition);
      if (outcome === null) {
        skipped.push({ name: partition.partitionName, reason: 'archive_failed' });
        continue;
      }
      archived.push({
        name: partition.partitionName,
        bytes: outcome.bytes,
        rowCount: outcome.rowCount,
      });

      const detached = await this.tryDetach(partition);
      if (!detached) {
        skipped.push({ name: partition.partitionName, reason: 'detach_failed' });
        continue;
      }

      const droppedOk = await this.tryDrop(partition.partitionName);
      if (!droppedOk) {
        skipped.push({ name: partition.partitionName, reason: 'drop_failed' });
        continue;
      }
      dropped.push(partition.partitionName);
    }

    return { archived, dropped, skipped };
  }

  private async tryArchive(partition: PartitionInfo): Promise<ArchiveOutcome | null> {
    try {
      const outcome = await this.archiver.archive({
        parentTable: this.parentTable,
        partitionName: partition.partitionName,
        partitionStart: partition.rangeStart,
        partitionEnd: partition.rangeEnd,
      });
      this.logger.info(
        {
          partition: partition.partitionName,
          rangeStart: partition.rangeStart.toISOString(),
          rangeEnd: partition.rangeEnd.toISOString(),
          objectKey: outcome.objectKey,
          bytes: outcome.bytes,
          rowCount: outcome.rowCount,
        },
        'partition management: archived',
      );
      return outcome;
    } catch (err) {
      this.logger.error(
        {
          partition: partition.partitionName,
          err: err instanceof Error ? err.message : String(err),
        },
        'partition management: archive failed — partition retained, will retry next week',
      );
      return null;
    }
  }

  private async tryDetach(partition: PartitionInfo): Promise<boolean> {
    try {
      await this.partitions.detachPartition(this.parentTable, partition.partitionName);
      return true;
    } catch (err) {
      this.logger.error(
        {
          partition: partition.partitionName,
          err: err instanceof Error ? err.message : String(err),
        },
        'partition management: detach failed after successful archive — will retry next week',
      );
      return false;
    }
  }

  private async tryDrop(tableName: string): Promise<boolean> {
    try {
      await this.partitions.dropTable(tableName);
      return true;
    } catch (err) {
      this.logger.error(
        {
          partition: tableName,
          err: err instanceof Error ? err.message : String(err),
        },
        'partition management: drop failed after successful detach — table is detached orphan, will retry next week',
      );
      return false;
    }
  }
}

/**
 * Returns the Monday-00:00 UTC start of the ISO week containing `d`.
 *
 * The migration's `dankdash_create_week_partition` uses
 * `date_trunc('week', ...)` server-side, which also pins to ISO Monday.
 * Matching that convention here keeps the partition names we compute
 * client-side identical to the names Postgres assigns server-side, so
 * `formatPartitionName` is faithful for logging.
 */
export function isoWeekStart(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay returns 0 for Sun, 1 for Mon … 6 for Sat. ISO weeks start Mon.
  const dayOfWeek = out.getUTCDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;
  out.setUTCDate(out.getUTCDate() - daysFromMonday);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/**
 * Mirror of the SQL helper's name format:
 *   `<parent>_<isoyear>_w<NN>`
 * where `isoyear` is ISO-week-numbering year (which can differ from the
 * Gregorian year for the last few days of December / first few of
 * January). The week number is 1-based, zero-padded to two digits.
 */
export function formatPartitionName(parentTable: string, weekStart: Date): string {
  const { isoYear, isoWeek } = isoWeekParts(weekStart);
  return `${parentTable}_${isoYear}_w${String(isoWeek).padStart(2, '0')}`;
}

function isoWeekParts(d: Date): { readonly isoYear: number; readonly isoWeek: number } {
  // Pure-JS reproduction of Postgres's `extract(isoyear ...)` and
  // `extract(week ...)`. The ISO week containing a given Thursday is
  // numbered with that Thursday's year, which is what makes ISO-week-
  // numbering year drift from the Gregorian year around new year.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayOfWeek = (tmp.getUTCDay() + 6) % 7; // 0 = Monday
  tmp.setUTCDate(tmp.getUTCDate() - dayOfWeek + 3); // shift to that week's Thursday
  const isoYear = tmp.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDay + 3);
  const isoWeek = Math.round((tmp.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY)) + 1;
  return { isoYear, isoWeek };
}

/**
 * Monthly partition rollover for the append-only audit tables.
 *
 * `order_events`, `order_status_history`, `notifications` and `audit_log` are
 * range-partitioned by month (see 0000_init.sql / 0005_order_status_history.sql).
 * The bootstrap migration pre-creates ~13-14 months of partitions, but
 * production needs an ongoing job to keep that runway intact. Without it, the
 * first INSERT past the bootstrap horizon fails — and because every
 * `OrderTransitionService.transition()` appends to `order_events` +
 * `order_status_history` inside the status-change transaction, that failure
 * halts the ENTIRE order lifecycle. This job is the runtime caller for the
 * `dankdash_rollover_monthly_partitions()` SQL function, which had no caller
 * before (the time-bomb the audit surfaced).
 *
 * The work is a single idempotent call: the SQL function ensures the current
 * month plus a three-month look-ahead exist for all four tables, each create
 * guarded by `IF NOT EXISTS`. There is no archive/detach/drop here — that is
 * the weekly `driver_location_history` lifecycle's concern; retention for the
 * monthly audit tables is handled separately and is out of scope for keeping
 * the write path alive.
 *
 * The scheduler runs this daily (and on worker boot) so a missed run is
 * recovered the next day and every deploy re-asserts the horizon.
 */
import { type Logger } from '@dankdash/config';
import { type PartitionsRepository } from '@dankdash/db';

export interface MonthlyPartitionRolloverDeps {
  readonly partitions: PartitionsRepository;
  readonly logger: Logger;
  readonly clock: () => Date;
}

export interface MonthlyPartitionRolloverSummary {
  readonly durationMs: number;
}

export class MonthlyPartitionRolloverService {
  private readonly partitions: PartitionsRepository;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(deps: MonthlyPartitionRolloverDeps) {
    this.partitions = deps.partitions;
    this.logger = deps.logger.child({ job: 'monthly_partition_rollover' });
    this.clock = deps.clock;
  }

  async runOnce(): Promise<MonthlyPartitionRolloverSummary> {
    const startedAt = this.clock().getTime();
    this.logger.info({ horizon: this.clock().toISOString() }, 'monthly partition rollover started');

    await this.partitions.rolloverMonthlyPartitions();

    const durationMs = this.clock().getTime() - startedAt;
    this.logger.info({ durationMs }, 'monthly partition rollover completed');
    return { durationMs };
  }
}

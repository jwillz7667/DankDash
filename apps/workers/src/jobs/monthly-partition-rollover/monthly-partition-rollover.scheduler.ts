/**
 * Cron wrapper around MonthlyPartitionRolloverService.runOnce().
 *
 * Schedule: `15 2 * * *` in America/Chicago — daily at 02:15 Central.
 * Daily (not weekly) because this job keeps the write path for the order
 * lifecycle alive: every status change appends to the monthly-partitioned
 * order_events / order_status_history tables, so the horizon must never be
 * allowed to lapse. A daily tick with a three-month look-ahead means even a
 * multi-day worker outage cannot collapse the runway. 02:15 sits in the
 * low-traffic window, ahead of the 02:30 weekly partition-lifecycle job, so
 * the night's DDL ordering in the log stream is stable.
 *
 * `runOnInit: true` — UNLIKE the sibling schedulers (payouts, dispatch,
 * metrc, partition-management), which deliberately avoid it because their
 * work has real side-effects that must not double-fire on restart. This
 * job's work is pure, idempotent DDL: dankdash_rollover_monthly_partitions()
 * only CREATEs partitions that don't already exist. Re-asserting the horizon
 * on every worker boot is precisely the self-heal we want — if the runway
 * ever did lapse, the fix lands the moment the worker starts rather than
 * waiting for 02:15. There is no harm in running it twice.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import {
  type MonthlyPartitionRolloverDeps,
  MonthlyPartitionRolloverService,
} from './monthly-partition-rollover.service.js';

export const MONTHLY_PARTITION_ROLLOVER_CRON_EXPRESSION = '15 2 * * *';
export const MONTHLY_PARTITION_ROLLOVER_CRON_TIMEZONE = 'America/Chicago';

export function scheduleMonthlyPartitionRolloverJob(
  deps: MonthlyPartitionRolloverDeps,
): ScheduledTask {
  const service = new MonthlyPartitionRolloverService(deps);
  return schedule(
    MONTHLY_PARTITION_ROLLOVER_CRON_EXPRESSION,
    () => {
      void service.runOnce().catch((err: unknown) => {
        // runOnce performs a single idempotent SQL call; anything that
        // escapes is an infrastructure fault (lost DB connection) or a
        // programming bug. Log with context and let the next tick — or the
        // next worker boot, via runOnInit — retry. A skipped run is safe so
        // long as the bootstrap runway hasn't been exhausted, which the
        // daily cadence guarantees against.
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error(
          { err: message, event: 'monthly_partition_rollover.scheduler_failed' },
          'monthly partition rollover orchestration failed',
        );
      });
    },
    { timezone: MONTHLY_PARTITION_ROLLOVER_CRON_TIMEZONE, runOnInit: true },
  );
}

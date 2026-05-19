/**
 * Cron wrapper around PartitionLifecycleService.runOnce().
 *
 * Schedule: `30 2 * * 0` in America/Chicago — every Sunday at 02:30
 * Central. Picked because:
 *
 *   - Sunday 02:30 is the lowest-traffic window of the week per the
 *     dispatch dashboard. The job's heaviest step (DETACH PARTITION)
 *     briefly takes an AccessExclusiveLock on the parent table while
 *     Postgres flips its catalog entries; any consumer writing into
 *     `driver_location_history` during the lock waits, so we want
 *     traffic at its weekly minimum.
 *   - Cleanly past the daily 04:00 webhook-events cleanup and the
 *     03:00 payouts job — readers of the worker log stream see a
 *     consistent ordering per night.
 *
 * `runOnInit` is intentionally not set: a restart Tuesday afternoon
 * should not retroactively fire Sunday's cron — there's nothing
 * urgent enough about partition lifecycle to justify the surprise
 * blocking DDL outside the chosen window.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import {
  type PartitionLifecycleDeps,
  PartitionLifecycleService,
} from './partition-management.service.js';

export const PARTITION_MANAGEMENT_CRON_EXPRESSION = '30 2 * * 0';
export const PARTITION_MANAGEMENT_CRON_TIMEZONE = 'America/Chicago';

export function schedulePartitionManagementJob(deps: PartitionLifecycleDeps): ScheduledTask {
  const service = new PartitionLifecycleService(deps);
  return schedule(
    PARTITION_MANAGEMENT_CRON_EXPRESSION,
    () => {
      void service.runOnce().catch((err: unknown) => {
        // Same posture as the other schedulers: the runOnce method
        // already swallows per-partition errors and logs them with
        // context. Anything that escapes here is a programming bug
        // (e.g. listWeekPartitions itself threw a TypeError); record
        // and let the next tick try again. A skipped week is at most
        // a 7-day retention delay, never data loss.
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error(
          { err: message, event: 'partition_management.scheduler_failed' },
          'partition management orchestration failed',
        );
      });
    },
    { timezone: PARTITION_MANAGEMENT_CRON_TIMEZONE },
  );
}

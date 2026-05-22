/**
 * Cron wrapper around `runMetrcReconciliationJob`.
 *
 * Schedule: `0 4 * * *` in America/Chicago — 04:00 Central, every day.
 * One hour after the existing webhook-events cleanup (also 04:00) so
 * ops can read the night's worker log as a clear sequence: payouts at
 * 03:00 → webhook cleanup + reconciliation at 04:00. Both nightly
 * jobs are bounded and short — they don't materially contend.
 *
 * `runOnInit` is intentionally omitted so a worker restart at noon
 * does not retroactively fire the morning reconciliation. The next
 * tick is at most 24 hours away; missing one run only widens any
 * discrepancy window by a day, never causes data loss.
 *
 * Errors at the orchestration layer (the dispensaries.listActive
 * query itself, the listReportedSince scan) are logged and swallowed;
 * crashing the worker would just defer the outage and take the other
 * crons down with it. Per-dispensary errors are already handled
 * inside the job — they never propagate here.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import {
  runMetrcReconciliationJob,
  type MetrcReconciliationJobDeps,
} from './metrc-reconciliation.job.js';

export const METRC_RECONCILIATION_CRON_EXPRESSION = '0 4 * * *';
export const METRC_RECONCILIATION_CRON_TIMEZONE = 'America/Chicago';

export function scheduleMetrcReconciliationJob(deps: MetrcReconciliationJobDeps): ScheduledTask {
  return schedule(
    METRC_RECONCILIATION_CRON_EXPRESSION,
    () => {
      void runMetrcReconciliationJob({ now: new Date(), deps }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error(
          { err: message, event: 'metrc.reconcile.scheduler_failed' },
          'metrc reconciliation orchestration failed',
        );
      });
    },
    { timezone: METRC_RECONCILIATION_CRON_TIMEZONE },
  );
}

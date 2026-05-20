/**
 * Cron wrapper around `runMetrcReportingJob`.
 *
 * Schedule: `* /1 * * * *` — every minute (5-field cron). One minute is
 * the lower bound of the spec's retry ladder (1m / 5m / 15m / 1h / 6h /
 * 24h), so any finer granularity would just claim rows whose
 * `next_retry_at` has not yet elapsed and let them go back to sleep.
 *
 * `runOnInit` deliberately off — a worker restart should not double-
 * fire an immediate tick. The next tick is at most one minute away.
 *
 * Errors at the orchestration layer (the `claimDueForReporting` query
 * itself) are logged and swallowed. Crashing the worker would just
 * defer the outage, and the other crons in the same process would die
 * with it — keep the process alive.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { runMetrcReportingJob, type MetrcReportingJobDeps } from './metrc-reporting.job.js';

export const METRC_REPORTING_CRON_EXPRESSION = '*/1 * * * *';

export function scheduleMetrcReportingJob(deps: MetrcReportingJobDeps): ScheduledTask {
  return schedule(METRC_REPORTING_CRON_EXPRESSION, () => {
    void runMetrcReportingJob({ now: new Date(), deps }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'unknown error';
      deps.logger.error({ err: message }, 'metrc reporting job orchestration failed');
    });
  });
}

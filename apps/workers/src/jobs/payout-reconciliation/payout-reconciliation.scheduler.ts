/**
 * Cron wrapper around runPayoutReconciliationJob. Keeps the job pure — this
 * module is the only part that touches a real scheduler and holds no
 * business logic.
 *
 * Schedule: every 30 minutes. The job self-limits to rows
 * that have been `processing` for at least `stuckAfterMinutes` (default
 * 15m), so a 30-minute cadence means a webhook that fails to deliver is
 * caught within ~45 minutes worst case while keeping Aeropay read volume
 * low (one `getPayout` per genuinely-stuck row). `runOnInit` is
 * intentionally unset — a worker restart should not fire an off-schedule
 * reconciliation pass.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { runWithCronSpan, type CronMetrics } from '../../instrumentation/cron-spans.js';
import {
  runPayoutReconciliationJob,
  type PayoutReconciliationJobDeps,
} from './payout-reconciliation.job.js';

export const PAYOUT_RECONCILIATION_CRON_EXPRESSION = '*/30 * * * *';
export const PAYOUT_RECONCILIATION_CRON_TIMEZONE = 'America/Chicago';

export interface SchedulePayoutReconciliationJobOptions {
  /**
   * Optional cron metrics. When provided, every invocation is wrapped in
   * an OTel span + duration histogram + outcome counter. Production
   * callers always pass this; tests opt out.
   */
  readonly cronMetrics?: CronMetrics;
}

export function schedulePayoutReconciliationJob(
  deps: PayoutReconciliationJobDeps,
  options: SchedulePayoutReconciliationJobOptions = {},
): ScheduledTask {
  return schedule(
    PAYOUT_RECONCILIATION_CRON_EXPRESSION,
    () => {
      const run = (): Promise<unknown> => runPayoutReconciliationJob({ now: new Date(), deps });
      const wrapped: Promise<unknown> =
        options.cronMetrics === undefined
          ? run()
          : runWithCronSpan({ name: 'payout-reconciliation', metrics: options.cronMetrics }, run);
      void wrapped.catch((err: unknown) => {
        // runPayoutReconciliationJob isolates per-row failures — landing
        // here means the orchestration itself (the list query) blew up.
        // Log and let the next tick retry rather than crash the worker.
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error({ err: message }, 'payout reconciliation orchestration failed');
      });
    },
    { timezone: PAYOUT_RECONCILIATION_CRON_TIMEZONE },
  );
}

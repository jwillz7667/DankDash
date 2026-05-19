/**
 * Cron wrapper around runWebhookEventsCleanupJob.
 *
 * Schedule: `0 4 * * *` in America/Chicago — 04:00 Central, every day.
 * Picked to run one hour after the payouts cron (03:00) so the two
 * jobs don't contend for the same db window and ops can read the log
 * stream as a clear sequence: payouts → webhook cleanup. Both jobs are
 * idempotent and short, so the ordering is more about log ergonomics
 * than correctness.
 *
 * As with the payouts scheduler, `runOnInit` is intentionally not set —
 * a worker restart at noon should not retroactively fire the morning
 * cleanup.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { runWebhookEventsCleanupJob, type WebhookEventsCleanupJobDeps } from './cleanup.job.js';

export const WEBHOOK_EVENTS_CLEANUP_CRON_EXPRESSION = '0 4 * * *';
export const WEBHOOK_EVENTS_CLEANUP_CRON_TIMEZONE = 'America/Chicago';

export function scheduleWebhookEventsCleanupJob(deps: WebhookEventsCleanupJobDeps): ScheduledTask {
  return schedule(
    WEBHOOK_EVENTS_CLEANUP_CRON_EXPRESSION,
    () => {
      void runWebhookEventsCleanupJob({ now: new Date(), deps }).catch((err: unknown) => {
        // Same orchestration-failure stance as the payouts scheduler: log
        // and let the next tick retry. The job's only side effect is a
        // bounded DELETE, so a missed run just means slightly slower
        // table growth — never a correctness problem.
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error({ err: message }, 'webhook events cleanup orchestration failed');
      });
    },
    { timezone: WEBHOOK_EVENTS_CLEANUP_CRON_TIMEZONE },
  );
}

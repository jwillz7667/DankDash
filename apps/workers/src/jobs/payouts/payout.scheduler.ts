/**
 * Cron wrapper around runPayoutJob. Lives in its own file so the job
 * itself stays pure and testable — this module is the only part that
 * touches a real scheduler, and it has no business logic.
 *
 * Schedule: `0 3 * * *` in America/Chicago — 03:00 Central, every day.
 * Picked because:
 *   - Customer ordering hours close at 02:00 Central; one hour of slack
 *     lets in-flight authorizations / webhooks settle before we sum the
 *     ledger for the previous day.
 *   - 03:00 is in the lowest-traffic window for both the API and the
 *     Aeropay sandbox, minimizing contention with anything else.
 *
 * node-cron's `runOnInit` is intentionally *not* set — we don't want a
 * worker restart at 09:00 to retroactively fire the 03:00 trigger.
 * Idempotency in the job protects against double-fires, but accidental
 * extra runs still cost Aeropay API calls and ops noise.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { type PayoutJobDeps, runPayoutJob } from './payout.job.js';

export const PAYOUT_CRON_EXPRESSION = '0 3 * * *';
export const PAYOUT_CRON_TIMEZONE = 'America/Chicago';

export function schedulePayoutJob(deps: PayoutJobDeps): ScheduledTask {
  return schedule(
    PAYOUT_CRON_EXPRESSION,
    () => {
      void runPayoutJob({ now: new Date(), deps }).catch((err: unknown) => {
        // runPayoutJob never throws on a single recipient — it logs and
        // moves on. If we land here something at the orchestration level
        // (ledger query, dispensary list) blew up; log and let the next
        // tick retry. Crashing the worker process would just defer the
        // outage; this keeps other workers (Metrc, notifications) alive.
        const message = err instanceof Error ? err.message : 'unknown error';
        deps.logger.error({ err: message }, 'payout job orchestration failed');
      });
    },
    { timezone: PAYOUT_CRON_TIMEZONE },
  );
}

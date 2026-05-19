/**
 * Cron wrapper around runOfferExpiryJob.
 *
 * Schedule: `*\/10 * * * * *` — every 10 seconds. Coarser than the
 * dispatch tick because:
 *
 *   - Dispatch correctness does NOT depend on offers being marked
 *     expired in the DB (the orchestrator checks `expiresAt > now`
 *     against the wall clock).
 *
 *   - The driver app's "active offers" query is the only consumer that
 *     wants the expire flip to be timely, and 10 seconds of staleness
 *     on a 30-second offer is acceptable UX latency for "this offer
 *     just expired."
 *
 * Splitting expiry from the dispatch tick keeps each job's per-tick DB
 * work small (each shows up distinctly in the slow-query log) and
 * means a hung dispatch tick does not block expiry — drivers will
 * stop seeing expired offers in their app even when something is
 * wrong with the dispatch path.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { runOfferExpiryJob, type OfferExpiryJobDeps } from './offer-expiry.job.js';

export const OFFER_EXPIRY_CRON_EXPRESSION = '*/10 * * * * *';

export function scheduleOfferExpiryJob(deps: OfferExpiryJobDeps): ScheduledTask {
  return schedule(OFFER_EXPIRY_CRON_EXPRESSION, () => {
    void runOfferExpiryJob({ now: new Date(), deps }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'unknown error';
      deps.logger.error({ err: message }, 'dispatch offer expiry orchestration failed');
    });
  });
}

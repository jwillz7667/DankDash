/**
 * Bulk-expire stale dispatch offers.
 *
 * The dispatch tick (dispatch.job.ts) already treats an offer with
 * `expires_at <= now` as inactive — the orchestrator's `findLiveOffer`
 * filters on the wall clock, so dispatch correctness does NOT depend
 * on this job ever running. So why does it exist?
 *
 *   - The driver app lists "my active offers" by querying
 *     `dispatch_offers WHERE status = 'offered' AND expires_at > now`.
 *     That query benefits from the partial index
 *     `dispatch_offers_active_idx`, which only covers rows where
 *     `status = 'offered'`. Once status flips to 'expired' the row
 *     drops out of the index — small, but the table grows monotonically
 *     while drivers come and go; the partial index stays tight.
 *
 *   - The `dispatchOffers.listForOrder` history fed into the
 *     orchestrator becomes more correct when stale 'offered' rows are
 *     flipped to 'expired' explicitly. The orchestrator handles both
 *     forms but the audit trail is easier to read when the DB and the
 *     clock agree.
 *
 * The DB-level mutation is a single `UPDATE … RETURNING id` scoped by
 * the partial index — sub-millisecond at our expected row counts.
 */
import { type Logger } from '@dankdash/config';
import { type DispatchOffersRepository } from '@dankdash/db';

export interface OfferExpiryJobDeps {
  readonly dispatchOffers: DispatchOffersRepository;
  readonly logger: Logger;
}

export interface OfferExpiryJobInput {
  readonly now: Date;
  readonly deps: OfferExpiryJobDeps;
}

export interface OfferExpiryJobSummary {
  readonly expired: number;
}

export async function runOfferExpiryJob(
  input: OfferExpiryJobInput,
): Promise<OfferExpiryJobSummary> {
  const { now, deps } = input;
  const expired = await deps.dispatchOffers.expireStale(now);
  if (expired > 0) {
    // Quiet on no-ops — this fires every 10s and would otherwise
    // dominate the log stream when no offers are in flight.
    deps.logger.info({ expired, horizon: now.toISOString() }, 'dispatch: expired stale offers');
  }
  return { expired };
}

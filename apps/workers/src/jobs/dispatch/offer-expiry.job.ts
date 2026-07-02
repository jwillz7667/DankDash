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
import { type DispatchOffersRepository, type ExpiredOffer } from '@dankdash/db';
import { type PublishRealtimeEventInput } from '@dankdash/realtime-events';
import { uuidv7 } from 'uuidv7';

export interface OfferExpiryJobDeps {
  readonly dispatchOffers: DispatchOffersRepository;
  readonly logger: Logger;
  /**
   * Publishes one `offer:expired` realtime envelope per expired offer so
   * the targeted driver's app dismisses the offer sheet immediately rather
   * than waiting out its next 10s poll. Wraps `publishRealtimeEvent(redis,
   * …)` at the composition root (the job stays Redis-free for tests).
   * Optional: when omitted the DB flip still happens, no events are emitted
   * — the driver app then falls back to its poll.
   */
  readonly publish?: (input: PublishRealtimeEventInput) => Promise<string>;
  /** Test seam — defaults to uuidv7 in production wiring. */
  readonly idGen?: () => string;
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
  if (expired.length > 0) {
    // Quiet on no-ops — this fires every 10s and would otherwise
    // dominate the log stream when no offers are in flight.
    deps.logger.info(
      { expired: expired.length, horizon: now.toISOString() },
      'dispatch: expired stale offers',
    );
    await publishExpirations(expired, now, deps);
  }
  return { expired: expired.length };
}

/**
 * Fan an `offer:expired` envelope to each driver whose offer just timed out.
 * Sequential — the row set is bounded by the offers created in one 10s
 * window, and a single XADD failure must not skip the remaining drivers, so
 * each publish is isolated behind its own try/catch (a lost push degrades to
 * the driver app's poll fallback, never to a thrown tick).
 */
async function publishExpirations(
  rows: readonly ExpiredOffer[],
  now: Date,
  deps: OfferExpiryJobDeps,
): Promise<void> {
  const publish = deps.publish;
  if (publish === undefined) return;
  const idGen = deps.idGen ?? uuidv7;
  const expiredAt = now.toISOString();

  for (const row of rows) {
    try {
      await publish({
        id: idGen(),
        emittedAt: expiredAt,
        source: 'workers',
        event: {
          type: 'offer:expired',
          payload: {
            offerId: row.id,
            orderId: row.orderId,
            driverId: row.driverId,
            expiredAt,
          },
        },
      });
    } catch (err) {
      deps.logger.warn(
        {
          event: 'offer_expiry.publish_failed',
          offerId: row.id,
          orderId: row.orderId,
          err: err instanceof Error ? err.message : String(err),
        },
        'dispatch: offer:expired publish failed — driver app falls back to poll',
      );
    }
  }
}

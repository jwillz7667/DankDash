/**
 * Payout-lifecycle webhook side effects — the terminal half of the payout
 * flow whose dispatch half lives in the nightly job
 * (`apps/workers/src/jobs/payouts/payout.job.ts`).
 *
 * The job creates a `payouts` row, calls `aeropay.createPayout`, and flips
 * the row to `processing` stamped with the upstream payout id in
 * `aeropay_payout_ref`. Settlement is asynchronous (ACH is T+1..T+3), so
 * Aeropay reports the outcome out-of-band:
 *
 *   - `payout.paid`   → the row moves `processing` → `completed`, stamping
 *                        `completed_at` with the event time.
 *   - `payout.failed` → the row moves `processing` → `failed`, recording
 *                        the upstream failure reason.
 *
 * Row lookup keys on `aeropay_payout_ref` (the upstream payout id), which
 * is exactly `data.object.id` on the webhook — a single indexed lookup.
 *
 * Idempotency + ordering: webhooks retry, and Aeropay can deliver out of
 * order. Both handlers only advance a row that is still `processing`;
 * re-receiving the same terminal event is a no-op, and a late/contradictory
 * event (e.g. `paid` after we already recorded `failed`) is logged and
 * dropped rather than allowed to clobber a terminal state. An unknown ref
 * (payout from another environment, or a replay after a purge) is a benign
 * no-op — surfacing an error would only trigger Aeropay's retry storm.
 *
 * This service performs no ledger writes: the settlement ledger already
 * credited the dispensary at `payment.settled` time (Phase 6.4). The payout
 * simply moves funds Aeropay already holds; reconciling the payout leg
 * against the ledger is a separate reporting concern, not a state change
 * here.
 */
import { type Payout, type PayoutsRepository } from '@dankdash/db';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PayoutWebhookService {
  private readonly logger = new Logger(PayoutWebhookService.name);

  constructor(private readonly payouts: PayoutsRepository) {}

  async applyPaid(aeropayPayoutRef: string, occurredAt: Date): Promise<void> {
    const payout = await this.payouts.findByAeropayPayoutRef(aeropayPayoutRef);
    if (payout === null) {
      this.logger.warn(`payout.paid for unknown aeropay_payout_ref=${aeropayPayoutRef} — ignoring`);
      return;
    }
    if (payout.status === 'completed') return; // replay
    if (payout.status !== 'processing') {
      this.logUnexpected('payout.paid', payout);
      return;
    }
    await this.payouts.updateStatus(payout.id, 'completed', { completedAt: occurredAt });
  }

  async applyFailed(
    aeropayPayoutRef: string,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const payout = await this.payouts.findByAeropayPayoutRef(aeropayPayoutRef);
    if (payout === null) {
      this.logger.warn(
        `payout.failed for unknown aeropay_payout_ref=${aeropayPayoutRef} — ignoring`,
      );
      return;
    }
    if (payout.status === 'failed') return; // replay
    if (payout.status !== 'processing') {
      this.logUnexpected('payout.failed', payout);
      return;
    }
    await this.payouts.updateStatus(payout.id, 'failed', {
      failureReason: extractFailureReason(raw),
    });
  }

  private logUnexpected(event: string, payout: Payout): void {
    // Out-of-order or contradictory delivery — never regress a terminal
    // row. Log with enough context for ops to reconcile manually.
    this.logger.warn(
      `${event} for payout ${payout.id} in status '${payout.status}' — ignoring to preserve terminal state`,
    );
  }
}

/**
 * Pull the upstream failure reason out of the verified webhook envelope.
 * Aeropay nests it at `data.object.failure_reason`; absent for opaque
 * declines, in which case we record a stable fallback so the `payouts`
 * row always carries a non-null reason for ops.
 */
function extractFailureReason(raw: Readonly<Record<string, unknown>>): string {
  const data = raw['data'];
  if (data === null || typeof data !== 'object') return 'aeropay_payout_failed';
  const object = (data as Record<string, unknown>)['object'];
  if (object === null || typeof object !== 'object') return 'aeropay_payout_failed';
  const reason = (object as Record<string, unknown>)['failure_reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : 'aeropay_payout_failed';
}

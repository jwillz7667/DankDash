/**
 * Settlement-reconciliation worker — PR #9.
 *
 * The payout lifecycle normally completes via Aeropay webhooks: dispatch
 * flips a `payouts` row to `processing` (stamping `aeropay_payout_ref` +
 * `initiated_at`), then `payout.paid` / `payout.failed` moves it to
 * `completed` / `failed`. A missed or undelivered webhook strands the row
 * in `processing` forever — the dispensary/driver never sees the money
 * settle and the books never close.
 *
 * This cron closes that gap. On each tick it:
 *
 *   1. Lists `payouts` rows stuck in `processing` since before
 *      `stuckAfterMinutes` ago (default 15m — long enough that a
 *      still-in-flight webhook isn't raced).
 *   2. Fetches each payout's authoritative state from Aeropay
 *      (`getPayout`).
 *   3. Applies the terminal transition through the *same* idempotency rule
 *      the webhook uses (`resolvePayoutTerminalTransition`), so a webhook
 *      that arrives late — after reconciliation already settled the row —
 *      is a no-op rather than a clobber, and vice-versa.
 *
 * Terminal mapping (Aeropay payout status → `payouts.status`):
 *   - `paid`                 → completed
 *   - `failed`               → failed  (reason `reconciliation_failed`)
 *   - `pending` / `in_transit` → still moving; leave for a later tick
 *   - 404 (Aeropay has no such payout) → if the row has been processing
 *     longer than `orphanAfterHours` (default 24h), mark it failed with
 *     reason `reconciliation_orphan` and log loudly; otherwise leave it
 *     (Aeropay read-after-write lag).
 *
 * Per-row failures (transient Aeropay 5xx, an update that lost a race) are
 * caught, counted, and logged — one bad payout never aborts the run.
 *
 * The job is a single pure async function. The scheduler builds deps once
 * and calls `runPayoutReconciliationJob({ now: new Date(), deps })` per
 * tick; tests pass a fake Aeropay client + repo and a fixed clock.
 */
import { type AeropayClient } from '@dankdash/aeropay';
import { type Logger } from '@dankdash/config';
import { resolvePayoutTerminalTransition, type Payout, type PayoutsRepository } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';

/**
 * Grace period before a `processing` payout is eligible for
 * reconciliation. Shields against racing a webhook that is still in
 * Aeropay's delivery queue — under normal operation the terminal webhook
 * lands within seconds, so 15m of slack means we only touch rows a webhook
 * genuinely failed to deliver for.
 */
export const DEFAULT_STUCK_AFTER_MINUTES = 15;

/**
 * How long a `processing` payout that Aeropay does not recognize (404)
 * must persist before we declare it an orphan and fail it. Absorbs
 * Aeropay's read-after-write lag on a freshly-created payout while still
 * bounding how long a genuinely-lost payout stays stuck. Failing an orphan
 * frees the recipient's earnings for the next payout run / instant cashout
 * (a `failed` payout is excluded from `sumOutstandingFor`).
 */
export const DEFAULT_ORPHAN_AFTER_HOURS = 24;

/**
 * Max rows reconciled per tick. Bounds the number of Aeropay reads a
 * single run makes; a backlog larger than this is drained over successive
 * ticks (oldest-first — see `listStuckProcessing`).
 */
export const DEFAULT_BATCH_LIMIT = 200;

export interface PayoutReconciliationJobDeps {
  readonly payouts: Pick<PayoutsRepository, 'listStuckProcessing' | 'findById' | 'updateStatus'>;
  readonly aeropay: Pick<AeropayClient, 'getPayout'>;
  readonly logger: Logger;
  /** Override the 15-minute stuck threshold. Production leaves this default. */
  readonly stuckAfterMinutes?: number;
  /** Override the 24-hour orphan threshold. */
  readonly orphanAfterHours?: number;
  /** Override the per-tick batch limit. */
  readonly batchLimit?: number;
}

export interface PayoutReconciliationJobInput {
  readonly now: Date;
  readonly deps: PayoutReconciliationJobDeps;
}

export interface PayoutReconciliationJobSummary {
  /** Rows examined this tick. */
  readonly scanned: number;
  /** Rows moved processing → completed. */
  readonly completed: number;
  /** Rows moved processing → failed (upstream `failed`). */
  readonly failed: number;
  /** Rows failed as `reconciliation_orphan` (Aeropay 404, past orphan age). */
  readonly orphaned: number;
  /** Rows Aeropay still reports pending / in_transit — left for a later tick. */
  readonly stillPending: number;
  /** Processing rows with a null `aeropay_payout_ref` — a dispatch anomaly, skipped. */
  readonly skippedNoRef: number;
  /** Rows whose reconciliation threw (transient Aeropay error, lost update race). */
  readonly errors: number;
}

type ReconcileOutcome = 'completed' | 'failed' | 'orphaned' | 'stillPending';

export async function runPayoutReconciliationJob(
  input: PayoutReconciliationJobInput,
): Promise<PayoutReconciliationJobSummary> {
  const { now, deps } = input;
  const stuckAfterMinutes = deps.stuckAfterMinutes ?? DEFAULT_STUCK_AFTER_MINUTES;
  const orphanAfterHours = deps.orphanAfterHours ?? DEFAULT_ORPHAN_AFTER_HOURS;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const log = deps.logger.child({ job: 'payout-reconciliation' });

  if (!Number.isFinite(stuckAfterMinutes) || stuckAfterMinutes < 0) {
    throw new RangeError(
      `stuckAfterMinutes must be a non-negative number, got ${String(stuckAfterMinutes)}`,
    );
  }
  if (!Number.isFinite(orphanAfterHours) || orphanAfterHours < 0) {
    throw new RangeError(
      `orphanAfterHours must be a non-negative number, got ${String(orphanAfterHours)}`,
    );
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1) {
    throw new RangeError(`batchLimit must be a positive integer, got ${String(batchLimit)}`);
  }

  const stuckBefore = new Date(now.getTime() - stuckAfterMinutes * 60_000);
  const orphanBefore = new Date(now.getTime() - orphanAfterHours * 60 * 60_000);

  const rows = await deps.payouts.listStuckProcessing(stuckBefore, batchLimit);

  let scanned = 0;
  let completed = 0;
  let failed = 0;
  let orphaned = 0;
  let stillPending = 0;
  let skippedNoRef = 0;
  let errors = 0;

  for (const payout of rows) {
    scanned += 1;

    if (payout.aeropayPayoutRef === null) {
      // A `processing` row without an upstream ref means dispatch flipped
      // the status but never stamped the ref — a data-integrity anomaly we
      // cannot poll our way out of. Log loudly for manual reconciliation.
      skippedNoRef += 1;
      log.error(
        { event: 'payout.reconcile.missing_ref', payoutId: payout.id },
        'processing payout has no aeropay_payout_ref — cannot reconcile',
      );
      continue;
    }

    try {
      const outcome = await reconcileOne(deps, payout, now, orphanBefore, log);
      switch (outcome) {
        case 'completed':
          completed += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'orphaned':
          orphaned += 1;
          break;
        case 'stillPending':
          stillPending += 1;
          break;
      }
    } catch (err) {
      errors += 1;
      log.error(
        {
          event: 'payout.reconcile.row_failed',
          payoutId: payout.id,
          aeropayPayoutRef: payout.aeropayPayoutRef,
          err: err instanceof Error ? err.message : String(err),
        },
        'payout reconciliation failed for row',
      );
    }
  }

  const summary: PayoutReconciliationJobSummary = {
    scanned,
    completed,
    failed,
    orphaned,
    stillPending,
    skippedNoRef,
    errors,
  };
  log.info({ summary }, 'payout reconciliation tick complete');
  return summary;
}

async function reconcileOne(
  deps: PayoutReconciliationJobDeps,
  payout: Payout,
  now: Date,
  orphanBefore: Date,
  log: Logger,
): Promise<ReconcileOutcome> {
  const aeropayPayoutRef = payout.aeropayPayoutRef;
  if (aeropayPayoutRef === null) {
    // Guarded by the caller; keeps the type non-null for getPayout.
    throw new TypeError(`reconcileOne called for payout ${payout.id} without an aeropay ref`);
  }

  let upstreamStatus: string;
  try {
    const upstream = await deps.aeropay.getPayout(aeropayPayoutRef);
    upstreamStatus = upstream.status;
  } catch (err) {
    if (err instanceof PaymentError && err.statusCode === 404) {
      // Aeropay has no record of this payout. Fresh dispatches can 404
      // briefly (read-after-write lag); only rows past the orphan age are
      // declared lost.
      const initiatedAt = payout.initiatedAt;
      if (initiatedAt !== null && initiatedAt <= orphanBefore) {
        const applied = await applyTerminal(deps, payout, 'failed', now, 'reconciliation_orphan');
        if (applied) {
          log.error(
            {
              event: 'payout.reconcile.orphan',
              payoutId: payout.id,
              aeropayPayoutRef,
              initiatedAt: initiatedAt.toISOString(),
            },
            'payout is unknown to Aeropay past the orphan threshold — marked failed',
          );
          return 'orphaned';
        }
        // A concurrent webhook already settled it — nothing to orphan.
        return 'stillPending';
      }
      log.warn(
        {
          event: 'payout.reconcile.not_found_young',
          payoutId: payout.id,
          aeropayPayoutRef,
        },
        'payout not found upstream but within orphan grace — leaving for a later tick',
      );
      return 'stillPending';
    }
    throw err;
  }

  if (upstreamStatus === 'paid') {
    const applied = await applyTerminal(deps, payout, 'completed', now);
    if (applied) {
      log.info(
        { event: 'payout.reconcile.completed', payoutId: payout.id, aeropayPayoutRef },
        'payout reconciled to completed from Aeropay state',
      );
      return 'completed';
    }
    return 'stillPending';
  }

  if (upstreamStatus === 'failed') {
    const applied = await applyTerminal(deps, payout, 'failed', now, 'reconciliation_failed');
    if (applied) {
      log.warn(
        { event: 'payout.reconcile.failed', payoutId: payout.id, aeropayPayoutRef },
        'payout reconciled to failed from Aeropay state',
      );
      return 'failed';
    }
    return 'stillPending';
  }

  // pending / in_transit — Aeropay is still moving the money. Revisit next tick.
  return 'stillPending';
}

/**
 * Apply a terminal transition using the shared idempotency rule. Re-reads
 * the row so a webhook that settled it between the list query and now is
 * respected (never regress a terminal state). Returns whether an UPDATE was
 * performed.
 */
async function applyTerminal(
  deps: PayoutReconciliationJobDeps,
  payout: Payout,
  target: 'completed' | 'failed',
  now: Date,
  failureReason?: string,
): Promise<boolean> {
  const current = await deps.payouts.findById(payout.id);
  if (current === null) return false;
  const resolution = resolvePayoutTerminalTransition(current.status, target);
  if (resolution.kind !== 'apply') return false;

  if (target === 'completed') {
    await deps.payouts.updateStatus(payout.id, 'completed', { completedAt: now });
  } else {
    await deps.payouts.updateStatus(payout.id, 'failed', {
      failureReason: failureReason ?? 'reconciliation_failed',
    });
  }
  return true;
}

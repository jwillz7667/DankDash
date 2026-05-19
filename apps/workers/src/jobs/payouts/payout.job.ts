/**
 * Daily payout job — Phase 6.6.
 *
 * Scheduled at 03:00 America/Chicago (see payout.scheduler.ts). Walks the
 * previous Central calendar day's ledger, computes per-recipient net
 * earnings, and issues an Aeropay payout for each dispensary that has a
 * bank account on file. Driver payouts are recorded in the same shape
 * but Aeropay dispatch waits until the driver-bank-onboarding work in
 * Phase 8 lands the column.
 *
 * Why drive the math from the ledger and not from orders:
 *   - Ledger entries are written *only* on payment.settled, so they
 *     already exclude initiated / authorized / failed transactions.
 *   - The dispensary share is whatever Phase 6.4's settlement logic
 *     credited — including the discount-aware fix; the payout job
 *     doesn't need to re-derive splits.
 *   - Refunds that finalized in the same window debit `refund_reserve`
 *     (not the dispensary leg directly). Summing the dispensary credits
 *     gives the gross we owe before refund drawdown; the refund_reserve
 *     window debits represent the drawdown. Net payable = gross − reserve
 *     drawdown for that window.
 *
 * Idempotency — three layers:
 *   1. payouts UNIQUE (recipient_type, recipient_id, period_start, period_end)
 *      means a re-run for the same Central day cannot duplicate rows;
 *      PayoutsRepository.createIfAbsent surfaces "already existed".
 *   2. AeropayClient.createPayout takes an idempotencyKey we set to
 *      `payout:<payouts.id>`. Even if we crash between insert and
 *      upstream call and the next run re-attempts, Aeropay coalesces.
 *   3. We skip recipients with netCents <= 0 entirely — a fully-refunded
 *      day produces no row.
 *
 * Failure handling:
 *   - Aeropay 5xx / network → mark the row `failed` with the error
 *     message, keep going (one bad recipient must not block the rest).
 *   - Aeropay 2xx → mark `processing` with `aeropayPayoutRef` and
 *     `initiatedAt`; payout.paid / payout.failed webhooks (Phase 6.7)
 *     flip to `completed` / `failed`.
 *
 * The job is a single pure async function. The cron scheduler builds the
 * deps once, then calls runPayoutJob({ now: new Date(), deps }) on each
 * tick. Tests construct deps with in-memory fakes and a fixed clock.
 */
import { type AeropayClient, type AeropayPayout } from '@dankdash/aeropay';
import { type Logger } from '@dankdash/config';
import {
  type DispensariesRepository,
  type LedgerEntriesRepository,
  type Payout,
  type PayoutsRepository,
} from '@dankdash/db';
import { computePayoutPeriod, type PayoutPeriod } from './payout.period.js';

export interface PayoutJobDeps {
  readonly dispensaries: DispensariesRepository;
  readonly payouts: PayoutsRepository;
  readonly ledger: LedgerEntriesRepository;
  readonly aeropay: Pick<AeropayClient, 'createPayout'>;
  readonly logger: Logger;
}

export interface PayoutJobInput {
  readonly now: Date;
  readonly deps: PayoutJobDeps;
}

export interface PayoutJobSummary {
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly dispensariesProcessed: number;
  readonly dispensariesSkippedNoEarnings: number;
  readonly dispensariesSkippedNoBank: number;
  readonly dispensariesAlreadyPaid: number;
  readonly dispensariesDispatched: number;
  readonly dispensariesFailed: number;
  readonly driversProcessed: number;
  readonly driversSkippedNoEarnings: number;
  readonly driversPendingBank: number;
  readonly driversAlreadyPaid: number;
}

export async function runPayoutJob(input: PayoutJobInput): Promise<PayoutJobSummary> {
  const period = computePayoutPeriod(input.now);
  const log = input.deps.logger.child({
    job: 'payout',
    periodStart: period.periodStartDateStr,
    periodEnd: period.periodEndDateStr,
  });
  log.info('payout job started');

  const dispensarySummary = await runDispensaryPayouts(input.deps, period, log);
  const driverSummary = await runDriverPayouts(input.deps, period, log);

  const summary: PayoutJobSummary = {
    periodStartDate: period.periodStartDateStr,
    periodEndDate: period.periodEndDateStr,
    ...dispensarySummary,
    ...driverSummary,
  };
  log.info({ summary }, 'payout job completed');
  return summary;
}

interface DispensarySummary {
  readonly dispensariesProcessed: number;
  readonly dispensariesSkippedNoEarnings: number;
  readonly dispensariesSkippedNoBank: number;
  readonly dispensariesAlreadyPaid: number;
  readonly dispensariesDispatched: number;
  readonly dispensariesFailed: number;
}

async function runDispensaryPayouts(
  deps: PayoutJobDeps,
  period: PayoutPeriod,
  log: Logger,
): Promise<DispensarySummary> {
  // Pull gross dispensary credits in the window, then net out refund_reserve
  // drawdowns scoped to the same dispensary. Two separate queries — one
  // group-by per accountType — keeps the SQL simple and lets each set live
  // on its own index. The merge in code is O(n) on the smaller of the two.
  const [grossRows, drawdownRows] = await Promise.all([
    deps.ledger.netByAccountRefInWindow('dispensary', period.periodStartUtc, period.periodEndUtc),
    deps.ledger.netByAccountRefInWindow(
      'refund_reserve',
      period.periodStartUtc,
      period.periodEndUtc,
    ),
  ]);

  // refund_reserve net is (debits − credits): refunds DR the reserve so a
  // positive value here means "$X owed back to customers in this window."
  // Dispensary gross was credited (CR), so for that accountType the
  // repo's `credits − debits` arithmetic is the right sign already.
  const drawdownByDispensary = new Map<string, number>(
    drawdownRows.map((row) => [row.accountRef, -row.netCents]),
  );

  let processed = 0;
  let skippedNoEarnings = 0;
  let skippedNoBank = 0;
  let alreadyPaid = 0;
  let dispatched = 0;
  let failed = 0;

  for (const row of grossRows) {
    const drawdown = drawdownByDispensary.get(row.accountRef) ?? 0;
    const netCents = row.netCents - drawdown;
    if (netCents <= 0) {
      skippedNoEarnings += 1;
      log.info(
        { dispensaryId: row.accountRef, grossCents: row.netCents, drawdownCents: drawdown },
        'dispensary payout skipped — net non-positive',
      );
      continue;
    }
    processed += 1;

    const dispensary = await deps.dispensaries.findById(row.accountRef);
    if (dispensary === null) {
      // A ledger entry exists for a dispensaryId with no matching row.
      // Treat as a hard data-integrity problem; record a failed payout so
      // ops can see it but keep going.
      failed += 1;
      const placeholder = await deps.payouts.createIfAbsent({
        recipientType: 'dispensary',
        recipientId: row.accountRef,
        periodStart: period.periodStartDateStr,
        periodEnd: period.periodEndDateStr,
        grossCents: row.netCents,
        feesCents: 0,
        netCents,
        status: 'failed',
        scheduledFor: period.periodEndDateStr,
        failureReason: 'dispensary row not found',
      });
      log.error(
        { dispensaryId: row.accountRef, payoutId: placeholder.payout.id },
        'dispensary not found for payout',
      );
      continue;
    }

    const { payout, created } = await deps.payouts.createIfAbsent({
      recipientType: 'dispensary',
      recipientId: dispensary.id,
      periodStart: period.periodStartDateStr,
      periodEnd: period.periodEndDateStr,
      grossCents: row.netCents,
      feesCents: 0,
      netCents,
      status: 'pending',
      scheduledFor: period.periodEndDateStr,
    });

    if (!created) {
      alreadyPaid += 1;
      log.info(
        { dispensaryId: dispensary.id, payoutId: payout.id, status: payout.status },
        'dispensary payout already exists — skipping dispatch',
      );
      continue;
    }

    if (dispensary.aeropayAccountRef === null) {
      skippedNoBank += 1;
      await deps.payouts.updateStatus(payout.id, 'failed', {
        failureReason: 'dispensary_bank_account_not_linked',
      });
      log.warn(
        { dispensaryId: dispensary.id, payoutId: payout.id },
        'dispensary payout failed — no Aeropay account on file',
      );
      continue;
    }

    const dispatchOutcome = await dispatchPayout(
      deps,
      payout,
      period,
      dispensary.aeropayAccountRef,
    );
    if (dispatchOutcome === 'ok') {
      dispatched += 1;
    } else {
      failed += 1;
    }
  }

  return {
    dispensariesProcessed: processed,
    dispensariesSkippedNoEarnings: skippedNoEarnings,
    dispensariesSkippedNoBank: skippedNoBank,
    dispensariesAlreadyPaid: alreadyPaid,
    dispensariesDispatched: dispatched,
    dispensariesFailed: failed,
  };
}

interface DriverSummary {
  readonly driversProcessed: number;
  readonly driversSkippedNoEarnings: number;
  readonly driversPendingBank: number;
  readonly driversAlreadyPaid: number;
}

async function runDriverPayouts(
  deps: PayoutJobDeps,
  period: PayoutPeriod,
  log: Logger,
): Promise<DriverSummary> {
  const driverRows = await deps.ledger.netByAccountRefInWindow(
    'driver',
    period.periodStartUtc,
    period.periodEndUtc,
  );

  let processed = 0;
  let skippedNoEarnings = 0;
  let pendingBank = 0;
  let alreadyPaid = 0;

  for (const row of driverRows) {
    if (row.netCents <= 0) {
      skippedNoEarnings += 1;
      continue;
    }
    processed += 1;

    // Drivers don't have an aeropay_account_ref column yet — Phase 8.
    // Record the obligation as a `pending` payout so we don't lose it,
    // and let an out-of-band reconciliation flip them to dispatched once
    // the bank linkage exists. Uniqueness prevents tomorrow's run from
    // duplicating.
    const { payout, created } = await deps.payouts.createIfAbsent({
      recipientType: 'driver',
      recipientId: row.accountRef,
      periodStart: period.periodStartDateStr,
      periodEnd: period.periodEndDateStr,
      grossCents: row.netCents,
      feesCents: 0,
      netCents: row.netCents,
      status: 'pending',
      scheduledFor: period.periodEndDateStr,
    });

    if (!created) {
      alreadyPaid += 1;
      log.info(
        { driverId: row.accountRef, payoutId: payout.id, status: payout.status },
        'driver payout already exists — skipping',
      );
      continue;
    }

    pendingBank += 1;
    log.info(
      { driverId: row.accountRef, payoutId: payout.id, netCents: row.netCents },
      'driver payout recorded pending — awaiting bank linkage (Phase 8)',
    );
  }

  return {
    driversProcessed: processed,
    driversSkippedNoEarnings: skippedNoEarnings,
    driversPendingBank: pendingBank,
    driversAlreadyPaid: alreadyPaid,
  };
}

type DispatchOutcome = 'ok' | 'failed';

async function dispatchPayout(
  deps: PayoutJobDeps,
  payout: Payout,
  period: PayoutPeriod,
  bankAccountId: string,
): Promise<DispatchOutcome> {
  let upstream: AeropayPayout;
  try {
    upstream = await deps.aeropay.createPayout({
      bankAccountId,
      amountCents: payout.netCents,
      recipientRef: `${payout.recipientType}:${payout.recipientId}`,
      periodStart: period.periodStartUtc,
      periodEnd: period.periodEndUtc,
      idempotencyKey: `payout:${payout.id}`,
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'unknown Aeropay error';
    await deps.payouts.updateStatus(payout.id, 'failed', { failureReason: reason });
    deps.logger.error(
      {
        payoutId: payout.id,
        recipientType: payout.recipientType,
        recipientId: payout.recipientId,
        error: reason,
      },
      'aeropay createPayout failed',
    );
    return 'failed';
  }

  await deps.payouts.updateStatus(payout.id, 'processing', {
    aeropayPayoutRef: upstream.id,
    initiatedAt: new Date(),
  });
  deps.logger.info(
    {
      payoutId: payout.id,
      recipientType: payout.recipientType,
      recipientId: payout.recipientId,
      aeropayPayoutRef: upstream.id,
      netCents: payout.netCents,
    },
    'aeropay payout dispatched',
  );
  return 'ok';
}

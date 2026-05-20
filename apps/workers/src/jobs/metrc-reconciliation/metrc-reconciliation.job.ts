/**
 * Metrc reconciliation worker — Phase 11.4.
 *
 * Runs daily at 04:00 America/Chicago (see scheduler.ts). For every
 * active dispensary with a provisioned Metrc API key:
 *
 *   1. List Metrc receipts modified in the last `windowDays` (default 7)
 *      via `GET /sales/v2/receipts/active`.
 *   2. Pull our local `reported`+`reconciled` rows for the same window,
 *      narrowed to orders owned by this dispensary.
 *   3. For each local row, find the upstream receipt whose
 *      `transactions[].packageLabel` set covers the row's `packageTags`
 *      and mark the row reconciled (`status='reconciled'`,
 *      `metricReceiptId` stamped). Rows already reconciled with a
 *      different receipt id are flagged as a discrepancy rather than
 *      overwritten — the first reconciliation is the source of truth
 *      and an admin needs to investigate the conflict.
 *   4. Build the discrepancy list:
 *        - `missing_upstream`: a local row that has stayed `reported`
 *          for longer than `discrepancyAfterHours` (default 24h) with
 *          no upstream receipt covering its tags — Metrc never recorded
 *          our POST.
 *        - `unexpected_upstream`: an upstream receipt whose tags do not
 *          intersect with any local row in the window — somebody POSTed
 *          to Metrc outside our pipeline (manual override, second
 *          integrator, etc.).
 *        - `receipt_id_mismatch`: a row is already `reconciled` against
 *          a different upstream id than we now see covering its tags.
 *
 * Per-dispensary errors (Metrc 5xx, decrypt failure, etc.) are logged
 * and isolated — one bad dispensary never blocks the rest of the run.
 * Discrepancies are surfaced both in the returned summary and as an
 * `error`-level log line per discrepancy so the existing log-shipping
 * alert pipeline can fire on them while the dedicated email channel
 * (Phase 12 Notifications) is still in flight.
 *
 * Throughput: the run iterates dispensaries sequentially. Metrc's
 * vendor guidance is ≤4 concurrent connections per integrator (spec
 * §7.3); a sequential walk over O(10) dispensaries is well under
 * that ceiling and keeps the per-dispensary log stream a single
 * coherent block instead of an interleaved mess.
 */
import { type Logger } from '@dankdash/config';
import {
  type DispensariesRepository,
  type Dispensary,
  type EncryptionService,
  type MetrcTransaction,
  type MetrcTransactionsRepository,
  type Order,
  type OrdersRepository,
  ENCRYPTION_CONTEXT,
} from '@dankdash/db';
import { type MetrcClient, type MetrcReceipt } from '@dankdash/metrc';
import { ExternalServiceError } from '@dankdash/types';

/**
 * How far back to look for receipts on each tick. Seven days mirrors
 * the cron cadence at which we'd notice anything missing — once a row
 * has been outside the window for a day, we'd never re-discover it,
 * so the window must be strictly longer than the run interval times
 * the longest acceptable "missing" delay. Spec §7.4 fixes this at 7d.
 */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * Once a row has been in `reported` for longer than this, the cron
 * flips it to a `missing_upstream` discrepancy. A few hours of slack
 * absorbs Metrc's own ingestion lag (which is normally seconds, but
 * we've seen multi-minute pauses during their maintenance windows).
 */
export const DEFAULT_DISCREPANCY_AFTER_HOURS = 24;

/**
 * Conservative clock-skew pad applied to the Metrc window. Our
 * `reportedAt` is wall-clock from the worker; Metrc's `LastModified`
 * is wall-clock from their side. A few minutes of buffer in both
 * directions means a row reported right at the window edge is still
 * matchable against an upstream receipt whose `LastModified` lands
 * just outside it. Strictly cosmetic — the inner matcher works on
 * tag sets, not timestamps.
 */
export const METRC_WINDOW_SKEW_MS = 5 * 60_000;

export interface MetrcReconciliationJobDeps {
  readonly metricTransactions: MetrcTransactionsRepository;
  readonly orders: OrdersRepository;
  readonly dispensaries: DispensariesRepository;
  readonly metrc: MetrcClient;
  readonly encryption: EncryptionService;
  readonly logger: Logger;
  /** Override the 7-day window. Production should leave this default. */
  readonly windowDays?: number;
  /** Override the 24h slack before flagging as missing upstream. */
  readonly discrepancyAfterHours?: number;
}

export interface MetrcReconciliationJobInput {
  readonly now: Date;
  readonly deps: MetrcReconciliationJobDeps;
}

export type DiscrepancyKind = 'missing_upstream' | 'unexpected_upstream' | 'receipt_id_mismatch';

export interface MetrcReconciliationDiscrepancy {
  readonly kind: DiscrepancyKind;
  readonly dispensaryId: string;
  /** Present for `missing_upstream` / `receipt_id_mismatch`. */
  readonly metrcTransactionId?: string;
  readonly orderId?: string;
  /** Present for `unexpected_upstream` / `receipt_id_mismatch`. */
  readonly upstreamReceiptId?: number;
  readonly upstreamReceiptNumber?: string;
  /** Free-form context for the log line / future email body. */
  readonly detail: string;
}

export interface MetrcReconciliationJobSummary {
  readonly dispensariesProcessed: number;
  readonly dispensariesSkipped: number;
  /** Rows we flipped from `reported` → `reconciled` this tick. */
  readonly reconciled: number;
  /** Rows already `reconciled` whose upstream receipt id still matched — no write. */
  readonly alreadyReconciled: number;
  readonly missingUpstream: number;
  readonly unexpectedUpstream: number;
  readonly receiptIdMismatches: number;
  /** Dispensaries whose run threw (Metrc 5xx, decrypt fail, etc.). */
  readonly errors: number;
  readonly discrepancies: readonly MetrcReconciliationDiscrepancy[];
}

interface PerDispensaryOutcome {
  readonly reconciled: number;
  readonly alreadyReconciled: number;
  readonly discrepancies: readonly MetrcReconciliationDiscrepancy[];
}

export async function runMetrcReconciliationJob(
  input: MetrcReconciliationJobInput,
): Promise<MetrcReconciliationJobSummary> {
  const { now, deps } = input;
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const discrepancyAfterHours = deps.discrepancyAfterHours ?? DEFAULT_DISCREPANCY_AFTER_HOURS;
  const log = deps.logger.child({ job: 'metrc-reconciliation' });

  if (!Number.isFinite(windowDays) || windowDays < 1) {
    throw new RangeError(`windowDays must be a positive number, got ${String(windowDays)}`);
  }
  if (!Number.isFinite(discrepancyAfterHours) || discrepancyAfterHours < 0) {
    throw new RangeError(
      `discrepancyAfterHours must be a non-negative number, got ${String(discrepancyAfterHours)}`,
    );
  }

  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60_000);

  // Single fetch covering every dispensary. We then group locally so
  // each dispensary only sees its own slice. The alternative (a
  // per-dispensary JOIN through orders) would be cleaner SQL but
  // would add a new repo method per cron; for a daily job with a
  // bounded row count, one-fetch-then-group is the right tradeoff.
  const allLocalRows = await deps.metricTransactions.listReportedSince(windowStart, windowEnd);
  const rowsByOrderId = new Map(allLocalRows.map((row) => [row.orderId, row]));

  const ordersByOrderId = await loadOrders(deps.orders, [...rowsByOrderId.keys()]);
  const rowsByDispensaryId = groupRowsByDispensary(allLocalRows, ordersByOrderId);

  const dispensaries = await deps.dispensaries.listActive();
  let dispensariesProcessed = 0;
  let dispensariesSkipped = 0;
  let errors = 0;
  let totalReconciled = 0;
  let totalAlreadyReconciled = 0;
  const aggregateDiscrepancies: MetrcReconciliationDiscrepancy[] = [];

  for (const dispensary of dispensaries) {
    if (dispensary.metrcApiKeyEnc === null) {
      log.debug(
        { dispensaryId: dispensary.id, event: 'metrc.reconcile.skipped_no_credential' },
        'reconciliation skipped: dispensary has no metrc credential',
      );
      dispensariesSkipped += 1;
      continue;
    }

    const localRows = rowsByDispensaryId.get(dispensary.id) ?? [];
    try {
      const outcome = await reconcileDispensary({
        dispensary,
        localRows,
        now,
        windowStart,
        windowEnd,
        discrepancyAfterHours,
        deps,
        log,
      });
      dispensariesProcessed += 1;
      totalReconciled += outcome.reconciled;
      totalAlreadyReconciled += outcome.alreadyReconciled;
      aggregateDiscrepancies.push(...outcome.discrepancies);
    } catch (err) {
      errors += 1;
      log.error(
        {
          dispensaryId: dispensary.id,
          err: err instanceof Error ? err.message : String(err),
          event: 'metrc.reconcile.dispensary_failed',
        },
        'reconciliation failed for dispensary',
      );
    }
  }

  // Emit each discrepancy at error-level so log-based alerting fires
  // even before the email path lands. The job-level summary at info
  // gives ops the totals at a glance.
  for (const discrepancy of aggregateDiscrepancies) {
    log.error(
      {
        event: 'metrc.reconcile.discrepancy',
        kind: discrepancy.kind,
        dispensaryId: discrepancy.dispensaryId,
        metrcTransactionId: discrepancy.metrcTransactionId,
        orderId: discrepancy.orderId,
        upstreamReceiptId: discrepancy.upstreamReceiptId,
        upstreamReceiptNumber: discrepancy.upstreamReceiptNumber,
        detail: discrepancy.detail,
      },
      'metrc reconciliation discrepancy',
    );
  }

  const missingUpstream = aggregateDiscrepancies.filter(
    (d) => d.kind === 'missing_upstream',
  ).length;
  const unexpectedUpstream = aggregateDiscrepancies.filter(
    (d) => d.kind === 'unexpected_upstream',
  ).length;
  const receiptIdMismatches = aggregateDiscrepancies.filter(
    (d) => d.kind === 'receipt_id_mismatch',
  ).length;

  const summary: MetrcReconciliationJobSummary = {
    dispensariesProcessed,
    dispensariesSkipped,
    reconciled: totalReconciled,
    alreadyReconciled: totalAlreadyReconciled,
    missingUpstream,
    unexpectedUpstream,
    receiptIdMismatches,
    errors,
    discrepancies: aggregateDiscrepancies,
  };

  log.info({ summary }, 'metrc reconciliation tick complete');
  return summary;
}

interface ReconcileDispensaryArgs {
  readonly dispensary: Dispensary;
  readonly localRows: readonly MetrcTransaction[];
  readonly now: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly discrepancyAfterHours: number;
  readonly deps: MetrcReconciliationJobDeps;
  readonly log: Logger;
}

async function reconcileDispensary(args: ReconcileDispensaryArgs): Promise<PerDispensaryOutcome> {
  const { dispensary, localRows, now, windowStart, windowEnd, discrepancyAfterHours, deps, log } =
    args;

  // metrcApiKeyEnc null check happens at the call site so the per-
  // dispensary fast-skip stays in the orchestrator; here it's an
  // invariant (TypeError because reaching this branch means a caller
  // bypassed the guard, not because the dispensary itself is bad).
  if (dispensary.metrcApiKeyEnc === null) {
    throw new TypeError(
      `reconcileDispensary called for dispensary ${dispensary.id} without a metrc credential`,
    );
  }

  let userKey: string;
  try {
    userKey = deps.encryption.decryptString(
      dispensary.metrcApiKeyEnc,
      ENCRYPTION_CONTEXT.DISPENSARY_METRC_API_KEY,
    );
  } catch (err) {
    // Wrap with the upstream service tag so log shippers can route
    // this to the same dashboard as a real Metrc call failure — both
    // categories require admin attention on the same credential. The
    // `details.cause` preserves the original encryption library error
    // for forensics.
    const message = err instanceof Error ? err.message : String(err);
    throw new ExternalServiceError(
      'metrc',
      `metrc credential decrypt failed: ${message}`,
      { dispensaryId: dispensary.id },
      err,
    );
  }

  // Pad the Metrc window with the clock-skew constant; our local
  // listReportedSince already used the strict 7d window so the only
  // way a row "leaks" is at the upstream LastModified boundary.
  const upstreamStart = new Date(windowStart.getTime() - METRC_WINDOW_SKEW_MS);
  const upstreamEnd = new Date(windowEnd.getTime() + METRC_WINDOW_SKEW_MS);
  const upstreamReceipts = await deps.metrc.listActiveReceipts({
    lastModifiedStart: upstreamStart,
    lastModifiedEnd: upstreamEnd,
    licenseNumber: dispensary.licenseNumber,
    userKey,
  });

  log.debug(
    {
      dispensaryId: dispensary.id,
      localCount: localRows.length,
      upstreamCount: upstreamReceipts.length,
      windowStart: upstreamStart.toISOString(),
      windowEnd: upstreamEnd.toISOString(),
    },
    'reconciliation: fetched local + upstream',
  );

  const discrepancies: MetrcReconciliationDiscrepancy[] = [];
  let reconciled = 0;
  let alreadyReconciled = 0;
  const matchedReceiptIds = new Set<number>();

  for (const row of localRows) {
    const localTagSet = toTagSet(row.packageTags);
    const match = findReceiptCovering(localTagSet, upstreamReceipts);

    if (match === null) {
      const reportedAt = row.reportedAt;
      const ageMs = reportedAt === null ? 0 : now.getTime() - reportedAt.getTime();
      const slackMs = discrepancyAfterHours * 60 * 60_000;
      if (reportedAt !== null && ageMs >= slackMs) {
        discrepancies.push({
          kind: 'missing_upstream',
          dispensaryId: dispensary.id,
          metrcTransactionId: row.id,
          orderId: row.orderId,
          detail: `row reported_at=${reportedAt.toISOString()} (${formatDurationHours(ageMs)} ago) but no upstream receipt covers its tags`,
        });
      }
      continue;
    }

    matchedReceiptIds.add(match.id);

    if (row.status === 'reconciled') {
      if (row.metrcReceiptId !== null && row.metrcReceiptId === String(match.id)) {
        alreadyReconciled += 1;
        continue;
      }
      // Either the stored id is null (impossible per repo contract) or
      // mismatched (Metrc reissued the receipt, manual edit, etc.).
      // Don't overwrite — flag and let an admin sort it out.
      discrepancies.push({
        kind: 'receipt_id_mismatch',
        dispensaryId: dispensary.id,
        metrcTransactionId: row.id,
        orderId: row.orderId,
        upstreamReceiptId: match.id,
        upstreamReceiptNumber: match.receiptNumber,
        detail: `row already reconciled against receipt_id=${row.metrcReceiptId ?? 'null'} but current upstream coverage is receipt_id=${String(match.id)}`,
      });
      continue;
    }

    await deps.metricTransactions.markReconciled(row.id, String(match.id));
    reconciled += 1;
    log.info(
      {
        event: 'metrc.reconcile.matched',
        dispensaryId: dispensary.id,
        metrcTransactionId: row.id,
        orderId: row.orderId,
        upstreamReceiptId: match.id,
        upstreamReceiptNumber: match.receiptNumber,
      },
      'reconciled local row to upstream receipt',
    );
  }

  for (const receipt of upstreamReceipts) {
    if (matchedReceiptIds.has(receipt.id)) continue;
    discrepancies.push({
      kind: 'unexpected_upstream',
      dispensaryId: dispensary.id,
      upstreamReceiptId: receipt.id,
      upstreamReceiptNumber: receipt.receiptNumber,
      detail: `upstream receipt ${receipt.receiptNumber} (id=${String(receipt.id)}) has no local row covering its packages — possible out-of-band POST or pre-Phase-11 backfill`,
    });
  }

  return { reconciled, alreadyReconciled, discrepancies };
}

async function loadOrders(
  ordersRepo: OrdersRepository,
  ids: readonly string[],
): Promise<Map<string, Order>> {
  const rows = await ordersRepo.findManyByIds(ids);
  const byId = new Map<string, Order>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return byId;
}

function groupRowsByDispensary(
  rows: readonly MetrcTransaction[],
  ordersByOrderId: ReadonlyMap<string, Order>,
): Map<string, MetrcTransaction[]> {
  const byDispensary = new Map<string, MetrcTransaction[]>();
  for (const row of rows) {
    const order = ordersByOrderId.get(row.orderId);
    if (order === undefined) continue;
    const bucket = byDispensary.get(order.dispensaryId);
    if (bucket === undefined) {
      byDispensary.set(order.dispensaryId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return byDispensary;
}

function toTagSet(tags: readonly string[]): ReadonlySet<string> {
  return new Set(tags.filter((t) => t.length > 0));
}

/**
 * A receipt "covers" a local row when every non-empty package tag on
 * the row appears in the receipt's transaction lines. We use coverage
 * (⊇) rather than equality because Metrc occasionally splits or merges
 * receipt lines during reconciliation on their side — what matters for
 * traceability is that every package we sold appears on the receipt.
 *
 * The local row with zero tags (the listener's "untagged data integrity
 * bug" branch) never covers any receipt — `tagSet.size === 0` short-
 * circuits to null so the row stays flagged as `missing_upstream` and
 * surfaces in admin instead of silently reconciling against the first
 * receipt in the window.
 */
function findReceiptCovering(
  tagSet: ReadonlySet<string>,
  receipts: readonly MetrcReceipt[],
): MetrcReceipt | null {
  if (tagSet.size === 0) return null;
  for (const receipt of receipts) {
    const receiptTags = new Set(receipt.transactions.map((t) => t.packageLabel));
    let covers = true;
    for (const tag of tagSet) {
      if (!receiptTags.has(tag)) {
        covers = false;
        break;
      }
    }
    if (covers) return receipt;
  }
  return null;
}

function formatDurationHours(ms: number): string {
  const hours = ms / 3_600_000;
  return `${hours.toFixed(1)}h`;
}

/**
 * Internals exposed for unit tests. Production callers should only
 * touch `runMetrcReconciliationJob`.
 */
export const __INTERNALS__ = Object.freeze({
  findReceiptCovering,
  groupRowsByDispensary,
  toTagSet,
  formatDurationHours,
});

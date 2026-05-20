/**
 * Metrc reporting worker — Phase 11.3.
 *
 * Tick contract: claim up to `claimLimit` `pending` rows whose
 * `next_retry_at` has elapsed, and for each one assemble the receipt
 * payload, POST it to Metrc, and persist the outcome:
 *   - 2xx                                      → markReported
 *   - terminal 4xx (400/403/404/422)            → markFailedTerminal
 *   - transient (408/425/429, 5xx, network)    → scheduleRetry on the
 *     1m/5m/15m/1h/6h/24h ladder; if the ladder is exhausted, terminate
 *   - DB/data-integrity gaps (missing order,
 *     missing dispensary creds, zero package
 *     tags, etc.)                              → markFailedTerminal
 *
 * Concurrency: `MetrcTransactionsRepository.claimDueForReporting` uses
 * `SELECT … FOR UPDATE SKIP LOCKED` plus a lease bump on `next_retry_at`,
 * so two worker pods racing on the same tick walk past each other's
 * leases instead of double-posting. The per-row processing is its own
 * try/catch — a row's failure never bleeds into the next row.
 *
 * No transaction wraps the whole tick. The Metrc POST is the only
 * write to the external system and lives outside Postgres entirely;
 * wrapping the tick would just extend the open-transaction window past
 * the network round-trip for no integrity benefit.
 *
 * Important: this job does NOT discover the Metrc receipt id. Metrc's
 * `POST /sales/v2/receipts` returns 200 with an empty body and never
 * echoes the freshly-minted id — the spec's reconciliation cron
 * (Phase 11.4) is responsible for joining our `reported` rows to the
 * upstream id via `/sales/v2/receipts/active`.
 */
import { type Logger } from '@dankdash/config';
import {
  type DispensariesRepository,
  type EncryptionService,
  type MetrcTransaction,
  type MetrcTransactionsRepository,
  type OrderItem,
  type OrderItemsRepository,
  type OrdersRepository,
  ENCRYPTION_CONTEXT,
} from '@dankdash/db';
import {
  type CreateReceiptInput,
  type MetrcClient,
  type MetrcTransactionLine,
  type MetrcUnitOfMeasure,
} from '@dankdash/metrc';
import { ExternalServiceError } from '@dankdash/types';
import { MAX_RETRY_ATTEMPTS, nextRetryAt } from './backoff.js';

/**
 * Default claim batch + lease. The lease must be strictly larger than
 * the worst-case per-row processing time so a slow row never has its
 * lease elapse mid-flight and become eligible for re-claim by a sibling
 * pod. Empirically a Metrc round-trip is sub-second; 60s gives us 60×
 * safety while still letting a crashed worker's rows recover on the
 * very next tick.
 */
export const DEFAULT_CLAIM_LIMIT = 25;
export const DEFAULT_LEASE_MS = 60_000;

export interface MetrcReportingJobDeps {
  readonly metricTransactions: MetrcTransactionsRepository;
  readonly orders: OrdersRepository;
  readonly orderItems: OrderItemsRepository;
  readonly dispensaries: DispensariesRepository;
  readonly metrc: MetrcClient;
  readonly encryption: EncryptionService;
  readonly logger: Logger;
  readonly claimLimit?: number;
  readonly leaseMs?: number;
}

export interface MetrcReportingJobInput {
  readonly now: Date;
  readonly deps: MetrcReportingJobDeps;
}

export interface MetrcReportingJobSummary {
  /** Rows the tick claimed (some may end in errors). */
  readonly claimed: number;
  /** Rows we successfully POSTed and flipped to `reported`. */
  readonly reported: number;
  /** Rows we rescheduled (transient failure with budget remaining). */
  readonly retried: number;
  /** Rows we flipped to terminal `failed` (4xx, missing creds, exhausted budget). */
  readonly failedTerminal: number;
  /** Rows the tick claimed but could not even decide on (unexpected per-row crashes). */
  readonly errors: number;
}

export async function runMetrcReportingJob(
  input: MetrcReportingJobInput,
): Promise<MetrcReportingJobSummary> {
  const { now, deps } = input;
  const limit = deps.claimLimit ?? DEFAULT_CLAIM_LIMIT;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const log = deps.logger.child({ job: 'metrc-reporting' });

  const claimed = await deps.metricTransactions.claimDueForReporting(now, limit, leaseMs);
  const summary: MetrcReportingJobSummary = {
    claimed: claimed.length,
    reported: 0,
    retried: 0,
    failedTerminal: 0,
    errors: 0,
  };

  if (claimed.length === 0) {
    log.debug({ summary }, 'metrc reporting tick: nothing to do');
    return summary;
  }

  // Mutable accumulators because we touch summary inside the per-row
  // try/catch — typescript widens the per-key updates fine with a
  // discriminated outcome string returned by `processOne`.
  const counters: Record<keyof Omit<MetrcReportingJobSummary, 'claimed'>, number> = {
    reported: 0,
    retried: 0,
    failedTerminal: 0,
    errors: 0,
  };

  for (const row of claimed) {
    try {
      const outcome = await processOne(row, now, deps);
      counters[outcome] += 1;
    } catch (err) {
      counters.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { metrcTransactionId: row.id, orderId: row.orderId, err: message },
        'metrc reporting: per-row failure',
      );
    }
  }

  const finalSummary: MetrcReportingJobSummary = { claimed: claimed.length, ...counters };
  log.info({ summary: finalSummary }, 'metrc reporting tick complete');
  return finalSummary;
}

type PerRowOutcome = 'reported' | 'retried' | 'failedTerminal';

async function processOne(
  row: MetrcTransaction,
  now: Date,
  deps: MetrcReportingJobDeps,
): Promise<PerRowOutcome> {
  const order = await deps.orders.findById(row.orderId);
  if (order === null) {
    // Orphan: the metrc_transactions row references an order that no
    // longer exists. This is a data-integrity bug worth alerting on,
    // but the worker can't recover by retrying. Terminate with a
    // structured reason so admin sees it in the failed-list view.
    return terminate(deps, row, 'order not found', undefined);
  }
  if (order.status !== 'delivered' || order.deliveredAt === null) {
    // The listener (apps/api compliance.module) only enqueues on the
    // `delivered` transition, so this should be impossible — but the
    // metric_transactions row was inserted post-commit and could in
    // principle co-exist with a future `disputed`/`canceled` reversal
    // that wiped `delivered_at`. Don't burn the budget; reschedule to
    // give the operational team a window to investigate.
    const nextAt = nextRetryAt(now, row.retryCount);
    if (nextAt === null) {
      return terminate(
        deps,
        row,
        `order status ${order.status} (delivered_at=${String(order.deliveredAt)}) — retries exhausted`,
        undefined,
      );
    }
    await deps.metricTransactions.scheduleRetry(
      row.id,
      nextAt,
      `order not in delivered state (status=${order.status})`,
    );
    return 'retried';
  }

  const dispensary = await deps.dispensaries.findById(order.dispensaryId);
  if (dispensary === null) {
    return terminate(deps, row, 'dispensary not found', undefined);
  }
  if (dispensary.metrcApiKeyEnc === null) {
    return terminate(deps, row, 'dispensary has no metrc_api_key_enc — not provisioned', undefined);
  }

  const items = await deps.orderItems.listForOrder(row.orderId);
  if (items.length === 0) {
    return terminate(deps, row, 'order has no order_items', undefined);
  }

  const transactions = buildTransactions(items);
  if (transactions instanceof Error) {
    // buildTransactions surfaces a structured reason — empty tags, bad
    // unit derivation, malformed snapshot — that callers want logged
    // verbatim. Terminal because re-running won't change the snapshot.
    return terminate(deps, row, transactions.message, undefined);
  }

  let userKey: string;
  try {
    userKey = deps.encryption.decryptString(
      dispensary.metrcApiKeyEnc,
      ENCRYPTION_CONTEXT.DISPENSARY_METRC_API_KEY,
    );
  } catch (err) {
    // Decryption failed — almost always means the master key changed
    // without re-encrypting this column, or the column was written under
    // a different AAD context. Either way, terminal; the worker cannot
    // self-heal a credential rewrap.
    const message = err instanceof Error ? err.message : String(err);
    return terminate(deps, row, `metrc credential decrypt failed: ${message}`, undefined);
  }

  const input: CreateReceiptInput = {
    salesDateTime: order.deliveredAt,
    salesCustomerType: 'Consumer',
    transactions,
    licenseNumber: dispensary.licenseNumber,
    userKey,
  };

  try {
    const outcome = await deps.metrc.createReceipt(input);
    await deps.metricTransactions.markReported(row.id, {
      acceptedAt: outcome.acceptedAt.toISOString(),
      transactionCount: transactions.length,
    });
    deps.logger.info(
      {
        metrcTransactionId: row.id,
        orderId: row.orderId,
        dispensaryId: dispensary.id,
        transactionCount: transactions.length,
      },
      'metrc reporting: receipt accepted',
    );
    return 'reported';
  } catch (err) {
    return handleCallFailure(row, err, now, deps);
  }
}

async function handleCallFailure(
  row: MetrcTransaction,
  err: unknown,
  now: Date,
  deps: MetrcReportingJobDeps,
): Promise<PerRowOutcome> {
  const classification = classifyError(err);
  const responsePayload = errorPayload(err);

  if (classification === 'terminal') {
    return terminate(deps, row, summarizeError(err), responsePayload);
  }

  const nextAt = nextRetryAt(now, row.retryCount);
  if (nextAt === null) {
    return terminate(
      deps,
      row,
      `retry budget exhausted (${String(MAX_RETRY_ATTEMPTS)} attempts): ${summarizeError(err)}`,
      responsePayload,
    );
  }
  await deps.metricTransactions.scheduleRetry(row.id, nextAt, summarizeError(err), responsePayload);
  deps.logger.warn(
    {
      metrcTransactionId: row.id,
      orderId: row.orderId,
      nextRetryAt: nextAt.toISOString(),
      attempt: row.retryCount + 1,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      err: summarizeError(err),
    },
    'metrc reporting: transient failure, rescheduled',
  );
  return 'retried';
}

async function terminate(
  deps: MetrcReportingJobDeps,
  row: MetrcTransaction,
  reason: string,
  responsePayload: unknown,
): Promise<'failedTerminal'> {
  await deps.metricTransactions.markFailedTerminal(row.id, reason, responsePayload);
  deps.logger.error(
    {
      metrcTransactionId: row.id,
      orderId: row.orderId,
      attempt: row.retryCount + 1,
      reason,
    },
    'metrc reporting: terminal failure',
  );
  return 'failedTerminal';
}

/**
 * Build the `MetrcTransactionLine[]` payload from one order's items.
 * Returns an `Error` (not throws) so the caller can route it to the
 * terminate path without losing the structured reason — `processOne`
 * pattern-matches `instanceof Error` because that keeps the happy-path
 * type as `readonly MetrcTransactionLine[]` instead of a discriminated
 * union the consumer would have to unwrap twice.
 */
function buildTransactions(items: readonly OrderItem[]): readonly MetrcTransactionLine[] | Error {
  const lines: MetrcTransactionLine[] = [];
  for (const item of items) {
    if (item.metrcPackageTag === null || item.metrcPackageTag.length === 0) {
      return new Error(
        `order item ${item.id} has no metrc_package_tag — cannot build receipt line`,
      );
    }
    const productType = readProductType(item.productSnapshot);
    if (productType === null) {
      return new Error(
        `order item ${item.id} snapshot is missing productType — cannot derive Metrc unit of measure`,
      );
    }
    lines.push({
      packageLabel: item.metrcPackageTag,
      // Flower/concentrate is sold by weight; everything else is sold
      // by discrete unit count. Per-line weight is `weightGramsTotal`
      // for the row (already includes the per-unit weight × quantity).
      quantity:
        unitOfMeasureFor(productType) === 'Grams' ? item.weightGramsTotal : String(item.quantity),
      unitOfMeasure: unitOfMeasureFor(productType),
      totalAmountCents: item.lineSubtotalCents,
    });
  }
  return lines;
}

function readProductType(snapshot: unknown): string | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const candidate = (snapshot as { productType?: unknown }).productType;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Metrc's UnitOfMeasure enum is exhaustive over a small set; we only
 * ever emit `Grams` or `Each`. Loose flower and concentrate are
 * inventory-tracked by weight in Metrc; pre-rolls/edibles/beverages/
 * vapes/tinctures/topicals are tracked by unit count. The default
 * branch picks `Each` so a future product type added to the enum
 * defaults to the safer choice (over-reporting unit count rather than
 * misreporting weight).
 */
function unitOfMeasureFor(productType: string): MetrcUnitOfMeasure {
  switch (productType) {
    case 'flower':
    case 'concentrate':
      return 'Grams';
    default:
      return 'Each';
  }
}

type ErrorClassification = 'transient' | 'terminal';

function classifyError(err: unknown): ErrorClassification {
  if (err instanceof ExternalServiceError) {
    const status = readStatus(err);
    if (status === undefined) {
      // Errors we threw locally before the request even went out
      // (validation errors). Don't retry — the input is bad.
      return 'terminal';
    }
    if (status === 408 || status === 425 || status === 429) return 'transient';
    if (status >= 500) return 'transient';
    return 'terminal';
  }
  // Anything that isn't an ExternalServiceError originated below the
  // metrc client — most commonly an undici socket error or DNS hiccup.
  // Both are transient by nature.
  return 'transient';
}

function readStatus(err: ExternalServiceError): number | undefined {
  const status = (err.details as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function summarizeError(err: unknown): string {
  if (err instanceof ExternalServiceError) {
    const status = readStatus(err);
    return status === undefined ? err.message : `[${String(status)}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorPayload(err: unknown): unknown {
  if (err instanceof ExternalServiceError) return err.details;
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

/**
 * Side-effect-free helpers exposed for unit tests. Keep this barrel
 * small — production code should import `runMetrcReportingJob` and
 * leave the internals untouched.
 */
export const __INTERNALS__ = Object.freeze({
  buildTransactions,
  classifyError,
  unitOfMeasureFor,
});

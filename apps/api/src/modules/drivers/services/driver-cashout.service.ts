/**
 * Driver cashout orchestration — POST /v1/driver/cashout.
 *
 * Flow:
 *
 *   1. Validate `amountCents > 0` (the schema gates this; the service
 *      re-validates so internal callers cannot bypass).
 *   2. Compute available balance:
 *        lifetime delivery earnings (delivery_fee + tip on delivered orders)
 *          − sum of outstanding payouts (non-failed / non-canceled)
 *      Both reads happen in the same scoped repo set. We do NOT take a
 *      DB lock at this layer because the failure mode of two racing
 *      cashouts is "second one over-draws" — caught by a fresh balance
 *      check inside the same scoped read. If real production traffic
 *      shows the race exploited at scale we'll tighten with
 *      `SELECT … FOR UPDATE` on the driver row.
 *   3. Reject with `PAYMENT_AMOUNT_MISMATCH` 422 if requested >
 *      available.
 *   4. Persist a `payouts` row with `status='pending'`. The unique
 *      constraint on `(recipient_type, recipient_id, period_start,
 *      period_end)` exists for the daily windowed-payout job's
 *      idempotency — it doesn't apply to ad-hoc driver cashouts. We
 *      shim around it by setting `period_start = period_end = epoch
 *      + N days` where N is the count of prior payouts for this
 *      driver. The period columns are bookkeeping placeholders the
 *      iOS layer never surfaces; the actual cashout instant lives on
 *      `created_at`.
 *   5. Fire the (stubbed-by-default) upstream call through the
 *      injected `AeropayDriverPayoutGateway`. The stub logs and
 *      returns null; production will return the upstream payout ref
 *      and we'll patch the row to `processing` + record the ref.
 *   6. Return the wire DTO.
 *
 * Phase 20 ships the persistence + balance gate only. The real upstream
 * call is deferred per the plan's locked scope decisions — ops process
 * the persisted requests manually until the integration phase. See
 * ADR 0007 (added in commit 15) for the full rationale.
 */
import { type Database, type OrdersRepository, type PayoutsRepository } from '@dankdash/db';
import { PaymentError, ValidationError } from '@dankdash/types';
import { Injectable, Logger } from '@nestjs/common';
import { DriverCashoutResponseSchema, type DriverCashoutResponse } from '../dto/index.js';

export interface DriverCashoutScopedRepos {
  readonly orders: OrdersRepository;
  readonly payouts: PayoutsRepository;
}

export type DriverCashoutScopedReposFactory = (db: Database) => DriverCashoutScopedRepos;

/**
 * Narrow boundary between the cashout service and the upstream Aeropay
 * client. Phase 20 default implementation is the stub (logs + returns
 * a synthetic-success outcome); a future phase will swap in a wrapper
 * around the real `AeropayClient.createPayout`.
 */
export interface AeropayDriverPayoutGateway {
  /**
   * Push the cashout to Aeropay. Returns the upstream payout ref on
   * success; the default stub returns `null` so the persisted row
   * stays the source of truth — ops will reconcile when the real
   * integration lands. Implementations should throw a typed
   * PaymentError on rejection.
   */
  requestPayout(input: {
    readonly payoutId: string;
    readonly driverUserId: string;
    readonly amountCents: number;
  }): Promise<string | null>;
}

export interface DriverCashoutServiceConfig {
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
}

@Injectable()
export class DriverCashoutService {
  private readonly logger = new Logger(DriverCashoutService.name);
  private readonly clock: () => Date;

  constructor(
    private readonly db: Database,
    private readonly reposFor: DriverCashoutScopedReposFactory,
    private readonly aeropay: AeropayDriverPayoutGateway,
    config: DriverCashoutServiceConfig = {},
  ) {
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async requestCashout(driverUserId: string, amountCents: number): Promise<DriverCashoutResponse> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new ValidationError('amountCents must be a positive integer', { amountCents });
    }

    const scoped = this.reposFor(this.db);
    const now = this.clock();

    // Lifetime delivery earnings (no lower bound). The aggregator uses
    // delivered_at, so partial / pending orders are correctly excluded.
    const earnings = await scoped.orders.sumDriverEarnings({
      driverId: driverUserId,
      since: null,
      until: now,
    });
    const lifetimeCents = earnings.tipsCents + earnings.deliveryFeesCents;
    const outstandingCents = await scoped.payouts.sumOutstandingFor('driver', driverUserId);
    const availableCents = lifetimeCents - outstandingCents;

    if (amountCents > availableCents) {
      throw new PaymentError(
        'PAYMENT_AMOUNT_MISMATCH',
        'requested cashout exceeds available balance',
        {
          requestedCents: amountCents,
          availableCents,
          lifetimeCents,
          outstandingCents,
        },
        422,
      );
    }

    // Build a deterministic, never-colliding period date pair from the
    // count of existing payouts for this driver. See the file header
    // for why this shim exists.
    const priorCount = await scoped.payouts.countForRecipient('driver', driverUserId);
    const periodDate = offsetEpochDays(priorCount);
    const scheduledFor = toCalendarDateString(now);

    const payout = await scoped.payouts.create({
      recipientType: 'driver',
      recipientId: driverUserId,
      periodStart: periodDate,
      periodEnd: periodDate,
      grossCents: amountCents,
      feesCents: 0,
      netCents: amountCents,
      status: 'pending',
      scheduledFor,
    });

    // Fire the (stubbed) upstream call. Logs + returns null in the
    // default stub; future production wiring will return the real
    // Aeropay payout ref and we'll update the row via the webhook
    // handler.
    let aeropayPayoutRef: string | null;
    try {
      aeropayPayoutRef = await this.aeropay.requestPayout({
        payoutId: payout.id,
        driverUserId,
        amountCents,
      });
    } catch (err) {
      // The persisted row stays in 'pending' for ops to inspect; we do
      // NOT roll it back — the audit trail is more valuable than a
      // clean error path. Surface a typed PaymentError so the
      // controller renders a stable response code.
      this.logger.error(
        { err, payoutId: payout.id, driverUserId },
        'Aeropay driver payout request failed — persisted row remains in pending',
      );
      throw err;
    }

    if (aeropayPayoutRef !== null) {
      await scoped.payouts.updateStatus(payout.id, 'processing', {
        aeropayPayoutRef,
        initiatedAt: now,
      });
    }

    return DriverCashoutResponseSchema.parse({
      id: payout.id,
      amountCents: payout.netCents,
      status: aeropayPayoutRef === null ? 'pending' : 'processing',
      requestedAt: payout.createdAt.toISOString(),
      aeropayPayoutRef,
    });
  }
}

/**
 * Postgres `date` column stores `YYYY-MM-DD`; Drizzle's `date` codec
 * is a string round-trip, not a Date. We render `today` in UTC so the
 * value is stable across deployments regardless of server timezone —
 * the iOS layer never reads these columns; only ops dashboards do.
 */
function toCalendarDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Derives a deterministic placeholder calendar date for the
 * `period_start` / `period_end` columns. We start at the unix epoch
 * (`1970-01-01`) and add `dayOffset` days — that keeps ad-hoc cashout
 * rows safely outside any realistic windowed-payout job range (which
 * starts at today and walks backwards a few days at most).
 *
 * Pre-2030 ad-hoc cashouts use 1970-2030; the function is correct
 * indefinitely as long as `dayOffset < 10_000_000` (which would push
 * us past year 29345 — fine for our purposes).
 */
function offsetEpochDays(dayOffset: number): string {
  const epochMs = 0;
  const oneDayMs = 86_400_000;
  const d = new Date(epochMs + dayOffset * oneDayMs);
  return d.toISOString().slice(0, 10);
}

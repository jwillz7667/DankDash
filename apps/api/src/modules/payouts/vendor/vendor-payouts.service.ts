/**
 * Vendor payouts service (Phase 15.3).
 *
 * Two read-only operations:
 *
 *   - `list(ctx)`           — Up to 50 most-recent payouts for the active
 *                             vendor (ordered by `period_end` desc).
 *   - `findById(ctx, id)`   — Single payout + the delivered orders that
 *                             contributed to its window. 404 (NotFoundError)
 *                             when the payout doesn't exist OR when it
 *                             belongs to another dispensary — the API
 *                             must not leak existence across tenants.
 *
 * The service does the date-to-UTC arithmetic. Payout rows store
 * `period_start`/`period_end` as `date` columns (YYYY-MM-DD), and the
 * Central-calendar instants that bound the constituent-orders query are
 * computed here via luxon (same zone the payout job uses to compute the
 * window in the first place — see `apps/workers/src/jobs/payouts/
 * payout.period.ts`). Keeping the timezone logic in the service rather
 * than the repo means the repo stays a pure Drizzle-over-Postgres layer
 * and the date arithmetic has a single home that can be unit-tested
 * without a database.
 *
 * No RLS scope wrapper here — the payouts query is read-only and the
 * application-level `WHERE recipient_id = ctx.dispensaryId` predicate is
 * the primary guard. Cross-dispensary access surfaces as 404 so a
 * probing call cannot distinguish "this payout does not exist" from
 * "this payout belongs to another vendor". A future Phase that swaps
 * the vendor surface onto an `app_vendor` connection pool can mirror
 * the `withScope` pattern from VendorListingsService without changing
 * this service.
 */
import {
  OrdersRepository,
  PayoutsRepository,
  type Payout,
  type VendorPayoutOrderRow,
} from '@dankdash/db';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type {
  VendorPayoutDetailResponse,
  VendorPayoutListResponse,
  VendorPayoutOrder,
  VendorPayoutSummary,
} from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

export interface PayoutsRepos {
  readonly payouts: PayoutsRepository;
  readonly orders: OrdersRepository;
}

/** Pre-bound repo accessor — production closes over the pooled DB token,
 *  tests return an in-memory fake. */
export type PayoutsRepoFactory = () => PayoutsRepos;

const PAYOUT_TIMEZONE = 'America/Chicago';
const PAYOUT_LIST_LIMIT = 50;
const PAYOUT_ORDERS_LIMIT = 500;

@Injectable()
export class VendorPayoutsService {
  constructor(private readonly repoFor: PayoutsRepoFactory) {}

  async list(ctx: VendorContext): Promise<VendorPayoutListResponse> {
    const { payouts } = this.repoFor();
    const rows = await payouts.listForRecipient('dispensary', ctx.dispensaryId, PAYOUT_LIST_LIMIT);
    return { payouts: rows.map(toSummary) };
  }

  async findById(ctx: VendorContext, payoutId: string): Promise<VendorPayoutDetailResponse> {
    const { payouts, orders } = this.repoFor();
    const payout = await payouts.findById(payoutId);
    // Same row applies to a 404 (no such payout) and a 404 (other tenant's
    // payout). The two are intentionally indistinguishable across vendors.
    if (payout?.recipientType !== 'dispensary' || payout.recipientId !== ctx.dispensaryId) {
      throw new NotFoundException(`Payout ${payoutId} not found`);
    }

    const { startUtc, endUtc } = periodToUtcRange(payout.periodStart, payout.periodEnd);
    const constituents = await orders.listDeliveredForDispensaryBetween(
      ctx.dispensaryId,
      startUtc,
      endUtc,
      PAYOUT_ORDERS_LIMIT,
    );

    return {
      ...toSummary(payout),
      orders: constituents.map(toOrder),
    };
  }
}

function toSummary(payout: Payout): VendorPayoutSummary {
  return {
    id: payout.id,
    periodStart: payout.periodStart,
    periodEnd: payout.periodEnd,
    grossCents: payout.grossCents,
    feesCents: payout.feesCents,
    netCents: payout.netCents,
    status: payout.status,
    scheduledFor: payout.scheduledFor,
    aeropayPayoutRef: payout.aeropayPayoutRef,
    initiatedAt: payout.initiatedAt === null ? null : payout.initiatedAt.toISOString(),
    completedAt: payout.completedAt === null ? null : payout.completedAt.toISOString(),
    failureReason: payout.failureReason,
    createdAt: payout.createdAt.toISOString(),
  };
}

function toOrder(row: VendorPayoutOrderRow): VendorPayoutOrder {
  return {
    id: row.id,
    shortCode: row.shortCode,
    deliveredAt: row.deliveredAt.toISOString(),
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    totalCents: row.totalCents,
    customerFirstName: row.customerFirstName,
    customerLastName: row.customerLastName,
  };
}

/**
 * Convert a payout's [periodStart, periodEnd) date pair into the same UTC
 * instants the payout job used when it wrote the row. Each date string is
 * parsed as 00:00 in America/Chicago; the upper bound is the exclusive
 * end of the window. luxon handles the DST spring-forward / fall-back
 * hours correctly — `startOf('day')` in zone always lands at 00:00 local.
 */
function periodToUtcRange(
  periodStart: string,
  periodEnd: string,
): { readonly startUtc: Date; readonly endUtc: Date } {
  const startCentral = DateTime.fromISO(periodStart, { zone: PAYOUT_TIMEZONE }).startOf('day');
  const endCentral = DateTime.fromISO(periodEnd, { zone: PAYOUT_TIMEZONE }).startOf('day');
  return {
    startUtc: startCentral.toUTC().toJSDate(),
    endUtc: endCentral.toUTC().toJSDate(),
  };
}

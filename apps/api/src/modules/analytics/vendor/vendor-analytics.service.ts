/**
 * Vendor analytics service. Pure projection layer over the
 * cross-domain `AnalyticsRepository` — runs five focused queries, then
 * stitches them into the two response shapes the portal consumes:
 *
 *   - `sales(ctx, query)`    — current+previous totals, hourly heatmap,
 *                              top 5 products.
 *   - `products(ctx, query)` — best sellers (25), dead inventory (50),
 *                              reorder rate (one ratio + counts).
 *
 * Why a service at all when the repo already returns shaped rows: the
 * previous-period window math, the AOV divide-by-zero guard, and the
 * reorder-rate rounding live here, isolated from the SQL. The portal's
 * server component can render straight from the response.
 *
 * No RLS scope wrapper here — the analytics queries are read-only and
 * cross several owning modules; the application-level
 * `WHERE dispensary_id = ctx.dispensaryId` predicate in every repo
 * method is the primary guard. A future Phase that swaps the vendor
 * surface onto an `app_vendor` connection pool can mirror the
 * `withScope` pattern from VendorListingsService without changing this
 * service.
 */
import { AnalyticsRepository } from '@dankdash/db';
import { Injectable } from '@nestjs/common';
import type {
  ProductsAnalyticsQuery,
  ProductsAnalyticsResponse,
  SalesAnalyticsQuery,
  SalesAnalyticsResponse,
} from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

/** Pre-bound repo accessor — production closes over the pooled DB token,
 *  tests return an in-memory fake. */
export type AnalyticsRepoFactory = () => AnalyticsRepository;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class VendorAnalyticsService {
  constructor(private readonly repoFor: AnalyticsRepoFactory) {}

  async sales(ctx: VendorContext, query: SalesAnalyticsQuery): Promise<SalesAnalyticsResponse> {
    const repo = this.repoFor();
    const from = new Date(query.from);
    const to = new Date(query.to);
    const windowMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - windowMs);
    const prevTo = from;

    const [current, previous, hourly, topProducts] = await Promise.all([
      repo.dispensarySalesBetween(ctx.dispensaryId, from, to),
      repo.dispensarySalesBetween(ctx.dispensaryId, prevFrom, prevTo),
      repo.dispensaryHourlyBetween(ctx.dispensaryId, from, to),
      repo.dispensaryTopProductsBetween(ctx.dispensaryId, from, to, 5),
    ]);

    return {
      from: query.from,
      to: query.to,
      revenueCents: current.revenueCents,
      previousRevenueCents: previous.revenueCents,
      orderCount: current.orderCount,
      previousOrderCount: previous.orderCount,
      avgOrderValueCents: avgCents(current.revenueCents, current.orderCount),
      previousAvgOrderValueCents: avgCents(previous.revenueCents, previous.orderCount),
      hourly,
      topProducts,
    };
  }

  async products(
    ctx: VendorContext,
    query: ProductsAnalyticsQuery,
  ): Promise<ProductsAnalyticsResponse> {
    const repo = this.repoFor();
    const from = new Date(query.from);
    const to = new Date(query.to);

    const [bestSellers, deadRows, reorder] = await Promise.all([
      repo.dispensaryTopProductsBetween(ctx.dispensaryId, from, to, 25),
      repo.dispensaryDeadInventory(ctx.dispensaryId, from, to, 50),
      repo.dispensaryReorderBetween(ctx.dispensaryId, from, to),
    ]);

    return {
      from: query.from,
      to: query.to,
      bestSellers,
      deadInventory: deadRows.map((row) => ({
        listingId: row.listingId,
        sku: row.sku,
        brand: row.brand,
        name: row.name,
        quantityAvailable: row.quantityAvailable,
        priceCents: row.priceCents,
        daysSinceLastSale:
          row.lastSoldAt === null
            ? null
            : Math.max(0, Math.floor((to.getTime() - row.lastSoldAt.getTime()) / DAY_MS)),
      })),
      reorderRate: {
        customerCount: reorder.customerCount,
        repeatCustomerCount: reorder.repeatCustomerCount,
        rate:
          reorder.customerCount === 0
            ? 0
            : roundTo4(reorder.repeatCustomerCount / reorder.customerCount),
      },
    };
  }
}

function avgCents(totalCents: number, orderCount: number): number {
  if (orderCount === 0) return 0;
  return Math.floor(totalCents / orderCount);
}

function roundTo4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

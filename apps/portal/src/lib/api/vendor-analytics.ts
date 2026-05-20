/**
 * Typed surface for the vendor-analytics endpoints the portal
 * analytics pages consume.
 *
 * Mirrors the wire shape from
 * `apps/api/src/modules/analytics/vendor/dto/`:
 *
 *   - `SalesAnalyticsResponseSchema`     → {@link SalesAnalytics}
 *   - `ProductsAnalyticsResponseSchema`  → {@link ProductsAnalytics}
 *
 * Hand-mirrored rather than imported to keep NestJS metadata out of the
 * Next bundle (same rationale as `vendor-orders.ts` / `vendor-listings.ts`).
 * A drift between this and the API DTO surfaces as a typecheck failure on
 * the consumer that reads a field that no longer exists.
 */
import type { ApiClient } from './client.js';

export interface AnalyticsWindowQuery {
  /** ISO-8601 (with offset). Inclusive lower bound for delivered orders. */
  readonly from: string;
  /** ISO-8601 (with offset). Exclusive upper bound. */
  readonly to: string;
}

export interface HourlyBucket {
  /** 0 = Sunday … 6 = Saturday, matching JS `Date#getDay`. */
  readonly dayOfWeek: number;
  /** Local hour in America/Chicago, 0..23. */
  readonly hour: number;
  readonly orderCount: number;
  readonly revenueCents: number;
}

export interface TopProduct {
  readonly productId: string;
  readonly brand: string;
  readonly name: string;
  readonly unitsSold: number;
  readonly revenueCents: number;
}

export interface SalesAnalytics {
  readonly from: string;
  readonly to: string;
  readonly revenueCents: number;
  readonly previousRevenueCents: number;
  readonly orderCount: number;
  readonly previousOrderCount: number;
  readonly avgOrderValueCents: number;
  readonly previousAvgOrderValueCents: number;
  readonly hourly: readonly HourlyBucket[];
  readonly topProducts: readonly TopProduct[];
}

export interface DeadInventoryRow {
  readonly listingId: string;
  readonly sku: string;
  readonly brand: string;
  readonly name: string;
  readonly quantityAvailable: number;
  readonly priceCents: number;
  /** `null` when the listing has never appeared in a delivered order. */
  readonly daysSinceLastSale: number | null;
}

export interface ReorderRate {
  readonly customerCount: number;
  readonly repeatCustomerCount: number;
  /** 0..1 rounded to 4 decimal places. */
  readonly rate: number;
}

export interface ProductsAnalytics {
  readonly from: string;
  readonly to: string;
  readonly bestSellers: readonly TopProduct[];
  readonly deadInventory: readonly DeadInventoryRow[];
  readonly reorderRate: ReorderRate;
}

/**
 * GET /v1/vendor/analytics/sales — revenue, AOV, hourly heatmap, top 5
 * products. The previous-period numbers come back as their own fields so
 * the portal renders deltas without a second round-trip.
 */
export async function getVendorSalesAnalytics(
  client: ApiClient,
  window: AnalyticsWindowQuery,
): Promise<SalesAnalytics> {
  return client.request<SalesAnalytics>('/v1/vendor/analytics/sales', {
    query: { from: window.from, to: window.to },
  });
}

/**
 * GET /v1/vendor/analytics/products — best sellers (25), dead inventory
 * (50 listings with no sales in the window), and the reorder rate.
 */
export async function getVendorProductsAnalytics(
  client: ApiClient,
  window: AnalyticsWindowQuery,
): Promise<ProductsAnalytics> {
  return client.request<ProductsAnalytics>('/v1/vendor/analytics/products', {
    query: { from: window.from, to: window.to },
  });
}

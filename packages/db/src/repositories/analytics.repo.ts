/**
 * Cross-domain analytics queries for the vendor portal.
 *
 *   - `dispensarySalesBetween`     — totals over `delivered_at`
 *   - `dispensaryHourlyBetween`    — local-time heatmap buckets
 *   - `dispensaryTopProductsBetween` — product distribution (units + $)
 *   - `dispensaryReorderBetween`   — distinct customers + repeats
 *   - `dispensaryDeadInventory`    — listings with no sales in the window
 *
 * Read-only by construction. Time bounds are always half-open: `since`
 * inclusive, `until` exclusive — so consecutive buckets stitched at the
 * same instant never double-count the boundary. Status filter is
 * `delivered` (not "any non-canceled") because the vendor portal's
 * revenue chart is the realized cash line, not gross merchandise volume.
 *
 * The day-of-week / hour bucketing converts the timestamp to local time
 * via `AT TIME ZONE 'America/Chicago'` before extracting fields. Every
 * MN dispensary is in the same zone per spec §6.1, so a hardcoded zone
 * here is correct; if/when the platform expands to other states, the
 * dispensary row's timezone column becomes a join key.
 *
 * Index coverage:
 *   - sales/hourly      — `orders_dispensary_status_idx (dispensary_id,
 *                          status, placed_at)` is leveraged by the
 *                          planner against the `(dispensary_id, status)`
 *                          prefix; `delivered_at` filter falls back to
 *                          a per-row check on the narrow result set.
 *                          Acceptable for typical windows (≤366 days);
 *                          larger windows are blocked at the DTO.
 *   - top products      — `order_items_order_idx` for the order-items
 *                          join, then a hash-aggregate by productId.
 *   - reorder           — group-by user_id over the same predicate set.
 *   - dead inventory    — `dispensary_listings_dispensary_active_idx`
 *                          (partial WHERE quantity_available > 0)
 *                          drives the outer scan; the NOT EXISTS uses
 *                          `order_items_listing_idx`.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { products, dispensaryListings } from '../schema/catalog.js';
import { orders, orderItems } from '../schema/orders.js';
import { BaseRepository } from './base.js';

export interface SalesAggregateRow {
  readonly revenueCents: number;
  readonly orderCount: number;
}

export interface HourlyBucketRow {
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly orderCount: number;
  readonly revenueCents: number;
}

export interface TopProductRow {
  readonly productId: string;
  readonly brand: string;
  readonly name: string;
  readonly unitsSold: number;
  readonly revenueCents: number;
}

export interface ReorderCountsRow {
  readonly customerCount: number;
  readonly repeatCustomerCount: number;
}

export interface DeadInventoryRow {
  readonly listingId: string;
  readonly sku: string;
  readonly brand: string;
  readonly name: string;
  readonly quantityAvailable: number;
  readonly priceCents: number;
  /** UTC instant of the most recent delivered sale; null if never sold. */
  readonly lastSoldAt: Date | null;
}

export class AnalyticsRepository extends BaseRepository {
  /**
   * Sum of `total_cents` + count of delivered orders for a dispensary in
   * `[since, until)`. Returned as integers — the SQL cast keeps the value
   * inside the JS safe-integer range; for a single MN dispensary one year
   * of revenue lands well below 2^53 cents (~$90 trillion).
   */
  async dispensarySalesBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<SalesAggregateRow> {
    const [row] = await this.db
      .select({
        revenueCents: sql<string>`COALESCE(SUM(${orders.totalCents}), 0)::bigint::text`,
        orderCount: sql<number>`COUNT(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.dispensaryId, dispensaryId),
          eq(orders.status, 'delivered'),
          isNotNull(orders.deliveredAt),
          sql`${orders.deliveredAt} >= ${since}`,
          sql`${orders.deliveredAt} < ${until}`,
        ),
      );
    return {
      revenueCents: row === undefined ? 0 : Number(row.revenueCents),
      orderCount: row?.orderCount ?? 0,
    };
  }

  /**
   * Local-time (America/Chicago) day-of-week × hour heatmap for delivered
   * orders. Only non-empty buckets are returned; the API layer fills in
   * the 168-cell grid client-side (or the chart renders the sparse set).
   *
   * `EXTRACT(DOW)` returns 0..6 with Sunday = 0, matching JS
   * `Date#getDay`. `EXTRACT(HOUR)` returns 0..23.
   */
  async dispensaryHourlyBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<readonly HourlyBucketRow[]> {
    const rows = await this.db.execute<{
      day_of_week: number;
      hour: number;
      order_count: number;
      revenue_cents: string;
    }>(sql`
      SELECT
        EXTRACT(DOW FROM (${orders.deliveredAt} AT TIME ZONE 'America/Chicago'))::int AS day_of_week,
        EXTRACT(HOUR FROM (${orders.deliveredAt} AT TIME ZONE 'America/Chicago'))::int AS hour,
        COUNT(*)::int AS order_count,
        COALESCE(SUM(${orders.totalCents}), 0)::bigint::text AS revenue_cents
      FROM ${orders}
      WHERE ${orders.dispensaryId} = ${dispensaryId}
        AND ${orders.status} = 'delivered'
        AND ${orders.deliveredAt} IS NOT NULL
        AND ${orders.deliveredAt} >= ${since}
        AND ${orders.deliveredAt} < ${until}
      GROUP BY day_of_week, hour
      ORDER BY day_of_week, hour
    `);
    return rows.map((r) => ({
      dayOfWeek: r.day_of_week,
      hour: r.hour,
      orderCount: r.order_count,
      revenueCents: Number(r.revenue_cents),
    }));
  }

  /**
   * Product distribution over delivered orders in `[since, until)`.
   * Aggregates `order_items.quantity` and `line_subtotal_cents` per
   * `productId`, joined to `products` for the brand+name projection.
   *
   * `limit` defaults high (25) so a single call serves both the small
   * "top 5" card on the sales page and the full table on the products
   * page; the analytics service slices as needed.
   */
  async dispensaryTopProductsBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
    limit = 25,
  ): Promise<readonly TopProductRow[]> {
    // Join via `dispensary_listings.product_id` rather than the snapshot's
    // embedded productId — the FK chain is indexed, the JSONB extraction
    // path is not. The snapshot is authoritative for *historic* product
    // attributes (price/name at checkout time), but the global catalog's
    // brand+name is what the vendor wants to see on a current-period
    // top-sellers panel.
    const rows = await this.db
      .select({
        productId: products.id,
        brand: products.brand,
        name: products.name,
        unitsSold: sql<number>`COALESCE(SUM(${orderItems.quantity}), 0)::int`,
        revenueCents: sql<string>`COALESCE(SUM(${orderItems.lineSubtotalCents}), 0)::bigint::text`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(dispensaryListings, eq(dispensaryListings.id, orderItems.listingId))
      .innerJoin(products, eq(products.id, dispensaryListings.productId))
      .where(
        and(
          eq(orders.dispensaryId, dispensaryId),
          eq(orders.status, 'delivered'),
          isNotNull(orders.deliveredAt),
          sql`${orders.deliveredAt} >= ${since}`,
          sql`${orders.deliveredAt} < ${until}`,
        ),
      )
      .groupBy(products.id, products.brand, products.name)
      .orderBy(sql`SUM(${orderItems.lineSubtotalCents}) DESC NULLS LAST`)
      .limit(limit);
    return rows.map((r) => ({
      productId: r.productId,
      brand: r.brand,
      name: r.name,
      unitsSold: r.unitsSold,
      revenueCents: Number(r.revenueCents),
    }));
  }

  /**
   * Distinct customer count + customers with ≥2 delivered orders in the
   * window. One query so the reorder rate is computed from the same row
   * set (no race between two queries straddling a new delivery).
   */
  async dispensaryReorderBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<ReorderCountsRow> {
    const result = await this.db.execute<{
      customer_count: number;
      repeat_customer_count: number;
    }>(sql`
      SELECT
        COUNT(*)::int AS customer_count,
        COUNT(*) FILTER (WHERE delivered_count >= 2)::int AS repeat_customer_count
      FROM (
        SELECT ${orders.userId} AS user_id, COUNT(*) AS delivered_count
        FROM ${orders}
        WHERE ${orders.dispensaryId} = ${dispensaryId}
          AND ${orders.status} = 'delivered'
          AND ${orders.deliveredAt} IS NOT NULL
          AND ${orders.deliveredAt} >= ${since}
          AND ${orders.deliveredAt} < ${until}
        GROUP BY ${orders.userId}
      ) c
    `);
    const row = result[0];
    return {
      customerCount: row?.customer_count ?? 0,
      repeatCustomerCount: row?.repeat_customer_count ?? 0,
    };
  }

  /**
   * Listings the dispensary has in stock that produced zero delivered
   * orders inside `[since, until)`. The "last sold" timestamp is the most
   * recent delivered sale for the listing across ALL time, so the portal
   * can render either "Never sold" or "Last sold 47 days ago" with no
   * extra fetch. Limit defaults to 50 — the table is paginated client-
   * side and 50 rows is enough to cover the longest dead-stock list a
   * single dispensary will ever care to triage in one sitting.
   */
  async dispensaryDeadInventory(
    dispensaryId: string,
    since: Date,
    until: Date,
    limit = 50,
  ): Promise<readonly DeadInventoryRow[]> {
    const rows = await this.db.execute<{
      listing_id: string;
      sku: string;
      brand: string;
      name: string;
      quantity_available: number;
      price_cents: number;
      last_sold_at: string | null;
    }>(sql`
      SELECT
        ${dispensaryListings.id}                  AS listing_id,
        ${dispensaryListings.sku}                 AS sku,
        ${products.brand}                         AS brand,
        ${products.name}                          AS name,
        ${dispensaryListings.quantityAvailable}   AS quantity_available,
        ${dispensaryListings.priceCents}          AS price_cents,
        (
          SELECT MAX(o.delivered_at)
          FROM ${orderItems} i
          INNER JOIN ${orders} o ON o.id = i.order_id
          WHERE i.listing_id = ${dispensaryListings.id}
            AND o.status = 'delivered'
            AND o.delivered_at IS NOT NULL
        )                                          AS last_sold_at
      FROM ${dispensaryListings}
      INNER JOIN ${products} ON ${products.id} = ${dispensaryListings.productId}
      WHERE ${dispensaryListings.dispensaryId} = ${dispensaryId}
        AND ${dispensaryListings.isActive} = true
        AND ${dispensaryListings.quantityAvailable} > 0
        AND NOT EXISTS (
          SELECT 1 FROM ${orderItems} i
          INNER JOIN ${orders} o ON o.id = i.order_id
          WHERE i.listing_id = ${dispensaryListings.id}
            AND o.dispensary_id = ${dispensaryId}
            AND o.status = 'delivered'
            AND o.delivered_at IS NOT NULL
            AND o.delivered_at >= ${since}
            AND o.delivered_at < ${until}
        )
      ORDER BY ${dispensaryListings.quantityAvailable} DESC,
               ${dispensaryListings.priceCents} DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      listingId: r.listing_id,
      sku: r.sku,
      brand: r.brand,
      name: r.name,
      quantityAvailable: r.quantity_available,
      priceCents: r.price_cents,
      lastSoldAt: r.last_sold_at === null ? null : new Date(r.last_sold_at),
    }));
  }
}

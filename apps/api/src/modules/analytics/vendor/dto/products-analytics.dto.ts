/**
 * DTOs for the vendor-portal product analytics surface.
 *
 *   GET /v1/vendor/analytics/products?from=ISO&to=ISO
 *
 * Three discrete projections share the same window:
 *
 *   - bestSellers   — highest unit volume across delivered orders in
 *                     [from, to). Same shape as `topProducts` on the
 *                     sales endpoint, but limited to 25 rows because the
 *                     product page renders a full table not a card.
 *   - deadInventory — listings with quantityAvailable > 0 that have
 *                     never appeared in a delivered order inside the
 *                     window. The portal can sort by `quantityAvailable`
 *                     desc to surface the biggest cash-tied-up rows.
 *   - reorderRate   — % of customers who placed ≥2 delivered orders in
 *                     the window. A single ratio + the constituent
 *                     counts so the UI can render "32%  (192 / 600)".
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SalesAnalyticsQuerySchema } from './sales-analytics.dto.js';

export const ProductsAnalyticsQuerySchema = SalesAnalyticsQuerySchema;
export type ProductsAnalyticsQuery = z.infer<typeof ProductsAnalyticsQuerySchema>;
export class ProductsAnalyticsQueryDto extends createZodDto(ProductsAnalyticsQuerySchema) {}

export const BestSellerSchema = z
  .object({
    productId: z.string().uuid(),
    brand: z.string(),
    name: z.string(),
    unitsSold: z.number().int().min(0),
    revenueCents: z.number().int().min(0),
  })
  .strict();
export type BestSeller = z.infer<typeof BestSellerSchema>;

export const DeadInventoryRowSchema = z
  .object({
    listingId: z.string().uuid(),
    sku: z.string(),
    brand: z.string(),
    name: z.string(),
    quantityAvailable: z.number().int().min(0),
    priceCents: z.number().int().min(0),
    /**
     * `null` when the listing has never appeared in a delivered order. A
     * numeric value is the integer days elapsed between the most recent
     * delivered sale and the window's `to` boundary.
     */
    daysSinceLastSale: z.number().int().min(0).nullable(),
  })
  .strict();
export type DeadInventoryRow = z.infer<typeof DeadInventoryRowSchema>;

export const ReorderRateSchema = z
  .object({
    /** Customers with ≥1 delivered order in the window. */
    customerCount: z.number().int().min(0),
    /** Customers with ≥2 delivered orders in the window. */
    repeatCustomerCount: z.number().int().min(0),
    /**
     * `repeatCustomerCount / customerCount` rounded to four decimal
     * places (so the portal can render "0.32" → "32.00%"). Zero when
     * `customerCount === 0`.
     */
    rate: z.number().min(0).max(1),
  })
  .strict();
export type ReorderRate = z.infer<typeof ReorderRateSchema>;

export const ProductsAnalyticsResponseSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    bestSellers: z.array(BestSellerSchema).readonly(),
    deadInventory: z.array(DeadInventoryRowSchema).readonly(),
    reorderRate: ReorderRateSchema,
  })
  .strict();
export type ProductsAnalyticsResponse = z.infer<typeof ProductsAnalyticsResponseSchema>;
export class ProductsAnalyticsResponseDto extends createZodDto(ProductsAnalyticsResponseSchema) {}

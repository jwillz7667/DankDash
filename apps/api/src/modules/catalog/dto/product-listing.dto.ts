/**
 * Query + response DTOs for `GET /v1/products/:id/listings`.
 *
 * Search is dispensary-agnostic — a hit carries no listing (price / stock /
 * store) because a single product can be carried by many dispensaries at
 * independent prices. Before the consumer app can add a search hit to the
 * cart it has to resolve a concrete listing; this endpoint returns the
 * stores actively carrying the product, in-stock, so the client can pick
 * one deterministically (its cart's current dispensary if it has one, else
 * the cheapest).
 *
 *   limit   — page size, 1..50. Default 24 to match the search grid.
 *   offset  — page offset, >=0.
 *
 * The row shape mirrors the per-listing half of a menu line
 * (`MenuItemResponse`) plus the resolved `dispensaryName` so the detail
 * screen can render "Sold by <store>" without a second round-trip. Product
 * fields are intentionally absent — the client already holds the search hit
 * (and re-fetches the full record via `GET /v1/products/:id`).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ProductListingsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(24),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ProductListingsQuery = z.infer<typeof ProductListingsQuerySchema>;

export class ProductListingsQueryDto extends createZodDto(ProductListingsQuerySchema) {}

export const ProductListingResultSchema = z
  .object({
    listingId: z.string().uuid(),
    dispensaryId: z.string().uuid(),
    dispensaryName: z.string(),
    sku: z.string(),
    priceCents: z.number().int().positive(),
    compareAtPriceCents: z.number().int().positive().nullable(),
    quantityAvailable: z.number().int().nonnegative(),
  })
  .strict();

export type ProductListingResult = z.infer<typeof ProductListingResultSchema>;

export const ProductListingsPageSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().min(0),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const ProductListingsResponseSchema = z
  .object({
    listings: z.array(ProductListingResultSchema).readonly(),
    page: ProductListingsPageSchema,
  })
  .strict();

export type ProductListingsResponse = z.infer<typeof ProductListingsResponseSchema>;

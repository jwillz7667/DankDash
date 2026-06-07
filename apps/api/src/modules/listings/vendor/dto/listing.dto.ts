/**
 * Vendor-facing listing projection.
 *
 *   POST  /v1/vendor/listings           — single ListingResponse (lean — the
 *                                          form already has the product info)
 *   PATCH /v1/vendor/listings/:id       — single ListingResponse (lean — the
 *                                          table row keeps the product locally
 *                                          and merges the patch return value)
 *   GET   /v1/vendor/listings           — ListingListResponse of
 *                                          ListingWithProductResponse — the
 *                                          menu table needs brand/name/type/
 *                                          imageKeys per row, joined server-
 *                                          side to avoid N+1
 *
 * The shape is the same view a vendor sees in the portal: per-SKU price,
 * inventory, the Metrc package tag, and a flag for whether the listing is
 * publicly surfaced. `lastSyncedAt` and `isActive` are present here (unlike
 * the public menu) because the vendor needs to see deactivated rows in
 * order to reactivate them, and the Metrc-sync timestamp is what they
 * pivot on when reconciling a manual edit against an automated sync.
 *
 * GET includes a compact `product` summary so the menu page can render
 * brand/name/image without an N+1 trip back to the catalog endpoint. The
 * embed is intentionally a *summary*, not the full Product — descriptions,
 * tags, and lab results are not needed at the list-row level. POST/PATCH
 * intentionally omit product to keep their hot path small; the table row
 * keeps the product reference locally between edits.
 *
 * Money fields are integer cents (the schema is `int4`); cannabis weights
 * elsewhere in the catalog DTO are decimal strings.
 */
import { z } from 'zod';

export const ListingResponseSchema = z
  .object({
    id: z.string().uuid(),
    dispensaryId: z.string().uuid(),
    productId: z.string().uuid(),
    sku: z.string(),
    priceCents: z.number().int().positive(),
    compareAtPriceCents: z.number().int().positive().nullable(),
    quantityAvailable: z.number().int().nonnegative(),
    imageKeys: z.array(z.string()).readonly(),
    metrcPackageTag: z.string().nullable(),
    lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
    isActive: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ListingResponse = z.infer<typeof ListingResponseSchema>;

/**
 * Compact product fields the vendor menu row renders.
 *
 *   - `isActive` and `deletedAt` surface so the row can show "archived" when
 *     a product is no longer in the global catalog (the public menu join
 *     hides it; the vendor portal needs to know why).
 *   - `imageKeys` is the full array so the portal can pick the index it
 *     prefers (most surfaces use [0]). Empty is acceptable; the row falls
 *     back to a placeholder tile.
 *   - `thcMgPerUnit` and `weightGramsPerUnit` are decimal strings to match
 *     the schema's `numeric` columns; the portal converts at the display
 *     boundary, never on the wire.
 */
export const VendorListingProductSummarySchema = z
  .object({
    id: z.string().uuid(),
    brand: z.string(),
    name: z.string(),
    productType: z.string(),
    strainType: z.string().nullable(),
    thcMgPerUnit: z.string(),
    weightGramsPerUnit: z.string(),
    imageKeys: z.array(z.string()).readonly(),
    isActive: z.boolean(),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type VendorListingProductSummary = z.infer<typeof VendorListingProductSummarySchema>;

export const ListingWithProductResponseSchema = ListingResponseSchema.extend({
  product: VendorListingProductSummarySchema,
}).strict();

export type ListingWithProductResponse = z.infer<typeof ListingWithProductResponseSchema>;

export const ListingListResponseSchema = z
  .object({
    listings: z.array(ListingWithProductResponseSchema).readonly(),
  })
  .strict();

export type ListingListResponse = z.infer<typeof ListingListResponseSchema>;

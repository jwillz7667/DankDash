/**
 * Vendor-facing listing projection.
 *
 *   GET   /v1/vendor/listings           — list of ListingResponse
 *   POST  /v1/vendor/listings           — single ListingResponse
 *   PATCH /v1/vendor/listings/:id       — single ListingResponse
 *
 * The shape is the same view a vendor sees in the portal: per-SKU price,
 * inventory, the Metrc package tag, and a flag for whether the listing is
 * publicly surfaced. `lastSyncedAt` and `isActive` are present here (unlike
 * the public menu) because the vendor needs to see deactivated rows in
 * order to reactivate them, and the Metrc-sync timestamp is what they
 * pivot on when reconciling a manual edit against an automated sync.
 *
 * The product is referenced by id only — the vendor portal renders the
 * product card from the global catalog read endpoint. Embedding the
 * product here would force every list/patch round trip to re-ship
 * descriptions, image keys, and tags the portal already has cached, and
 * would also make catalog edits invalidate vendor list caches needlessly.
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
    metrcPackageTag: z.string().nullable(),
    lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
    isActive: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ListingResponse = z.infer<typeof ListingResponseSchema>;

export const ListingListResponseSchema = z
  .object({
    listings: z.array(ListingResponseSchema).readonly(),
  })
  .strict();

export type ListingListResponse = z.infer<typeof ListingListResponseSchema>;

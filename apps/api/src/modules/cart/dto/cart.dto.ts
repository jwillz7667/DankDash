/**
 * Cart response projection.
 *
 *   POST   /v1/carts                       — CartResponse
 *   GET    /v1/carts/:id                   — CartResponse
 *   POST   /v1/carts/:id/items             — CartResponse
 *   PATCH  /v1/carts/:id/items/:itemId     — CartResponse
 *   DELETE /v1/carts/:id/items/:itemId     — CartResponse
 *
 * The shape mirrors what the iOS cart screen renders: the cart envelope
 * (owner, dispensary context, lifecycle timestamps), the line items
 * (listing reference, quantity, snapshotted unit price, line subtotal),
 * and the aggregate subtotal for the price stripe. Tax/fee/tip totals
 * are NOT on this shape — they belong to the validate (Phase 5.2) and
 * checkout (Phase 5.3) responses, which run the full pricing engine and
 * the compliance check. Returning a fictitious tax total here would
 * encourage the client to render a number it then has to overwrite.
 *
 * The item's `listingId` is the foreign key only — product details
 * (brand, name, image keys, COA) come from the catalog response the
 * client has already cached. Embedding the product card here would
 * require the cache invalidation surface to also invalidate cart reads,
 * and the consumer is in the same session as the menu read 99% of the
 * time anyway.
 *
 * Money fields are integer cents (matches schema `int4`). Weights and
 * THC totals are intentionally absent — the cart line stores only what
 * the line CHECK constraint references; the compliance engine reads
 * weights from the product row at validate-time, not from cart memory.
 */
import { z } from 'zod';

export const CartItemResponseSchema = z
  .object({
    id: z.string().uuid(),
    listingId: z.string().uuid(),
    quantity: z.number().int().positive(),
    unitPriceCents: z.number().int().nonnegative(),
    lineSubtotalCents: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CartItemResponse = z.infer<typeof CartItemResponseSchema>;

export const CartResponseSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    dispensaryId: z.string().uuid(),
    items: z.array(CartItemResponseSchema).readonly(),
    subtotalCents: z.number().int().nonnegative(),
    expiresAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CartResponse = z.infer<typeof CartResponseSchema>;

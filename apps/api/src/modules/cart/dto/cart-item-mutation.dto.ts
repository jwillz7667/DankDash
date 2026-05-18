/**
 * Cart-item mutation DTOs.
 *
 *   POST  /v1/carts/:id/items            — AddCartItemRequest  { listingId, quantity }
 *   PATCH /v1/carts/:id/items/:itemId    — PatchCartItemRequest { quantity }
 *
 * The unitPrice is not in either body. The cart service reads it from the
 * listing row at the moment of write — the customer is not authoritative
 * on price, and the rate of price changes is low enough that snapshotting
 * at add-time is a clean UX (subsequent listing edits do not silently
 * mutate the cart). Compliance and inventory checks fire on validate /
 * checkout, not on cart-item mutation, so the body stays minimal.
 *
 * Quantity bounds:
 *   - lower: the schema's `quantity > 0` CHECK constraint precludes 0
 *     in a row. The PATCH endpoint accepts `quantity: 0` semantically
 *     (caller-friendly "set to zero" === "remove"); the service routes
 *     that to a delete instead of an UPDATE.
 *   - upper: 9_999 — a sanity cap. No MN per-transaction-limit business
 *     rule produces a single SKU quantity anywhere near that; the cap
 *     keeps a typo (1_000_000) from producing a misleading 422 from
 *     the compliance engine 30 lines downstream.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const QUANTITY_MAX = 9_999;

export const AddCartItemRequestSchema = z
  .object({
    listingId: z.string().uuid(),
    quantity: z.number().int().min(1).max(QUANTITY_MAX),
  })
  .strict();

export type AddCartItemRequest = z.infer<typeof AddCartItemRequestSchema>;

export class AddCartItemRequestDto extends createZodDto(AddCartItemRequestSchema) {}

export const PatchCartItemRequestSchema = z
  .object({
    quantity: z.number().int().min(0).max(QUANTITY_MAX),
  })
  .strict();

export type PatchCartItemRequest = z.infer<typeof PatchCartItemRequestSchema>;

export class PatchCartItemRequestDto extends createZodDto(PatchCartItemRequestSchema) {}

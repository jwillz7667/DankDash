/**
 * Checkout request body — `POST /v1/carts/:id/checkout`.
 *
 * The cart id is in the URL path (so it matches the cart surface's URL
 * scheme); the body carries the per-order context the cart row does not
 * persist:
 *
 *   - `deliveryAddressId`    — the customer's address for this order. Must
 *                              belong to the same user as the cart (the
 *                              service 404s a cross-user id with the same
 *                              shape as a missing one, so a probe cannot
 *                              distinguish). Drives the geofence rule.
 *   - `paymentMethodId`      — optional in Phase 5 (Aeropay lands in
 *                              Phase 6). When omitted, the checkout uses
 *                              the user's default Aeropay-ACH method, or
 *                              a `null` payment-method ref on the
 *                              transaction row if none exists yet. The
 *                              `payment_methods` table FK is nullable on
 *                              `payment_transactions.payment_method_id`
 *                              because Aeropay's authorize call sometimes
 *                              creates the method on the fly.
 *   - `driverTipCents`       — pre-delivery tip in integer cents. Lands
 *                              on `orders.driver_tip_cents` and on a
 *                              dedicated ledger entry to the driver
 *                              account at delivery time. Required, with
 *                              a $2 floor (every order is a delivery and
 *                              the driver tip is mandatory) and a $500
 *                              cap — a higher tip is almost certainly a
 *                              UI bug.
 *   - `deliveryInstructions` — free-text note for the driver. Trimmed to
 *                              500 characters at the schema layer so a
 *                              pasted essay never reaches Postgres. Stored
 *                              in the `delivery_address_snapshot` JSONB
 *                              alongside the rest of the address.
 *
 * Strict (no extra keys): the body shape is the contract; an unknown key
 * is either a client bug or a probe and we reject it rather than silently
 * dropping it.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Driver tips are voluntary, but pre-paid. Capping at $500 prevents a
 * fat-finger or a UI off-by-100 (e.g. cents/dollars confusion) from
 * placing an order with a four-figure tip the customer cannot recover
 * without a refund. The cap is intentionally generous: a $200 cannabis
 * order with a $400 tip is implausible but not impossible.
 */
export const MAX_DRIVER_TIP_CENTS = 50_000;

/**
 * Every order is a delivery, and the platform guarantees drivers a tip on
 * each one: $2 minimum, business rule from product. The field is required
 * (no default) — silently charging a customer a tip they never chose is
 * worse than rejecting the request, so clients must state the tip
 * explicitly. iOS mirrors this floor in `TipPolicy` for UX preview; this
 * schema is the authoritative check.
 */
export const MIN_DRIVER_TIP_CENTS = 200;

/**
 * Cap on the free-text driver note. Keeps the JSONB snapshot small (the
 * snapshot is read into memory at every order list / detail surface).
 */
export const MAX_DELIVERY_INSTRUCTIONS_LENGTH = 500;

export const CheckoutRequestSchema = z
  .object({
    deliveryAddressId: z.string().uuid(),
    paymentMethodId: z.string().uuid().optional(),
    driverTipCents: z.number().int().min(MIN_DRIVER_TIP_CENTS).max(MAX_DRIVER_TIP_CENTS),
    deliveryInstructions: z.string().trim().max(MAX_DELIVERY_INSTRUCTIONS_LENGTH).optional(),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export class CheckoutRequestDto extends createZodDto(CheckoutRequestSchema) {}

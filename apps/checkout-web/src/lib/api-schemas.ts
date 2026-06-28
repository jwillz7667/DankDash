/**
 * Zod schemas for the DankDash API responses checkout-web consumes, plus the
 * inferred types. We parse every response at the network boundary rather than
 * trusting the shape: this surface handles a payment, so a contract drift on
 * the API side should surface as a typed error here, not a render crash or a
 * silently-wrong total.
 *
 * The shapes mirror the authoritative DTOs in apps/api:
 *   - exchange   → auth/dto/checkout-handoff.dto.ts (CheckoutHandoffExchangeResponse)
 *   - cart       → cart/dto/cart.dto.ts (CartResponse)
 *   - compliance → cart/dto/validate-cart.dto.ts (ValidateCartResponse)
 *   - checkout   → checkout/dto/checkout-response.dto.ts (CheckoutResponse)
 */
import { z } from 'zod';

export const exchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresInSeconds: z.number().int().positive(),
  cartId: z.string().uuid(),
  deliveryAddressId: z.string().uuid(),
});
export type ExchangeResponse = z.infer<typeof exchangeResponseSchema>;

export const cartItemSchema = z.object({
  id: z.string().uuid(),
  listingId: z.string().uuid(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  lineSubtotalCents: z.number().int().nonnegative(),
});
export type CartItem = z.infer<typeof cartItemSchema>;

export const cartSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  dispensaryId: z.string().uuid(),
  items: z.array(cartItemSchema),
  subtotalCents: z.number().int().nonnegative(),
  expiresAt: z.string(),
});
export type Cart = z.infer<typeof cartSchema>;

export const ruleResultSchema = z.object({
  rule: z.string(),
  passed: z.boolean(),
  details: z.record(z.unknown()),
});
export type RuleResult = z.infer<typeof ruleResultSchema>;

export const complianceSchema = z.object({
  passed: z.boolean(),
  rules: z.array(ruleResultSchema),
  cartTotals: z.object({
    flowerGrams: z.number().nonnegative(),
    concentrateGrams: z.number().nonnegative(),
    edibleThcMg: z.number().nonnegative(),
  }),
  limits: z.object({
    flowerGramsMax: z.number().positive(),
    concentrateGramsMax: z.number().positive(),
    edibleThcMgMax: z.number().positive(),
  }),
  evaluatedAt: z.string(),
  evaluationVersion: z.string().min(1),
});
export type Compliance = z.infer<typeof complianceSchema>;

export const checkoutOrderSchema = z.object({
  id: z.string().uuid(),
  shortCode: z.string(),
  status: z.string(),
  subtotalCents: z.number().int().nonnegative(),
  cannabisTaxCents: z.number().int().nonnegative(),
  salesTaxCents: z.number().int().nonnegative(),
  deliveryFeeCents: z.number().int().nonnegative(),
  driverTipCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
});
export type CheckoutOrder = z.infer<typeof checkoutOrderSchema>;

export const checkoutResponseSchema = z.object({
  order: checkoutOrderSchema,
  paymentIntent: z.object({
    provider: z.string(),
    status: z.string(),
    amountCents: z.number().int().nonnegative(),
  }),
});
export type CheckoutResult = z.infer<typeof checkoutResponseSchema>;

/** The DankDash error envelope (openapi-excerpt.yaml). */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * /v1/auth/checkout-handoff DTOs.
 *
 *   POST /v1/auth/checkout-handoff
 *     body     { cartId, deliveryAddressId }
 *     response { handoffToken, exchangeUrl, expiresAt }
 *
 * The iOS consumer mints a single-shot token, opens the returned
 * `exchangeUrl` inside SFSafariViewController, and lets checkout-web
 * exchange the token for a session + run the actual payment flow (Apple
 * §10.4: iOS itself is forbidden from carrying a checkout surface).
 *
 * `exchangeUrl` is composed server-side and returned fully qualified so
 * iOS never templates URLs (a class of typos and per-env divergence
 * mistakes). The token is short-lived (5 minutes by default) and
 * single-shot — the second exchange of the same `jti` returns 401 even
 * if the JWT signature still verifies.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CheckoutHandoffRequestSchema = z
  .object({
    cartId: z.string().uuid(),
    deliveryAddressId: z.string().uuid(),
  })
  .strict();
export class CheckoutHandoffRequestDto extends createZodDto(CheckoutHandoffRequestSchema) {}

export const CheckoutHandoffResponseSchema = z
  .object({
    handoffToken: z.string(),
    exchangeUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CheckoutHandoffResponse = z.infer<typeof CheckoutHandoffResponseSchema>;

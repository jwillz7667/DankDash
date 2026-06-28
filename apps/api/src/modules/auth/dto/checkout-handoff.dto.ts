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

/**
 * POST /v1/auth/checkout-handoff/exchange
 *
 *   body     { handoff }   — the single-shot JWT from the iOS hand-off
 *   response { accessToken, tokenType, expiresInSeconds, cartId,
 *              deliveryAddressId }
 *
 * checkout-web (the Apple §10.4 web surface) calls this server-side the
 * moment Safari opens `${CHECKOUT_BASE_URL}/checkout?handoff=<jwt>`. The
 * endpoint is `@Public` because the hand-off token IS the credential; it is
 * verified + atomically consumed (one-shot via the `jti` Redis claim) by
 * `CheckoutHandoffService.consume`. The minted `accessToken` is a normal
 * `aud: dankdash.app` access token — a different audience from the
 * hand-off's `dankdash.checkout`, so the two surfaces never cross-validate —
 * which checkout-web then presents to `GET /v1/carts/:id` and
 * `POST /v1/carts/:id/checkout`.
 */
export const CheckoutHandoffExchangeRequestSchema = z
  .object({
    handoff: z.string().min(1),
  })
  .strict();
export class CheckoutHandoffExchangeRequestDto extends createZodDto(
  CheckoutHandoffExchangeRequestSchema,
) {}

export const CheckoutHandoffExchangeResponseSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresInSeconds: z.number().int().positive(),
    cartId: z.string().uuid(),
    deliveryAddressId: z.string().uuid(),
  })
  .strict();
export type CheckoutHandoffExchangeResponse = z.infer<typeof CheckoutHandoffExchangeResponseSchema>;

/**
 * Checkout capabilities — `GET /v1/checkout/capabilities`.
 *
 * A tiny, authenticated probe the iOS consumer calls before rendering the
 * cart's checkout controls. It advertises whether the server is running
 * in the test-only payment-bypass mode (`PAYMENTS_BYPASS_ENABLED`,
 * default OFF). The value is sourced from the *same* flag the
 * `CheckoutService` enforces at checkout time, so the client can never
 * surface an in-app "place order" affordance that the server would then
 * refuse — and, critically, in production (flag OFF) the affordance is
 * hidden, keeping the consumer app compliant with Apple §10.4 (no in-app
 * checkout of a cannabis purchase).
 *
 * `.strict()` so an accidental extra key on the wire is a loud failure,
 * not a silent contract drift the iOS decoder would ignore.
 */
import { z } from 'zod';

export const CheckoutCapabilitiesResponseSchema = z
  .object({
    paymentBypassEnabled: z.boolean(),
  })
  .strict();

export type CheckoutCapabilitiesResponse = z.infer<typeof CheckoutCapabilitiesResponseSchema>;

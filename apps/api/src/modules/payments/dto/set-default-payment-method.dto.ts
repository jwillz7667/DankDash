/**
 * Request + response shapes for promoting a payment method to the user's
 * default.
 *
 *   PATCH /v1/payment-methods/:id
 *     body  → { isDefault: true }
 *     200   → { paymentMethod: PaymentMethodResponse }
 *
 * `isDefault` is a `z.literal(true)`, not a boolean: the only mutation this
 * endpoint performs is promotion. Un-defaulting is implicit — promoting a
 * different method demotes the previous holder inside the same DB
 * transaction (`PaymentMethodsRepository.setDefault`). There is deliberately
 * no "clear the default" operation: a user always has at most one default
 * and removing the concept of a default (rather than moving it) has no
 * product meaning. A `false` therefore fails validation up front rather
 * than reaching the service as a no-op.
 *
 * The response is wrapped in `{ paymentMethod }` to match the rest of the
 * payments module (`list` → `{ paymentMethods }`, `link` →
 * `{ paymentMethod, link }`); the client still re-lists afterwards to pick
 * up the demoted previous default, but the promoted row is returned so an
 * optimistic UI can reflect it immediately.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaymentMethodResponseSchema } from './payment-method.dto.js';

export const SetDefaultPaymentMethodRequestSchema = z
  .object({
    isDefault: z.literal(true),
  })
  .strict();

export type SetDefaultPaymentMethodRequest = z.infer<typeof SetDefaultPaymentMethodRequestSchema>;

export class SetDefaultPaymentMethodRequestDto extends createZodDto(
  SetDefaultPaymentMethodRequestSchema,
) {}

export const PaymentMethodEnvelopeResponseSchema = z
  .object({
    paymentMethod: PaymentMethodResponseSchema,
  })
  .strict();

export type PaymentMethodEnvelopeResponse = z.infer<typeof PaymentMethodEnvelopeResponseSchema>;

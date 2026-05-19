/**
 * Payment-method response projection.
 *
 *   GET    /v1/payment-methods            — { paymentMethods: PaymentMethodResponse[] }
 *   POST   /v1/payment-methods/aeropay/link
 *     200 → { paymentMethod: PaymentMethodResponse, link: AeropayLinkResponse }
 *
 * The shape carries what the iOS Settings → Payment Methods row renders:
 *   - the method `id` so the row can be tapped to set-default or delete,
 *   - the funding source type and bank metadata for display,
 *   - the lifecycle `status` so a `pending` row can be greyed out and a
 *     `failed` row surfaces with a retry CTA,
 *   - the `isDefault` flag so the iOS list shows the correct chevron.
 *
 * `aeropayPaymentMethodRef` is the upstream identifier persisted in
 * `payment_methods.aeropay_payment_method_ref`. It is included in the
 * response because the checkout flow (Phase 6.3) needs to reference it
 * when creating payments. It is opaque to the client.
 *
 * Cash payment methods (`type === 'cash'`) carry no bank metadata —
 * `bankName`/`last4`/`aeropayPaymentMethodRef` are null for that variant.
 * Modeling it on the same response shape keeps the iOS list view simple.
 */
import { z } from 'zod';

export const PaymentMethodTypeSchema = z.enum(['aeropay_ach', 'cash']);
export type PaymentMethodTypeDto = z.infer<typeof PaymentMethodTypeSchema>;

export const PaymentMethodStatusSchema = z.enum(['pending', 'active', 'failed', 'revoked']);
export type PaymentMethodStatusDto = z.infer<typeof PaymentMethodStatusSchema>;

export const PaymentMethodResponseSchema = z
  .object({
    id: z.string().uuid(),
    type: PaymentMethodTypeSchema,
    aeropayPaymentMethodRef: z.string().nullable(),
    bankName: z.string().nullable(),
    last4: z.string().nullable(),
    isDefault: z.boolean(),
    status: PaymentMethodStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PaymentMethodResponse = z.infer<typeof PaymentMethodResponseSchema>;

export const ListPaymentMethodsResponseSchema = z
  .object({
    paymentMethods: z.array(PaymentMethodResponseSchema).readonly(),
  })
  .strict();

export type ListPaymentMethodsResponse = z.infer<typeof ListPaymentMethodsResponseSchema>;

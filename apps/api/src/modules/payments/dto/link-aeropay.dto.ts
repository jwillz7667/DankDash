/**
 * Request and response shapes for the Aeropay link-session endpoint.
 *
 *   POST /v1/payment-methods/aeropay/link
 *     body  → { returnUrl }
 *     200   → { paymentMethod, link: { id, hostedUrl, expiresAt } }
 *
 * The client (iOS or web) opens `link.hostedUrl` in a webview / Safari
 * sheet; Aeropay redirects back to the supplied `returnUrl` when the
 * bank-link flow completes. The webhook then promotes the resulting
 * `payment_methods` row from `pending` to `active` once Aeropay confirms
 * the link (`bank_account.linked`).
 *
 * `returnUrl` is required and must be an absolute URL — letting the client
 * choose it keeps the API agnostic about the consumer surface (iOS deep
 * link, web checkout page, vendor portal admin tool). Validation here
 * rejects relative URLs and protocol-relative paths so a misconfigured
 * client can't ship a 4xx into Aeropay.
 *
 * Only one Aeropay link can be in flight per user at a time — the service
 * surfaces a 409 if the user already has an `aeropay_ach` row in `pending`
 * state. The iOS flow recovers by resuming the previous hostedUrl rather
 * than minting a fresh link session, which keeps the customer_ref → link
 * session relationship 1:1 on Aeropay's side.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaymentMethodResponseSchema } from './payment-method.dto.js';

export const LinkAeropayRequestSchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export type LinkAeropayRequest = z.infer<typeof LinkAeropayRequestSchema>;

export class LinkAeropayRequestDto extends createZodDto(LinkAeropayRequestSchema) {}

export const AeropayLinkSessionResponseSchema = z
  .object({
    id: z.string().min(1),
    hostedUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AeropayLinkSessionResponse = z.infer<typeof AeropayLinkSessionResponseSchema>;

export const LinkAeropayResponseSchema = z
  .object({
    paymentMethod: PaymentMethodResponseSchema,
    link: AeropayLinkSessionResponseSchema,
  })
  .strict();

export type LinkAeropayResponse = z.infer<typeof LinkAeropayResponseSchema>;

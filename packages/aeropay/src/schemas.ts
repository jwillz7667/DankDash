/**
 * Zod schemas for upstream Aeropay responses and webhook envelopes.
 *
 * Every external response crosses the schema before any property access —
 * if Aeropay ships a breaking change we want a structured parse failure
 * (mapped to PAYMENT_PROVIDER_UNAVAILABLE) rather than a downstream
 * `TypeError: cannot read undefined.foo` that leaks stack frames.
 *
 * The schemas are deliberately tolerant on unknown fields (`.passthrough()`)
 * so a non-breaking upstream addition doesn't fail prod. The fields we
 * actually use are tightly typed; the rest is allowed through.
 */
import { z } from 'zod';

const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'invalid ISO date-time',
});

export const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().int().positive(),
  })
  .passthrough();

const paymentStatusSchema = z.enum([
  'initiated',
  'authorized',
  'settled',
  'failed',
  'canceled',
  'refunded',
]);

export const PaymentResponseSchema = z
  .object({
    id: z.string().min(1),
    status: paymentStatusSchema,
    amount_cents: z.number().int().nonnegative(),
    bank_account_id: z.string().min(1),
    customer_ref: z.string().min(1),
    order_ref: z.string().min(1),
    created_at: isoDateTime,
  })
  .passthrough();

const payoutStatusSchema = z.enum(['pending', 'in_transit', 'paid', 'failed']);

export const PayoutResponseSchema = z
  .object({
    id: z.string().min(1),
    status: payoutStatusSchema,
    amount_cents: z.number().int().nonnegative(),
    bank_account_id: z.string().min(1),
    recipient_ref: z.string().min(1),
    period_start: isoDateTime,
    period_end: isoDateTime,
    created_at: isoDateTime,
  })
  .passthrough();

const bankAccountStatusSchema = z.enum(['pending', 'linked', 'failed']);

export const BankAccountResponseSchema = z
  .object({
    id: z.string().min(1),
    customer_ref: z.string().min(1),
    status: bankAccountStatusSchema,
    masked_account_number: z.string().min(1),
    institution_name: z.string().min(1),
  })
  .passthrough();

export const LinkSessionResponseSchema = z
  .object({
    id: z.string().min(1),
    hosted_url: z.string().url(),
    expires_at: isoDateTime,
  })
  .passthrough();

/**
 * Webhook envelope. The `data.object` payload shape varies by event type
 * (payment vs payout vs bank_account) — schema validation here only asserts
 * the envelope; callers pull out `data.object.id` and the verifier returns
 * the full payload as `raw` so the controller can route by event type.
 */
export const WebhookEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    created_at: isoDateTime,
    data: z
      .object({
        object: z
          .object({
            id: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

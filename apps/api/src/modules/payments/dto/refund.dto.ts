/**
 * Request and response shapes for the refunds surface.
 *
 *   POST /v1/vendor/orders/:id/refund
 *     body  → { amountCents, reasonCode, reasonNotes? }
 *     201   → { refund: RefundResponse }
 *
 *   POST /v1/admin/refunds/:id/approve
 *     201   → { refund: RefundResponse }
 *
 * Refunds above `REFUND_AUTO_APPROVE_LIMIT_CENTS` ($50) require an admin
 * to call /approve before the Aeropay reverse-ACH fires; refunds at or
 * below the limit finalize inline. The vendor-side controller always
 * returns a `refund` row with `requiresAdminApproval` set so the portal
 * UI knows whether to show "awaiting approval" or "completed" copy.
 *
 * `reasonCode` is constrained to snake_case ASCII for portability (the
 * Aeropay API forwards it verbatim; mixing case across vendors creates
 * reporting noise). Free-form context lives in `reasonNotes`. Both are
 * persisted to `refunds.reason_code` / `refunds.reason_notes` and
 * surface in the vendor activity feed.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Below this amount the vendor's initial POST finalizes the refund;
 * above it the row stays `pending` until an admin approves. The DB
 * `refunds_separation_of_duties` CHECK keeps the admin distinct from
 * the initiator regardless — auto-approve leaves `approved_by` NULL
 * so the constraint is trivially satisfied.
 */
export const REFUND_AUTO_APPROVE_LIMIT_CENTS = 5_000;

export const RefundStatusSchema = z.enum(['pending', 'completed', 'failed', 'canceled']);
export type RefundStatusDto = z.infer<typeof RefundStatusSchema>;

export const InitiateRefundRequestSchema = z
  .object({
    amountCents: z.number().int().positive().max(2_000_000),
    reasonCode: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'reasonCode must be lowercase snake_case'),
    reasonNotes: z.string().max(500).optional(),
  })
  .strict();

export type InitiateRefundRequest = z.infer<typeof InitiateRefundRequestSchema>;

export class InitiateRefundRequestDto extends createZodDto(InitiateRefundRequestSchema) {}

export const RefundResponseSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    reasonCode: z.string(),
    reasonNotes: z.string().nullable(),
    initiatedBy: z.string().uuid(),
    approvedBy: z.string().uuid().nullable(),
    providerRef: z.string().nullable(),
    status: RefundStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    requiresAdminApproval: z.boolean(),
  })
  .strict();

export type RefundResponse = z.infer<typeof RefundResponseSchema>;

export const RefundEnvelopeResponseSchema = z
  .object({
    refund: RefundResponseSchema,
  })
  .strict();

export type RefundEnvelopeResponse = z.infer<typeof RefundEnvelopeResponseSchema>;

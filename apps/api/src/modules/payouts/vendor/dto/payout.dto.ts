/**
 * DTOs for the vendor-portal payouts surface.
 *
 *   GET /v1/vendor/payouts        — list of payouts for the active vendor
 *   GET /v1/vendor/payouts/:id    — single payout + its constituent orders
 *
 * The wire shape mirrors the `payouts` row (Drizzle `Payout`) with two
 * adaptations:
 *   - `period_start`/`period_end` are emitted as ISO date strings
 *     (YYYY-MM-DD) — they're already `date` columns in PG and the portal
 *     formats them with luxon against America/Chicago.
 *   - Timestamp columns are emitted as ISO-8601 strings with offset; the
 *     portal converts to the Central calendar for display. Null when the
 *     underlying column has not been stamped (e.g. `initiatedAt` while
 *     the payout is still `pending`).
 *
 * Money columns stay as integer cents — the portal renders dollars via
 * the shared `formatMoney` helper.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PayoutStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
  'canceled',
]);
export type VendorPayoutStatus = z.infer<typeof PayoutStatusSchema>;

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, { message: 'expected YYYY-MM-DD' });

export const VendorPayoutSummarySchema = z
  .object({
    id: z.string().uuid(),
    /** ISO calendar date (YYYY-MM-DD) for the period's inclusive lower bound. */
    periodStart: DateOnlySchema,
    /** ISO calendar date (YYYY-MM-DD) for the period's exclusive upper bound. */
    periodEnd: DateOnlySchema,
    grossCents: z.number().int().min(0),
    feesCents: z.number().int().min(0),
    netCents: z.number().int(),
    status: PayoutStatusSchema,
    /** ISO calendar date (YYYY-MM-DD) the payout was scheduled to disburse. */
    scheduledFor: DateOnlySchema,
    aeropayPayoutRef: z.string().nullable(),
    /** ISO-8601 UTC timestamp when the upstream provider was first hit. */
    initiatedAt: z.string().datetime({ offset: true }).nullable(),
    /** ISO-8601 UTC timestamp when the upstream provider settled the payout. */
    completedAt: z.string().datetime({ offset: true }).nullable(),
    /** Operator-readable reason a `failed` payout did not disburse. */
    failureReason: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type VendorPayoutSummary = z.infer<typeof VendorPayoutSummarySchema>;

export const VendorPayoutListResponseSchema = z
  .object({
    payouts: z.array(VendorPayoutSummarySchema).readonly(),
  })
  .strict();
export type VendorPayoutListResponse = z.infer<typeof VendorPayoutListResponseSchema>;
export class VendorPayoutListResponseDto extends createZodDto(VendorPayoutListResponseSchema) {}

export const VendorPayoutOrderSchema = z
  .object({
    id: z.string().uuid(),
    /** Customer-facing short code (e.g. `DD-A4F2-19`). */
    shortCode: z.string(),
    /** ISO-8601 UTC timestamp when the order flipped to `delivered`. */
    deliveredAt: z.string().datetime({ offset: true }),
    subtotalCents: z.number().int().min(0),
    discountCents: z.number().int().min(0),
    totalCents: z.number().int().min(0),
    customerFirstName: z.string().nullable(),
    customerLastName: z.string().nullable(),
  })
  .strict();
export type VendorPayoutOrder = z.infer<typeof VendorPayoutOrderSchema>;

/**
 * Detail response — the same summary fields plus the constituent orders
 * that delivered inside the period. The portal renders gross/fees/net at
 * the top and the orders list below; the sum of `totalCents` reconciles
 * to `grossCents` minus any in-window refunds (which the ledger already
 * nets out before the payout row is written).
 */
export const VendorPayoutDetailResponseSchema = VendorPayoutSummarySchema.extend({
  orders: z.array(VendorPayoutOrderSchema).readonly(),
}).strict();
export type VendorPayoutDetailResponse = z.infer<typeof VendorPayoutDetailResponseSchema>;
export class VendorPayoutDetailResponseDto extends createZodDto(VendorPayoutDetailResponseSchema) {}
